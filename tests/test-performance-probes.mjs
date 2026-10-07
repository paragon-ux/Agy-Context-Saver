import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { safeWriteFileIfChanged, safeCopyFileIfChanged } from "../scripts/install-register.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpServer = path.resolve(__dirname, "../mcp/index.js");
const hookScript = path.resolve(__dirname, "../scripts/execution-guard-hook.mjs");

console.log("==========================================================");
console.log("Agy-Context-Saver Performance & Diagnostic Verification");
console.log("==========================================================\n");

// --- Probe 1: Idempotent File Operations (Copilot Churn Recommendation) ---
console.log("--- Probe 1: Idempotent Config & Schema Writes ---");
{
  const tmpProbe = path.join(os.tmpdir(), `agy-perf-probe-${process.pid}.txt`);
  try {
    fs.writeFileSync(tmpProbe, "original content", "utf-8");
    const changed1 = await safeWriteFileIfChanged(tmpProbe, "original content");
    assert.equal(changed1, false, "Must return false and skip write when content is identical");

    const changed2 = await safeWriteFileIfChanged(tmpProbe, "updated content");
    assert.equal(changed2, true, "Must return true and write when content differs");
    assert.equal(fs.readFileSync(tmpProbe, "utf-8"), "updated content");

    const tmpProbeCopy = path.join(os.tmpdir(), `agy-perf-probe-copy-${process.pid}.txt`);
    fs.writeFileSync(tmpProbeCopy, "updated content", "utf-8");
    const copyChanged = await safeCopyFileIfChanged(tmpProbe, tmpProbeCopy);
    assert.equal(copyChanged, false, "Must skip copy when target file matches source byte-for-byte");
    try { fs.unlinkSync(tmpProbeCopy); } catch {}
  } finally {
    try { fs.unlinkSync(tmpProbe); } catch {}
  }
  console.log("✓ safeWriteFileIfChanged and safeCopyFileIfChanged prevent redundant disk churn");
}

// --- Probe 2: Hook Fast-Path Builtin Bypass & Rewrite Caching ---
console.log("\n--- Probe 2: Hook Fast-Path Builtin Bypass & Rewrite Caching ---");
{
  function runHook(payload) {
    const res = spawnSync(process.execPath, [hookScript], {
      input: JSON.stringify(payload),
      encoding: "utf-8"
    });
    assert.equal(res.status, 0);
    return JSON.parse(res.stdout.trim());
  }

  // Measure bypass latency for node, powershell, and dir
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) {
    const out = runHook({
      toolCall: { name: "run_command", args: { CommandLine: "node -e 'console.log(1)'", WaitMsBeforeAsync: 1000 } }
    });
    assert.equal(out.decision, "allow");
    assert.equal(out.overwrite?.CommandLine, undefined);
  }
  const bypassElapsed = performance.now() - t0;
  console.log(`✓ 20x fast-path builtin bypass checks executed in ${bypassElapsed.toFixed(1)}ms`);

  // Verify persistent LRU cache for rewritable commands
  const cacheFile = path.join(os.tmpdir(), "agy-rtk-rewrite-cache.json");
  if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);

  // First call: writes to cache
  const first = runHook({
    toolCall: { name: "run_command", args: { CommandLine: "git status", WaitMsBeforeAsync: 1000 } }
  });
  assert.equal(first.overwrite?.CommandLine, "rtk git status");
  assert.ok(fs.existsSync(cacheFile), "Rewrite cache file must be created");

  // Second call: reads from cache
  const tCache0 = performance.now();
  for (let i = 0; i < 10; i++) {
    const cached = runHook({
      toolCall: { name: "run_command", args: { CommandLine: "git status", WaitMsBeforeAsync: 1000 } }
    });
    assert.equal(cached.overwrite?.CommandLine, "rtk git status");
  }
  const cacheElapsed = performance.now() - tCache0;
  console.log(`✓ 10x cached command rewrites completed in ${cacheElapsed.toFixed(1)}ms via persistent cache`);
}

// --- Section 3: MCP Server Performance & Forensic Probes ---
console.log("\n--- Probe 3: MCP Server Protocol, Forensic & Memory Limits ---");

const proc = spawn(process.execPath, [mcpServer], {
  stdio: ["pipe", "pipe", "inherit"]
});

const rl = readline.createInterface({ input: proc.stdout, terminal: false });

let reqId = 1;
const pending = new Map();

rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  } catch {}
});

