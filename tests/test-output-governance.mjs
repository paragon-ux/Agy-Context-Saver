import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpServer = path.resolve(__dirname, "../mcp/index.js");
const hookScript = path.resolve(__dirname, "../scripts/execution-guard-hook.mjs");

console.log("Running Agy-Context-Saver Output Inspection Governance Tests...\n");

// Helper to invoke hook script via stdin JSON
function invokeHook(payload) {
  const json = JSON.stringify(payload);
  const res = spawnSync(process.execPath, [hookScript], {
    input: json,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf-8"
  });
  assert.equal(res.status, 0, `Hook failed with status ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

// Spawn MCP server for JSON-RPC tests
const proc = spawn(process.execPath, [mcpServer], {
  stdio: ["pipe", "pipe", "inherit"]
});

const rl = readline.createInterface({ input: proc.stdout, terminal: false });

let reqId = 1;
const pending = new Map();

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id && pending.has(msg.id)) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
});

function callMcp(method, params = {}) {
  const id = reqId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

// 1. MCP Handshake
await callMcp("initialize", { protocolVersion: "2024-11-05" });
console.log("✓ MCP handshake established");

// --- Group 1: Hook Redirection for Runtime Output Files ---
console.log("\n--- Group 1: Hook Redirection for Runtime Spillover & Task Logs ---");

// 1.1 view_file on runtime step spillover
{
  const out = invokeHook({
    toolCall: {
      name: "view_file",
      args: { AbsolutePath: "C:/Users/USER/.gemini/antigravity/brain/session-123/.system_generated/steps/507/output.txt" }
    }
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /Direct access to internal Antigravity execution state \(\.system_generated\)/);
  assert.match(out.reason, /get_spillover_content\(uri="/);
  console.log("✓ view_file on step output spillover denies with get_spillover_content routing");
}

// 1.2 view_file on task log
{
  const out = invokeHook({
    toolCall: {
      name: "view_file",
      args: { AbsolutePath: "C:/Users/USER/.gemini/antigravity/brain/session-123/.system_generated/tasks/task-409.log" }
    }
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /Direct access to internal Antigravity execution state \(\.system_generated\)/);
  assert.match(out.reason, /read_task_output\(taskId="409"\)/);
  console.log("✓ view_file on task log denies with read_task_output routing");
}

// 1.3 run_command shell access to step spillover
{
  const out = invokeHook({
    toolCall: {
      name: "run_command",
      args: { CommandLine: "cat .system_generated/steps/102/output.txt" }
    }
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /Direct shell access to internal Antigravity execution state/);
  assert.match(out.reason, /get_spillover_content/);
  console.log("✓ run_command shell access to step output denies with get_spillover_content routing");
}

// 1.4 run_command shell access to task log
{
  const out = invokeHook({
    toolCall: {
      name: "run_command",
      args: { CommandLine: 'Get-Content ".system_generated/tasks/task-999.log"' }
    }
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /Direct shell access to internal Antigravity execution state/);
  assert.match(out.reason, /read_task_output\(taskId="999"\)/);
  console.log("✓ run_command shell access to task log denies with read_task_output routing");
}

// --- Group 2: MCP get_spillover_content Governance & Windowing ---
console.log("\n--- Group 2: MCP get_spillover_content Governance & Windowing ---");

// 2.1 Unauthorized file access denial
{
  const res = await callMcp("tools/call", {
    name: "get_spillover_content",
    arguments: { uri: "C:/Users/USER/.gemini/antigravity/brain/sess/transcript.jsonl" }
  });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /\[GOVERNANCE DENIAL\]/);
  console.log("✓ get_spillover_content strictly denies non-spillover paths");
}

// 2.2 Valid spillover file head windowing and regex filtering
{
  const testDir = path.resolve(__dirname, "../tmp_spillover_test/.system_generated/steps/101");
  fs.mkdirSync(testDir, { recursive: true });
  const testFile = path.join(testDir, "output.txt");

  const lines = [
    "Step init: started tool execution",
    "Debug: loading module A",
    "Result: 42 passed",
    "Warning: deprecated API used",
    "Step finish: tool complete"
  ];
  fs.writeFileSync(testFile, lines.join("\n") + "\n", "utf-8");

  // Head window
  const resHead = await callMcp("tools/call", {
    name: "get_spillover_content",
    arguments: { uri: testFile, lines: 2, tail: false }
  });
  assert.equal(resHead.result.isError, undefined);
  const headText = resHead.result.content[0].text;
  assert.match(headText, /Step init/);
  assert.match(headText, /Debug: loading module A/);
  assert.doesNotMatch(headText, /Step finish/);

  // Tail window
  const resTail = await callMcp("tools/call", {
    name: "get_spillover_content",
    arguments: { uri: testFile, lines: 2, tail: true }
  });
  assert.equal(resTail.result.isError, undefined);
  const tailText = resTail.result.content[0].text;
  assert.match(tailText, /Warning: deprecated API/);
  assert.match(tailText, /Step finish/);

  // Regex filtering
  const resFilter = await callMcp("tools/call", {
    name: "get_spillover_content",
    arguments: { uri: testFile, filterRegex: "Result:" }
  });
  assert.equal(resFilter.result.isError, undefined);
  const filterText = resFilter.result.content[0].text;
  assert.match(filterText, /Result: 42 passed/);
  assert.doesNotMatch(filterText, /Debug: loading module A/);

  // Clean up
  try { fs.rmSync(path.resolve(__dirname, "../tmp_spillover_test"), { recursive: true, force: true }); } catch {}
  console.log("✓ get_spillover_content correctly windows head/tail and applies regex filtering");
}

// --- Group 3: MCP read_task_output Lifecycle Gating ---
console.log("\n--- Group 3: MCP read_task_output Lifecycle Gating ---");

// 3.1 Missing task returns clean error
{
  const res = await callMcp("tools/call", {
    name: "read_task_output",
    arguments: { taskId: "task-unknown-5555" }
  });
  assert.equal(res.result.isError, true);
  console.log("✓ read_task_output handles missing task IDs safely");
}

// --- Group 4: MCP get_step_detail Forensic Extraction ---
console.log("\n--- Group 4: MCP get_step_detail Forensic Extraction ---");

// 4.1 Surgical field extraction
{
  const resContent = await callMcp("tools/call", {
    name: "get_step_detail",
    arguments: {
      conversationId: "fcda194f-62d6-46aa-b545-b2de8fa5774e",
      stepIndex: 1,
      field: "content"
    }
  });
  assert.equal(resContent.result.isError, undefined);
  assert.match(resContent.result.content[0].text, /Step 1 Content/);
  console.log("✓ get_step_detail extracts specific content field");

  const resAll = await callMcp("tools/call", {
    name: "get_step_detail",
    arguments: {
      conversationId: "fcda194f-62d6-46aa-b545-b2de8fa5774e",
      stepIndex: 1
    }
  });
  assert.equal(resAll.result.isError, undefined);
  assert.match(resAll.result.content[0].text, /Step 1/);
  console.log("✓ get_step_detail returns full step formatted as Markdown");
}

// --- Group 5: Pointer-Over-Wire Contract in subagent_brief ---
console.log("\n--- Group 5: Pointer-Over-Wire Contract in subagent_brief ---");
{
  const res = await callMcp("tools/call", {
    name: "subagent_brief",
    arguments: { objective: "Audit compiler performance" }
  });
  const text = res.result.content[0].text;
  assert.match(text, /POINTER-OVER-WIRE/);
  assert.match(text, /transmit ONLY:\n\s+- Executive Summary/);
  assert.match(text, /Clickable File Link/);
  console.log("✓ subagent_brief enforces Pointer-Over-Wire delivery contract");
}

proc.kill();
console.log("\n=================================================");
console.log("ALL OUTPUT GOVERNANCE & FORENSIC TESTS PASSED 100%!");
console.log("=================================================");
process.exit(0);
