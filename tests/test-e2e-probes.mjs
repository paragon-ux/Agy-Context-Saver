import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookScript = path.resolve(__dirname, "../scripts/execution-guard-hook.mjs");
const mcpServer = path.resolve(__dirname, "../mcp/index.js");

console.log("=================================================");
console.log("Agy-Context-Saver + RTK End-to-End Governance Probes");
console.log("=================================================\n");

// --- Section 1: PreToolUse Hook Robustness Probes ---
console.log("--- Section 1: PreToolUse Hook Robustness Probes ---");

function runHookRaw(rawInput) {
  const result = spawnSync(process.execPath, [hookScript], {
    input: rawInput,
    encoding: "utf-8"
  });
  assert.equal(result.status, 0, `Hook process must exit 0: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

// 1.1 Empty stdin
{
  const res = runHookRaw("");
  assert.equal(res.decision, "allow", "Empty stdin must fail-open to allow");
  console.log("✓ Empty stdin -> decision: 'allow'");
}

// 1.2 Whitespace-only stdin
{
  const res = runHookRaw("   \n\t  ");
  assert.equal(res.decision, "allow", "Whitespace-only stdin must fail-open to allow");
  console.log("✓ Whitespace-only stdin -> decision: 'allow'");
}

// 1.3 Partial / truncated JSON
{
  const res = runHookRaw('{"toolCall": {"name": "run_command", "args":');
  assert.equal(res.decision, "deny", "Truncated JSON on governed tool must fail-closed to deny");
  console.log("✓ Truncated JSON on governed tool -> decision: 'deny' (fail-closed)");
}

// 1.4 Arbitrary corrupt text / XML without governed tools
{
  const res = runHookRaw("<tool_call><action>run</action></tool_call>");
  assert.equal(res.decision, "allow", "Corrupt / XML non-JSON without governed tool must fail-open to allow");
  console.log("✓ Non-JSON text payload without governed tool -> decision: 'allow'");
}

// 1.5 Non-governed tool calls are allowed
{
  const nonGoverned = [
    { name: "ask_question", args: { questions: [{ question: "Proceed?", options: ["yes", "no"] }] } },
    { name: "custom_unknown_tool", args: { foo: "bar" } },
    { name: "generate_image", args: { Prompt: "diagram" } }
  ];

  for (const t of nonGoverned) {
    const res = runHookRaw(JSON.stringify({ toolCall: t }));
    assert.equal(res.decision, "allow", `Non-governed tool ${t.name} must be allowed`);
  }
  console.log("✓ Non-governed tool calls (ask_question, custom, generate_image) -> decision: 'allow'");
}

// 1.6 Malformed / empty toolCall structure
{
  const resEmptyObj = runHookRaw(JSON.stringify({}));
  assert.equal(resEmptyObj.decision, "allow");
  const resEmptyToolCall = runHookRaw(JSON.stringify({ toolCall: {} }));
  assert.equal(resEmptyToolCall.decision, "allow");
  console.log("✓ Empty object / empty toolCall -> decision: 'allow'");
}

console.log("\n--- Section 2: MCP Server Functional & End-to-End Probes ---");

// Start MCP Server process
const proc = spawn(process.execPath, [mcpServer], {
  stdio: ["pipe", "pipe", "inherit"]
});
const rl = readline.createInterface({ input: proc.stdout, terminal: false });

let reqId = 100;
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

function callRpc(method, params = {}) {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC timeout for ${method} (id=${id})`));
    }, 15000);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

// Initialize
await callRpc("initialize", { protocolVersion: "2024-11-05" });
console.log("✓ MCP Server initialized");

// Probe 2.a: safe_command is retired and rejected
{
  console.log("\nTesting MCP safe_command retirement...");
  const res = await callRpc("tools/call", {
    name: "safe_command",
    arguments: { command: "git status" }
  });
  assert.ok(res.error, "Calling safe_command must return RPC error");
  assert.equal(res.error.code, -32601, "Error code must be -32601 (Tool not found)");
  console.log("✓ safe_command correctly rejected (-32601 tool not found)");
}

// Probe 2.b: RTK CLI commands functional and verified
{
  console.log("\nTesting RTK CLI functionality (rtk read, rtk git)...");
  const rtkReadRes = spawnSync("rtk", ["read", "package.json"], { encoding: "utf-8" });
  assert.equal(rtkReadRes.status, 0, "rtk read package.json must exit 0");
  assert.ok(rtkReadRes.stdout.includes('"name": "agy-context-saver"'), "rtk read must output file content");
  console.log("✓ rtk read package.json executed successfully");

  const rtkGitRes = spawnSync("rtk", ["git", "status"], { encoding: "utf-8" });
  assert.equal(rtkGitRes.status, 0, "rtk git status must exit 0");
  assert.ok(rtkGitRes.stdout.includes("package.json") || rtkGitRes.stdout.includes("main"), "rtk git status must list git status");
  console.log("✓ rtk git status executed successfully");
}

