import assert from "node:assert/strict";
import cp from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpIndexPath = path.resolve(__dirname, "../mcp/index.js");

console.log("=================================================");
console.log("Agy-Context-Saver Subagent Delegation Trials");
console.log("=================================================\n");

// Helper to send JSON-RPC requests to mcp/index.js over stdio
function createMcpClient() {
  const proc = cp.spawn("node", [mcpIndexPath], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, AGY_MAX_STDIO_PAYLOAD_BYTES: "10485760" }
  });

  let idCounter = 1;
  const pending = new Map();
  let buffer = "";

  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    let lineEnd;
    while ((lineEnd = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          const resolve = pending.get(msg.id);
          pending.delete(msg.id);
          resolve(msg);
        }
      } catch (err) {
        console.error("JSON parse error from MCP:", err);
      }
    }
  });

  function send(method, params = {}) {
    return new Promise((resolve) => {
      const id = idCounter++;
      pending.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  function kill() {
    proc.stdin.end();
    proc.kill();
  }

  return { send, kill };
}

const client = createMcpClient();

// Initialize handshake
await client.send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "test-subagent-trials", version: "1.0.0" }
});

console.log("✓ MCP handshake established\n");

// -----------------------------------------------------------------
// Trial 1: Single Subagent with Custom Role & Detailed Directives
// -----------------------------------------------------------------
console.log("--- Trial 1: Single Subagent with Custom Role ---");
{
  const resp = await client.send("tools/call", {
    name: "subagent_brief",
    arguments: {
      role: "Codebase Security Auditor",
      objective: "Audit execution guard hook boundaries and fail-closed security handling",
      instructions: "1. Verify corrupt JSON payloads trigger strict fail-closed denials.\n2. Ensure no execution paths bypass RTK optimization.",
      scopeFiles: ["scripts/execution-guard-hook.mjs", "tests/test-hook.mjs"],
      expectedDeliverable: "Vulnerability matrix and audit verdict table",
      typeName: "self",
      model: "inherit",
      workspace: "inherit"
    }
  });

  assert.ok(resp.result, "Must return valid MCP result");
  assert.equal(resp.result.isError, undefined, "Must not be an error");
  const text = resp.result.content[0].text;

  // Verify Role & Directives in Brief
  assert.ok(text.includes("ROLE: Codebase Security Auditor"), "Must embed custom role");
  assert.ok(text.includes("Audit execution guard hook boundaries"), "Must embed objective");
  assert.ok(text.includes("scripts/execution-guard-hook.mjs"), "Must list scope file 1");
  assert.ok(text.includes("tests/test-hook.mjs"), "Must list scope file 2");
  assert.ok(text.includes("SPECIFIC INSTRUCTIONS:"), "Must include specific instructions section");
  assert.ok(text.includes("Verify corrupt JSON payloads trigger strict fail-closed denials"), "Must embed instruction 1");
  assert.ok(text.includes("POINTER-OVER-WIRE"), "Must enforce POW contract");

  // Verify Ready-to-Use JSON Payload
  const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(jsonMatch, "Must output a fenced JSON block with invoke_subagent payload");
  const payload = JSON.parse(jsonMatch[1]);
  assert.ok(Array.isArray(payload.Subagents), "Payload must contain Subagents array");
  assert.equal(payload.Subagents.length, 1, "Must contain exactly 1 subagent");
  assert.equal(payload.Subagents[0].Role, "Codebase Security Auditor");
  assert.equal(payload.Subagents[0].TypeName, "self");
  assert.equal(payload.Subagents[0].Model, "inherit");
  assert.equal(payload.Subagents[0].Workspace, "inherit");
  assert.ok(payload.Subagents[0].Prompt.includes("ROLE: Codebase Security Auditor"));

  console.log("✓ Trial 1 Passed: Single subagent with custom role formulated cleanly with 100% turnkey payload");
}

