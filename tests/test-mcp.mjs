import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpServer = path.resolve(__dirname, "../mcp/index.js");

console.log("Running Agy-Context-Saver MCP Server tests...\n");

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

function send(method, params = {}) {
  const id = reqId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

// 1. Initialize
{
  const res = await send("initialize", { protocolVersion: "2024-11-05" });
  assert.equal(res.result.serverInfo.name, "agy-context-saver");
  assert.ok(res.result.capabilities.tools);
  assert.ok(res.result.capabilities.resources);
  assert.ok(res.result.capabilities.prompts);
  console.log("✓ initialize handshake succeeded");
}

// 2. tools/list (9 tools, safe_command permanently retired)
{
  const res = await send("tools/list");
  const toolNames = res.result.tools.map((t) => t.name);
  assert.equal(toolNames.includes("safe_command"), false, "safe_command must not be exposed in tools/list");
  assert.ok(toolNames.includes("check_context_health"));
  assert.ok(toolNames.includes("subagent_brief"));
  assert.ok(toolNames.includes("get_installation_status"));
  assert.ok(toolNames.includes("sync_installation"));
  assert.ok(toolNames.includes("read_transcript"));
  assert.ok(toolNames.includes("query_transcript"));
  assert.ok(toolNames.includes("get_spillover_content"));
  assert.ok(toolNames.includes("read_task_output"));
  assert.ok(toolNames.includes("get_step_detail"));
  assert.equal(toolNames.length, 9, "Must expose exactly 9 canonical tools");
  console.log("✓ tools/list returned all 9 governance & transcript tools (safe_command retired)");
}

// 3. tools/call: safe_command must fail as tool not found
{
  const res = await send("tools/call", {
    name: "safe_command",
    arguments: { command: "echo should-fail" }
  });
  assert.ok(res.error, "Calling safe_command must return an error");
  assert.equal(res.error.code, -32601);
  assert.match(res.error.message, /Tool not found: safe_command/);
  console.log("✓ tools/call (safe_command) correctly rejected (-32601 tool not found)");
}

// 4. tools/call: subagent_brief
{
  const res = await send("tools/call", {
    name: "subagent_brief",
    arguments: { objective: "Analyze test failures", scopeFiles: ["tests/test_foo.py"] }
  });
  assert.match(res.result.content[0].text, /Analyze test failures/);
  assert.match(res.result.content[0].text, /POINTER-OVER-WIRE/);
  console.log("✓ tools/call (subagent_brief) generated scope-isolated brief");
}

// 5. tools/call: get_installation_status
{
  const res = await send("tools/call", { name: "get_installation_status" });
  assert.match(res.result.content[0].text, /Installation Status: HEALTHY & ACTIVE/);
  assert.match(res.result.content[0].text, /ALL 9 SCHEMAS PRESENT/);
  assert.match(res.result.content[0].text, /RTK Binary: INSTALLED/);
  console.log("✓ tools/call (get_installation_status) reported live 4-layer health + RTK");
}

// 6. tools/call: sync_installation (dry-run audit)
{
  const res = await send("tools/call", {
    name: "sync_installation",
    arguments: { checkOnly: true }
  });
  assert.match(res.result.content[0].text, /Installation Synchronization/);
  assert.match(res.result.content[0].text, /Pre-flight check complete/);
  assert.match(res.result.content[0].text, /RTK Binary:/);
  console.log("✓ tools/call (sync_installation) verified dry-run synchronization");
}

// 7. tools/call: read_transcript
{
  const res = await send("tools/call", {
    name: "read_transcript",
    arguments: {
      conversationId: "fcda194f-62d6-46aa-b545-b2de8fa5774e",
      mode: "compact",
      lastTurns: 3
    }
  });
  assert.equal(res.result.isError, undefined);
  const text = res.result.content[0].text;
  assert.match(text, /# Conversation Transcript: `fcda194f-62d6-46aa-b545-b2de8fa5774e`/);
  assert.match(text, /- Mode: \*\*compact\*\*/);
  console.log("✓ tools/call (read_transcript) successfully streamed and formatted conversation turns");
}

// 8. tools/call: query_transcript
{
  const res = await send("tools/call", {
    name: "query_transcript",
    arguments: {
      conversationId: "fcda194f-62d6-46aa-b545-b2de8fa5774e",
      query: "verification",
      roles: ["user", "assistant"],
      maxResults: 5
    }
  });
  assert.equal(res.result.isError, undefined);
  const text = res.result.content[0].text;
  assert.match(text, /## Transcript Query Results: `fcda194f-62d6-46aa-b545-b2de8fa5774e`/);
  assert.match(text, /- Filter: query="verification"/);
  console.log("✓ tools/call (query_transcript) filtered and returned matching forensic steps");
}

// 8b. tools/call: query_transcript (summaryOnly mode)
{
  const res = await send("tools/call", {
    name: "query_transcript",
    arguments: {
      conversationId: "fcda194f-62d6-46aa-b545-b2de8fa5774e",
      summaryOnly: true,
      maxResults: 3
    }
  });
  assert.equal(res.result.isError, undefined);
  const text = res.result.content[0].text;
  assert.match(text, /## Transcript Query Summary:/);
  console.log("✓ tools/call (query_transcript with summaryOnly: true) returned compact 1-line bullet summaries");
}

// 8c. tools/call: get_spillover_content
{
  // Test invalid file denial (non-spillover)
  const resDenied = await send("tools/call", {
    name: "get_spillover_content",
    arguments: { uri: "C:/Users/USER/.gemini/antigravity/brain/session/secret.env" }
  });
  assert.equal(resDenied.result.isError, true);
  assert.match(resDenied.result.content[0].text, /GOVERNANCE DENIAL/);

  // Test reading simulated spillover file
  const testSpilloverDir = path.resolve(__dirname, "../tmp_test/.system_generated/steps/999");
  fs.mkdirSync(testSpilloverDir, { recursive: true });
  const testFile = path.join(testSpilloverDir, "output.txt");
  fs.writeFileSync(testFile, "Line 1: Build started\nLine 2: 12 tests passed\nLine 3: Build finished\n", "utf-8");

  const resAllowed = await send("tools/call", {
    name: "get_spillover_content",
    arguments: { uri: `file:///${testFile.replace(/\\/g, "/")}`, lines: 2, tail: true }
  });
  assert.equal(resAllowed.result.isError, undefined);
  const allowedText = resAllowed.result.content[0].text;
  assert.match(allowedText, /Runtime Step Output Spillover/);
  assert.match(allowedText, /12 tests passed/);
  assert.match(allowedText, /Build finished/);

  // Clean up
  try { fs.rmSync(path.resolve(__dirname, "../tmp_test"), { recursive: true, force: true }); } catch {}
  console.log("✓ tools/call (get_spillover_content) enforced spillover boundary and windowed output");
}

// 8d. tools/call: read_task_output
{
  // Test missing task
  const resMissing = await send("tools/call", {
    name: "read_task_output",
    arguments: { taskId: "task-nonexistent-9999" }
  });
  assert.equal(resMissing.result.isError, true);
  console.log("✓ tools/call (read_task_output) handled missing/running task lifecycle gating");
}

// 8e. tools/call: get_step_detail
{
  const resStep = await send("tools/call", {
    name: "get_step_detail",
    arguments: {
      conversationId: "fcda194f-62d6-46aa-b545-b2de8fa5774e",
      stepIndex: 1
    }
  });
  assert.equal(resStep.result.isError, undefined);
  assert.match(resStep.result.content[0].text, /Step 1/);
  console.log("✓ tools/call (get_step_detail) surgically dereferenced step content");
}

// 9. resources/read
{
  const res = await send("resources/read", { uri: "context-saver://rules/governance" });
  assert.match(res.result.contents[0].text, /Antigravity Execution & Context Governance/);
  console.log("✓ resources/read served governance rulebook");
}

// 10. prompts/get
{
  const res = await send("prompts/get", { name: "context_shield" });
  assert.match(res.result.messages[0].content.text, /Antigravity Context Governance rules/);
  console.log("✓ prompts/get served context_shield prompt");
}

proc.kill();
console.log("\nAll MCP tests passed successfully!");
process.exit(0);