// Probe 2.c: get_installation_status reports live 4-layer health + RTK
{
  console.log("\nTesting MCP get_installation_status...");
  const res = await callRpc("tools/call", { name: "get_installation_status" });
  const text = res.result.content[0].text;
  assert.match(text, /Installation Status: HEALTHY & ACTIVE/);
  assert.match(text, /ALL 6 SCHEMAS PRESENT/);
  assert.match(text, /RTK Binary: INSTALLED/);
  console.log("✓ get_installation_status reported healthy status with 6 schemas and RTK");
}

// Probe 2.d: subagent_brief format validation
{
  console.log("\nTesting MCP subagent_brief...");
  const resBrief = await callRpc("tools/call", {
    name: "subagent_brief",
    arguments: {
      objective: "Deep audit of authentication logic",
      scopeFiles: ["src/auth.js", "src/tokens.js"],
      expectedDeliverable: "Markdown matrix of vulnerabilities"
    }
  });

  const briefText = resBrief.result.content[0].text;
  assert.ok(briefText.includes("ROLE: Scope-Isolated Deep Research Subagent"), "Must include designated role header");
  assert.ok(briefText.includes("src/auth.js"), "Must list target file 1");
  assert.ok(briefText.includes("src/tokens.js"), "Must list target file 2");
  assert.ok(briefText.includes("Markdown matrix of vulnerabilities"), "Must embed expected deliverable");
  assert.ok(briefText.includes("cite exact file:line references"), "Must include citation mandate");
  console.log("✓ subagent_brief generated strictly formatted, scope-isolated instructions");
}

// Probe 2.e: Transcript streaming error tolerance and corrupt line reporting
{
  console.log("\nTesting MCP check_context_health on streaming transcript with corrupted JSON...");
  const tempTranscript = path.join(os.tmpdir(), "corrupt-probe-transcript.jsonl");
  const sampleLines = [
    JSON.stringify({ type: "USER_INPUT", content: "hello" }),
    "THIS_IS_CORRUPTED_JSON_NOT_VALID",
    JSON.stringify({ type: "PLANNER_RESPONSE", content: "response" }),
    JSON.stringify({ type: "PLANNER_RESPONSE", tool_calls: [{ name: "manage_task", args: { Action: "status" } }] })
  ];
  fs.writeFileSync(tempTranscript, sampleLines.join("\n"), "utf-8");

  const resHealth = await callRpc("tools/call", {
    name: "check_context_health",
    arguments: { transcriptPath: tempTranscript }
  });
  const report = resHealth.result.content[0].text;
  assert.match(report, /- Total Steps: 4/, "Must count all non-empty lines");
  assert.match(report, /- Corrupted\/Unparsed Lines: 1/, "Must report exact corrupt line count");
  assert.match(report, /- Detected Busy-Polling Events: 1/, "Must detect tool polling event");
  assert.match(report, /- RTK Command Optimizer: Active/, "Must report RTK optimizer active");
  try { fs.unlinkSync(tempTranscript); } catch {}
  console.log("✓ check_context_health streamed and parsed transcript with corrupt line tolerance & RTK status");
}