// -----------------------------------------------------------------
// Trial 2: Multi-Subagent Batch with Diverse Specialized Roles
// -----------------------------------------------------------------
console.log("\n--- Trial 2: Multi-Subagent Batch with Diverse Roles ---");
{
  const resp = await client.send("tools/call", {
    name: "subagent_brief",
    arguments: {
      subagents: [
        {
          role: "Performance Benchmark Engineer",
          objective: "Profile command rewriting cache and fast-path hook latency",
          instructions: "Measure microsecond latency across 20x fast-path checks and persistent cache hits.",
          scopeFiles: ["tests/test-performance-probes.mjs"],
          expectedDeliverable: "Latency comparison table (mean, p95, speedup factor)",
          typeName: "self",
          model: "inherit"
        },
        {
          role: "API Regression Specialist",
          objective: "Validate JSON-RPC 2.0 error handling and payload safety ceilings",
          instructions: "Verify -32601 tool not found, -32602 invalid params, and 10MB payload ceiling enforcement.",
          scopeFiles: ["mcp/index.js", "tests/test-mcp.mjs"],
          expectedDeliverable: "Pass/Fail scoreboard with exact response codes",
          typeName: "self",
          model: "inherit"
        },
        {
          role: "Documentation Integrity Reviewer",
          objective: "Verify AGENTS.md, README.md, and tool schemas synchronization",
          instructions: "Check that rulebook, README, and ~/.gemini/ schemas are aligned.",
          scopeFiles: ["rules/AGENTS.md", "README.md"],
          expectedDeliverable: "Synchronization checklist and drift analysis",
          typeName: "research",
          model: "flash",
          workspace: "inherit"
        }
      ]
    }
  });

  assert.ok(resp.result, "Must return valid MCP result");
  assert.equal(resp.result.isError, undefined, "Must not be an error");
  const text = resp.result.content[0].text;

  // Verify All 3 Subagent Sections Rendered
  assert.ok(text.includes("Performance Benchmark Engineer"), "Must render Subagent 1");
  assert.ok(text.includes("API Regression Specialist"), "Must render Subagent 2");
  assert.ok(text.includes("Documentation Integrity Reviewer"), "Must render Subagent 3");

  // Verify JSON Payload Structure for invoke_subagent
  const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(jsonMatch, "Must output a fenced JSON block with multi-subagent payload");
  const payload = JSON.parse(jsonMatch[1]);
  assert.ok(Array.isArray(payload.Subagents), "Payload must contain Subagents array");
  assert.equal(payload.Subagents.length, 3, "Must contain all 3 subagents");

  // Subagent 1 checks
  assert.equal(payload.Subagents[0].Role, "Performance Benchmark Engineer");
  assert.equal(payload.Subagents[0].TypeName, "self");
  assert.equal(payload.Subagents[0].Model, "inherit");
  assert.ok(payload.Subagents[0].Prompt.includes("tests/test-performance-probes.mjs"));

  // Subagent 2 checks
  assert.equal(payload.Subagents[1].Role, "API Regression Specialist");
  assert.equal(payload.Subagents[1].TypeName, "self");
  assert.ok(payload.Subagents[1].Prompt.includes("JSON-RPC 2.0 error handling"));

  // Subagent 3 checks
  assert.equal(payload.Subagents[2].Role, "Documentation Integrity Reviewer");
  assert.equal(payload.Subagents[2].TypeName, "research");
  assert.equal(payload.Subagents[2].Model, "flash");
  assert.ok(payload.Subagents[2].Prompt.includes("rules/AGENTS.md"));

  console.log("✓ Trial 2 Passed: 3-role batch formulated in single call with validated Subagents JSON array");
}

// -----------------------------------------------------------------
// Trial 3: Agent Error Tolerance (Missing Arguments)
// -----------------------------------------------------------------
console.log("\n--- Trial 3: Agent Error Tolerance ---");
{
  const resp = await client.send("tools/call", {
    name: "subagent_brief",
    arguments: {}
  });

  assert.ok(resp.result.isError, "Must return error on completely empty invocation");
  assert.ok(resp.result.content[0].text.includes("subagent_brief error"), "Must provide actionable guidance");
  console.log("✓ Trial 3 Passed: Actionable error guidance on empty parameters");
}

client.kill();

console.log("\n=================================================");
console.log("ALL SUBAGENT DELEGATION TRIALS PASSED 100%!");
console.log("=================================================");
process.exit(0);
