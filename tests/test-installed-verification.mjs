import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupHermeticTestEnv, HERMETIC_CONV_ID } from "./helpers/hermetic-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliScript = path.resolve(__dirname, "../bin/agy-context.mjs");

console.log("=================================================");
console.log("Agy-Context-Saver v2.0.0 Installed System Verification");
console.log("=================================================\n");

const hermetic = await setupHermeticTestEnv({ forceShim: true, shimVersion: "1.1.0" });
const homeDir = process.env.AGY_TEST_PROFILE_DIR || os.homedir();
const geminiConfigDir = path.join(homeDir, ".gemini", "config");
const pluginDest = path.join(geminiConfigDir, "plugins", "agy-context-saver");
const pluginHooksPath = path.join(pluginDest, "hooks.json");
const globalHooksJsonPath = path.join(geminiConfigDir, "hooks.json");
const mcpJsonPath = path.join(geminiConfigDir, "mcp_config.json");
const antigravityMcpRootDir = path.join(homeDir, ".gemini", "antigravity", "mcp");
const antigravityBinDir = path.join(homeDir, ".gemini", "antigravity", "bin");
const { getStateDir } = await import("../scripts/state-dir.mjs");
const stateFile = path.join(getStateDir(), "agy-session-governance-state.json");

try {
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
} catch {}

// --- 1. Configuration, Single-Hook Registration & MCP Retirement ---
console.log("--- 1. Plugin Link, Single Hook & MCP Retirement Verification ---");
assert.ok(fs.existsSync(pluginDest), `Native plugin link missing at ${pluginDest}`);
assert.ok(fs.existsSync(pluginHooksPath), `Plugin hooks.json missing at ${pluginHooksPath}`);

const pluginHooks = JSON.parse(fs.readFileSync(pluginHooksPath, "utf-8"));
assert.ok(pluginHooks["agy-context-saver"], "Plugin hooks.json must define 'agy-context-saver'");
const hookCmd = pluginHooks["agy-context-saver"].PreToolUse[0].hooks[0].command;
assert.equal(hookCmd.includes("ANTIGRAVITY_PLUGIN_ROOT"), false, "Plugin hooks.json must not reference unexpanded ANTIGRAVITY_PLUGIN_ROOT");
const hookMatcher = pluginHooks["agy-context-saver"].PreToolUse[0].matcher;
for (const tool of ["manage_task", "schedule", "run_command", "read_file", "edit_file", "write_file", "grep_search", "find_by_name", "list_dir"]) {
  assert.ok(hookMatcher.includes(tool), `Matcher includes ${tool}`);
}

// Global hooks.json must prune legacy execution-guard, register agy-context-saver for /swarm workers, and preserve foreign hooks
const mirroredHook = path.join(geminiConfigDir, "scripts", "execution-guard-hook.mjs");
assert.ok(fs.existsSync(mirroredHook), `Mirrored global hook script missing at ${mirroredHook}`);
const globalHooks = JSON.parse(fs.readFileSync(globalHooksJsonPath, "utf-8"));
assert.equal(globalHooks["execution-guard"], undefined, "Legacy execution-guard must not be in global hooks.json");
assert.ok(globalHooks["agy-context-saver"]?.PreToolUse?.[0]?.hooks?.[0]?.command?.includes("execution-guard-hook.mjs"), "agy-context-saver must register in global hooks.json for /swarm workers");
assert.equal(globalHooks["agy-context-saver"]?.PreToolUse?.[0]?.matcher, hookMatcher, "Global hooks.json matcher must match plugin hooks.json");
assert.ok(globalHooks["waymark-continuity"], "Foreign hook waymark-continuity must remain preserved");

// Default MCP retired cleanly
const mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
assert.equal(mcpConfig.mcpServers?.["agy-context-saver"], undefined, "agy-context-saver must be retired from mcp_config.json");
assert.ok(mcpConfig.mcpServers?.["waymark-engine"], "Foreign MCP server waymark-engine must remain preserved");
if (fs.existsSync(antigravityMcpRootDir)) {
  const stale = fs.readdirSync(antigravityMcpRootDir).filter((n) => n.startsWith("agy-context-saver"));
  assert.deepEqual(stale, [], "Zero agy-context-saver* MCP schema directories may remain");
}
console.log("✓ Plugin + global hooks.json active for coordinator & /swarm workers; zero duplicate MCP configs; foreign entries preserved");

