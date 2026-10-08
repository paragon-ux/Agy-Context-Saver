#!/usr/bin/env node

/**
 * Agy-Context-Saver Output Governance & Forensic Dereferencing Tests (Simplified Architecture)
 *
 * Verifies:
 * 1. Safe-Harbor rtk read on runtime step spillover files (.system_generated/steps/<step>/output.txt) (0 New Tools)
 * 2. Native view_file on spillover denies and routes to rtk read
 * 3. Lifecycle-gated rtk read on task logs (0 New Tools):
 *    - Denied with Proportional Backoff countdown while RUNNING
 *    - Allowed when TERMINATED
 * 4. Surgical single-step extraction folded into query_transcript(stepIndex, field) (0 New Tools)
 * 5. Pointer-Over-Wire (POW) contract in subagent_brief
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookScript = path.resolve(__dirname, "../scripts/execution-guard-hook.mjs");
const mcpServer = path.resolve(__dirname, "../mcp/index.js");

console.log("Running Agy-Context-Saver Output Inspection Governance Tests (Simplified Architecture)...\n");

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

// --- Group 1: Safe-Harbor rtk read for Runtime Spillover Files ---
console.log("\n--- Group 1: Safe-Harbor rtk read for Runtime Spillover Files ---");

// 1.1 view_file on runtime step spillover routes to rtk read
{
  const out = invokeHook({
    toolCall: {
      name: "view_file",
      args: { AbsolutePath: "C:/Users/USER/.gemini/antigravity/brain/session-123/.system_generated/steps/507/output.txt" }
    }
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /rtk read/);
  console.log("✓ view_file on step output spillover denies and routes to 'rtk read'");
}

// 1.2 run_command with rtk read on step spillover is ALLOWED
{
  const out = invokeHook({
    toolCall: {
      name: "run_command",
      args: { CommandLine: "rtk read .system_generated/steps/102/output.txt" }
    }
  });
  assert.equal(out.decision, "allow");
  console.log("✓ run_command with 'rtk read' on step output spillover is ALLOWED under safe harbor");
}

// 1.3 run_command shell access (cat) is rewritten to rtk read and ALLOWED
{
  const out = invokeHook({
    toolCall: {
      name: "run_command",
      args: { CommandLine: "cat .system_generated/steps/102/output.txt" }
    }
  });
  assert.equal(out.decision, "allow");
  assert.equal(out.overwrite?.CommandLine, "rtk read .system_generated/steps/102/output.txt");
  console.log("✓ run_command shell access (cat) is rewritten to 'rtk read' and ALLOWED");
}

// --- Group 2: Lifecycle-Gated Task Output Inspection ---
console.log("\n--- Group 2: Lifecycle-Gated Task Output Inspection ---");

const tempBrainDir = path.join(os.tmpdir(), `agy-test-brain-${Date.now()}`);
process.env.AGY_BRAIN_DIR = tempBrainDir;
const convLive = "conv-test-live";
const convDir = path.join(tempBrainDir, convLive, ".system_generated");
fs.mkdirSync(path.join(convDir, "logs"), { recursive: true });
fs.mkdirSync(path.join(convDir, "tasks"), { recursive: true });
const liveLog = path.join(convDir, "tasks", "task-live-1.log");
const transcriptFile = path.join(convDir, "logs", "transcript.jsonl");

// Reset session state for conv-test-live
try { fs.unlinkSync(path.join(os.tmpdir(), "agy-session-conv_test_live.json")); } catch {}

fs.writeFileSync(liveLog, "Running output in progress...\n", "utf-8");
fs.writeFileSync(
  transcriptFile,
  JSON.stringify({
    step_index: 1,
    type: "SYSTEM_MESSAGE",
    content: `Tool is running as a background task with task id: ${convLive}/task-live-1\nTask logs are available at: ${liveLog}`
  }) + "\n",
  "utf-8"
);

// 2.1 view_file on actively running task log is DENIED with Proportional Backoff
{
  const out = invokeHook({
    conversationId: convLive,
    toolCall: {
      name: "view_file",
      args: { AbsolutePath: liveLog.replace(/\\/g, "/") }
    }
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /actively RUNNING/);
  console.log("✓ view_file on actively running task log denies with Proportional Backoff");
}

// 2.2 run_command on actively running task log is DENIED with Proportional Backoff
{
  const out = invokeHook({
    conversationId: convLive,
    toolCall: {
      name: "run_command",
      args: { CommandLine: "rtk read tasks/task-live-1.log" }
    }
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /actively RUNNING/);
  console.log("✓ run_command on actively running task log denies with Proportional Backoff");
}

// 2.2b OBS-B Regression: task quiet for >15s without finish notice remains actively RUNNING
{
  const pastTime = (Date.now() - 30000) / 1000;
  fs.utimesSync(liveLog, pastTime, pastTime);
  const out = invokeHook({
    conversationId: convLive,
    toolCall: {
      name: "run_command",
      args: { CommandLine: "rtk read tasks/task-live-1.log" }
    }
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /actively RUNNING/);
  console.log("✓ OBS-B verified: task log quiet for >15s remains actively RUNNING if unfinished in transcript");
}

// 2.3 view_file on completed task log denies and routes to rtk read
{
  // Mark finished in transcript
  fs.appendFileSync(
    transcriptFile,
    JSON.stringify({
      step_index: 2,
      type: "SYSTEM_MESSAGE",
      content: `Task id "${convLive}/task-live-1" finished with result:\nAll tests passed.`
    }) + "\n",
    "utf-8"
  );

  const out = invokeHook({
    conversationId: convLive,
    toolCall: {
      name: "view_file",
      args: { AbsolutePath: liveLog.replace(/\\/g, "/") }
    }
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /rtk read/);
  console.log("✓ view_file on completed task log routes to 'rtk read'");
}

// 2.4 run_command with rtk read on completed task log is ALLOWED
{
  const out = invokeHook({
    conversationId: convLive,
    toolCall: {
      name: "run_command",
      args: { CommandLine: `rtk read tasks/task-live-1.log` }
    }
  });
  assert.equal(out.decision, "allow");
  console.log("✓ run_command with 'rtk read' on completed task log is ALLOWED");
}

// 2.5 Legacy task log >5m old without notices falls back to completed and is ALLOWED
{
  const legacyLog = path.join(convDir, "tasks", "task-legacy-99.log");
  fs.writeFileSync(legacyLog, "Old session output\n", "utf-8");
  const oldTime = (Date.now() - 360000) / 1000;
  fs.utimesSync(legacyLog, oldTime, oldTime);

  const out = invokeHook({
    conversationId: convLive,
    toolCall: {
      name: "run_command",
      args: { CommandLine: `rtk read tasks/task-legacy-99.log` }
    }
  });
  assert.equal(out.decision, "allow");
  console.log("✓ legacy task log >5m old without notices falls back to completed and is ALLOWED");

  try { fs.rmSync(tempBrainDir, { recursive: true, force: true }); } catch {}
}

// --- Group 3: Forensic Extraction Folded into query_transcript ---
console.log("\n--- Group 3: Forensic Extraction Folded into query_transcript ---");

// 3.1 Surgical field extraction via query_transcript(stepIndex, field)
{
  const resContent = await callMcp("tools/call", {
    name: "query_transcript",
    arguments: {
      conversationId: "fcda194f-62d6-46aa-b545-b2de8fa5774e",
      stepIndex: 1,
      field: "content"
    }
  });
  assert.equal(resContent.result.isError, undefined);
  assert.match(resContent.result.content[0].text, /Step 1 Content/);
  console.log("✓ query_transcript(stepIndex, field='content') surgically extracts content field");

  const resAll = await callMcp("tools/call", {
    name: "query_transcript",
    arguments: {
      conversationId: "fcda194f-62d6-46aa-b545-b2de8fa5774e",
      stepIndex: 1
    }
  });
  assert.equal(resAll.result.isError, undefined);
  assert.match(resAll.result.content[0].text, /Step 1/);
  console.log("✓ query_transcript(stepIndex) returns full un-truncated step formatted as Markdown");
}

// --- Group 4: Pointer-Over-Wire Contract in subagent_brief ---
console.log("\n--- Group 4: Pointer-Over-Wire Contract in subagent_brief ---");
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
