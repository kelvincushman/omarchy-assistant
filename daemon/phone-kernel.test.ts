import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kernel = path.join(repo, "bin", "omarchy-phone-kernel");
let root = "";
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-phone-kernel-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const contentswarm = `#!/bin/bash
printf '%s\\n' "$*" >>"$PHONE_TEST_LOG"
case $1 in
  compose)
    for ((i=1; i<=$#; i++)); do
      if [[ \${!i} == --token-file ]]; then j=$((i+1)); printf '%s\\n' test-prepared-token >"\${!j}"; chmod 600 "\${!j}"; fi
    done
    echo '{"sent":false,"success":true}'
    ;;
  send) echo '{"sent":true,"verified":true,"success":true}' ;;
  *) echo '{"success":true}' ;;
esac
`;
  const assistant = `#!/bin/bash
printf '%s\\n' "$*" >>"$PHONE_TEST_APPROVALS"
[[ $PHONE_APPROVE == allow ]]
`;
  writeFileSync(path.join(bin, "contentswarm"), contentswarm, { mode: 0o755 });
  writeFileSync(path.join(bin, "omarchy-assistant"), assistant, { mode: 0o755 });
  chmodSync(path.join(bin, "contentswarm"), 0o755);
  chmodSync(path.join(bin, "omarchy-assistant"), 0o755);
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CONTENTSWARM_BIN: path.join(bin, "contentswarm"),
    CONTENTSWARM_API_TOKEN: "test-token",
    CONTENTSWARM_API_URL: "http://127.0.0.1:5055/api/v1",
    XDG_RUNTIME_DIR: path.join(root, "run"),
    XDG_STATE_HOME: path.join(root, "state"),
    PHONE_TEST_LOG: path.join(root, "contentswarm.log"),
    PHONE_TEST_APPROVALS: path.join(root, "approvals.log"),
    PHONE_APPROVE: "allow",
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(args: string[]) {
  return spawnSync(kernel, args, { env, encoding: "utf8" });
}

function messageFile(text = "Private message") {
  const file = path.join(root, "message.txt");
  writeFileSync(file, text, { mode: 0o600 });
  return file;
}

describe("phone kernel boundary", () => {
  test("read-only commands pass through without approval", () => {
    const result = run(["phones"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /success/);
    assert.equal(readFileSync(env.PHONE_TEST_LOG!, "utf8"), "phones\n");
    assert.throws(() => readFileSync(env.PHONE_TEST_APPROVALS!, "utf8"));
  });

  test("compose cannot send and binds channel, recipient, and body", () => {
    const body = messageFile();
    const result = run(["compose", "primary", "sms", "+447700900123", "--body-file", body]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"sent":false/);
    const invocation = readFileSync(env.PHONE_TEST_LOG!, "utf8");
    assert.match(invocation, /compose primary sms \+447700900123 --body-file/);
    assert.doesNotMatch(invocation, /Private message/);
  });

  test("send requires prior matching compose, approval, and verified result", () => {
    const body = messageFile("Private message\n\n");
    assert.equal(run(["compose", "primary", "whatsapp", "+447700900123", "--body-file", body]).status, 0);
    const result = run(["send", "primary", "whatsapp", "+447700900123", "--expect-body-file", body]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"verified":true/);
    assert.match(readFileSync(env.PHONE_TEST_APPROVALS!, "utf8"), /send whatsapp[\s\S]*Private message\n\n/);
    const audit = readFileSync(path.join(env.XDG_STATE_HOME!, "omarchy-assistant", "phone-audit.jsonl"), "utf8");
    assert.match(audit, /"action":"send"/);
    assert.doesNotMatch(audit, /Private message/);
    assert.doesNotMatch(audit, /test-token/);
  });

  test("changed recipient cannot be approved or sent", () => {
    const body = messageFile();
    assert.equal(run(["compose", "primary", "sms", "+447700900123", "--body-file", body]).status, 0);
    const result = run(["send", "primary", "sms", "+447700900999", "--expect-body-file", body]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /changed/);
    assert.throws(() => readFileSync(env.PHONE_TEST_APPROVALS!, "utf8"));
  });

  test("denied send never reaches the send transport", () => {
    const body = messageFile();
    assert.equal(run(["compose", "primary", "sms", "+447700900123", "--body-file", body]).status, 0);
    env.PHONE_APPROVE = "deny";
    const result = run(["send", "primary", "sms", "+447700900123", "--expect-body-file", body]);
    assert.equal(result.status, 1);
    assert.deepEqual(readFileSync(env.PHONE_TEST_LOG!, "utf8").trim().split("\n").map(line => line.split(" ")[0]), ["compose"]);
  });

  test("sensitive semantic taps obtain approval and pass confirm", () => {
    const result = run(["tap", "primary", "--text", "Post"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(env.PHONE_TEST_APPROVALS!, "utf8"), /tap.*Post/);
    assert.equal(readFileSync(env.PHONE_TEST_LOG!, "utf8"), "tap primary --text Post --confirm\n");
  });

  test("neutral semantic taps are exact-confirmed without human approval", () => {
    const result = run(["tap", "primary", "--text", "Continue"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(env.PHONE_TEST_LOG!, "utf8"), "tap primary --text Continue --confirm\n");
    assert.throws(() => readFileSync(env.PHONE_TEST_APPROVALS!, "utf8"));
  });

  test("navigation keys are exact-confirmed without human approval", () => {
    const result = run(["key", "primary", "back"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(env.PHONE_TEST_LOG!, "utf8"), "key primary BACK --confirm\n");
    assert.throws(() => readFileSync(env.PHONE_TEST_APPROVALS!, "utf8"));
  });

  test("activating keys require human approval", () => {
    const result = run(["key", "primary", "ENTER"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(env.PHONE_TEST_APPROVALS!, "utf8"), /press ENTER/);
    assert.equal(readFileSync(env.PHONE_TEST_LOG!, "utf8"), "key primary ENTER --confirm\n");
  });

  test("screenshots are confined to runtime or vault storage", () => {
    const denied = run(["screenshot", "primary", "-o", "/etc/phone.png"]);
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /runtime directory or Obsidian vault/);
    assert.throws(() => readFileSync(env.PHONE_TEST_LOG!, "utf8"));

    const allowed = run(["screenshot", "primary"]);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(readFileSync(env.PHONE_TEST_LOG!, "utf8"), /screenshot primary -o .*omarchy-assistant\/phone-primary-/);
  });
});
