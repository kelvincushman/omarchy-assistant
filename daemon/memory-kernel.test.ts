import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kernel = path.join(repo, "bin", "omarchy-memory-kernel");
let root = "";
let vault = "";
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-memory-kernel-"));
  vault = path.join(root, "vault");
  const bin = path.join(root, "dossier");
  mkdirSync(path.join(vault, "Notes"), { recursive: true });
  writeFileSync(path.join(vault, "Notes", "2026-09-07.md"), "# Notes\n\nKelvin prefers deterministic kernels.\n");
  writeFileSync(path.join(vault, "empty.md"), "\n");
  writeFileSync(bin, `#!/bin/bash
set -e
printf '%s\\n' "$*" >>"$MEMORY_TEST_LOG"
project=""
while (($#)); do
  if [[ $1 == --project ]]; then project=$2; shift 2; break; fi
  shift
done
case $1 in
ingest)
  mkdir -p "$project/wiki/sources" "$project/wiki/entities"
  printf '%s\\n' '---' 'kind: source' 'name: Test' '---' '' '# Test source' '' '## Entities (2)' '' '- [[entities/the]]' '- [[entities/kelvin]]' >"$project/wiki/sources/test.md"
  printf '%s\\n' '---' 'kind: entity' 'name: The' 'edited_by: llm' '---' '' '## Evidence' >"$project/wiki/entities/the.md"
  printf '%s\\n' '---' 'kind: entity' 'name: Kelvin' 'edited_by: llm' '---' '' '## Evidence' '' '- Kelvin prefers deterministic kernels.' >"$project/wiki/entities/kelvin.md"
  echo 'routed: ingest_document'
  ;;
query)
  shift
  echo "question: $*"
  echo 'candidates (2):'
  echo '  wiki entities/kelvin.md score=2.00'
  echo '  wiki sources/test.md score=1.00'
  ;;
gardener) echo 'gardener complete — orphans=0 stale=0 review=0 missing_xref=0' ;;
*) exit 2 ;;
esac
`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  env = {
    ...process.env,
    OMARCHY_MEMORY_HOME: path.join(root, "memory"),
    OMARCHY_VAULT: vault,
    OMARCHY_DOSSIER_BIN: bin,
    MEMORY_TEST_LOG: path.join(root, "dossier.log"),
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(args: string[]) {
  return spawnSync(kernel, args, { env, encoding: "utf8" });
}

describe("memory kernel boundary", () => {
  test("ingests changed notes once and excludes its generated wiki", () => {
    const first = run(["sync"]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /seen=2 ingested=1 unchanged=0 empty=1 pruned=1 failed=0/);
    assert.equal(readFileSync(env.MEMORY_TEST_LOG!, "utf8").trim().split("\n").length, 1);
    const source = readFileSync(path.join(vault, "Memory", "Dossier", "sources", "test.md"), "utf8");
    assert.match(source, /## Entities \(1\)/);
    assert.doesNotMatch(source, /entities\/the/);
    assert.match(source, /entities\/kelvin/);

    const second = run(["sync"]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /seen=2 ingested=0 unchanged=2 empty=0 pruned=0 failed=0/);
    assert.equal(readFileSync(env.MEMORY_TEST_LOG!, "utf8").trim().split("\n").length, 1);

    writeFileSync(path.join(vault, "Notes", "2026-09-07.md"), "# Notes\n\nKelvin prefers a grounded memory kernel.\n");
    const third = run(["sync"]);
    assert.equal(third.status, 0, third.stderr);
    assert.match(third.stdout, /ingested=1/);
    assert.equal(readFileSync(env.MEMORY_TEST_LOG!, "utf8").trim().split("\n").length, 2);
  });

  test("query combines Dossier context with cited original lines", () => {
    const result = run(["query", "What does Kelvin prefer?"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /## HMLR Dossier lattice/);
    assert.match(result.stdout, /\[entities\/kelvin\]/);
    assert.doesNotMatch(result.stdout, /\[sources\/test\]/);
    assert.match(result.stdout, /## Direct Obsidian source matches/);
    assert.match(result.stdout, /\[Notes\/2026-09-07.md:3\] Kelvin prefers deterministic kernels/);
  });

  test("status is machine-readable and confirms there are no model calls", () => {
    const sync = run(["sync"]);
    assert.equal(sync.status, 0, sync.stderr);
    const result = run(["status", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.installed, true);
    assert.equal(status.sources, 2);
    assert.equal(status.rawSnapshots, 1);
    assert.equal(status.mode, "dossier-deterministic-document-lattice");
    assert.equal(status.hmlrDialogueEngine, false);
    assert.equal(status.modelCalls, false);
  });
});
