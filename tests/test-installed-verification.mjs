import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
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

// --- 1. Verify Configuration Registrations ---
console.log("--- 1. Configuration Registration Verification ---");

assert.ok(fs.existsSync(hooksJsonPath), `hooks.json not found at ${hooksJsonPath}`);
const hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
assert.ok(hooksConfig["execution-guard"], "execution-guard must be registered in hooks.json");
assert.ok(hooksConfig["waymark-continuity"], "waymark-continuity must be preserved in hooks.json");
console.log("✓ hooks.json contains execution-guard and preserved waymark-continuity");

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
assert.ok(fs.existsSync(path.join(installedSchemasDir, "safe_command.json")), "safe_command.json exists in Antigravity MCP directory");
assert.ok(fs.existsSync(path.join(installedSchemasDir, "check_context_health.json")), "check_context_health.json exists in Antigravity MCP directory");
assert.ok(fs.existsSync(path.join(installedSchemasDir, "subagent_brief.json")), "subagent_brief.json exists in Antigravity MCP directory");
assert.ok(fs.existsSync(path.join(installedSchemasDir, "get_installation_status.json")), "get_installation_status.json exists in Antigravity MCP directory");
assert.ok(fs.existsSync(path.join(installedSchemasDir, "sync_installation.json")), "sync_installation.json exists in Antigravity MCP directory");
assert.ok(fs.existsSync(path.join(installedSchemasDir, "read_transcript.json")), "read_transcript.json exists in Antigravity MCP directory");
assert.ok(fs.existsSync(path.join(installedSchemasDir, "query_transcript.json")), "query_transcript.json exists in Antigravity MCP directory");
console.log("✓ All 7 Antigravity tool schemas successfully installed to ~/.gemini/antigravity/mcp/agy-context-saver");

// Test existing installation detector
const { detectExistingInstallation } = await import("../scripts/install-register.mjs");
const detection = detectExistingInstallation();
assert.equal(detection.isInstalled, true, "detectExistingInstallation must report isInstalled: true");
assert.equal(detection.isComplete, true, "detectExistingInstallation must report isComplete: true");
assert.equal(detection.details.plugin.exists, true, "plugin link must be detected");
assert.equal(detection.details.hook.registered, true, "hook registration must be detected");
assert.equal(detection.details.mcp.registered, true, "mcp registration must be detected");
assert.equal(detection.details.schemas.exists, true, "schemas must be detected");
console.log("✓ detectExistingInstallation() accurately verifies all 4 installation layers");

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

// 2.1 Initial status check: ALLOWED (safe harbor for inspecting potentially hung tasks)
{
  const res = callInstalledHook({
    conversationId: "installed-conv-1",
    toolCall: { name: "manage_task", args: { Action: "status", TaskId: "task-live-1" } }
  });
  assert.equal(res.decision, "allow");
  console.log("✓ Installed Hook: Initial manage_task(status) -> ALLOWED (debugging safe harbor)");
}

// 2.2 Rapid consecutive status check: DENIED (blocks compulsive busy-wait loops)
{
  const res = callInstalledHook({
    conversationId: "installed-conv-1",
    toolCall: { name: "manage_task", args: { Action: "status", TaskId: "task-live-1" } }
  });
  assert.equal(res.decision, "deny");
  assert.match(res.reason, /Rapid task polling detected/);
  console.log("✓ Installed Hook: Rapid consecutive manage_task(status) -> DENIED");
}

// 2.3 Debugging stuck task: ALLOWED (safe harbor)
{
  const res = callInstalledHook({
    conversationId: "installed-conv-1",
    toolCall: { name: "manage_task", args: { Action: "status", TaskId: "task-live-1", Reason: "debugging stuck background task" } }
  });
  assert.equal(res.decision, "allow");
  console.log("✓ Installed Hook: Debugging manage_task(status) -> ALLOWED");
}

// 2.4 Teamwork / subagent spawn: ALLOWED (safe harbor)
{
  const res = callInstalledHook({
    conversationId: "teamwork-session-123",
    toolCall: { name: "manage_task", args: { Action: "status", TaskId: "task-teamwork" } }
  });
  assert.equal(res.decision, "allow");
  console.log("✓ Installed Hook: /teamwork-preview manage_task(status) -> ALLOWED");
}

// 2.5 Task kill allowance
{
  const res = callInstalledHook({
    toolCall: { name: "manage_task", args: { Action: "kill", TaskId: "task-99" } }
  });
  assert.equal(res.decision, "allow");
  console.log("✓ Installed Hook: manage_task(Action='kill') -> ALLOWED");
}