// --- 2. Detection & RTK Config ---
console.log("\n--- 2. Installer Status & RTK Config Verification ---");
const { detectExistingInstallation } = await import("../scripts/install-register.mjs");
const detection = detectExistingInstallation();
assert.equal(detection.isInstalled, true);
assert.equal(detection.isComplete, true);
assert.equal(detection.details.plugin.exists, true);
assert.equal(detection.details.hook.registered, true);
assert.equal(detection.details.hook.pluginHookRegistered, true);
assert.equal(detection.details.hook.globalHookRegistered, true);
assert.equal(detection.details.hook.mirroredHookExists, true);
assert.equal(detection.details.cliShim.exists, true);
assert.equal(detection.details.mcp.clean, true);
assert.ok(detection.details.rtk, "RTK >= 1.1.0 must be detected");

const { getRtkConfigPath } = await import("../scripts/provision-rtk.mjs");
const rtkCfgPath = getRtkConfigPath();
assert.ok(fs.existsSync(rtkCfgPath));
assert.match(fs.readFileSync(rtkCfgPath, "utf-8"), /suppress_hook_warning\s*=\s*true/);
console.log(`✓ detectExistingInstallation() verified all 2.0 layers + RTK (${detection.details.rtk.version})`);

// --- 3. Live CLI Shim & Plugin Hook Execution Verification ---
console.log("\n--- 3. Live CLI Shim & Plugin Hook Execution ---");
const shimName = process.platform === "win32" ? "agy-context.cmd" : "agy-context";
const installedShim = path.join(antigravityBinDir, shimName);
assert.ok(fs.existsSync(installedShim), `CLI shim must exist at ${installedShim}`);

const shimStatus = spawnSync(process.platform === "win32" ? "cmd.exe" : installedShim,
  process.platform === "win32" ? ["/c", installedShim, "status", "--json"] : ["status", "--json"],
  { encoding: "utf-8" }
);
assert.equal(shimStatus.status, 0, `CLI shim failed: ${shimStatus.stderr}`);
assert.equal(JSON.parse(shimStatus.stdout).isComplete, true);

const shimQuery = spawnSync(process.execPath, [cliScript, "transcript", "query", "--id", HERMETIC_CONV_ID, "--query", "streaming", "--summary"], {
  encoding: "utf-8"
});
assert.equal(shimQuery.status, 0);
assert.match(shimQuery.stdout, /Step 3/);

// Run hook from pluginDest (matching Antigravity's plugin hooks.json cwd contract!)
const hookPayload = JSON.stringify({
  toolCall: { name: "run_command", args: { CommandLine: "git status" } }
});
const shellCmd = process.platform === "win32" ? "cmd.exe" : "sh";
const shellArgs = process.platform === "win32" ? ["/c", hookCmd] : ["-c", hookCmd];
const hookRes = spawnSync(shellCmd, shellArgs, {
  cwd: pluginDest,
  input: hookPayload,
  encoding: "utf-8"
});
assert.equal(hookRes.status, 0, `Plugin hooks.json command failed in ${pluginDest}: ${hookRes.stderr}`);
const parsedHookOut = JSON.parse(hookRes.stdout.trim());
assert.equal(parsedHookOut.decision, "allow");
assert.equal(parsedHookOut.overwrite?.CommandLine, "rtk git status");
assert.equal(parsedHookOut.overwrite?.WaitMsBeforeAsync, 10000);
console.log("✓ Installed CLI shim and plugin hooks.json relative execution verified");

hermetic.cleanup();
console.log("\n=================================================");
console.log("ALL 2.0 INSTALLED SYSTEM VERIFICATION TESTS PASSED!");
console.log("=================================================");
