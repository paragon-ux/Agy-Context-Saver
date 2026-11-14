import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupHermeticTestEnv, HERMETIC_CONV_ID, runRtkCli } from "./helpers/hermetic-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookScript = path.resolve(__dirname, "../scripts/execution-guard-hook.mjs");
const cliScript = path.resolve(__dirname, "../bin/agy-context.mjs");

console.log("=================================================");
console.log("Agy-Context-Saver + RTK v2.0.0 End-to-End Probes");
console.log("=================================================\n");
const hermetic = await setupHermeticTestEnv({ forceShim: true, shimVersion: "1.1.0" });

function runHookRaw(rawInput) {
  const result = spawnSync(process.execPath, [hookScript], {
    input: rawInput,
    encoding: "utf-8"
  });
  assert.equal(result.status, 0, `Hook process must exit 0: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

function runCli(args) {
  const result = spawnSync(process.execPath, [cliScript, ...args], {
    encoding: "utf-8"
  });
  assert.equal(result.status, 0, `CLI exited with ${result.status}: ${result.stderr}`);
  return result.stdout;
}

// --- Section 1: PreToolUse Hook Fail-Closed / Fail-Open Robustness ---
console.log("--- Section 1: PreToolUse Hook Robustness Probes ---");
assert.equal(runHookRaw("").decision, "allow", "Empty stdin must fail-open");
assert.equal(runHookRaw("   \n\t  ").decision, "allow", "Whitespace-only stdin must fail-open");
assert.equal(runHookRaw('{"toolCall": {"name": "run_command", "args":').decision, "deny", "Truncated governed tool JSON must fail-closed");
assert.equal(runHookRaw("<tool_call><action>run</action></tool_call>").decision, "allow", "Non-governed corrupt text fails open");
for (const name of ["ask_question", "custom_unknown_tool", "image_generator"]) {
  assert.equal(runHookRaw(JSON.stringify({ toolCall: { name, args: { foo: "bar" } } })).decision, "allow");
}
assert.equal(runHookRaw("{}").decision, "allow");
console.log("✓ Fail-closed governed vs fail-open non-governed robustness verified");

// --- Section 2: End-to-End CLI Workflows (`agy-context transcript|status`) ---
console.log("\n--- Section 2: End-to-End CLI Workflows ---");
const statusJson = JSON.parse(runCli(["status", "--json"]));
assert.equal(statusJson.isComplete, true, "Hermetic installed status must be complete");
assert.equal(statusJson.details.mcp.clean, true, "MCP cleanup must report clean=true");

const healthOut = runCli(["transcript", "health", "--id", HERMETIC_CONV_ID]);
assert.match(healthOut, /HEALTHY/);
assert.match(healthOut, /Total Steps: 6/);

const readOut = runCli(["transcript", "read", "--id", HERMETIC_CONV_ID, "--last-turns", "2"]);
assert.match(readOut, /Step 5 Content/);
assert.match(readOut, /Step 6 Content/);

const queryOut = runCli(["transcript", "query", "--id", HERMETIC_CONV_ID, "--query", "streaming JSONL", "--summary"]);
assert.match(queryOut, /Step 3/);

const stepOut = runCli(["transcript", "step", "--id", HERMETIC_CONV_ID, "--step", "2", "--field", "tool_args:CommandLine"]);
assert.match(stepOut, /rtk git status/);
console.log("✓ End-to-end CLI status, transcript health, read, query, and step commands verified");

// --- Section 3: RTK Read & Git CLI Parity Probe ---
console.log("\n--- Section 3: RTK Read & Git CLI Parity Probe ---");
const rtkVer = runRtkCli(["--version"]);
assert.equal(rtkVer.status, 0);
assert.match(rtkVer.stdout, /1\.1\.0/);

const tmpTarget = path.join(hermetic.profileDir, "sample.txt");
fs.writeFileSync(tmpTarget, "line one\nline two\n", "utf-8");
const rtkReadRes = runRtkCli(["read", tmpTarget]);
assert.equal(rtkReadRes.status, 0);
assert.match(rtkReadRes.stdout, /line one/);
console.log("✓ RTK CLI execution probe passed");

hermetic.cleanup();
console.log("\n=================================================");
console.log("ALL END-TO-END PROBES PASSED SUCCESSFULLY!");
console.log("=================================================");
