import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kernel = path.join(repo, "bin", "omarchy-mail-kernel");
let root = "";
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-mail-kernel-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const himalaya = `#!/bin/bash
printf '%s\\n' "$*" >>"$MAIL_TEST_LOG"
if [[ $* == '--json account list' ]]; then
  printf '%s\\n' '{"accounts":[{"name":"aigentis","default":true,"backends":["imap","smtp"]}]}'
  exit 0
fi
cat >>"$MAIL_TEST_BODY" || true
echo ok
`;
  const assistant = `#!/bin/bash
printf '%s\\n' "$*" >>"$MAIL_TEST_APPROVALS"
[[ $MAIL_APPROVE == allow ]]
`;
  writeFileSync(path.join(bin, "himalaya"), himalaya, { mode: 0o755 });
  writeFileSync(path.join(bin, "omarchy-assistant"), assistant, { mode: 0o755 });
  chmodSync(path.join(bin, "himalaya"), 0o755);
  chmodSync(path.join(bin, "omarchy-assistant"), 0o755);
  const config = path.join(root, "himalaya.toml");
  writeFileSync(config, '[accounts.aigentis]\nemail = "owner@example.com"\n');
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HIMALAYA_CONFIG: config,
    XDG_STATE_HOME: path.join(root, "state"),
    MAIL_TEST_LOG: path.join(root, "himalaya.log"),
    MAIL_TEST_BODY: path.join(root, "body.log"),
    MAIL_TEST_APPROVALS: path.join(root, "approvals.log"),
    MAIL_APPROVE: "allow",
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(args: string[], input = "") {
  return spawnSync(kernel, args, { env, input, encoding: "utf8" });
}

describe("mail kernel boundary", () => {
  test("rejects unknown accounts and option-shaped message ids", () => {
    const unknown = run(["unknown", "inbox"]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown account/);

    const badId = run(["aigentis", "read", "--bad"]);
    assert.equal(badId.status, 2);
    assert.match(badId.stderr, /invalid message id/);
  });

  test("send is approved, delivered by Himalaya, saved, and audited without its body", () => {
    const result = run(["aigentis", "send", "person@example.com", "A subject"], "private body");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /sent/);
    assert.match(readFileSync(env.MAIL_TEST_APPROVALS!, "utf8"), /approve send an email/);
    const invocation = readFileSync(env.MAIL_TEST_LOG!, "utf8");
    assert.match(invocation, /message compose/);
    assert.match(invocation, /--send --save sent/);
    assert.equal(readFileSync(env.MAIL_TEST_BODY!, "utf8"), "private body\n");
    const audit = readFileSync(path.join(env.XDG_STATE_HOME!, "omarchy-assistant", "mail-audit.jsonl"), "utf8");
    assert.match(audit, /"action":"send"/);
    assert.doesNotMatch(audit, /private body/);
  });

  test("a denied send never reaches the transport", () => {
    env.MAIL_APPROVE = "deny";
    const result = run(["aigentis", "send", "person@example.com", "No"], "do not send");
    assert.equal(result.status, 1);
    const invocations = readFileSync(env.MAIL_TEST_LOG!, "utf8").trim().split("\n");
    assert.deepEqual(invocations, ["--json account list"]);
  });

  test("reply explicitly sends and saves a copy", () => {
    const result = run(["aigentis", "reply", "42"], "reply body");
    assert.equal(result.status, 0, result.stderr);
    const invocation = readFileSync(env.MAIL_TEST_LOG!, "utf8");
    assert.match(invocation, /message reply 42 --send --save sent/);
  });
});
