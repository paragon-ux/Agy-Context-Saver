import assert from "node:assert/strict";
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

// 2. tools/list
{
  const res = await send("tools/list");
  const toolNames = res.result.tools.map((t) => t.name);
  assert.ok(toolNames.includes("safe_command"));
  assert.ok(toolNames.includes("check_context_health"));
  assert.ok(toolNames.includes("subagent_brief"));
  assert.ok(toolNames.includes("get_installation_status"));
  assert.ok(toolNames.includes("sync_installation"));
  assert.ok(toolNames.includes("read_transcript"));
  assert.ok(toolNames.includes("query_transcript"));
  assert.equal(toolNames.length, 7);
  console.log("✓ tools/list returned all 7 governance & transcript tools");
}

// 3. tools/call: safe_command
{
  const res = await send("tools/call", {
    name: "safe_command",
    arguments: { command: "echo hello-from-safe-command" }
  });
  assert.match(res.result.content[0].text, /hello-from-safe-command/);
  assert.match(res.result.content[0].text, /STATUS: PASSED/);
  console.log("✓ tools/call (safe_command) executed and captured stdout");
}

// 4. tools/call: subagent_brief
{
  const res = await send("tools/call", {
    name: "subagent_brief",
    arguments: { objective: "Analyze test failures", scopeFiles: ["tests/test_foo.py"] }
  });
  assert.match(res.result.content[0].text, /Analyze test failures/);
  assert.match(res.result.content[0].text, /CRITICAL CONTEXT GOVERNANCE/);
  console.log("✓ tools/call (subagent_brief) generated scope-isolated brief");
}

// 5. tools/call: get_installation_status
{
  const res = await send("tools/call", { name: "get_installation_status" });
  assert.match(res.result.content[0].text, /Installation Status: HEALTHY & ACTIVE/);
  assert.match(res.result.content[0].text, /ALL 7 SCHEMAS PRESENT/);
  console.log("✓ tools/call (get_installation_status) reported live 4-layer health");
}

// 6. tools/call: sync_installation (dry-run audit)
{
  const res = await send("tools/call", {
    name: "sync_installation",
    arguments: { checkOnly: true }
  });
  assert.match(res.result.content[0].text, /Installation Synchronization/);
  assert.match(res.result.content[0].text, /Pre-flight check complete/);
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
  assert.match(text, /### \[Step \d+ \|/);
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

// 8b. tools/call: safe_command (legacy terse mode)
{
  const res = await send("tools/call", {
    name: "safe_command",
    arguments: { command: "echo terse-output-line", terse: true }
  });
  const text = res.result.content[0].text;
  assert.match(text, /✓ \[STATUS: PASSED \(exit 0\)/);
  assert.match(text, /lines collapsed in terse mode/);
  assert.ok(text.length <= 500, "Terse output must be <= 500 chars");
  console.log("✓ tools/call (safe_command with terse: true) returned 1-line collapsed summary");
}

// 8b-2. tools/call: safe_command (verbosity: quiet)
{
  const res = await send("tools/call", {
    name: "safe_command",
    arguments: { command: "echo quiet-output-line", verbosity: "quiet" }
  });
  const text = res.result.content[0].text;
  assert.match(text, /✓ \[STATUS: PASSED \(exit 0\)/);
  assert.match(text, /lines collapsed in quiet mode/);
  assert.ok(text.length <= 500, "Quiet output must be <= 500 chars");
  console.log("✓ tools/call (safe_command with verbosity: quiet) returned 1-line collapsed summary");
}

// 8b-3. tools/call: safe_command (verbosity: normal with code block fencing)
{
  const res = await send("tools/call", {
    name: "safe_command",
    arguments: { command: "echo normal-mode-output", verbosity: "normal" }
  });
  const text = res.result.content[0].text;
  assert.match(text, /\[STATUS: PASSED \(exit 0\)/);
  assert.match(text, /```text\r?\nnormal-mode-output\r?\n```/);
  assert.ok(text.length <= 4096, "Normal output must be <= 4096 chars");
  console.log("✓ tools/call (safe_command with verbosity: normal) returned output inside ```text code fences");
}

// 8b-4. tools/call: safe_command (verbosity: full)
{
  const res = await send("tools/call", {
    name: "safe_command",
    arguments: { command: "echo full-mode-output", verbosity: "full" }
  });
  const text = res.result.content[0].text;
  assert.match(text, /\[STATUS: PASSED \(exit 0\)/);
  assert.match(text, /```text\r?\nfull-mode-output\r?\n```/);
  assert.ok(text.length <= 24576, "Full output must be <= 24576 chars");
  console.log("✓ tools/call (safe_command with verbosity: full) returned raw output inside code fences");
}

// 8c. tools/call: query_transcript (summaryOnly mode)
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
  assert.match(text, /- \*\*\[Step \d+ \|/);
  console.log("✓ tools/call (query_transcript with summaryOnly: true) returned compact 1-line bullet summaries");
}

// 9. resources/read
{
  const res = await send("resources/read", { uri: "context-saver://rules/governance" });
  assert.match(res.result.contents[0].text, /Layer 1: Background Task & Polling Ban/);
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