// 2.6 Synchronous wait upgrade
{
  const res = callInstalledHook({
    toolCall: { name: "run_command", args: { CommandLine: "npm run build", WaitMsBeforeAsync: 3000 } }
  });
  assert.equal(res.decision, "allow");
  assert.equal(res.overwrite?.WaitMsBeforeAsync, 10000);
  console.log("✓ Installed Hook: run_command WaitMsBeforeAsync upgraded to 10000ms");
}

// 2.4 Daemon run preservation
{
  const res = callInstalledHook({
    toolCall: { name: "run_command", args: { CommandLine: "node server.js", IsDaemon: true, WaitMsBeforeAsync: 500 } }
  });
  assert.equal(res.decision, "allow");
  assert.equal(res.overwrite, undefined);
  console.log("✓ Installed Hook: run_command with IsDaemon:true preserves wait window");
}

// 2.7 Schedule task polling denial (< 120s)
{
  const res = callInstalledHook({
    toolCall: { name: "schedule", args: { DurationSeconds: 30, Prompt: "Check on background task-99" } }
  });
  assert.equal(res.decision, "deny");
  assert.match(res.reason, /polling timer/);
  console.log("✓ Installed Hook: schedule short background task polling -> DENIED");
}

// 2.8 Schedule watchdog timer allowance (>= 120s)
{
  const res = callInstalledHook({
    toolCall: { name: "schedule", args: { DurationSeconds: 300, Prompt: "Watchdog timer for background task-99", TimerCondition: "task-99" } }
  });
  assert.equal(res.decision, "allow");
  console.log("✓ Installed Hook: schedule watchdog timer (>= 120s) -> ALLOWED (debugging safe harbor)");
}

// 2.9 Schedule teamwork context allowance
{
  const res = callInstalledHook({
    toolCall: { name: "schedule", args: { DurationSeconds: 30, Prompt: "teamwork check on subagents" } }
  });
  assert.equal(res.decision, "allow");
  console.log("✓ Installed Hook: schedule with teamwork context -> ALLOWED");
}

// 2.10 Schedule regular timer allowance
{
  const res = callInstalledHook({
    toolCall: { name: "schedule", args: { DurationSeconds: 600, Prompt: "Remind user about deployment status" } }
  });
  assert.equal(res.decision, "allow");
  console.log("✓ Installed Hook: schedule user timer -> ALLOWED");
}

// 2.11 Intercept view_file on transcript.jsonl
{
  const res = callInstalledHook({
    toolCall: {
      name: "view_file",
      args: { AbsolutePath: "C:/Users/USER/.gemini/antigravity/brain/42aea43d-ea8b-48f8-bbf5-eef4e6242956/.system_generated/logs/transcript.jsonl" }
    }
  });
  assert.equal(res.decision, "deny");
  assert.match(res.reason, /read_transcript\(conversationId="42aea43d-ea8b-48f8-bbf5-eef4e6242956", mode="compact"\)/);
  console.log("✓ Installed Hook: view_file on transcript.jsonl -> DENIED with redirection to read_transcript");
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
  assert.equal(res.result.serverInfo.version, "1.0.0");
  console.log("✓ Installed MCP Server: Handshake succeeded (name: agy-context-saver, v1.0.0)");
}

// 3.2 Tools List
{
  const res = await sendRpc("tools/list");
  const toolNames = res.result.tools.map(t => t.name);
  assert.ok(toolNames.includes("safe_command"));
  assert.ok(toolNames.includes("check_context_health"));
  assert.ok(toolNames.includes("subagent_brief"));
  assert.ok(toolNames.includes("get_installation_status"));
  assert.ok(toolNames.includes("sync_installation"));
  assert.ok(toolNames.includes("read_transcript"));
  assert.ok(toolNames.includes("query_transcript"));
  assert.equal(toolNames.length, 7);
  console.log("✓ Installed MCP Server: tools/list verified [all 7 tools present]");
}

// 3.3 Installation Status Tool Call
{
  const res = await sendRpc("tools/call", { name: "get_installation_status" });
  assert.match(res.result.content[0].text, /Installation Status: HEALTHY & ACTIVE/);
  console.log("✓ Installed MCP Server: get_installation_status reported healthy status");
}

// 3.4 Safe Command Tool Call
{
  const res = await sendRpc("tools/call", {
    name: "safe_command",
    arguments: { command: "node -e \"console.log('mcp-live-test-success')\"" }
  });
  assert.equal(res.result.isError, false);
  assert.match(res.result.content[0].text, /mcp-live-test-success/);
  assert.match(res.result.content[0].text, /STATUS: PASSED \(exit 0\)/);
  console.log("✓ Installed MCP Server: safe_command executed successfully with compressed status");
}

// 3.4 Resources Read
{
  const res = await sendRpc("resources/read", { uri: "context-saver://rules/governance" });
  assert.ok(res.result.contents[0].text.length > 500);
  console.log("✓ Installed MCP Server: resources/read served governance markdown rules");
}

// 3.5 Prompts Get
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
