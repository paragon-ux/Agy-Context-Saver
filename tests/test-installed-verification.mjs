import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

console.log("=================================================");
console.log("Agy-Context-Saver Live Installed System Validation");
console.log("=================================================\n");

const homeDir = process.env.USERPROFILE || process.env.HOME;
const geminiConfigDir = path.join(homeDir, ".gemini", "config");
const hooksJsonPath = path.join(geminiConfigDir, "hooks.json");
const mcpJsonPath = path.join(geminiConfigDir, "mcp_config.json");
const installedHookScript = path.join(geminiConfigDir, "scripts", "execution-guard-hook.mjs");
const installedSchemasDir = path.join(homeDir, ".gemini", "antigravity", "mcp", "agy-context-saver");
const stateFile = path.join(os.tmpdir(), "agy-session-governance-state.json");
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

// Clean test state
try {
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
} catch {}

// --- 1. Verify Configuration Registrations ---
console.log("--- 1. Configuration Registration Verification ---");

assert.ok(fs.existsSync(hooksJsonPath), `hooks.json not found at ${hooksJsonPath}`);
const hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
assert.ok(hooksConfig["execution-guard"], "execution-guard must be registered in hooks.json");
assert.ok(hooksConfig["waymark-continuity"], "waymark-continuity must be preserved in hooks.json");
const hookMatcher = hooksConfig["execution-guard"].PreToolUse[0].matcher;
assert.ok(hookMatcher.includes("manage_task"), "matcher includes manage_task");
assert.ok(hookMatcher.includes("run_command"), "matcher includes run_command");
assert.ok(hookMatcher.includes("view_file"), "matcher includes view_file");
assert.ok(hookMatcher.includes("grep_search"), "matcher includes grep_search");
assert.ok(hookMatcher.includes("find_by_name"), "matcher includes find_by_name");
assert.ok(hookMatcher.includes("list_dir"), "matcher includes list_dir");
console.log(`✓ hooks.json contains execution-guard with closed-topology matcher: "${hookMatcher}"`);

const hooksBakPath = path.join(geminiConfigDir, "hooks.json.bak");
assert.ok(fs.existsSync(hooksBakPath), `hooks.json.bak not found at ${hooksBakPath}`);
console.log("✓ hooks.json.bak configuration backup verified");

assert.ok(fs.existsSync(mcpJsonPath), `mcp_config.json not found at ${mcpJsonPath}`);
const mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
assert.ok(mcpConfig.mcpServers?.["agy-context-saver"], "agy-context-saver must be registered in mcpServers");
assert.ok(mcpConfig.mcpServers?.["waymark-engine"], "waymark-engine must be preserved in mcpServers");
console.log("✓ mcp_config.json contains agy-context-saver and preserved waymark-engine");

const mcpBakPath = path.join(geminiConfigDir, "mcp_config.json.bak");
assert.ok(fs.existsSync(mcpBakPath), `mcp_config.json.bak not found at ${mcpBakPath}`);
console.log("✓ mcp_config.json.bak configuration backup verified");

assert.ok(fs.existsSync(installedSchemasDir), `Antigravity MCP schemas dir not found at ${installedSchemasDir}`);
assert.equal(fs.existsSync(path.join(installedSchemasDir, "safe_command.json")), false, "safe_command.json must NOT exist in MCP dir");
assert.ok(fs.existsSync(path.join(installedSchemasDir, "check_context_health.json")), "check_context_health.json exists");
assert.ok(fs.existsSync(path.join(installedSchemasDir, "subagent_brief.json")), "subagent_brief.json exists");
assert.ok(fs.existsSync(path.join(installedSchemasDir, "get_installation_status.json")), "get_installation_status.json exists");
assert.ok(fs.existsSync(path.join(installedSchemasDir, "sync_installation.json")), "sync_installation.json exists");
assert.ok(fs.existsSync(path.join(installedSchemasDir, "read_transcript.json")), "read_transcript.json exists");
assert.ok(fs.existsSync(path.join(installedSchemasDir, "query_transcript.json")), "query_transcript.json exists");
console.log("✓ Exactly 6 Antigravity tool schemas installed (safe_command permanently removed)");

// Test existing installation detector
const { detectExistingInstallation } = await import("../scripts/install-register.mjs");
const detection = detectExistingInstallation();
assert.equal(detection.isInstalled, true, "detectExistingInstallation must report isInstalled: true");
assert.equal(detection.isComplete, true, "detectExistingInstallation must report isComplete: true");
assert.equal(detection.details.plugin.exists, true, "plugin link must be detected");
assert.equal(detection.details.hook.registered, true, "hook registration must be detected");
assert.equal(detection.details.mcp.registered, true, "mcp registration must be detected");
assert.equal(detection.details.schemas.exists, true, "schemas must be detected");
assert.ok(detection.details.rtk, "RTK must be detected");
console.log(`✓ detectExistingInstallation() verified 4 layers + RTK (${detection.details.rtk.version})`);

