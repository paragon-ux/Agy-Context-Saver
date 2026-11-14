import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CircularRingBuffer, queryTranscript, readTranscript } from "../lib/transcript-core.mjs";
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
  console.log(`✓ 15x fast-path non-governed bypasses executed in ${fastElapsed.toFixed(1)}ms`);

  const t1 = performance.now();
  for (let i = 0; i < 10; i++) {
    const out = runHook({ toolCall: { name: "run_command", args: { CommandLine: "git status", WaitMsBeforeAsync: 5000 } } });
    assert.equal(out.decision, "allow");
    assert.equal(out.overwrite?.CommandLine, "rtk git status");
  }
  const rtkElapsed = performance.now() - t1;
  console.log(`✓ 10x live hook-to-rtk delegations completed in ${rtkElapsed.toFixed(1)}ms`);
}

// --- Probe 3: Batch Full-Transcript Dereferencing & Bounded Streaming Memory (ACS-ARCH-01) ---
console.log("\n--- Probe 3: Batch Dereferencing & Streaming Ring Bounds ---");
{
  const syntheticConvId = `conv-perf-batch-${Date.now()}`;
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

  const tRead = performance.now();
  const readRes = await readTranscript({ conversationId: syntheticConvId, lastTurns: 0, mode: "compact" });
  const readElapsed = performance.now() - tRead;
  assert.equal(readRes.totalSteps, TOTAL);
  assert.ok(readRes.selectedSteps <= 200, "lastTurns=0 must cap buffered steps at <= 200 via CircularRingBuffer");

  const tQuery = performance.now();
  const qRes = await queryTranscript({
    conversationId: syntheticConvId,
    query: "NEEDLE_PERF",
    mode: "auto",
    maxResults: 10
  });
  const qElapsed = performance.now() - tQuery;
  assert.ok(qRes.text.includes("Tail payload step 1200 NEEDLE_PERF"));

  // Summary mode skips full hydration unless needed
  const sumRes = await queryTranscript({
    conversationId: syntheticConvId,
    query: "Truncated",
    mode: "auto",
    summaryOnly: true,
    maxResults: 5
  });
  assert.ok(sumRes.displayedCount > 0);
  console.log(`✓ Streamed ${TOTAL} steps in ${readElapsed.toFixed(1)}ms; auto-dereferenced batch query in ${qElapsed.toFixed(1)}ms`);
}

// Ring buffer O(1) micro-check
{
  const ring = new CircularRingBuffer(64);
  for (let i = 0; i < 10000; i++) ring.push(i);
  const arr = ring.toArray();
  assert.equal(arr.length, 64);
  assert.equal(arr[0], 10000 - 64);
  assert.equal(arr[63], 9999);
}

hermetic.cleanup();
console.log("\n==========================================================");
console.log("ALL PERFORMANCE & MEMORY PROBES PASSED!");
console.log("==========================================================");
