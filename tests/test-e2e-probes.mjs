import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpServer = path.resolve(__dirname, "../mcp/index.js");
const hookScript = path.resolve(__dirname, "../scripts/execution-guard-hook.mjs");
const historicalTranscriptPath = "C:/Users/USER/.gemini/antigravity/brain/fcda194f-62d6-46aa-b545-b2de8fa5774e/.system_generated/logs/transcript.jsonl";

console.log("=================================================");
console.log("Agy-Context-Saver Comprehensive End-to-End Probes");
console.log("=================================================\n");

// --- Helper: Run Hook with raw input string ---
function runHookRaw(rawInput) {
  const result = spawnSync(process.execPath, [hookScript], {
    input: rawInput,
    encoding: "utf-8"
  });
  assert.equal(result.status, 0, `Hook process exited with unexpected status ${result.status}: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout.trim());
  return parsed;
}

// --- Section 1: Hook Resilience Tests ---
console.log("--- Section 1: Hook Resilience Probes (Fail-Open Verification) ---");

// 1.1 Empty stdin
{
  const res = runHookRaw("");
  assert.equal(res.decision, "allow", "Empty stdin must fail-open to allow");
  console.log("✓ Empty stdin -> decision: 'allow'");
}

// 1.2 Whitespace stdin
{
  const res = runHookRaw("   \r\n   ");
  assert.equal(res.decision, "allow", "Whitespace stdin must fail-open to allow");
  console.log("✓ Whitespace-only stdin -> decision: 'allow'");
}

// 1.3 Malformed JSON
{
  const res = runHookRaw("{ 'invalid': json text without quotes... ");
  assert.equal(res.decision, "allow", "Malformed JSON must fail-open to allow");
  console.log("✓ Malformed JSON -> decision: 'allow'");
}

// 1.4 Arbitrary corrupt text / XML
{
  const res = runHookRaw("<tool_call><action>run</action></tool_call>");
  assert.equal(res.decision, "allow", "Corrupt / XML non-JSON must fail-open to allow");
  console.log("✓ Non-JSON text payload -> decision: 'allow'");
}

// 1.5 Non-target tool calls
{
  const toolsToTest = [
    { name: "view_file", args: { AbsolutePath: "C:/project/foo.py" } },
    { name: "write_to_file", args: { TargetFile: "C:/project/bar.py", CodeContent: "test" } },
    { name: "ask_question", args: { questions: [{ question: "Proceed?", options: ["yes", "no"] }] } },
    { name: "replace_file_content", args: { TargetFile: "foo.py" } },
    { name: "custom_unknown_tool", args: { foo: "bar" } }
  ];

  for (const t of toolsToTest) {
    const res = runHookRaw(JSON.stringify({ toolCall: t }));
    assert.equal(res.decision, "allow", `Non-target tool ${t.name} must be allowed`);
  }
  console.log("✓ Non-target tool calls (view_file, write_to_file, ask_question, replace_file_content, custom) -> decision: 'allow'");
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

// Probe 2.a: safe_command with 150+ lines (success case and failure case)
{
  console.log("\nTesting MCP safe_command with 180 lines output...");
  // Node one-liner that prints 180 lines
  const cmdSuccess = `node -e "for(let i=1; i<=180; i++) console.log('LOG_ENTRY_ROW_' + String(i).padStart(3, '0') + ': detail_payload');"`;
  const resSuccess = await callRpc("tools/call", {
    name: "safe_command",
    arguments: { command: cmdSuccess, maxOutputLines: 30 }
  });

  assert.equal(resSuccess.result.isError, false, "Exit 0 must produce isError: false");
  const textSuccess = resSuccess.result.content[0].text;
  
  // Verify status header
  assert.match(textSuccess, /\[STATUS: PASSED \(exit 0\) in \d+\.\d+s\]/, "Status header must report PASSED (exit 0) with elapsed time");
  
  // Verify top lines preserved
  assert.ok(textSuccess.includes("LOG_ENTRY_ROW_001: detail_payload"), "Header line 1 must be preserved");
  assert.ok(textSuccess.includes("LOG_ENTRY_ROW_015: detail_payload"), "Head line 15 must be preserved");
  
  // Verify middle compression marker
  assert.match(textSuccess, /\.\.\. \[agy-context-saver: compressed 150 repetitive output lines\] \.\.\./, "Compression marker must report exact 150 compressed lines");
  
  // Verify middle lines are omitted
  assert.ok(!textSuccess.includes("LOG_ENTRY_ROW_050: detail_payload"), "Middle line 50 must NOT be present in output");
  assert.ok(!textSuccess.includes("LOG_ENTRY_ROW_100: detail_payload"), "Middle line 100 must NOT be present in output");
  
  // Verify bottom lines preserved
  assert.ok(textSuccess.includes("LOG_ENTRY_ROW_166: detail_payload"), "Tail line 166 must be preserved");
  assert.ok(textSuccess.includes("LOG_ENTRY_ROW_180: detail_payload"), "Final line 180 must be preserved");
  
  console.log("✓ safe_command successfully compressed 180 lines to 30 lines (top 15 + bottom 15 preserved, 150 compressed)");
  console.log("✓ Exit code 0 status preserved: [STATUS: PASSED (exit 0)]");

  // Non-zero exit code preservation with large output
  console.log("Testing MCP safe_command failure exit code preservation with 200 lines output...");
  const cmdFail = `node -e "for(let i=1; i<=200; i++) console.log('ERR_ROW_' + i); process.exit(42);"`;
  const resFail = await callRpc("tools/call", {
    name: "safe_command",
    arguments: { command: cmdFail, maxOutputLines: 30 }
  });

  assert.equal(resFail.result.isError, true, "Exit 42 must produce isError: true");
  const textFail = resFail.result.content[0].text;
  assert.match(textFail, /\[STATUS: FAILED \(exit 42\) in \d+\.\d+s\]/, "Status header must report FAILED (exit 42)");
  assert.ok(textFail.includes("ERR_ROW_1"), "ERR_ROW_1 must be preserved in head");
  assert.ok(textFail.includes("ERR_ROW_200"), "ERR_ROW_200 must be preserved in tail");
  assert.match(textFail, /compressed 170 repetitive output lines/, "Should report 170 compressed lines");
  console.log("✓ safe_command non-zero exit status (exit 42) accurately retained without data loss");
}

// Probe 2.b: check_context_health against historical transcript
{
  console.log("\nTesting MCP check_context_health on historical transcript...");
  assert.ok(fs.existsSync(historicalTranscriptPath), `Historical transcript not found at: ${historicalTranscriptPath}`);
  
  const resHealth = await callRpc("tools/call", {
    name: "check_context_health",
    arguments: { transcriptPath: historicalTranscriptPath }
  });

  assert.equal(resHealth.result.isError, undefined, "Successful health check should not set isError: true");
  const healthReport = resHealth.result.content[0].text;
  console.log("\n--- Transcript Inspection Output ---\n" + healthReport + "\n------------------------------------");

  // Assertions on diagnosis
  assert.match(healthReport, /Context Health Report: CRITICAL \(Active Polling Loops Detected\)/, "Must diagnose CRITICAL status due to polling");
  assert.match(healthReport, /- Total Steps: 933/, "Must accurately report total steps (933)");
  assert.match(healthReport, /- Detected Busy-Polling Events: 37/, "Must report exactly 37 detected busy-polling events");
  assert.match(healthReport, /- Approximate Raw Transcript Size: 1441\.\d KB/, "Must report transcript size around ~1441.2 KB");
  assert.match(healthReport, /⚠️ Recommendation: Background polling detected! Cease manage_task\(status\) calls/, "Must provide remediation guidance");
  
  console.log("✓ check_context_health accurately identified busy-polling loop and computed correct step & byte metrics");
}

// Probe 2.c: subagent_brief verification
{
  console.log("\nTesting MCP subagent_brief generation...");
  const briefArgs = {
    objective: "Execute regression analysis on PDLt Anti-Overfitting suite",
    scopeFiles: [
      "tests/test_harness_anti_overfitting.py",
      "docs/guardrails/ANTI_OVERFITTING_AND_BENCHMARK_INTEGRITY.md"
    ],
    expectedDeliverable: "Markdown summary citing violated GUARD-0X rules and exact file:line references"
  };

  const resBrief = await callRpc("tools/call", {
    name: "subagent_brief",
    arguments: briefArgs
  });

  const briefText = resBrief.result.content[0].text;
  assert.ok(briefText.includes("ROLE: Scope-Isolated Deep Research Subagent"), "Must specify subagent role");
  assert.ok(briefText.includes("OBJECTIVE: Execute regression analysis"), "Must include objective");
  assert.ok(briefText.includes("- tests/test_harness_anti_overfitting.py"), "Must format scope file 1");
  assert.ok(briefText.includes("- docs/guardrails/ANTI_OVERFITTING_AND_BENCHMARK_INTEGRITY.md"), "Must format scope file 2");
  assert.ok(briefText.includes("CRITICAL CONTEXT GOVERNANCE INSTRUCTIONS:"), "Must include governance banner");
  assert.ok(briefText.includes("DO NOT dump raw file contents or massive grep outputs"), "Must include anti-dumping mandate");
  assert.ok(briefText.includes("Markdown summary citing violated GUARD-0X rules"), "Must include expected deliverable");
  assert.ok(briefText.includes("cite exact file:line references"), "Must include citation mandate");

  console.log("✓ subagent_brief generated strictly formatted, scope-isolated instructions");
}

// Probe 2.d: Pathological single-line output clamping
{
  console.log("\nTesting MCP safe_command clamping on pathological long line (5,000 chars)...");
  const cmdLong = `node -e "console.log('A'.repeat(5000));"`;
  const resLong = await callRpc("tools/call", {
    name: "safe_command",
    arguments: { command: cmdLong, maxOutputLines: 30 }
  });
  const textLong = resLong.result.content[0].text;
  assert.match(textLong, /\[truncated long line 5000 chars\]/, "Must clamp pathological single-line output exceeding 2000 chars");
  console.log("✓ safe_command successfully clamped pathological 5,000-char single line");
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
  try { fs.unlinkSync(tempTranscript); } catch {}
  console.log("✓ check_context_health streamed and parsed transcript with corrupt line tolerance");
}

// Probe 2.f: Timeout & escalating termination
{
  console.log("\nTesting MCP safe_command process timeout and clean termination...");
  const cmdSleep = `node -e "setTimeout(() => console.log('done'), 10000);"`;
  const resTimeout = await callRpc("tools/call", {
    name: "safe_command",
    arguments: { command: cmdSleep, timeoutSeconds: 1 }
  });
  assert.equal(resTimeout.result.isError, true, "Timed-out command must report isError: true");
  assert.match(resTimeout.result.content[0].text, /\[COMMAND TIMEOUT\] Process exceeded 1s and was terminated/);
  console.log("✓ safe_command terminated long-running command on timeout with escalating signal protection");
}

proc.kill();
console.log("\n=================================================");
console.log("ALL END-TO-END VERIFICATION PROBES PASSED 100%!");
console.log("=================================================");
process.exit(0);
