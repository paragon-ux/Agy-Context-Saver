import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkTranscriptHealth } from "../lib/transcript-health.mjs";
import { setupHermeticTestEnv } from "./helpers/hermetic-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookScript = path.resolve(__dirname, "../scripts/execution-guard-hook.mjs");

console.log("==========================================================");
console.log("Agy-Context-Saver v2.0.0 Performance & Memory Probes");
console.log("==========================================================\n");
const hermetic = await setupHermeticTestEnv({ forceShim: true, shimVersion: "1.1.0" });
const { safeWriteFileIfChanged, safeCopyFileIfChanged } = await import("../scripts/install-register.mjs");

// --- Probe 1: Idempotent File Operations ---
console.log("--- Probe 1: Idempotent Config Writes ---");
{
  const tmpProbe = path.join(os.tmpdir(), `agy-perf-probe-${process.pid}.txt`);
  try {
    fs.writeFileSync(tmpProbe, "original content", "utf-8");
    assert.equal(await safeWriteFileIfChanged(tmpProbe, "original content"), false);
    assert.equal(await safeWriteFileIfChanged(tmpProbe, "updated content"), true);
    const tmpProbeCopy = path.join(os.tmpdir(), `agy-perf-probe-copy-${process.pid}.txt`);
    fs.writeFileSync(tmpProbeCopy, "updated content", "utf-8");
    assert.equal(await safeCopyFileIfChanged(tmpProbe, tmpProbeCopy), false);
    try { fs.unlinkSync(tmpProbeCopy); } catch {}
  } finally {
    try { fs.unlinkSync(tmpProbe); } catch {}
  }
  console.log("✓ Idempotent file helpers skip identical writes");
}

// --- Probe 2: Fast-Path Bypass & `rtk hook antigravity` Latency ---
console.log("\n--- Probe 2: Hook Fast-Path Bypass & RTK Delegation Latency ---");
{
  function runHook(payload) {
    const res = spawnSync(process.execPath, [hookScript], {
      input: JSON.stringify(payload),
      encoding: "utf-8"
    });
    assert.equal(res.status, 0);
    return JSON.parse(res.stdout.trim());
  }

  const t0 = performance.now();
  for (let i = 0; i < 15; i++) {
    const out = runHook({ toolCall: { name: "ask_question", args: { questions: [] } } });
    assert.equal(out.decision, "allow");
  }
  const fastElapsed = performance.now() - t0;
  assert.ok(
    fastElapsed < 15000,
    `15x fast-path non-governed bypasses exceeded conservative 15000ms ceiling (${fastElapsed.toFixed(1)}ms)`
  );
  console.log(`✓ 15x fast-path non-governed bypasses executed in ${fastElapsed.toFixed(1)}ms (< 15000ms ceiling)`);

  // Verify session state stays compact (zero recentHookCalls / writtenFiles bloat after large write_file calls)
  const { getStateDir } = await import("../scripts/state-dir.mjs");
  const bloatConvId = `conv-perf-compact-${Date.now()}`;
  const largeBody = "console.log('payload');\n".repeat(1000);
  for (let i = 0; i < 5; i++) {
    const wfOut = runHook({
      conversationId: bloatConvId,
      cwd: hermetic.profileDir,
      toolCall: { name: "write_file", args: { Path: `scratch/sample-${i}.mjs`, Content: largeBody } }
    });
    assert.equal(wfOut.decision, "allow");
  }
  const mtOut = runHook({
    conversationId: bloatConvId,
    toolCall: { name: "manage_task", args: { Action: "status", TaskId: `${bloatConvId}/task-1` } }
  });
  assert.equal(mtOut.decision, "allow");
  const sessionStatePath = path.join(getStateDir(), `agy-session-${bloatConvId}.json`);
  assert.ok(fs.existsSync(sessionStatePath), "Expected per-conversation session state file");
  const sessionStateRaw = fs.readFileSync(sessionStatePath, "utf-8");
  const sessionState = JSON.parse(sessionStateRaw);
  assert.equal(sessionState.recentHookCalls, undefined, "Session state must not persist recentHookCalls bloat");
  assert.equal(sessionState.writtenFiles, undefined, "Session state must not persist writtenFiles bloat");
  assert.ok(
    Buffer.byteLength(sessionStateRaw, "utf-8") < 4096,
    `Session state file should stay compact (< 4096 bytes), got ${Buffer.byteLength(sessionStateRaw, "utf-8")} bytes`
  );
  console.log(`✓ Session state stayed compact (${Buffer.byteLength(sessionStateRaw, "utf-8")} bytes, zero recentHookCalls/writtenFiles bloat)`);

  const t1 = performance.now();
  for (let i = 0; i < 10; i++) {
    const out = runHook({ toolCall: { name: "run_command", args: { CommandLine: "git status", WaitMsBeforeAsync: 5000 } } });
    assert.equal(out.decision, "allow");
    assert.equal(out.overwrite?.CommandLine, "rtk git status");
  }
  const rtkElapsed = performance.now() - t1;
  console.log(`✓ 10x live hook-to-rtk delegations completed in ${rtkElapsed.toFixed(1)}ms`);
}

