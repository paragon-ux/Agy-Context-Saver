import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupHermeticTestEnv } from "./helpers/hermetic-fixture.mjs";
import { getStateDir } from "../scripts/state-dir.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookScript = path.join(root, "scripts/execution-guard-hook.mjs");
const cliScript = path.join(root, "bin/agy-context.mjs");
const hermetic = await setupHermeticTestEnv({ installProfile: false, forceShim: true, shimVersion: "1.1.0" });
const brain = path.join(hermetic.profileDir, ".gemini", "antigravity", "brain");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "agy-tguard-"));

const P = "aaaaaaaa-0000-4000-8000-000000000001";
const A = "aaaaaaaa-0000-4000-8000-000000000002";
const B = "aaaaaaaa-0000-4000-8000-000000000003";
const logsOf = (id) => path.join(brain, id, ".system_generated", "logs");
const tfile = (id) => path.join(logsOf(id), "transcript.jsonl");

function seed(id, parent) {
  fs.mkdirSync(logsOf(id), { recursive: true });
  const first = parent
    ? { step_index: 0, type: "SYSTEM_MESSAGE", source: "SYSTEM", content: `[Message] timestamp=2026-01-01T00:00:00Z sender=${parent} priority=MESSAGE_PRIORITY_HIGH content=Do the task` }
    : { step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", content: "hello" };
  fs.writeFileSync(tfile(id), JSON.stringify(first) + "\n" + JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", content: "ok" }) + "\n");
}
seed(P, null); seed(A, P); seed(B, P);
fs.writeFileSync(path.join(work, "note.txt"), "x\n");
fs.symlinkSync(logsOf(B), path.join(work, "lnk"));

function hook(convId, toolName, args) {
  const r = spawnSync(process.execPath, [hookScript], {
    input: JSON.stringify({ conversationId: convId, cwd: work, toolCall: { name: toolName, args } }),
    encoding: "utf-8", env: process.env
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim()).decision;
}
const readFile = (id, file) => hook(id, "read_file", { Path: file, StartLine: 1, EndLine: 20 });
const shell = (id, cmd) => hook(id, "run_command", { CommandLine: cmd, WaitMsBeforeAsync: 5000 });
const cli = (id, ...args) => spawnSync(process.execPath, [cliScript, "transcript", "access", ...args], {
  encoding: "utf-8", env: { ...process.env, GEMINI_CONVERSATION_ID: id }
});

console.log("--- Transcript guard: open mode (no policy) ---");
assert.equal(fs.existsSync(path.join(getStateDir(), "transcript-policy.json")), false);
assert.equal(readFile(A, tfile(B)), "allow", "open: sibling read allowed");
assert.equal(shell(A, `head -n 5 "${tfile(B)}"`), "allow", "open: shell read allowed");
assert.equal(hook(A, "grep_search", { Path: tfile(B), Query: "ok" }), "allow", "open: grep allowed");
console.log("✓ open mode allows native transcript reads");

console.log("--- Transcript guard: self-only ---");
const set = cli(P, "set", "self-only");
assert.equal(set.status, 0, set.stderr);
assert.match(cli(P, "status").stdout, /self-only/);
assert.equal(readFile(A, tfile(A)), "allow", "self-only: own transcript allowed");
assert.equal(shell(A, `head -n 5 "${tfile(A)}"`), "allow", "self-only: own shell read allowed");
assert.equal(readFile(A, tfile(B)), "deny", "self-only: sibling denied");
assert.equal(readFile(A, tfile(P)), "deny", "self-only: parent denied");
assert.equal(hook(A, "grep_search", { Path: tfile(B), Query: "ok" }), "deny", "self-only: grep sibling denied");
assert.equal(shell(A, `head -n 5 "${tfile(B)}"`), "deny", "self-only: shell sibling denied");
assert.equal(shell(A, `rg ok "${path.join(brain, "*", ".system_generated", "logs", "transcript.jsonl")}"`), "deny", "self-only: glob denied");
assert.equal(readFile(A, path.join(work, "lnk", "transcript.jsonl")), "deny", "self-only: symlink to sibling denied");
assert.equal(shell(A, `head -n 5 "${path.join(work, "lnk", "transcript.jsonl")}"`), "deny", "self-only: shell symlink denied");
assert.equal(shell(A, "agy-context transcript health --id " + B), "deny", "self-only: health for others denied");
assert.equal(readFile(A, path.join(work, "note.txt")), "allow", "self-only: unrelated files unaffected");
assert.equal(readFile(P, tfile(A)), "allow", "parent is not restricted");
assert.equal(hook(undefined, "read_file", { Path: tfile(A), StartLine: 1, EndLine: 5 }), "deny", "unknown caller fails closed");
console.log("✓ self-only allows own transcript and denies siblings, parent, globs, symlinks, and unknown callers");

console.log("--- Transcript guard: deny ---");
assert.equal(cli(P, "set", "deny").status, 0);
assert.equal(readFile(A, tfile(A)), "deny", "deny: own transcript denied");
assert.equal(shell(A, `head -n 5 "${tfile(A)}"`), "deny", "deny: shell denied");
assert.equal(readFile(P, tfile(A)), "allow", "deny: setter unaffected");
console.log("✓ deny mode blocks every transcript read for children");

console.log("--- Transcript guard: writes and reset ---");
for (const mode of ["deny", "open"]) {
  cli(P, "set", mode);
  assert.equal(hook(A, "write_to_file", { TargetFile: tfile(A), CodeContent: "x" }), "deny", `write denied (${mode})`);
  assert.equal(hook(P, "edit_file", { Path: tfile(P), Content: "x" }), "deny", `top-level write denied (${mode})`);
  assert.equal(shell(A, `rm "${tfile(A)}"`), "deny", `delete denied (${mode})`);
  assert.equal(hook(A, "write_to_file", { TargetFile: path.join(getStateDir(), "transcript-policy.json"), CodeContent: "{}" }), "deny", `policy file write denied (${mode})`);
}
assert.equal(readFile(A, tfile(B)), "allow", "open again after reset");
assert.equal(cli(A, "set", "bogus").status, 1, "invalid mode rejected");
console.log("✓ writes and deletes stay denied; resetting to open restores reads");

console.log("--- Config edit prompt for top-level sessions only ---");
const cfg = path.join(hermetic.profileDir, ".gemini", "antigravity", "mcp_config.json");
assert.equal(hook(P, "edit_file", { Path: cfg, Content: "{}" }), "force_ask", "top-level config edit asks");
assert.equal(hook(A, "edit_file", { Path: cfg, Content: "{}" }), "deny", "child config edit denied");
cli(P, "set", "self-only");
assert.equal(hook(P, "edit_file", { Path: cfg, Content: "{}" }), "force_ask", "setter stays top-level");
console.log("✓ config edits ask for top-level sessions and stay denied for children");

fs.rmSync(work, { recursive: true, force: true });
hermetic.cleanup();
console.log("\nALL TRANSCRIPT GUARD TESTS PASSED!");