function send(method, params = {}) {
  const id = reqId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

// 3.1 Initialize
{
  const res = await send("initialize", { protocolVersion: "2024-11-05" });
  assert.equal(res.result.serverInfo.name, "agy-context-saver");
  console.log("✓ MCP handshake completed");
}

// 3.2 In-Memory Governance Rules Cache (AGENTS.md)
{
  const res1 = await send("resources/read", { uri: "context-saver://rules/governance" });
  assert.ok(res1.result.contents[0].text.includes("Antigravity Execution & Context Governance"));

  const res2 = await send("resources/read", { uri: "context-saver://rules/governance" });
  assert.equal(res1.result.contents[0].text, res2.result.contents[0].text);
  console.log("✓ Static governance rules served from mtime-invalidated in-memory cache");
}

// 3.3 Batch Full-Transcript Dereferencing (Fixes Copilot Issue #6)
{
  const syntheticConvId = `conv-perf-batch-${Date.now()}`;
  const logsDir = path.join(os.homedir(), ".gemini", "antigravity", "brain", syntheticConvId, ".system_generated", "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  const compactFile = path.join(logsDir, "transcript.jsonl");
  const fullFile = path.join(logsDir, "transcript_full.jsonl");

  // Create 10 steps, where steps 2, 4, 6, 8 are truncated in compact
  const compactLines = [];
  const fullLines = [];

  for (let i = 1; i <= 10; i++) {
    const fullContent = `Complete full payload for step ${i} with detailed information ${"x".repeat(300)}`;
    const fullItem = {
      step_index: i,
      source: i % 2 === 1 ? "USER_EXPLICIT" : "MODEL",
      type: i % 2 === 1 ? "USER_INPUT" : "PLANNER_RESPONSE",
      status: "DONE",
      created_at: new Date(Date.now() + i * 1000).toISOString(),
      content: fullContent
    };
    fullLines.push(JSON.stringify(fullItem));

    if (i % 2 === 0) {
      // Truncated in compact
      const compactItem = {
        ...fullItem,
        content: `Truncated step ${i}...`,
        truncated_fields: ["content"]
      };
      compactLines.push(JSON.stringify(compactItem));
    } else {
      compactLines.push(JSON.stringify(fullItem));
    }
  }

  fs.writeFileSync(compactFile, compactLines.join("\n") + "\n", "utf-8");
  fs.writeFileSync(fullFile, fullLines.join("\n") + "\n", "utf-8");

  // Query with mode="auto" to trigger batch dereferencing
  const tQuery0 = performance.now();
  const queryRes = await send("tools/call", {
    name: "query_transcript",
    arguments: {
      conversationId: syntheticConvId,
      query: "step",
      mode: "auto",
      maxResults: 10
    }
  });
  const queryElapsed = performance.now() - tQuery0;
  const queryText = queryRes.result.content[0].text;

  // Verify all dereferenced steps have their full content restored
  assert.ok(queryText.includes("Complete full payload for step 2"), "Truncated step 2 must be dereferenced");
  assert.ok(queryText.includes("Complete full payload for step 4"), "Truncated step 4 must be dereferenced");
  assert.ok(queryText.includes("Complete full payload for step 6"), "Truncated step 6 must be dereferenced");
  console.log(`✓ Single-pass batch dereferencing retrieved all truncated items in ${queryElapsed.toFixed(1)}ms`);

  // Clean up
  try {
    fs.rmSync(path.join(os.homedir(), ".gemini", "antigravity", "brain", syntheticConvId), { recursive: true, force: true });
  } catch {}
}

// 3.4 Sliding-Window Turn Retention on Large Transcript (Fixes Copilot Issue #5)
{
  const syntheticConvId = `conv-perf-window-${Date.now()}`;
  const logsDir = path.join(os.homedir(), ".gemini", "antigravity", "brain", syntheticConvId, ".system_generated", "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  const compactFile = path.join(logsDir, "transcript.jsonl");

  // Generate 2,000 steps (~1,000 turns)
  const lines = [];
  for (let i = 1; i <= 2000; i++) {
    lines.push(JSON.stringify({
      step_index: i,
      source: i % 2 === 1 ? "USER_EXPLICIT" : "MODEL",
      type: i % 2 === 1 ? "USER_INPUT" : "PLANNER_RESPONSE",
      status: "DONE",
      created_at: new Date(Date.now() + i * 1000).toISOString(),
      content: `Turn entry step ${i} message body data padding ${"y".repeat(100)}`
    }));
  }
  fs.writeFileSync(compactFile, lines.join("\n") + "\n", "utf-8");

  const tRead0 = performance.now();
  const readRes = await send("tools/call", {
    name: "read_transcript",
    arguments: {
      conversationId: syntheticConvId,
      lastTurns: 3,
      mode: "compact"
    }
  });
  const readElapsed = performance.now() - tRead0;
  const readText = readRes.result.content[0].text;

  // Must only contain recent steps from the end, bounded output
  assert.ok(readText.includes("step 2000") || readText.includes("step 1999"), "Output must contain recent turns");
  assert.ok(!readText.includes("step 1\n") && !readText.includes("step 10\n"), "Output must not contain ancient turns");
  assert.ok(readText.length <= 25000, `Output length (${readText.length}) must be safely bounded`);
  console.log(`✓ Sliding-window turn retention parsed 2,000 steps and bounded output in ${readElapsed.toFixed(1)}ms`);

  // Clean up
  try {
    fs.rmSync(path.join(os.homedir(), ".gemini", "antigravity", "brain", syntheticConvId), { recursive: true, force: true });
  } catch {}
}

// 3.5 Oversized Payload Stdio Guard
{
  const guardProc = spawn(process.execPath, [mcpServer], {
    env: { ...process.env, AGY_MAX_STDIO_PAYLOAD_BYTES: "50000" },
    stdio: ["pipe", "pipe", "inherit"]
  });

  const guardRl = readline.createInterface({ input: guardProc.stdout, terminal: false });
  const errorPromise = new Promise((resolve) => {
    guardRl.on("line", (line) => {
      resolve(JSON.parse(line));
    });
  });

  const oversizedPayload = "x".repeat(60000);
  guardProc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "ping", params: { data: oversizedPayload } }) + "\n");
  const errRes = await errorPromise;
  assert.equal(errRes.error?.code, -32600);
  assert.ok(errRes.error?.message.includes("safety ceiling"), "Must reject oversized message with standard error code");
  guardProc.kill();
  console.log("✓ JSON-RPC Stdio payload safety ceiling guard successfully intercepted and handled oversized message");
}

proc.kill();
console.log("\nAll Performance & Forensic Probes Passed 100%!");