// --- Probe 3: Streaming Transcript Health ---
console.log("\n--- Probe 3: Streaming Transcript Health ---");
{
  const syntheticConvId = `00000000-0000-4000-8000-${String(Date.now()).padStart(12, "0").slice(-12)}`;
  const logsDir = path.join(hermetic.profileDir, ".gemini", "antigravity", "brain", syntheticConvId, ".system_generated", "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const compactFile = path.join(logsDir, "transcript.jsonl");
  const fullFile = path.join(logsDir, "transcript_full.jsonl");

  const wsCompact = fs.createWriteStream(compactFile, "utf-8");
  const wsFull = fs.createWriteStream(fullFile, "utf-8");

  const TOTAL = 1200;
  for (let i = 1; i <= TOTAL; i++) {
    const fullItem = {
      step_index: i,
      type: i % 2 === 1 ? "USER_INPUT" : "PLANNER_RESPONSE",
      status: "DONE",
      created_at: new Date(1700000000000 + i * 1000).toISOString(),
      content: i >= 1190 ? `Tail payload step ${i} NEEDLE_PERF` : `Bulk filler step ${i} ${"x".repeat(200)}`
    };
    wsFull.write(JSON.stringify(fullItem) + "\n");
    if (i >= 1190 && i % 2 === 0) {
      wsCompact.write(JSON.stringify({ ...fullItem, content: `Truncated ${i}...`, truncated_fields: ["content"] }) + "\n");
    } else {
      wsCompact.write(JSON.stringify(fullItem) + "\n");
    }
  }
  await Promise.all([
    new Promise((r) => wsCompact.end(r)),
    new Promise((r) => wsFull.end(r))
  ]);

  const prevBrain = process.env.AGY_TEST_PROFILE_DIR;
  process.env.AGY_TEST_PROFILE_DIR = hermetic.profileDir;
  const tHealth = performance.now();
  const health = await checkTranscriptHealth({ ids: [syntheticConvId] });
  const healthElapsed = performance.now() - tHealth;
  if (prevBrain === undefined) delete process.env.AGY_TEST_PROFILE_DIR; else process.env.AGY_TEST_PROFILE_DIR = prevBrain;
  assert.ok(!health.error, health.error);
  assert.equal(health.sessions[0].steps, TOTAL);
  assert.equal(health.sessions[0].turns, TOTAL / 2);
  console.log(`✓ Streamed ${TOTAL} steps through transcript health in ${healthElapsed.toFixed(1)}ms`);
}

hermetic.cleanup();
console.log("\n==========================================================");
console.log("ALL PERFORMANCE & MEMORY PROBES PASSED!");
console.log("==========================================================");
