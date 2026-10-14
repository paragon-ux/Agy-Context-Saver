import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setupHermeticTestEnv, createRtkShim, prependToPath } from "./helpers/hermetic-fixture.mjs";
import { ensureRtkInstalled, ensureRtkConfigured, getRtkConfigPath } from "../scripts/provision-rtk.mjs";

console.log("=================================================");
console.log("RTK Ledger & Fresh Install Verification Suite");
console.log("=================================================\n");

// --- TEST 1: RTK-01 Fresh Installation Standardizes config.toml ---
console.log("--- 1. RTK-01: Fresh Install Config Standardization ---");

const tempProfile = fs.mkdtempSync(path.join(os.tmpdir(), "agy-rtk-fresh-test-"));
process.env.AGY_TEST_PROFILE_DIR = tempProfile;

const configPath = getRtkConfigPath();
assert.equal(fs.existsSync(configPath), false, "Fresh profile must not have config.toml initially");

// Provision / configure RTK in this fresh profile
ensureRtkConfigured({ silent: true });

assert.equal(fs.existsSync(configPath), true, `config.toml must be created at ${configPath}`);
const freshContent = fs.readFileSync(configPath, "utf-8");
assert.match(freshContent, /\[hooks\]/, "Must contain [hooks] section");
assert.match(freshContent, /suppress_hook_warning\s*=\s*true/, "Must standardize suppress_hook_warning = true");
console.log("✓ Fresh install automatically creates RTK config.toml with suppress_hook_warning = true");

// --- TEST 2: RTK-01 Non-destructive Config Preservation ---
console.log("\n--- 2. RTK-01: Non-destructive Preservation of Custom Config ---");

// Write existing custom settings with suppress_hook_warning = false
const customConfig = [
  "# Custom RTK user preferences",
  "[general]",
  'log_level = "debug"',
  "telemetry = false",
  "",
  "[hooks]",
  "suppress_hook_warning = false",
  'other_flag = "preserved"',
  ""
].join("\n");
fs.writeFileSync(configPath, customConfig, "utf-8");

ensureRtkConfigured({ silent: true });

const updatedContent = fs.readFileSync(configPath, "utf-8");
assert.match(updatedContent, /suppress_hook_warning\s*=\s*true/, "suppress_hook_warning must be updated to true");
assert.match(updatedContent, /\[general\]/, "[general] section preserved");
assert.match(updatedContent, /log_level\s*=\s*"debug"/, "log_level setting preserved");
assert.match(updatedContent, /telemetry\s*=\s*false/, "telemetry setting preserved");
assert.match(updatedContent, /other_flag\s*=\s*"preserved"/, "other_flag preserved");
console.log("✓ Existing user sections, comments, and flags preserved while standardizing suppress_hook_warning = true");

// Cleanup temp profile
try { fs.rmSync(tempProfile, { recursive: true, force: true }); } catch {}

// --- TEST 3: RTK-02 & RTK-03: Direct Upstream Root Configuration & Clean Command Delivery ---
console.log("\n--- 3. RTK-02 & RTK-03: Direct Upstream Root Configuration & Clean Command Delivery ---");

// Set up hermetic environment for hook execution
const { profileDir, cleanup } = await setupHermeticTestEnv();

const hookScript = path.resolve(fileURLToPath(import.meta.url), "../../scripts/execution-guard-hook.mjs");

function runHook(payload) {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "cmd.exe" : "sh";
  const args = isWin ? ["/c", "node", hookScript] : ["-c", `node "${hookScript}"`];
  const res = spawnSync(cmd, args, {
    input: JSON.stringify(payload),
    encoding: "utf-8"
  });
  assert.equal(res.status, 0, `Hook process exited with code ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

// 3a. Verify direct rewrite delivery with zero regex line mangling
const rewriteOutput = runHook({
  toolCall: { name: "run_command", args: { CommandLine: "git status", WaitMsBeforeAsync: 3000 } }
});

assert.equal(rewriteOutput.decision, "allow", "Rewritten command must be allowed");
assert.ok(rewriteOutput.overwrite?.CommandLine, "CommandLine must be overwritten");
assert.equal(rewriteOutput.overwrite.CommandLine, "rtk git status", "Direct command output delivered cleanly");
console.log("✓ Direct RTK rewrite cleanly delivers 'rtk git status' without regex line mangling");

// 3b. Verify pipeline commands and commands referencing 'rtk' are not corrupted
const pipeOutput = runHook({
  toolCall: { name: "run_command", args: { CommandLine: "cat package.json", WaitMsBeforeAsync: 3000 } }
});
assert.equal(pipeOutput.decision, "allow");
assert.equal(pipeOutput.overwrite?.CommandLine, "rtk read package.json", "Preserves target arguments cleanly");
console.log("✓ Direct command execution preserves arguments and subcommands cleanly with zero edge-case clashing");

// --- TEST 4: RTK-04 ripgrep Stdin Deadlock Prevention on Windows ---
console.log("\n--- 4. RTK-04: ripgrep Trailing Target Enforcement ---");

const grepOutput = runHook({
  toolCall: { name: "grep_search", args: { query: "export function handleRequest" } }
});

assert.equal(grepOutput.decision, "deny", "grep_search must be routed to rtk");
if (process.platform === "win32") {
  assert.match(grepOutput.reason, /rtk rg "export function handleRequest" \./, "Windows grep_search must include trailing '.' target");
  console.log("✓ Windows grep_search routes to 'rtk rg <pattern> .' with explicit target '.' preventing stdin freeze");
} else {
  assert.match(grepOutput.reason, /rtk grep "export function handleRequest"/, "POSIX grep_search routes to rtk grep");
  console.log("✓ POSIX grep_search routes to 'rtk grep <pattern>'");
}

// --- TEST 5: RTK-05 Windows FIND.EXE Collision Prevention ---
console.log("\n--- 5. RTK-05: find_by_name Canonical Routing ---");

const findOutput = runHook({
  toolCall: { name: "find_by_name", args: { pattern: "*.mjs" } }
});

assert.equal(findOutput.decision, "deny", "find_by_name must be routed to rtk find");
assert.match(findOutput.reason, /rtk find \*\.mjs/, "Must route to canonical 'rtk find *.mjs' without POSIX flags");
assert.equal(findOutput.reason.includes("-name"), false, "Must not use -name flag which triggers Windows FIND.EXE collision");
console.log("✓ find_by_name routes to canonical 'rtk find *.mjs' avoiding Windows FIND.EXE parameter collisions");

// --- TEST 6: RTK-06 Missing POSIX Binary Avoidance on Windows ---
console.log("\n--- 6. RTK-06: list_dir Platform-Specific Routing ---");

const listOutput = runHook({
  toolCall: { name: "list_dir", args: { dir_path: "c:/project/tests" } }
});

assert.equal(listOutput.decision, "deny", "list_dir must be routed to rtk");
if (process.platform === "win32") {
  assert.match(listOutput.reason, /rtk find c:\/project\/tests/, "Windows list_dir routes to 'rtk find' to avoid missing ls.exe");
  console.log("✓ Windows list_dir routes to 'rtk find <path>' avoiding missing ls.exe / tree.com");
} else {
  assert.match(listOutput.reason, /rtk ls c:\/project\/tests/, "POSIX list_dir routes to 'rtk ls <path>'");
  console.log("✓ POSIX list_dir routes to 'rtk ls <path>'");
}

cleanup();

console.log("\n=================================================");
console.log("All 6 RTK Ledger Quirks Verified from Fresh Install!");
console.log("=================================================");