// --- 2. Live Hook Execution Test (via cmd.exe /c as executed by Antigravity) ---
console.log("\n--- 2. Live Hook Execution Verification (cmd.exe /c wrapper) ---");

function callInstalledHook(payload) {
  const res = spawnSync("cmd.exe", ["/c", "node", installedHookScript], {
    input: JSON.stringify(payload),
    encoding: "utf-8"
  });
  assert.equal(res.status, 0, `Hook process exited with code ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

// 2.1 Initial status check: ALLOWED
{
  const res = callInstalledHook({
    conversationId: "installed-conv-1",
    toolCall: { name: "manage_task", args: { Action: "status", TaskId: "task-live-1" } }
  });
  assert.equal(res.decision, "allow");
  console.log("✓ Installed Hook: Initial manage_task(status) -> ALLOWED");
}

// 2.2 Rapid consecutive status check: DENIED under Proportional Backoff
{
  const res = callInstalledHook({
    conversationId: "installed-conv-1",
    toolCall: { name: "manage_task", args: { Action: "status", TaskId: "task-live-1" } }
  });
  assert.equal(res.decision, "deny");
  assert.match(res.reason, /Proportional Backoff Active/);
  console.log("✓ Installed Hook: Subsequent manage_task(status) -> DENIED (Proportional Backoff)");
}

// 2.3 Task kill allowance
{
  const res = callInstalledHook({
    toolCall: { name: "manage_task", args: { Action: "kill", TaskId: "task-99" } }
  });
  assert.equal(res.decision, "allow");
  console.log("✓ Installed Hook: manage_task(Action='kill') -> ALLOWED");
}

// 2.4 Synchronous wait upgrade & RTK rewrite
{
  const res = callInstalledHook({
    toolCall: { name: "run_command", args: { CommandLine: "git status", WaitMsBeforeAsync: 3000 } }
  });
  assert.equal(res.decision, "allow");
  assert.equal(res.overwrite?.CommandLine, "rtk git status");
  assert.equal(res.overwrite?.WaitMsBeforeAsync, 10000);
  console.log("✓ Installed Hook: run_command('git status') rewritten to 'rtk git status' & wait 10000ms");
}

// 2.4b Shell wrapper unwrapping (cmd /c, powershell -Command)
{
  const resCmd = callInstalledHook({
    toolCall: { name: "run_command", args: { CommandLine: 'cmd /c "git status"', WaitMsBeforeAsync: 3000 } }
  });
  assert.equal(resCmd.decision, "allow");
  assert.equal(resCmd.overwrite?.CommandLine, 'cmd /c "rtk git status"');

  const resPs = callInstalledHook({
    toolCall: { name: "run_command", args: { CommandLine: 'powershell -Command "git status"', WaitMsBeforeAsync: 3000 } }
  });
  assert.equal(resPs.decision, "allow");
  assert.equal(resPs.overwrite?.CommandLine, 'powershell -Command "rtk git status"');
  console.log("✓ Installed Hook: shell wrappers (cmd /c, powershell -Command) unwrapped for RTK (LH-01-B closed)");
}

// 2.4c Native pytest rewriting (opt-in fail-fast) (LH-11)
{
  const res = callInstalledHook({
    toolCall: { name: "run_command", args: { CommandLine: "pytest", WaitMsBeforeAsync: 3000 } }
  });
  assert.equal(res.decision, "allow");
  assert.equal(res.overwrite?.CommandLine, "rtk pytest");
  console.log("✓ Installed Hook: pytest rewrites to rtk pytest with native semantics (LH-11)");
}

// 2.5 Daemon run preservation
{
  const res = callInstalledHook({
    toolCall: { name: "run_command", args: { CommandLine: "node server.js", IsDaemon: true, WaitMsBeforeAsync: 500 } }
  });
  assert.equal(res.decision, "allow");
  assert.equal(res.overwrite, undefined);
  console.log("✓ Installed Hook: run_command with IsDaemon:true preserves wait window");
}

// 2.6 Schedule task polling denial (< 30s)
{
  const res = callInstalledHook({
    conversationId: "installed-conv-1",
    toolCall: { name: "schedule", args: { DurationSeconds: 15, Prompt: "Check on background task-99", TimerCondition: "task-99" } }
  });
  assert.equal(res.decision, "deny");
  assert.match(res.reason, /Task watchdog timer duration too short/);
  console.log("✓ Installed Hook: schedule task polling (< 30s) -> DENIED (no watchdog loophole)");
}

// 2.6b Schedule watchdog timer meeting backoff (>= 30s): ALLOWED
{
  const res = callInstalledHook({
    conversationId: "installed-conv-watchdog",
    toolCall: { name: "schedule", args: { DurationSeconds: 60, Prompt: "Check on background task-99", TimerCondition: "task-99" } }
  });
  assert.equal(res.decision, "allow");
  console.log("✓ Installed Hook: schedule watchdog timer (60s >= 30s backoff) -> ALLOWED");
}

// 2.7 Schedule user timer allowance
{
  const res = callInstalledHook({
    toolCall: { name: "schedule", args: { DurationSeconds: 600, Prompt: "Remind user about deployment status", TimerCondition: "never" } }
  });
  assert.equal(res.decision, "allow");
  console.log("✓ Installed Hook: schedule user reminder -> ALLOWED");
}

// 2.8 Native inspection routing: view_file on workspace file -> RTK read
{
  const res = callInstalledHook({
    toolCall: { name: "view_file", args: { AbsolutePath: "c:/project/src/index.js" } }
  });
  assert.equal(res.decision, "deny");
  assert.match(res.reason, /rtk read/);
  console.log("✓ Installed Hook: view_file on workspace file -> DENIED & routed to 'rtk read'");
}

// 2.9 Protected internal state: view_file on transcript.jsonl
{
  const res = callInstalledHook({
    toolCall: {
      name: "view_file",
      args: { AbsolutePath: "C:/Users/USER/.gemini/antigravity/brain/42aea43d-ea8b-48f8-bbf5-eef4e6242956/.system_generated/logs/transcript.jsonl" }
    }
  });
  assert.equal(res.decision, "deny");
  assert.match(res.reason, /Direct access to internal Antigravity execution state \(\.system_generated\)/);
  console.log("✓ Installed Hook: view_file on .system_generated -> STRICTLY DENIED by root");
}

// 2.9 Direct shell access to .system_generated denied
{
  const resCat = callInstalledHook({
    toolCall: { name: "run_command", args: { CommandLine: "cat .system_generated/logs/transcript.jsonl" } }
  });
  assert.equal(resCat.decision, "deny");
  assert.match(resCat.reason, /Direct shell access to internal Antigravity execution state/);
  console.log("✓ Installed Hook: direct shell access to .system_generated -> DENIED (LH-02-B closed)");
}

// --- 3. Live Installed MCP Server Verification ---
console.log("\n--- 3. Live Installed MCP Server Protocol Verification ---");

const mcpServerConfig = mcpConfig.mcpServers["agy-context-saver"];
const mcpProc = spawn(mcpServerConfig.command, mcpServerConfig.args, {
  stdio: ["pipe", "pipe", "inherit"]
});

const rl = readline.createInterface({ input: mcpProc.stdout, terminal: false });
let reqId = 1;
const pending = new Map();

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id && pending.has(msg.id)) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
});

function sendRpc(method, params = {}) {
  const id = reqId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    mcpProc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

// 3.1 Initialize
{
  const res = await sendRpc("initialize", { protocolVersion: "2024-11-05" });
  assert.equal(res.result.serverInfo.name, "agy-context-saver");
  assert.equal(res.result.serverInfo.version, pkg.version);
  console.log(`✓ Installed MCP Server: Handshake succeeded (name: agy-context-saver, v${pkg.version})`);
}

// 3.2 Tools List (6 tools)
{
  const res = await sendRpc("tools/list");
  const toolNames = res.result.tools.map(t => t.name);
  assert.equal(toolNames.includes("safe_command"), false);
  assert.ok(toolNames.includes("check_context_health"));
  assert.ok(toolNames.includes("subagent_brief"));
  assert.ok(toolNames.includes("get_installation_status"));
  assert.ok(toolNames.includes("sync_installation"));
  assert.ok(toolNames.includes("read_transcript"));
  assert.ok(toolNames.includes("query_transcript"));
  assert.equal(toolNames.length, 6);
  console.log("✓ Installed MCP Server: tools/list verified [all 6 tools present, safe_command retired]");
}

// 3.3 Installation Status Tool Call
{
  const res = await sendRpc("tools/call", { name: "get_installation_status" });
  assert.match(res.result.content[0].text, /Installation Status: HEALTHY & ACTIVE/);
  assert.match(res.result.content[0].text, /ALL 6 SCHEMAS PRESENT/);
  assert.match(res.result.content[0].text, /RTK Binary: INSTALLED/);
  console.log("✓ Installed MCP Server: get_installation_status reported healthy status + RTK");
}

// 3.4 Safe Command is rejected
{
  const res = await sendRpc("tools/call", {
    name: "safe_command",
    arguments: { command: "echo test" }
  });
  assert.ok(res.error);
  assert.equal(res.error.code, -32601);
  console.log("✓ Installed MCP Server: safe_command correctly rejected (-32601 tool not found)");
}

// 3.5 Resources Read
{
  const res = await sendRpc("resources/read", { uri: "context-saver://rules/governance" });
  assert.ok(res.result.contents[0].text.length > 500);
  console.log("✓ Installed MCP Server: resources/read served governance markdown rules");
}

// 3.6 Prompts Get
{
  const res = await sendRpc("prompts/get", { name: "context_shield" });
  assert.ok(res.result.messages[0].content.text.includes("Antigravity Context Governance"));
  console.log("✓ Installed MCP Server: prompts/get served context_shield prompt");
}

mcpProc.kill();

console.log("\n=================================================");
console.log("ALL LIVE INSTALLED SYSTEM VALIDATIONS PASSED 100%!");
console.log("=================================================\n");
process.exit(0);