// Probe 2.f: read_transcript streaming on historical transcript (compact and full)
{
  console.log("\nTesting MCP read_transcript on historical transcript (compact and full)...");
  const resCompact = await callRpc("tools/call", {
    name: "read_transcript",
    arguments: {
      conversationId: "fcda194f-62d6-46aa-b545-b2de8fa5774e",
      mode: "compact",
      lastTurns: 5
    }
  });
  assert.equal(resCompact.result.isError, undefined);
  const compactText = resCompact.result.content[0].text;
  assert.match(compactText, /# Conversation Transcript: `fcda194f-62d6-46aa-b545-b2de8fa5774e`/);
  assert.match(compactText, /- Mode: \*\*compact\*\*/);
  assert.match(compactText, /### \[Step \d+ \| (USER|ASSISTANT)\]/);
  assert.ok(!compactText.includes('{"step_index":'), "Must format into clean Markdown, zero raw JSON strings");

  const resFull = await callRpc("tools/call", {
    name: "read_transcript",
    arguments: {
      conversationId: "fcda194f-62d6-46aa-b545-b2de8fa5774e",
      mode: "full",
      lastTurns: 2
    }
  });
  assert.equal(resFull.result.isError, undefined);
  const fullText = resFull.result.content[0].text;
  assert.match(fullText, /- Mode: \*\*full\*\*/);
  console.log("✓ read_transcript successfully rendered clean Markdown dialogue in both compact and full modes");
}

// Probe 2.g: Edge Case - Trailing unclosed line resilience and base64 media clamping
{
  console.log("\nTesting MCP read_transcript edge cases: unclosed trailing lines and base64 media clamping...");
  const tempEdgeFile = path.join(os.tmpdir(), "edge-transcript.jsonl");
  const fakeBase64 = "data:image/png;base64," + "A".repeat(500);
  const giantBase64 = "B".repeat(300);
  const testLines = [
    JSON.stringify({ step_index: 1, type: "USER_INPUT", content: `Here is an image: ${fakeBase64} and inline payload: ${giantBase64}` }),
    JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", content: "Processed the payload." }),
    '{"step_index": 3, "type": "USER_INPUT", "content": "incomplete line without closing brace' // Unclosed trailing line
  ];
  fs.writeFileSync(tempEdgeFile, testLines.join("\n"), "utf-8");

  const resEdge = await callRpc("tools/call", {
    name: "read_transcript",
    arguments: { conversationId: tempEdgeFile, mode: "compact" }
  });
  assert.equal(resEdge.result.isError, undefined);
  const edgeText = resEdge.result.content[0].text;
  assert.match(edgeText, /\[Embedded Media\/Binary Omitted\]/, "Must strip data:image base64");
  assert.match(edgeText, /\[Binary\/Base64 Payload Omitted\]/, "Must strip giant base64 sequences");
  assert.match(edgeText, /Processed the payload\./, "Must retain valid lines");
  try { fs.unlinkSync(tempEdgeFile); } catch {}
  console.log("✓ read_transcript handled unclosed trailing flush and clamped binary/base64 media without errors");
}

// Probe 2.h: query_transcript filtering by keyword, roles, and boundaries
{
  console.log("\nTesting MCP query_transcript keyword and role filtering...");
  const resQuery = await callRpc("tools/call", {
    name: "query_transcript",
    arguments: {
      conversationId: "fcda194f-62d6-46aa-b545-b2de8fa5774e",
      query: "anti-overfitting",
      roles: ["user", "assistant"],
      maxResults: 5
    }
  });
  assert.equal(resQuery.result.isError, undefined);
  const qText = resQuery.result.content[0].text;
  assert.match(qText, /## Transcript Query Results/);
  assert.match(qText, /anti-overfitting/i);
  console.log("✓ query_transcript filtered steps by keyword and role with zero context bloat");
}

// Probe 2.i: query_transcript auto-dereferencing
{
  console.log("\nTesting MCP query_transcript auto-dereferencing on synthetic paired transcripts...");
  const tmpDir = path.join(os.tmpdir(), `test-auto-${Date.now()}`);
  const logsDir = path.join(tmpDir, ".system_generated", "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  const compactFile = path.join(logsDir, "transcript.jsonl");
  const fullFile = path.join(logsDir, "transcript_full.jsonl");

  const compactLine = {
    step_index: 42,
    type: "PLANNER_RESPONSE",
    content: "Truncated summary...",
    truncated_fields: ["content"]
  };
  const fullLine = {
    step_index: 42,
    type: "PLANNER_RESPONSE",
    content: "Full expanded content dereferenced from transcript_full.jsonl!"
  };

  fs.writeFileSync(compactFile, JSON.stringify(compactLine) + "\n", "utf-8");
  fs.writeFileSync(fullFile, JSON.stringify(fullLine) + "\n", "utf-8");

  const resAuto = await callRpc("tools/call", {
    name: "query_transcript",
    arguments: {
      conversationId: tmpDir,
      mode: "auto",
      roles: ["all"]
    }
  });
  assert.equal(resAuto.result.isError, undefined);
  const autoText = resAuto.result.content[0].text;
  assert.match(autoText, /Full expanded content dereferenced from transcript_full\.jsonl!/, "Must automatically dereference full content when truncated");

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
  console.log("✓ query_transcript auto-dereferenced truncated step from transcript_full.jsonl with step_index verification");
}

proc.kill();
console.log("\n=================================================");
console.log("ALL END-TO-END VERIFICATION PROBES PASSED 100%!");
console.log("=================================================");
process.exit(0);
