import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CircularRingBuffer,
  cleanMessageContent,
  extractConvId,
  getCompiledRegex,
  readTranscript,
  queryTranscript,
  getStepDetail,
  checkContextHealth,
  getRequiredBackoffSeconds,
  getRequiredSubagentBackoffSeconds,
  extractTaskBackoffKey,
  hasValidTaskTimerCondition,
  hasValidSubagentTimerCondition,
  isSwarmPollSchedule,
  isSubagentPollSchedule,
  isRemoteCiPollSchedule,
  extractRemoteCiBackoffKey,
  listTranscriptConversations,
  exportSanitizedTranscript,
  stripSummaryStepBoilerplate,
  inspectTranscriptLineageFromFile,
  formatTranscriptItem,
  formatSingleStepDetail,
  formatTranscriptAccessStatus,
  scanRecentLaunchRestrictions,
  manageTranscriptAccessPolicy,
  recordTranscriptHookGrant,
  consumeTranscriptAccessGrant,
  ACTIVE_SWARM_WINDOW_MS
} from "../lib/transcript-core.mjs";
import { findGoverningPolicyForCaller } from "../lib/access-policy.mjs";
import { isProtectedInternalOutPath } from "../lib/path-guards.mjs";
import { runStatus } from "../scripts/install-register.mjs";
import { getStateDir } from "../scripts/state-dir.mjs";
import { createRtkShim, prependToPath } from "./helpers/hermetic-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliScript = path.resolve(__dirname, "../bin/agy-context.mjs");

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "agy-transcript-test-"));
const brainDir = path.join(tempHome, ".gemini", "antigravity", "brain");
const shimDir = path.join(tempHome, "rtk-bin");
createRtkShim(shimDir, "1.1.0");
const testEnv = { ...process.env, AGY_TEST_PROFILE_DIR: tempHome, AGY_BRAIN_DIR: brainDir };
prependToPath(shimDir, testEnv);
process.env.AGY_TEST_PROFILE_DIR = tempHome;
process.env.AGY_BRAIN_DIR = brainDir;
prependToPath(shimDir);

function runCli(args, env = testEnv) {
  return spawnSync(process.execPath, [cliScript, ...args], {
    encoding: "utf-8",
    env
  });
}

console.log("Running Agy-Context-Saver v2.0.0 Transcript Engine & CLI Tests...\n");

try {
  // ==========================================================================
  // 1. ACS-ARCH-01: O(1) CircularRingBuffer & bounded lastTurns: 0 reading
  // ==========================================================================
  console.log("--- 1. CircularRingBuffer & Bounded Streaming readTranscript (ACS-ARCH-01) ---");
  {
    const ring = new CircularRingBuffer(3);
    for (let i = 1; i <= 7; i++) ring.push(i);
    assert.deepEqual(ring.toArray(), [5, 6, 7], "Ring buffer must evict oldest entries in O(1)");

    const bigConv = "conv-large-ring";
    const bigLogs = path.join(brainDir, bigConv, ".system_generated", "logs");
    fs.mkdirSync(bigLogs, { recursive: true });
    const lines = [];
    for (let i = 1; i <= 500; i++) {
      lines.push(JSON.stringify({
        step_index: i,
        type: i % 2 === 1 ? "USER_INPUT" : "PLANNER_RESPONSE",
        content: `Turn step ${i}`,
        created_at: new Date(1700000000000 + i * 1000).toISOString()
      }));
    }
    fs.writeFileSync(path.join(bigLogs, "transcript.jsonl"), lines.join("\n") + "\n", "utf-8");

    const resZero = await readTranscript({ conversationId: bigConv, lastTurns: 0, mode: "full" });
    assert.equal(resZero.totalSteps, 500);
    assert.ok(resZero.selectedSteps <= 200, `lastTurns: 0 must stay bounded (got ${resZero.selectedSteps})`);
    assert.ok(resZero.steps[resZero.steps.length - 1].step_index === 500, "Must keep trailing steps");
    console.log(`✓ CircularRingBuffer bounded 500-step log with lastTurns=0 to ${resZero.selectedSteps} steps`);
  }

  // ==========================================================================
  // 2. ACS-MCP-04: Media/CRLF Stripping Before Slicing, Safe Base64, Line Clamp
  // ==========================================================================
  console.log("\n--- 2. Message Sanitization & Base64 Safety (ACS-MCP-04) ---");
  {
    const longB64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".repeat(5) + "==";
    const sha256 = "a3f5c8e1902b4d7c1234567890abcdef1234567890abcdef1234567890abcdef";
    const longUrlToken = "https://example.com/" + "A1b2C3d4".repeat(40);
    const longSnake = "my_very_long_snake_case_identifier_".repeat(10);
    const input = [
      "warning: in the working copy of 'src/a.js', LF will be replaced by CRLF the next time Git touches it",
      `Image: data:image/png;base64,${longB64}`,
      `RawBlob: ${longB64}`,
      `CommitSHA: ${sha256}`,
      `Docs: ${longUrlToken}`,
      `Symbol: ${longSnake}`,
      "Actual useful message survives!"
    ].join("\n");

    const cleaned = cleanMessageContent(input, 1500);
    assert.equal(cleaned.includes("will be replaced by"), false, "CRLF warning must be stripped BEFORE slicing");
    assert.ok(cleaned.includes("[Embedded Media/Binary Omitted]"), "data:image must be stripped");
    assert.ok(cleaned.includes("[Binary/Base64 Payload Omitted]"), "raw >=256 base64 must be stripped");
    assert.ok(cleaned.includes(sha256), "Hex SHA-256 must NOT be corrupted");
    assert.ok(cleaned.includes(longUrlToken), "URL tokens must NOT be treated as base64");
    assert.ok(cleaned.includes("my_very_long_snake_case_identifier_"), "Long snake_case identifiers must NOT be stripped");
    assert.ok(cleaned.includes("Actual useful message survives!"));

    // Single-line 2500-char payload without newlines must still clamp
    const singleLine = "Z".repeat(2500);
    const clampedSingle = cleanMessageContent(singleLine, 5000);
    assert.ok(clampedSingle.includes("[line clamped]"), "Single-line log > 1000 chars must be clamped");

    // Ellipsis mode honors maxChars and appends `...` cleanly without verbose banner
    const ellipsis = cleanMessageContent("Hello ".repeat(50), 60, { truncationStyle: "ellipsis" });
    assert.ok(ellipsis.length <= 60 && ellipsis.endsWith("..."), "Ellipsis mode must stay within limit");
    assert.equal(ellipsis.includes("[Content Truncated"), false);
    console.log("✓ Sanitization strips media/CRLF first, preserves hashes/URLs/identifiers, and clamps single-line blobs");
  }

  // ==========================================================================
  // 3. ACS-MCP-02, 03, 05, 09, 10: Query Auto-Hydration, Multi-Tool, Errors, Summary
  // ==========================================================================
  console.log("\n--- 3. Forensic Query Auto-Hydration, Multi-Tool, Error Role & Summary ---");
  {
    const richConv = "conv-rich-forensic";
    const logsDir = path.join(brainDir, richConv, ".system_generated", "logs");
    fs.mkdirSync(logsDir, { recursive: true });

    const fullSteps = [
      {
        step_index: 1,
        type: "USER_INPUT",
        status: "DONE",
        content: "Notice: handle potential error strings cleanly without false alarms.",
        created_at: "2026-11-10T10:00:00Z"
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "Prefix summary only... [hidden needle: NEEDLE_IN_FULL_TAIL]",
        thinking: "Secret thinking reasoning here",
        tool_calls: [
          { name: "run_command", args: { CommandLine: "npm test" } },
          { name: "read_file", args: { Path: "lib/transcript-core.mjs", StartLine: 1, EndLine: 50 } }
        ],
        created_at: "2026-11-10T10:00:10Z"
      },
      {
        step_index: 3,
        type: "PLANNER_RESPONSE",
        status: "ERROR",
        content: "Command failed with exit code 2",
        tool_calls: [{ name: "run_command", status: "ERROR", args: { CommandLine: "broken-cmd" } }],
        created_at: "2026-11-10T10:00:20Z"
      }
    ];

    const compactSteps = fullSteps.map((s) => {
      if (s.step_index === 2) {
        return {
          ...s,
          content: "Prefix summary only...",
          truncated_fields: ["content"]
        };
      }
      return s;
    });

    fs.writeFileSync(path.join(logsDir, "transcript.jsonl"), compactSteps.map((s) => JSON.stringify(s)).join("\n") + "\n");
    fs.writeFileSync(path.join(logsDir, "transcript_full.jsonl"), fullSteps.map((s) => JSON.stringify(s)).join("\n") + "\n");

    // ACS-MCP-02: mode="auto" finds needle inside truncated tail!
    const needleRes = await queryTranscript({
      conversationId: richConv,
      query: "NEEDLE_IN_FULL_TAIL",
      mode: "auto"
    });
    assert.equal(needleRes.matchedCount, 1, "mode='auto' must search full tail when truncated_fields present");
    assert.match(needleRes.text, /NEEDLE_IN_FULL_TAIL/);

    // ACS-MCP-09: roles=["error"] matches ONLY structured status/error fields, NOT "error" prose in step 1!
    const errRes = await queryTranscript({
      conversationId: richConv,
      roles: ["error"]
    });
    assert.equal(errRes.matchedCount, 1, "roles=['error'] must match only structured error step 3, not prose step 1");
    assert.ok(errRes.text.includes("Step 3") && !errRes.text.includes("Step 1"));
    assert.match(errRes.text, /\[ERROR\]/);

    // ACS-MCP-03 & 10: summaryOnly respects ellipsis, tool calls, and [ERROR] badge
    const sumRes = await queryTranscript({
      conversationId: richConv,
      roles: ["all"],
      summaryOnly: true,
      includeToolCalls: true
    });
    assert.match(sumRes.text, /\[Step 2 \| ASSISTANT\]\*\*.*\[tools: run_command\(CommandLine="npm test"\), read_file\(Path="lib\/transcript-core\.mjs"\)\]/);
    assert.match(sumRes.text, /\[Step 3 \| ASSISTANT\]\*\* \[ERROR\]/);

    // ACS-MCP-05: step tool_args across ALL tool_calls[0..N]
    const allToolArgs = await getStepDetail({
      conversationId: richConv,
      stepIndex: 2,
      field: "tool_args"
    });
    assert.match(allToolArgs.text, /run_command/);
    assert.match(allToolArgs.text, /read_file/);

    const pathKeyOnly = await getStepDetail({
      conversationId: richConv,
      stepIndex: 2,
      field: "tool_args:Path"
    });
    assert.match(pathKeyOnly.text, /lib\/transcript-core\.mjs/);
    // Default query includes GENERIC & SYSTEM steps; `--roles generic` & `--roles error` include non-zero shell exit codes
    const genericConv = "conv-generic-exit";
    const genericLogs = path.join(brainDir, genericConv, ".system_generated", "logs");
    fs.mkdirSync(genericLogs, { recursive: true });
    fs.writeFileSync(
      path.join(genericLogs, "transcript_full.jsonl"),
      [
        JSON.stringify({ step_index: 1, type: "SYSTEM_MESSAGE", content: "Swarm wakeup", created_at: "2026-11-10T10:00:00Z" }),
        JSON.stringify({ step_index: 2, type: "GENERIC", status: "DONE", content: "Created At: x\nCommand exited with code 0.\nShowing docs mentioning Command exited with code 7.", created_at: "2026-11-10T10:00:05Z" }),
        JSON.stringify({ step_index: 3, type: "GENERIC", status: "DONE", content: "Created At: x\nCompleted At: y\nCommand exited with code 7.\n\nCommand output:\nfatal probe error", created_at: "2026-11-10T10:00:10Z" })
      ].join("\n") + "\n"
    );
    const defaultQueryCli = runCli(["transcript", "query", "--id", genericConv, "--query", "fatal probe error", "--summary"]);
    assert.equal(defaultQueryCli.status, 0, defaultQueryCli.stderr);
    assert.match(defaultQueryCli.stdout, /Step 3 \| GENERIC/);
    const genericRoleRes = await queryTranscript({ conversationId: genericConv, roles: ["generic"] });
    assert.equal(genericRoleRes.matchedCount, 2, "roles=['generic'] must return GENERIC steps");
    const exitErrRes = await queryTranscript({ conversationId: genericConv, roles: ["error"] });
    assert.equal(exitErrRes.matchedCount, 1, "roles=['error'] must match header exit code 7 and skip Command output prose");
    assert.match(exitErrRes.text, /Step 3/);

    // Batch multi-step & range extraction in `transcript step`, `--full-args` / `--field` in `transcript query`, and auto-expanded range defaultMaxResults
    const batchConv = "conv-batch-range";
    const batchLogs = path.join(brainDir, batchConv, ".system_generated", "logs");
    fs.mkdirSync(batchLogs, { recursive: true });
    const longCommand = "mkdir -p scratch/multi-agent/live-w2/team-alpha/specialist-1 && sed -n '1,15p' scripts/state-dir.mjs > scratch/multi-agent/live-w2/team-alpha/specialist-1/slice-a.txt && echo FULL_ARGS_END_MARKER_OK";
    const batchSteps = Array.from({ length: 12 }, (_, idx) => ({
      step_index: idx + 1,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: `Step ${idx + 1} body`,
      tool_calls: [{ name: "run_command", args: { CommandLine: `${longCommand}_${idx + 1}` } }],
      created_at: `2026-11-10T10:00:${String(idx + 10).padStart(2, "0")}Z`
    }));
    fs.writeFileSync(path.join(batchLogs, "transcript.jsonl"), batchSteps.map((s) => JSON.stringify(s)).join("\n") + "\n");
    fs.writeFileSync(path.join(batchLogs, "transcript_full.jsonl"), batchSteps.map((s) => JSON.stringify(s)).join("\n") + "\n");

    // 1) Multi-step CSV & range selector (`--step 2,5-7,10..11` and `--start 1 --end 3`)
    const multiStepCli = runCli(["transcript", "step", "--id", batchConv, "--step", "2,5-6,10..11", "--field", "tool_args", "--json"]);
    assert.equal(multiStepCli.status, 0, multiStepCli.stderr);
    const multiStepJson = JSON.parse(multiStepCli.stdout);
    assert.deepEqual(multiStepJson.stepIndices, [2, 5, 6, 10, 11]);
    assert.equal(multiStepJson.steps.length, 5);
    assert.match(multiStepJson.steps[0].data[0].args.CommandLine, /FULL_ARGS_END_MARKER_OK_2/);

    const rangeStepCli = runCli(["transcript", "step", "--id", batchConv, "--start", "1", "--end", "3", "--field", "tool_args"]);
    assert.equal(rangeStepCli.status, 0, rangeStepCli.stderr);
    assert.match(rangeStepCli.stdout, /Step 1 Tool Arguments/);
    assert.match(rangeStepCli.stdout, /Step 2 Tool Arguments/);
    assert.match(rangeStepCli.stdout, /Step 3 Tool Arguments/);
    assert.match(rangeStepCli.stdout, /FULL_ARGS_END_MARKER_OK_3/);

    // 2) Auto-expanded defaultMaxResults when `--start` and `--end` are both passed (returns all 10 steps in [1, 10] instead of clamping at 5)
    const rangeQueryRes = await queryTranscript({
      conversationId: batchConv,
      startStep: 1,
      endStep: 10
    });
    assert.equal(rangeQueryRes.displayedCount, 10, "Explicit [startStep, endStep] range without maxResults must auto-expand up to 50 steps instead of clamping at 5");
    assert.doesNotMatch(rangeQueryRes.text, /FULL_ARGS_END_MARKER_OK_1/, "Default query without fullArgs clamps >80c strings");

    // 3) `--full-args` and `--field tool_args` on `transcript query` preserve >80c CommandLine arguments
    const fullArgsCli = runCli(["transcript", "query", "--id", batchConv, "--start", "1", "--end", "4", "--full-args"]);
    assert.equal(fullArgsCli.status, 0, fullArgsCli.stderr);
    assert.match(fullArgsCli.stdout, /FULL_ARGS_END_MARKER_OK_1/);
    assert.match(fullArgsCli.stdout, /FULL_ARGS_END_MARKER_OK_4/);

    const fieldQueryCli = runCli(["transcript", "query", "--id", batchConv, "--start", "2", "--end", "3", "--field", "tool_args"]);
    assert.equal(fieldQueryCli.status, 0, fieldQueryCli.stderr);
    assert.match(fieldQueryCli.stdout, /### Step 2 Tool Arguments/);
    assert.match(fieldQueryCli.stdout, /FULL_ARGS_END_MARKER_OK_2/);
    assert.match(fieldQueryCli.stdout, /### Step 3 Tool Arguments/);
    assert.match(fieldQueryCli.stdout, /FULL_ARGS_END_MARKER_OK_3/);

    console.log("✓ Truncated tail auto-search, generic/default roles, exit-code errors, summary formatting, batch step ranges, and --full-args/--field query verified");
  }

  // ==========================================================================
  // 4. ACS-MCP-01 & ACS-HOOK-12: Unified Context Health & Polling Violation Parity
  // ==========================================================================
  console.log("\n--- 4. Unified Context Health & Proportional Backoff Evaluator ---");
  {
    assert.equal(getRequiredBackoffSeconds(0), 0);
    assert.equal(getRequiredBackoffSeconds(1), 30);
    assert.equal(getRequiredBackoffSeconds(2), 75);
    assert.equal(getRequiredBackoffSeconds(3), 188);
    assert.equal(getRequiredSubagentBackoffSeconds(0), 180);
    assert.equal(getRequiredSubagentBackoffSeconds(1), 450);
    assert.equal(getRequiredSubagentBackoffSeconds(2), 600);
    assert.equal(getRequiredSubagentBackoffSeconds(3), 600);
    assert.equal(extractTaskBackoffKey("manage_task", { TaskId: "conv-1/task-150" }), "task-150");
    assert.equal(extractTaskBackoffKey("schedule", { TimerCondition: "conv-1/task-150", Prompt: "Check status" }), "task-150");
    assert.equal(extractTaskBackoffKey("schedule", { TimerCondition: "7657a17a-258b-4f47-a860-4cf3072800f6", Prompt: "Check subagent" }), "7657a17a-258b-4f47-a860-4cf3072800f6");
    assert.equal(hasValidTaskTimerCondition({ TimerCondition: "conv-1/task-1" }), true);
    assert.equal(hasValidTaskTimerCondition({ TimerCondition: "never" }), false);
    assert.equal(hasValidSubagentTimerCondition({ TimerCondition: "7657a17a-258b-4f47-a860-4cf3072800f6" }), true);
    assert.equal(hasValidSubagentTimerCondition({ TimerCondition: "conv-1/task-1" }), false);
    assert.equal(isSwarmPollSchedule({ Prompt: "Check swarm status", TimerCondition: "7657a17a-258b-4f47-a860-4cf3072800f6" }), true);
    assert.equal(isSubagentPollSchedule({ Prompt: "Check if subagent stalled", TimerCondition: "7657a17a-258b-4f47-a860-4cf3072800f6" }), true);

    const pollConv = "conv-polling-health";
    const pollLogs = path.join(brainDir, pollConv, ".system_generated", "logs");
    fs.mkdirSync(pollLogs, { recursive: true });
    const baseMs = Date.parse("2026-11-10T12:00:00Z");
    const pollSteps = [
      { step_index: 1, type: "USER_INPUT", content: "Start", created_at: new Date(baseMs).toISOString() },
      // Legal poll #1 at t=0s
      { step_index: 2, type: "PLANNER_RESPONSE", tool_calls: [{ name: "manage_task", args: { Action: "status", TaskId: "t1" } }], created_at: new Date(baseMs + 1000).toISOString() },
      // Premature poll #2 at t+5s (requires >= 30s!) -> violation
      { step_index: 3, type: "PLANNER_RESPONSE", tool_calls: [{ name: "manage_task", args: { Action: "status", TaskId: "t1" } }], created_at: new Date(baseMs + 6000).toISOString() },
      // Short schedule poll -> violation
      { step_index: 4, type: "PLANNER_RESPONSE", tool_calls: [{ name: "schedule", args: { DurationSeconds: 5, Prompt: "Check status of task-1", TimerCondition: "task-1" } }], created_at: new Date(baseMs + 10000).toISOString() },
      // Valid kill (must NOT count as violation!)
      { step_index: 5, type: "PLANNER_RESPONSE", tool_calls: [{ name: "manage_task", args: { Action: "kill", TaskId: "t1" } }], created_at: new Date(baseMs + 11000).toISOString() }
    ];
    fs.writeFileSync(path.join(pollLogs, "transcript.jsonl"), pollSteps.map((s) => JSON.stringify(s)).join("\n") + "\n");

    const health = await checkContextHealth({ conversationId: pollConv });
    assert.equal(health.metrics.legalChecks, 1);
    assert.equal(health.metrics.pollingViolations, 2);
    assert.match(health.status, /WARNING/);

    // Per-task isolation, watchdog wakeup inspections, and conditioned direct-subagent (>=180s) watchdogs
    const healthyWatchdogConv = "conv-healthy-watchdogs";
    const healthyWatchdogLogs = path.join(brainDir, healthyWatchdogConv, ".system_generated", "logs");
    fs.mkdirSync(healthyWatchdogLogs, { recursive: true });
    const subA = "7657a17a-258b-4f47-a860-4cf3072800f6";
    const subB = "88888888-258b-4f47-a860-4cf3072800f6";
    const healthySteps = [
      { step_index: 1, type: "USER_INPUT", content: "Run tasks", created_at: new Date(baseMs).toISOString() },
      { step_index: 2, type: "PLANNER_RESPONSE", tool_calls: [{ name: "schedule", args: { DurationSeconds: 45, Prompt: "Check status of task-1", TimerCondition: `${healthyWatchdogConv}/task-1` } }], created_at: new Date(baseMs + 1000).toISOString() },
      { step_index: 3, type: "PLANNER_RESPONSE", tool_calls: [{ name: "manage_task", args: { Action: "status", TaskId: "task-1" } }], created_at: new Date(baseMs + 46000).toISOString() },
      { step_index: 4, type: "PLANNER_RESPONSE", tool_calls: [{ name: "schedule", args: { DurationSeconds: 75, Prompt: "Check status of task-1", TimerCondition: `${healthyWatchdogConv}/task-1` } }], created_at: new Date(baseMs + 47000).toISOString() },
      // Fresh task-2 immediately starts at Level 0 (45s allowed without inheriting task-1 Level 3!)
      { step_index: 5, type: "PLANNER_RESPONSE", tool_calls: [{ name: "schedule", args: { DurationSeconds: 45, Prompt: "Check status of task-2", TimerCondition: `${healthyWatchdogConv}/task-2` } }], created_at: new Date(baseMs + 48000).toISOString() },
      { step_index: 6, type: "PLANNER_RESPONSE", tool_calls: [{ name: "manage_task", args: { Action: "status", TaskId: "task-3" } }], created_at: new Date(baseMs + 49000).toISOString() },
      // Direct subagent stall watchdogs (180s -> 450s on subA, fresh 180s on subB)
      { step_index: 7, type: "PLANNER_RESPONSE", tool_calls: [{ name: "schedule", args: { DurationSeconds: 180, Prompt: "Check if subagent stalled", TimerCondition: subA } }], created_at: new Date(baseMs + 50000).toISOString() },
      { step_index: 8, type: "PLANNER_RESPONSE", tool_calls: [{ name: "schedule", args: { DurationSeconds: 450, Prompt: "Check if subagent stalled", TimerCondition: subA } }], created_at: new Date(baseMs + 230000).toISOString() },
      { step_index: 9, type: "PLANNER_RESPONSE", tool_calls: [{ name: "schedule", args: { DurationSeconds: 180, Prompt: "Check if direct subagent stalled", TimerCondition: subB } }], created_at: new Date(baseMs + 231000).toISOString() }
    ];
    fs.writeFileSync(path.join(healthyWatchdogLogs, "transcript.jsonl"), healthySteps.map((s) => JSON.stringify(s)).join("\n") + "\n");
    const healthyWatchdogRes = await checkContextHealth({ conversationId: healthyWatchdogConv });
    assert.equal(healthyWatchdogRes.metrics.pollingViolations, 0, "Per-task watchdogs and >=180s conditioned direct-subagent watchdogs must have 0 violations");
    assert.equal(healthyWatchdogRes.metrics.legalChecks, 8);
    assert.equal(healthyWatchdogRes.status, "HEALTHY");

    // Violation parity: unconditioned task poll, <180s subagent poll, unconditioned subagent poll, and /swarm poll with UUID
    const badWatchdogConv = "conv-bad-watchdogs";
    const badWatchdogLogs = path.join(brainDir, badWatchdogConv, ".system_generated", "logs");
    fs.mkdirSync(badWatchdogLogs, { recursive: true });
    const badSteps = [
      { step_index: 1, type: "USER_INPUT", content: "Poll", created_at: new Date(baseMs).toISOString() },
      { step_index: 2, type: "PLANNER_RESPONSE", tool_calls: [{ name: "schedule", args: { DurationSeconds: 45, Prompt: "Check status of task-1" } }], created_at: new Date(baseMs + 1000).toISOString() },
      { step_index: 3, type: "PLANNER_RESPONSE", tool_calls: [{ name: "schedule", args: { DurationSeconds: 60, Prompt: "Check if subagent stalled", TimerCondition: subA } }], created_at: new Date(baseMs + 2000).toISOString() },
      { step_index: 4, type: "PLANNER_RESPONSE", tool_calls: [{ name: "schedule", args: { DurationSeconds: 180, Prompt: "Check if subagent stalled" } }], created_at: new Date(baseMs + 3000).toISOString() },
      { step_index: 5, type: "PLANNER_RESPONSE", tool_calls: [{ name: "schedule", args: { DurationSeconds: 180, Prompt: "Check if swarm worker stalled", TimerCondition: subA } }], created_at: new Date(baseMs + 4000).toISOString() }
    ];
    fs.writeFileSync(path.join(badWatchdogLogs, "transcript.jsonl"), badSteps.map((s) => JSON.stringify(s)).join("\n") + "\n");
    const badWatchdogRes = await checkContextHealth({ conversationId: badWatchdogConv });
    assert.equal(badWatchdogRes.metrics.pollingViolations, 4, "Unconditioned task/subagent polls, <180s subagent polls, and /swarm polls must all count as violations");
    assert.match(badWatchdogRes.status, /CRITICAL/);

    // Auto-clamp state sync: a conditioned 60s Level-2 task watchdog flags the under-sized attempt (1 violation)
    // AND advances the bucket to Level 3 + arms pendingWatchdog (75s), so wakeup manage_task(status) at +75s is legal
    const clampSyncConv = "conv-clamp-sync";
    const clampSyncLogs = path.join(brainDir, clampSyncConv, ".system_generated", "logs");
    fs.mkdirSync(clampSyncLogs, { recursive: true });
    const clampSyncSteps = [
      { step_index: 1, type: "USER_INPUT", content: "Run", created_at: new Date(baseMs).toISOString() },
      { step_index: 2, type: "PLANNER_RESPONSE", tool_calls: [{ name: "schedule", args: { DurationSeconds: 45, Prompt: "Check status of task-1", TimerCondition: `${clampSyncConv}/task-1` } }], created_at: new Date(baseMs + 1000).toISOString() },
      { step_index: 3, type: "PLANNER_RESPONSE", tool_calls: [{ name: "manage_task", args: { Action: "status", TaskId: "task-1" } }], created_at: new Date(baseMs + 46000).toISOString() },
      // Under-sized 60s Level-2 conditioned watchdog (hook auto-clamps to 75s -> 1 violation, advances bucket to Level 3)
      { step_index: 4, type: "PLANNER_RESPONSE", tool_calls: [{ name: "schedule", args: { DurationSeconds: 60, Prompt: "Check status of task-1", TimerCondition: `${clampSyncConv}/task-1` } }], created_at: new Date(baseMs + 47000).toISOString() },
      // Wakeup inspection after clamped 75s -> legal!
      { step_index: 5, type: "PLANNER_RESPONSE", tool_calls: [{ name: "manage_task", args: { Action: "status", TaskId: "task-1" } }], created_at: new Date(baseMs + 122000).toISOString() },
      // Next watchdog properly uses Level 3 (188s) -> legal!
      { step_index: 6, type: "PLANNER_RESPONSE", tool_calls: [{ name: "schedule", args: { DurationSeconds: 188, Prompt: "Check status of task-1", TimerCondition: `${clampSyncConv}/task-1` } }], created_at: new Date(baseMs + 123000).toISOString() }
    ];
    fs.writeFileSync(path.join(clampSyncLogs, "transcript.jsonl"), clampSyncSteps.map((s) => JSON.stringify(s)).join("\n") + "\n");
    const clampSyncRes = await checkContextHealth({ conversationId: clampSyncConv });
    assert.equal(clampSyncRes.metrics.pollingViolations, 1, "Only the under-sized 60s Level-2 attempt should register as a violation");
    assert.equal(clampSyncRes.metrics.legalChecks, 4, "Wakeup inspection at +75s and Level-3 188s watchdog must stay synced with live hook state");

    console.log("✓ Unified health evaluator enforces per-task & direct-subagent backoff parity without false-flagging kill/list");
  }

  // ==========================================================================
  // 5. ACS-MCP-05: Active Swarm Ambiguity Disambiguation & Realpath Containment
  // ==========================================================================
  console.log("\n--- 5. Active Swarm Disambiguation, Containment & CLI Subcommands ---");
  {
    const swarmHome = fs.mkdtempSync(path.join(os.tmpdir(), "agy-swarm-disambig-"));
    const swarmBrain = path.join(swarmHome, ".gemini", "antigravity", "brain");
    for (const id of ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"]) {
      const d = path.join(swarmBrain, id, ".system_generated", "logs");
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "transcript.jsonl"), JSON.stringify({ step_index: 1, type: "USER_INPUT", content: `hi ${id}` }) + "\n");
    }
    const swarmEnv = { ...testEnv, AGY_TEST_PROFILE_DIR: swarmHome, AGY_BRAIN_DIR: swarmBrain };
    delete swarmEnv.GEMINI_CONVERSATION_ID;
    const ambigCli = runCli(["transcript", "health", "--json"], swarmEnv);
    assert.notEqual(ambigCli.status, 0, "Omitting --id with 2 active transcripts must fail cleanly");
    assert.match(ambigCli.stderr, /Ambiguous active conversation/);
    assert.match(ambigCli.stderr, /11111111-1111-1111-1111-111111111111/);

    // Explicit --id succeeds via CLI
    const okCli = runCli(["transcript", "read", "--id", "11111111-1111-1111-1111-111111111111", "--json"], swarmEnv);
    assert.equal(okCli.status, 0, `CLI failed: ${okCli.stderr}`);
    assert.equal(JSON.parse(okCli.stdout).convId, "11111111-1111-1111-1111-111111111111");

    // Path traversal --id is rejected
    const badId = runCli(["transcript", "read", "--id", "../../etc/passwd"], swarmEnv);
    assert.notEqual(badId.status, 0);

    // Symlink escaping brainDir is rejected by realpath containment
    const outsideFile = path.join(swarmHome, "outside.jsonl");
    fs.writeFileSync(outsideFile, JSON.stringify({ step_index: 1, type: "USER_INPUT", content: "secret" }) + "\n");
    const symConvLogs = path.join(swarmBrain, "33333333-3333-3333-3333-333333333333", ".system_generated", "logs");
    fs.mkdirSync(symConvLogs, { recursive: true });
    try {
      fs.symlinkSync(outsideFile, path.join(symConvLogs, "transcript.jsonl"));
      const symRes = runCli(["transcript", "read", "--id", "33333333-3333-3333-3333-333333333333"], swarmEnv);
      assert.notEqual(symRes.status, 0, "Symlink escaping brainDir must be denied by realpath check");
    } catch {
      // Windows unprivileged symlink skipped gracefully
    }

    fs.rmSync(swarmHome, { recursive: true, force: true });
    console.log("✓ Active swarm disambiguation, realpath containment, and bin/agy-context.mjs CLI verified");
  }

  console.log("\n--- 6. Intuitive CLI Aliases, Positionals & Step Slicing ---");
  {
    const convTarget = "conv-batch-range";
    const grepRes = runCli(["transcript", "grep", "FULL_ARGS_END_MARKER_OK", "--id", convTarget, "--include-tools", "--summary"]);
    assert.equal(grepRes.status, 0, "transcript grep positional alias must succeed");
    assert.ok(grepRes.stdout.includes("Step 1"), "transcript grep --summary must output matched steps");

    const statsRes = runCli(["transcript", "stats", convTarget]);
    assert.equal(statsRes.status, 0, "transcript stats positional <id> alias must succeed");
    assert.ok(statsRes.stdout.includes("Health") || statsRes.stdout.includes("HEALTHY"), "transcript stats must output health report");

    const toolsRes = runCli(["transcript", "tools", "--id", convTarget, "--start", "1", "--end", "2"]);
    assert.equal(toolsRes.status, 0, "transcript tools alias must succeed");
    assert.ok(toolsRes.stdout.includes("CommandLine"), "transcript tools must extract tool_args");

    const outlineRes = runCli(["transcript", "read", "--id", convTarget, "--outline"]);
    assert.equal(outlineRes.status, 0, "transcript read --outline must succeed");
    assert.ok(outlineRes.stdout.includes("Step 1"), "transcript read --outline must delegate to summary outline");

    const stepTailRes = runCli(["transcript", "step", "1-2", "--id", convTarget, "--field", "tool_args", "--tail", "5", "--full"]);
    assert.equal(stepTailRes.status, 0, "transcript step positional selector with --tail and --full must succeed");
    assert.ok(stepTailRes.stdout.includes("Step 1") && stepTailRes.stdout.includes("Step 2"), "step 1-2 must return both steps");

    const listRes = runCli(["transcript", "list", "--limit", "5", "--json"]);
    assert.equal(listRes.status, 0, "transcript list --json must succeed");
    const listJson = JSON.parse(listRes.stdout);
    assert.ok(listJson.total >= 2 && Array.isArray(listJson.conversations), "transcript list must list conversations in brainDir");
    console.log("✓ grep/stats/tools/outline/list aliases, positional selectors, and step --tail/--head/--full verified");
  }

  console.log("\n--- 7. Transcript Access Policy & Runtime Hook-Grant Verification ---");
  {
    const convTarget = "conv-batch-range";
    // 1. Default status is OPEN
    const stOpen = runCli(["transcript", "access", "--status", "--json"]);
    assert.equal(stOpen.status, 0);
    const stOpenJson = JSON.parse(stOpen.stdout);
    assert.equal(stOpenJson.mode, "open");
    assert.equal(stOpenJson.active, false);

    // 2. Parent sets mode=deny via PreToolUse mutation grant
    recordTranscriptHookGrant({ callerConvId: "parent-owner", subcommand: "access", mode: "open", isMutation: true });
    const lockRes = runCli(["transcript", "access", "--off", "--json"]);
    assert.equal(lockRes.status, 0, "Authorized parent transcript access --off must succeed");
    const lockJson = JSON.parse(lockRes.stdout);
    assert.equal(lockJson.mode, "deny");
    assert.equal(lockJson.ownerId, "parent-owner");

    // 3. Direct readTranscript / CLI list without a fresh PreToolUse hook grant MUST fail closed
    manageTranscriptAccessPolicy({ off: true, _testAuthorizedOwner: "parent-owner" });
    const blockedDirect = await readTranscript({ conversationId: convTarget });
    assert.equal(blockedDirect.isError, true, "Direct readTranscript without PreToolUse hook grant must fail closed when policy is active");
    assert.match(blockedDirect.text, /restricted by parent governance policy/);

    const blockedList = runCli(["transcript", "list"]);
    assert.notEqual(blockedList.status, 0, "CLI transcript list without PreToolUse hook grant must fail closed");

    // 4. Child subprocess trying `transcript access --on` without PreToolUse mutation grant MUST fail closed
    const unauthUnlock = runCli(["transcript", "access", "--on"]);
    assert.notEqual(unauthUnlock.status, 0, "Unauthorized child subprocess transcript access --on must fail closed");

    // 5. With a valid PreToolUse hook grant (mode: self-only), reading own transcript succeeds ONCE (single-use in-process & cross-process)
    recordTranscriptHookGrant({ callerConvId: convTarget, subcommand: "read", targetConvId: convTarget, mode: "self-only" });
    const allowedSelf = await readTranscript({ conversationId: convTarget, lastTurns: 1 });
    assert.ok(!allowedSelf.isError, "Authorized self-only read of own transcript must succeed");

    const blockedSameProcessReuse = await readTranscript({ conversationId: convTarget, lastTurns: 1 });
    assert.equal(blockedSameProcessReuse.isError, true, "Second call in the same process must fail closed after single-use grant consumption (L39)");

    // 5b. Cross-session --id read in self-only mode fails closed even with a fresh grant
    recordTranscriptHookGrant({ callerConvId: convTarget, subcommand: "read", targetConvId: convTarget, mode: "self-only" });
    const blockedCross = await readTranscript({ conversationId: "conv-rich-forensic", lastTurns: 1 });
    assert.equal(blockedCross.isError, true, "Cross-session read in self-only mode must fail closed inside transcript-core");

    // 5c. Explicit --file outside caller's brain directory fails closed inside transcript-core under self-only and active policies (L38)
    const externalJsonl = path.join(tempHome, "external-outside-brain.jsonl");
    fs.writeFileSync(externalJsonl, JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "outside" }) + "\n", "utf-8");

    recordTranscriptHookGrant({ callerConvId: convTarget, subcommand: "read", targetConvId: convTarget, mode: "self-only" });
    const blockedExternalSelfOnly = await readTranscript({ filePath: externalJsonl, lastTurns: 1 });
    assert.equal(blockedExternalSelfOnly.isError, true, "Self-only --file outside caller brain folder must fail closed inside transcript-core (L38)");
    assert.match(blockedExternalSelfOnly.text, /Cross-session '--file' access outside/);

    const otherBrainTranscript = path.join(brainDir, "conv-rich-forensic", ".system_generated", "logs", "transcript.jsonl");
    recordTranscriptHookGrant({ callerConvId: convTarget, subcommand: "read", targetConvId: convTarget, mode: "self-only" });
    const blockedSiblingFileSelfOnly = await readTranscript({ filePath: otherBrainTranscript, lastTurns: 1 });
    assert.equal(blockedSiblingFileSelfOnly.isError, true, "Self-only --file pointing to another session's brain folder must fail closed (L38)");

    recordTranscriptHookGrant({ callerConvId: "allowlisted-worker", subcommand: "read", mode: "open" });
    const blockedExternalUnderPolicy = await readTranscript({ filePath: externalJsonl, lastTurns: 1 });
    assert.equal(blockedExternalUnderPolicy.isError, true, "External --file outside brainDir must fail closed while any parent policy is active (L38)");
    assert.match(blockedExternalUnderPolicy.text, /escapes brain directory/);

    // 5d. Subcommand and targetConvId grant binding (L39)
    recordTranscriptHookGrant({ callerConvId: "allowlisted-worker", subcommand: "health", targetConvId: convTarget, mode: "open" });
    const blockedSubcommandMismatch = await readTranscript({ conversationId: convTarget, lastTurns: 1 });
    assert.equal(blockedSubcommandMismatch.isError, true, "Grant for 'health' must be rejected when calling readTranscript (L39)");
    assert.match(blockedSubcommandMismatch.text, /subcommand mismatch/);

    // Caller-supplied subcommand override (e.g., passing subcommand:'health' or 'resolve' to readTranscript) must be ignored
    recordTranscriptHookGrant({ callerConvId: "allowlisted-worker", subcommand: "health", targetConvId: convTarget, mode: "open" });
    const blockedSubOverride = await readTranscript({ conversationId: convTarget, lastTurns: 1, subcommand: "health" });
    assert.equal(blockedSubOverride.isError, true, "Caller-supplied subcommand option on readTranscript must not bypass grant binding (Defect 3A)");

    recordTranscriptHookGrant({ callerConvId: "allowlisted-worker", subcommand: "read", targetConvId: convTarget, mode: "open" });
    const blockedTargetMismatch = await readTranscript({ conversationId: "conv-rich-forensic", lastTurns: 1 });
    assert.equal(blockedTargetMismatch.isError, true, "Grant bound to convTarget must be rejected when requesting conv-rich-forensic (L39)");
    assert.match(blockedTargetMismatch.text, /target mismatch/);

    // Grant issued for 'current' must reject explicit cross-session conversationId (Defect 3B)
    recordTranscriptHookGrant({ callerConvId: "allowlisted-worker", subcommand: "read", targetConvId: "current", mode: "open" });
    const blockedCurrentWildcard = await readTranscript({ conversationId: "conv-rich-forensic", lastTurns: 1 });
    assert.equal(blockedCurrentWildcard.isError, true, "Grant for 'current' must reject explicit cross-session conversationId (Defect 3B)");
    assert.match(blockedCurrentWildcard.text, /target mismatch/);

    // Early validation error in getStepDetail must consume disk grant (Defect 2A)
    recordTranscriptHookGrant({ callerConvId: convTarget, subcommand: "step", targetConvId: convTarget, mode: "self-only" });
    const invalidStepRes = await getStepDetail({ conversationId: convTarget, stepIndex: "invalid-selector" });
    assert.equal(invalidStepRes.isError, true, "Invalid step selector must return error");
    const reuseAfterInvalidStep = await getStepDetail({ conversationId: convTarget, stepIndex: 1 });
    assert.equal(reuseAfterInvalidStep.isError, true, "Grant must be consumed even when getStepDetail fails early validation (Defect 2A)");

    // Concurrent Promise.all([getStepDetail, readTranscript]) must not share in-memory grant (Defect 2B)
    recordTranscriptHookGrant({ callerConvId: convTarget, subcommand: "step", targetConvId: convTarget, mode: "self-only" });
    const [concStep, concRead] = await Promise.all([
      getStepDetail({ conversationId: convTarget, stepIndex: 1 }),
      readTranscript({ conversationId: convTarget, lastTurns: 1 })
    ]);
    assert.ok(!concStep.isError, "Authorized getStepDetail in Promise.all must succeed");
    assert.equal(concRead.isError, true, "Concurrent readTranscript in Promise.all must not reuse getStepDetail's grant (Defect 2B)");

    // Governance mismatch on getStepDetail(--id) must preserve exact governance error (Defect 2C)
    recordTranscriptHookGrant({ callerConvId: "allowlisted-worker", subcommand: "step", targetConvId: convTarget, mode: "open" });
    const stepTargetMismatch = await getStepDetail({ conversationId: "conv-rich-forensic", stepIndex: 1 });
    assert.equal(stepTargetMismatch.isError, true);
    assert.match(stepTargetMismatch.text, /target mismatch/, "getStepDetail must preserve exact governance error on --id (Defect 2C)");

    // checkContextHealth with external transcriptPath spoofing callerConvId must fail under active restriction (Defect 1A)
    const spoofedExternalFile = path.join(tempHome, `${convTarget}.jsonl`);
    fs.writeFileSync(spoofedExternalFile, JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "spoof" }) + "\n", "utf-8");
    recordTranscriptHookGrant({ callerConvId: convTarget, subcommand: "health", targetConvId: convTarget, mode: "self-only" });
    const blockedSpoofHealth = await checkContextHealth({ transcriptPath: spoofedExternalFile });
    assert.equal(blockedSpoofHealth.isError, true, "checkContextHealth with external transcriptPath must fail under active restriction (Defect 1A)");

    // 6. Parent resets policy back to OPEN
    recordTranscriptHookGrant({ callerConvId: "parent-owner", subcommand: "access", mode: "open", isMutation: true });
    const unlockRes = runCli(["transcript", "access", "--on", "--json"]);
    assert.equal(unlockRes.status, 0, "Authorized parent transcript access --on must succeed");
    const unlockJson = JSON.parse(unlockRes.stdout);
    assert.equal(unlockJson.mode, "open");
    assert.equal(unlockJson.active, false);

    // 7. Concurrent atomic grants (ACS-ARCH-001) + terminal operator exemption
    recordTranscriptHookGrant({ callerConvId: "parent-owner", subcommand: "access", mode: "open", isMutation: true });
    manageTranscriptAccessPolicy({ callerConvId: "parent-owner", mode: "deny" });
    try {
      recordTranscriptHookGrant({ callerConvId: "allowlisted-worker", subcommand: "read", targetConvId: convTarget, mode: "open" });
      recordTranscriptHookGrant({ callerConvId: "allowlisted-worker", subcommand: "query", targetConvId: "conv-rich-forensic", mode: "open" });
      const [gRead, gQuery] = await Promise.all([
        readTranscript({ conversationId: convTarget, lastTurns: 1 }),
        queryTranscript({ conversationId: "conv-rich-forensic", query: "npm", includeToolCalls: true })
      ]);
      assert.ok(!gRead.isError, "Concurrent atomic grant #1 (read) must succeed");
      assert.ok(!gQuery.isError, "Concurrent atomic grant #2 (query) must succeed");

      // External/unrelated session must NOT be locked out merely by another session's launch-directive session file (ACS-ARCH-001)
      recordTranscriptHookGrant({ callerConvId: "parent-owner", subcommand: "access", mode: "open", isMutation: true });
      manageTranscriptAccessPolicy({ callerConvId: "parent-owner", mode: "open" });
      const { getStateDir } = await import("../scripts/state-dir.mjs");
      const launchSessionFile = path.join(getStateDir(), "agy-session-launch-child-iso.json");
      fs.writeFileSync(launchSessionFile, JSON.stringify({ pollCount: 0, denials: 0, lineage: { launchDirective: "deny" } }));
      try {
        const externalSessionRead = await readTranscript({ conversationId: convTarget, lastTurns: 1 });
        assert.ok(!externalSessionRead.isError, "Launch-directive lock on another session must not block unrelated callers (ACS-ARCH-001)");
      } finally {
        try { fs.unlinkSync(launchSessionFile); } catch {}
      }
    } finally {
      recordTranscriptHookGrant({ callerConvId: "parent-owner", subcommand: "access", mode: "open", isMutation: true });
      manageTranscriptAccessPolicy({ callerConvId: "parent-owner", mode: "open" });
    }

    // 8. ACS-RUN-008/009/010 & ACS-ARCH-002 regressions
    const manyToolsConv = "conv-many-tools";
    const manyLogs = path.join(brainDir, manyToolsConv, ".system_generated", "logs");
    fs.mkdirSync(manyLogs, { recursive: true });
    const manyLines = [
      JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "Turn 0 user prompt", created_at: "2026-11-16T00:00:00Z" }),
      JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", content: "Turn 0 reply", created_at: "2026-11-16T00:00:01Z" })
    ];
    for (let s = 2; s < 562; s++) {
      manyLines.push(JSON.stringify({
        step_index: s,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: s === 561 ? "schedule" : "run_command", args: s === 561 ? { DurationSeconds: 10, Prompt: "Check swarm status" } : { CommandLine: `echo step-${s}` } }],
        created_at: "2026-11-16T00:00:02Z"
      }));
    }
    fs.writeFileSync(path.join(manyLogs, "transcript.jsonl"), manyLines.join("\n") + "\n");

    const toolsCli = runCli(["transcript", "tools", "--id", manyToolsConv]);
    assert.equal(toolsCli.status, 0, toolsCli.stderr);
    const shownMatch = toolsCli.stdout.match(/Matched Steps:\s+(\d+)\s+\(showing\s+(\d+)\)/);
    assert.ok(shownMatch && Number(shownMatch[2]) > 50, `tools must exceed old 50-item ceiling (got: ${shownMatch?.[0]})`);
    assert.match(toolsCli.stdout, /24 KB safety ceiling|Truncated:/i);

    const limitTruncCli = runCli(["transcript", "query", "--id", manyToolsConv, "--roles", "assistant", "--summary", "--limit", "75"]);
    assert.equal(limitTruncCli.status, 0, limitTruncCli.stderr);
    assert.match(limitTruncCli.stdout, /Matched Steps:\s+561\s+\(showing 75\b/);
    assert.match(limitTruncCli.stdout, /Truncated: showing last 75 of 561 matching steps/);

    const turnConv = "conv-single-turn-anchor";
    const turnLogs = path.join(brainDir, turnConv, ".system_generated", "logs");
    fs.mkdirSync(turnLogs, { recursive: true });
    fs.writeFileSync(
      path.join(turnLogs, "transcript.jsonl"),
      [
        JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "Turn 0 user prompt", created_at: "2026-11-16T00:00:00Z" }),
        JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", content: "Step 1 work", created_at: "2026-11-16T00:00:01Z" }),
        JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", content: "Step 2 work", created_at: "2026-11-16T00:00:02Z" }),
        JSON.stringify({ step_index: 3, type: "PLANNER_RESPONSE", content: "Step 3 work", created_at: "2026-11-16T00:00:03Z" })
      ].join("\n") + "\n"
    );
    const lastTurnRead = await readTranscript({ conversationId: turnConv, lastTurns: 1 });
    assert.ok(!lastTurnRead.isError);
    assert.match(lastTurnRead.text, /Turn 0 user prompt/, "read --last-turns 1 must anchor to latest USER_INPUT even with multiple PLANNER_RESPONSE steps (ACS-RUN-009)");

    const lastTurnQuery = await queryTranscript({
      conversationId: turnConv,
      lastTurns: 1,
      query: "Step 1 work"
    });
    assert.ok(!lastTurnQuery.isError);
    assert.equal(
      lastTurnQuery.matchedCount,
      1,
      "query --last-turns 1 must anchor on USER_INPUT (with literal prefilter not skipping USER_INPUT) matching readTranscript (ACS-RUN-009)"
    );
    const lastTurnQueryEmpty = await queryTranscript({
      conversationId: turnConv,
      lastTurns: 1
    });
    assert.ok(!lastTurnQueryEmpty.isError);
    assert.equal(
      lastTurnQueryEmpty.matchedCount,
      4,
      "query --last-turns 1 without literal filter must include USER_INPUT and all 3 PLANNER_RESPONSE steps (ACS-RUN-009)"
    );

    const healthSched = await checkContextHealth({ conversationId: manyToolsConv });
    assert.ok(!healthSched.isError);
    assert.equal(healthSched.metrics.pollingViolations, 1, "checkContextHealth must count swarm poll schedule() events cleanly (ACS-RUN-009)");

    const badTtl = runCli(["transcript", "access", "--off", "--ttl", "0"]);
    assert.notEqual(badTtl.status, 0, "--ttl 0 must be rejected (ACS-RUN-010)");
    const badListLimit = runCli(["transcript", "list", "--limit", "abc"]);
    assert.notEqual(badListLimit.status, 0, "list --limit abc must be rejected (ACS-RUN-010)");

    // Multi-product brain discovery without AGY_BRAIN_DIR override
    const altBrain = path.join(tempHome, ".gemini", "antigravity-cli", "brain");
    const altConv = "cli-product-conv";
    fs.mkdirSync(path.join(altBrain, altConv, ".system_generated", "logs"), { recursive: true });
    fs.writeFileSync(
      path.join(altBrain, altConv, ".system_generated", "logs", "transcript.jsonl"),
      JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "CLI product prompt", created_at: "2026-11-16T00:01:00Z" }) + "\n"
    );
    const multiEnv = { ...testEnv };
    delete multiEnv.AGY_BRAIN_DIR;
    const multiList = runCli(["transcript", "list", "--limit", "50", "--json"], multiEnv);
    assert.equal(multiList.status, 0, multiList.stderr);
    const listIds = JSON.parse(multiList.stdout).conversations.map((c) => c.conversationId);
    assert.ok(listIds.includes(altConv), "transcript list must aggregate antigravity-cli/brain (ACS-ARCH-002)");

    const prevBrainEnv = process.env.AGY_BRAIN_DIR;
    delete process.env.AGY_BRAIN_DIR;
    try {
      const cliTrFile = path.join(altBrain, altConv, ".system_generated", "logs", "transcript.jsonl");
      assert.equal(
        extractConvId(cliTrFile, { strictBrainContainment: true }),
        altConv,
        "extractConvId({ strictBrainContainment: true }) must recognize ~/.gemini/antigravity-cli/brain paths (ACS-ARCH-002)"
      );
      assert.equal(
        extractConvId(path.join(tempHome, "outside", altConv, "transcript.jsonl"), { strictBrainContainment: true }),
        null,
        "extractConvId({ strictBrainContainment: true }) must return null outside brain roots"
      );

      // Self-only caller on antigravity-cli/brain using --file must succeed via hook grant + extractConvId
      manageTranscriptAccessPolicy({ callerConvId: "owner-cli", mode: "self-only" });
      recordTranscriptHookGrant({ callerConvId: altConv, subcommand: "read", targetConvId: altConv, mode: "self-only" });
      const prevEnvConv = process.env.GEMINI_CONVERSATION_ID;
      process.env.GEMINI_CONVERSATION_ID = altConv;
      try {
        const selfCliRes = await readTranscript({ filePath: cliTrFile });
        assert.ok(!selfCliRes.isError, `self-only read --file on antigravity-cli/brain failed: ${selfCliRes.error}`);
        assert.match(selfCliRes.text, /CLI product prompt/);
      } finally {
        if (prevEnvConv !== undefined) process.env.GEMINI_CONVERSATION_ID = prevEnvConv;
        else delete process.env.GEMINI_CONVERSATION_ID;
      }

      // Concurrent grant isolation across separate processes when GEMINI_CONVERSATION_ID is unset
      const grantA = { callerConvId: "concurrent-a", subcommand: "read", targetConvId: turnConv, mode: "open" };
      const grantB = { callerConvId: "concurrent-b", subcommand: "read", targetConvId: manyToolsConv, mode: "open" };
      const spawnCore = (code, extraEnv = {}) =>
        spawnSync(process.execPath, ["--input-type=module", "-e", code], {
          cwd: path.resolve(__dirname, ".."),
          encoding: "utf-8",
          env: { ...multiEnv, ...extraEnv }
        });
      const recA = spawnCore(`import { recordTranscriptHookGrant } from "./lib/transcript-core.mjs"; recordTranscriptHookGrant(${JSON.stringify(grantA)});`);
      const recB = spawnCore(`import { recordTranscriptHookGrant } from "./lib/transcript-core.mjs"; recordTranscriptHookGrant(${JSON.stringify(grantB)});`);
      assert.equal(recA.status, 0, recA.stderr);
      assert.equal(recB.status, 0, recB.stderr);

      const noEnvConsumeEnv = { ...multiEnv };
      delete noEnvConsumeEnv.GEMINI_CONVERSATION_ID;
      const consumeWithTwo = spawnCore(`import { consumeTranscriptAccessGrant } from "./lib/transcript-core.mjs"; consumeTranscriptAccessGrant();`, noEnvConsumeEnv);
      assert.equal(consumeWithTwo.status, 0, consumeWithTwo.stderr);

      const afterPartialConsume = runCli(["transcript", "health", "--id", turnConv], noEnvConsumeEnv);
      assert.equal(afterPartialConsume.status, 1, "mismatched health without health grant must fail rather than stealing concurrent read grants");

      // Verify per-caller reads succeed using their own GEMINI_CONVERSATION_ID in separate processes
      const subReadA = runCli(["transcript", "read", "--id", turnConv, "--last-turns", "1"], { ...multiEnv, GEMINI_CONVERSATION_ID: "concurrent-a" });
      const subReadB = runCli(["transcript", "read", "--id", manyToolsConv, "--last-turns", "1"], { ...multiEnv, GEMINI_CONVERSATION_ID: "concurrent-b" });
      assert.equal(subReadA.status, 0, `concurrent-a grant should remain intact: ${subReadA.stderr}`);
      assert.equal(subReadB.status, 0, `concurrent-b grant should remain intact: ${subReadB.stderr}`);

      // ACS-SVC-002: Reset owner-cli lock cleanly and verify transcript list --parent/--lineage + transcript export --sanitized
      manageTranscriptAccessPolicy({ on: true, _testAuthorizedOwner: "owner-cli" });
      const parentUuid = "parent-cohort-uuid";
      const swarmChildA = "swarm-child-alpha";
      const swarmChildB = "swarm-child-beta";
      const subChildC = "subagent-child-gamma";
      const unrelatedChild = "other-parent-child";

      const writeConvLines = (rootDir, convId, lines) => {
        const logDir = path.join(rootDir, convId, ".system_generated", "logs");
        fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(path.join(logDir, "transcript.jsonl"), lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
      };

      writeConvLines(brainDir, parentUuid, [
        { step_index: 0, type: "USER_INPUT", content: "Coordinate storage review.", created_at: "2026-11-16T01:00:00Z" }
      ]);
      writeConvLines(brainDir, swarmChildA, [
        {
          step_index: 0,
          type: "SYSTEM_MESSAGE",
          source: "SYSTEM",
          content: `[Message] timestamp=2026-11-16T01:00:01Z sender=${parentUuid} priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message: Your assignment (recorded on the board as #1 for @storage-wal):\nReview WAL.`,
          created_at: "2026-11-16T01:00:01Z"
        },
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          thinking: "SECRET_INTERNAL_THINKING_DO_NOT_LEAK",
          content: "Checked WAL with Bearer supersecret_token_123456 and data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA",
          tool_calls: [{ name: "run_command", args: { CommandLine: "npm test", Content: "HUGE_UNEXPORTED_FILE_BODY" } }],
          created_at: "2026-11-16T01:00:02Z"
        }
      ]);
      writeConvLines(altBrain, swarmChildB, [
        {
          step_index: 0,
          type: "SYSTEM_MESSAGE",
          source: "SYSTEM",
          content: `[Message] timestamp=2026-11-16T01:00:03Z sender=${parentUuid} priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message: Your assignment (recorded on the board as #2 for @storage-index):\nReview index.`,
          created_at: "2026-11-16T01:00:03Z"
        },
        {
          step_index: 1,
          type: "GENERIC",
          status: "ERROR",
          content: "Command exited with code 1.\nENOENT: missing fixture",
          created_at: "2026-11-16T01:00:04Z"
        }
      ]);
      writeConvLines(brainDir, subChildC, [
        {
          step_index: 0,
          type: "SYSTEM_MESSAGE",
          source: "SYSTEM",
          content: `[Message] timestamp=2026-11-16T01:00:05Z sender=${parentUuid} priority=MESSAGE_PRIORITY_HIGH content=Inspect docs.`,
          created_at: "2026-11-16T01:00:05Z"
        }
      ]);
      writeConvLines(brainDir, unrelatedChild, [
        {
          step_index: 0,
          type: "SYSTEM_MESSAGE",
          source: "SYSTEM",
          content: `[Message] timestamp=2026-11-16T01:00:06Z sender=completely-different-parent priority=MESSAGE_PRIORITY_HIGH content=Other task.`,
          created_at: "2026-11-16T01:00:06Z"
        }
      ]);

      // 1. transcript list --parent & --lineage across multi-product brain roots
      const lineageList = runCli(["transcript", "list", "--parent", parentUuid, "--lineage", "--json"], multiEnv);
      assert.equal(lineageList.status, 0, lineageList.stderr);
      const lineageJson = JSON.parse(lineageList.stdout);
      assert.equal(lineageJson.total, 3, "Must match exact 3 children of parentUuid across brain roots");
      assert.equal(lineageJson.parentFilter, parentUuid);
      const byConv = new Map(lineageJson.conversations.map((c) => [c.conversationId, c]));
      assert.equal(byConv.get(swarmChildA).rosterName, "storage-wal");
      assert.equal(byConv.get(swarmChildA).sessionKind, "swarm");
      assert.equal(byConv.get(swarmChildA).stepCount, 2);
      assert.equal(byConv.get(swarmChildB).rosterName, "storage-index");
      assert.equal(byConv.get(swarmChildB).brainRoot, "antigravity-cli");
      assert.equal(byConv.get(subChildC).sessionKind, "subagent");
      assert.equal(byConv.has(unrelatedChild), false);

      const lineageText = runCli(["transcript", "list", "--parent", parentUuid, "--lineage"], multiEnv);
      assert.equal(lineageText.status, 0, lineageText.stderr);
      assert.match(lineageText.stdout, /roster: @storage-wal/);
      assert.match(lineageText.stdout, /steps: 2/);

      // 2. transcript export requires --sanitized (fail closed if omitted)
      const unsanitizedExport = runCli(["transcript", "export", "--id", swarmChildA], multiEnv);
      assert.notEqual(unsanitizedExport.status, 0, "export without --sanitized must fail closed");
      assert.match(unsanitizedExport.stderr, /--sanitized/);

      // 2b. Redaction before 36-char tool truncation, non-priority body key omission, --start/--end, malformed lines, and empty transcript
      const secretEdgeConv = "secret-edge-conv";
      writeConvLines(brainDir, secretEdgeConv, [
        {
          step_index: 0,
          type: "USER_INPUT",
          content: "Inspect data:application/octet-stream;base64,SGVsbG8= and token",
          created_at: "2026-11-16T01:01:00Z"
        },
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          content: "Running secret checks",
          tool_calls: [
            { name: "run_command", args: { CommandLine: "curl -u user -H 'X-Key: sk-1234567890abcdef123456'" } },
            { name: "custom_write", args: { Content: "RAW_BODY_ONLY_MUST_NOT_LEAK" } }
          ],
          created_at: "2026-11-16T01:01:01Z"
        },
        {
          step_index: 2,
          type: "PLANNER_RESPONSE",
          content: "Final step",
          created_at: "2026-11-16T01:01:02Z"
        }
      ]);
      // Append a malformed JSONL line to verify streaming resilience
      fs.appendFileSync(path.join(brainDir, secretEdgeConv, ".system_generated", "logs", "transcript.jsonl"), "{broken_json_line\n");
      const secretExport = runCli(
        ["transcript", "export", "--id", secretEdgeConv, "--sanitized", "--start", "0", "--end", "1"],
        multiEnv
      );
      assert.equal(secretExport.status, 0, secretExport.stderr);
      assert.equal(secretExport.stdout.includes("1234567890abcdef"), false, "API key prefix must be redacted before 36-char tool truncation");
      assert.equal(secretExport.stdout.includes("RAW_BODY_ONLY_MUST_NOT_LEAK"), false, "Non-priority Content arg must be omitted");
      assert.equal(secretExport.stdout.includes("SGVsbG8="), false, "Non-image data URI base64 must be stripped");
      assert.match(secretExport.stdout, /Steps Shown: 2 of 2/);
      assert.equal(secretExport.stdout.includes("Final step"), false, "--end 1 must exclude step 2");

      // Invalid --start/--end and empty --parent must fail closed
      const badRangeExport = runCli(
        ["transcript", "export", "--id", secretEdgeConv, "--sanitized", "--start", "5", "--end", "2"],
        multiEnv
      );
      assert.notEqual(badRangeExport.status, 0, "--start > --end must fail closed");
      const emptyParentList = runCli(["transcript", "list", "--parent", ""], multiEnv);
      assert.notEqual(emptyParentList.status, 0, "Empty --parent must fail closed");

      // Empty transcript file exports cleanly with "(no matching steps)"
      const emptyConv = "empty-export-conv";
      const emptyLogs = path.join(brainDir, emptyConv, ".system_generated", "logs");
      fs.mkdirSync(emptyLogs, { recursive: true });
      fs.writeFileSync(path.join(emptyLogs, "transcript.jsonl"), "");
      const emptyExp = runCli(["transcript", "export", "--id", emptyConv, "--sanitized"], multiEnv);
      assert.equal(emptyExp.status, 0, emptyExp.stderr);
      assert.match(emptyExp.stdout, /\(no matching steps\)/);

      // Symlinked conversation directory in brain root must not be listed
      const outsideBrainDir = path.join(tempHome, "outside-brain-conv");
      const outsideLogs = path.join(outsideBrainDir, ".system_generated", "logs");
      fs.mkdirSync(outsideLogs, { recursive: true });
      fs.writeFileSync(path.join(outsideLogs, "transcript.jsonl"), JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "outside" }) + "\n");
      let createdBrainSym = false;
      try {
        fs.symlinkSync(outsideBrainDir, path.join(brainDir, "symlinked-outside-conv"));
        createdBrainSym = true;
      } catch {}
      if (createdBrainSym) {
        const listWithSym = runCli(["transcript", "list", "--limit", "50", "--json"], multiEnv);
        assert.equal(listWithSym.status, 0, listWithSym.stderr);
        const listedIds = JSON.parse(listWithSym.stdout).conversations.map((c) => c.conversationId);
        assert.equal(listedIds.includes("symlinked-outside-conv"), false, "list must exclude symlinked conversation dirs");
      }

      // 3. transcript export --parent <parentUuid> --sanitized --out <path> produces sanitized index
      const scratchOut = path.join(tempHome, "scratch-export", "transcript-index.md");
      const parentExportCli = runCli(
        ["transcript", "export", "--parent", parentUuid, "--sanitized", "--out", scratchOut],
        multiEnv
      );
      assert.equal(parentExportCli.status, 0, parentExportCli.stderr);
      assert.ok(fs.existsSync(scratchOut), "export --out must create sanitized index file");
      const exportedMd = fs.readFileSync(scratchOut, "utf8");
      assert.match(exportedMd, /# Sanitized Transcript Index/);
      assert.match(exportedMd, /@storage-wal/);
      assert.match(exportedMd, /@storage-index/);
      assert.match(exportedMd, /run_command\(CommandLine="npm test"\)/);
      assert.match(exportedMd, /Bearer \[REDACTED\]/);
      assert.match(exportedMd, /\[Embedded Media\/Binary Omitted\]/);
      assert.equal(exportedMd.includes("SECRET_INTERNAL_THINKING_DO_NOT_LEAK"), false, "Sanitized export must omit thinking blocks");
      assert.equal(exportedMd.includes("HUGE_UNEXPORTED_FILE_BODY"), false, "Sanitized export must omit raw Content payloads");
      assert.equal(exportedMd.includes("supersecret_token_123456"), false, "Sanitized export must redact bearer tokens");

      // 4. --out protection rejects .system_generated, stateDir, ~/.gemini/config, benchmarks, symlink-to-benchmarks, dangling symlinks, and .. traversal
      const sysGenOut = path.join(brainDir, swarmChildA, ".system_generated", "leak.md");
      const blockedOutCli = runCli(
        ["transcript", "export", "--id", swarmChildA, "--sanitized", "--out", sysGenOut],
        multiEnv
      );
      assert.notEqual(blockedOutCli.status, 0, "export --out into .system_generated must fail closed");

      const stateLeakOut = path.join(getStateDir(), "leak.md");
      const blockedStateOut = runCli(
        ["transcript", "export", "--id", swarmChildA, "--sanitized", "--out", stateLeakOut],
        multiEnv
      );
      assert.notEqual(blockedStateOut.status, 0, "export --out into stateDir must fail closed (ACS-TEST-002)");

      const geminiCfgOut = path.join(tempHome, ".gemini", "config", "hooks.json.md");
      const blockedCfgOut = runCli(
        ["transcript", "export", "--id", swarmChildA, "--sanitized", "--out", geminiCfgOut],
        multiEnv
      );
      assert.notEqual(blockedCfgOut.status, 0, "export --out into ~/.gemini/config must fail closed (ACS-TEST-002)");

      const blockedRelDotDot = runCli(
        ["transcript", "export", "--id", swarmChildA, "--sanitized", "--out", "../outside.md"],
        multiEnv
      );
      assert.notEqual(blockedRelDotDot.status, 0, "export --out with '..' traversal must fail closed (ACS-TEST-002)");

      const danglingSymOut = path.join(tempHome, "dangling-out.md");
      let danglingSymCreated = false;
      try {
        fs.symlinkSync(path.join(tempHome, "does-not-exist-target.md"), danglingSymOut);
        danglingSymCreated = true;
      } catch {}
      if (danglingSymCreated) {
        const blockedDangling = runCli(
          ["transcript", "export", "--id", swarmChildA, "--sanitized", "--out", danglingSymOut],
          multiEnv
        );
        assert.notEqual(blockedDangling.status, 0, "export --out targeting a dangling symlink must fail closed (ACS-PR4-RUN-003)");
      }

      const benchOut = path.join(tempHome, "benchmarks", "leak.json");
      const blockedBenchOut = runCli(
        ["transcript", "export", "--id", swarmChildA, "--sanitized", "--out", benchOut],
        multiEnv
      );
      assert.notEqual(blockedBenchOut.status, 0, "export --out into benchmarks/ must fail closed");

      fs.mkdirSync(path.join(tempHome, "benchmarks"), { recursive: true });
      let createdBenchSym = false;
      const benchSymLink = path.join(tempHome, "scratch-bench-link");
      try {
        fs.symlinkSync(path.join(tempHome, "benchmarks"), benchSymLink);
        createdBenchSym = true;
      } catch {}
      if (createdBenchSym) {
        const blockedSymBench = runCli(
          ["transcript", "export", "--id", swarmChildA, "--sanitized", "--out", path.join(benchSymLink, "sub", "leak.md")],
          multiEnv
        );
        assert.notEqual(blockedSymBench.status, 0, "export --out through symlink into benchmarks/ must fail closed");
      }

      // Positional comma-separated multi-id export under active policy binds sorted multi: grant key
      manageTranscriptAccessPolicy({ callerConvId: "owner-exp", mode: "self-only" });
      recordTranscriptHookGrant({
        callerConvId: "owner-exp",
        subcommand: "export",
        targetConvId: `multi:${[swarmChildA, swarmChildB].sort().join(",")}`,
        mode: "open"
      });
      const multiPosCli = runCli(
        ["transcript", "export", `${swarmChildB},${swarmChildA}`, "--sanitized", "--json"],
        { ...multiEnv, GEMINI_CONVERSATION_ID: "owner-exp" }
      );
      assert.equal(multiPosCli.status, 0, multiPosCli.stderr);
      assert.equal(JSON.parse(multiPosCli.stdout).exportedCount, 2);
      manageTranscriptAccessPolicy({ on: true, _testAuthorizedOwner: "owner-exp" });

      // 5. Under active policy restriction, export --parent / --id require matching PreToolUse grant (L39)
      manageTranscriptAccessPolicy({ callerConvId: "owner-exp", mode: "self-only" });
      const blockedExportNoGrant = runCli(["transcript", "export", "--parent", parentUuid, "--sanitized"], multiEnv);
      assert.notEqual(blockedExportNoGrant.status, 0, "export without PreToolUse grant must fail closed under policy");

      recordTranscriptHookGrant({
        callerConvId: "owner-exp",
        subcommand: "export",
        targetConvId: `parent:${parentUuid}`,
        mode: "open"
      });
      const grantedParentExport = runCli(
        ["transcript", "export", "--parent", parentUuid, "--sanitized", "--json"],
        { ...multiEnv, GEMINI_CONVERSATION_ID: "owner-exp" }
      );
      assert.equal(grantedParentExport.status, 0, grantedParentExport.stderr);
      assert.equal(JSON.parse(grantedParentExport.stdout).exportedCount, 3);

      // Single-use grant consumed: immediate second call must fail closed
      const secondParentExport = runCli(
        ["transcript", "export", "--parent", parentUuid, "--sanitized"],
        { ...multiEnv, GEMINI_CONVERSATION_ID: "owner-exp" }
      );
      assert.notEqual(secondParentExport.status, 0, "Reusing consumed export grant must fail closed (L39)");

      // self-only grant rejects cross-session and parent exports
      recordTranscriptHookGrant({
        callerConvId: swarmChildA,
        subcommand: "export",
        targetConvId: swarmChildA,
        mode: "self-only"
      });
      const selfCrossExport = runCli(
        ["transcript", "export", "--id", swarmChildB, "--sanitized"],
        { ...multiEnv, GEMINI_CONVERSATION_ID: swarmChildA }
      );
      assert.notEqual(selfCrossExport.status, 0, "self-only export grant must reject cross-session --id");
      manageTranscriptAccessPolicy({ on: true, _testAuthorizedOwner: "owner-exp" });

      // 6. ACS-LIVE-SVC-001: Step 0..2 leading `[swarm] new board message` notifications must NOT shadow Step 1/2 `Your assignment` coordinator sender=
      const liveCoordId = "live-coord-uuid-001";
      const liveW1 = "live-swarm-w1";
      const liveW2 = "live-swarm-w2";
      const liveW3 = "live-swarm-w3";
      writeConvLines(brainDir, liveW1, [
        {
          step_index: 0,
          type: "SYSTEM_MESSAGE",
          source: "SYSTEM",
          content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-16T10:00:00Z sender=${liveCoordId} priority=MESSAGE_PRIORITY_HIGH content=Your assignment (recorded on the board as #1 for @acs-lead):\n[agy-transcript-access: allow]\nLead\n</SYSTEM_MESSAGE>`,
          created_at: "2026-11-16T10:00:00Z"
        }
      ]);
      writeConvLines(brainDir, liveW2, [
        {
          step_index: 0,
          type: "SYSTEM_MESSAGE",
          source: "SYSTEM",
          content: `[Message] timestamp=2026-11-16T10:00:01Z sender=${liveW1} priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #1`,
          created_at: "2026-11-16T10:00:01Z"
        },
        {
          step_index: 1,
          type: "SYSTEM_MESSAGE",
          source: "SYSTEM",
          content: `[Message] timestamp=2026-11-16T10:00:02Z sender=${liveCoordId} priority=MESSAGE_PRIORITY_HIGH content=Your assignment (recorded on the board as #2 for @acs-runtime):\n[agy-transcript-access: deny]\nRuntime`,
          created_at: "2026-11-16T10:00:02Z"
        }
      ]);
      writeConvLines(altBrain, liveW3, [
        {
          step_index: 0,
          type: "SYSTEM_MESSAGE",
          source: "SYSTEM",
          content: `[Message] timestamp=2026-11-16T10:00:03Z sender=${liveW1} priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #1`,
          created_at: "2026-11-16T10:00:03Z"
        },
        {
          step_index: 1,
          type: "SYSTEM_MESSAGE",
          source: "SYSTEM",
          content: `[Message] timestamp=2026-11-16T10:00:04Z sender=${liveW2} priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #2`,
          created_at: "2026-11-16T10:00:04Z"
        },
        {
          step_index: 2,
          type: "SYSTEM_MESSAGE",
          source: "SYSTEM",
          content: `[Message] timestamp=2026-11-16T10:00:05Z sender=${liveCoordId} priority=MESSAGE_PRIORITY_HIGH content=Your assignment (recorded on the board as #3 for @acs-docs):\n[agy-transcript-access: deny]\nDocs`,
          created_at: "2026-11-16T10:00:05Z"
        }
      ]);
      const w2Lineage = inspectTranscriptLineageFromFile(path.join(brainDir, liveW2, ".system_generated", "logs", "transcript.jsonl"));
      assert.equal(w2Lineage.parentConvId, liveCoordId, "Step 1 coordinator assignment sender= must override Step 0 board notification sender=");
      assert.equal(w2Lineage.rosterName, "acs-runtime");
      assert.equal(w2Lineage.launchDirective, "deny");
      const w3Lineage = inspectTranscriptLineageFromFile(path.join(altBrain, liveW3, ".system_generated", "logs", "transcript.jsonl"));
      assert.equal(w3Lineage.parentConvId, liveCoordId, "Step 2 coordinator assignment sender= must override leading board messages");

      // Large-swarm regression (>12 leading board messages before Your assignment)
      const liveW14 = "live-swarm-w14";
      const w14Steps = [];
      for (let b = 0; b < 14; b++) {
        w14Steps.push({
          step_index: b,
          type: "SYSTEM_MESSAGE",
          source: "SYSTEM",
          content: `[Message] timestamp=2026-11-16T10:00:00Z sender=sibling-${b} priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #${b + 1}`,
          created_at: "2026-11-16T10:00:00Z"
        });
      }
      w14Steps.push({
        step_index: 14,
        type: "SYSTEM_MESSAGE",
        source: "SYSTEM",
        content: `[Message] timestamp=2026-11-16T10:00:14Z sender=${liveCoordId} priority=MESSAGE_PRIORITY_HIGH content=Your assignment (recorded on the board as #15 for @worker-14):\n[agy-transcript-access: deny]\nWorker 14`,
        created_at: "2026-11-16T10:00:14Z"
      });
      writeConvLines(brainDir, liveW14, w14Steps);
      const w14Lineage = inspectTranscriptLineageFromFile(path.join(brainDir, liveW14, ".system_generated", "logs", "transcript.jsonl"));
      assert.equal(w14Lineage.parentConvId, liveCoordId, "Step 14 coordinator assignment must still bind parentConvId (>12 leading board messages)");
      assert.equal(w14Lineage.launchDirective, "deny");

      const prevTestBrain = process.env.AGY_BRAIN_DIR;
      const prevTestProfile = process.env.AGY_TEST_PROFILE_DIR;
      process.env.AGY_TEST_PROFILE_DIR = tempHome;
      delete process.env.AGY_BRAIN_DIR;
      try {
        const listedLive = listTranscriptConversations({ parentId: liveCoordId, includeLineage: true });
        assert.equal(listedLive.total, 4, "list --parent must find all 4 swarm workers despite leading board notifications (ACS-LIVE-SVC-001)");

        // 7. ACS-PR4-SVC-001: Direct ESM listTranscriptConversations() must enforce verifyTranscriptCoreAccess under active policy
        manageTranscriptAccessPolicy({ callerConvId: "owner-list-svc", mode: "self-only" });
        const deniedDirectList = listTranscriptConversations({ parentId: liveCoordId, includeLineage: true });
        assert.equal(deniedDirectList.isError, true, "Direct listTranscriptConversations() must fail closed without 'list' grant (ACS-PR4-SVC-001)");
        recordTranscriptHookGrant({ callerConvId: "owner-list-svc", subcommand: "list", mode: "open" });
        const allowedDirectList = listTranscriptConversations({ parentId: liveCoordId, includeLineage: true });
        assert.equal(allowedDirectList.total, 4, "Direct listTranscriptConversations() must succeed once with 'list' grant");
        const reusedDirectList = listTranscriptConversations({ parentId: liveCoordId, includeLineage: true });
        assert.equal(reusedDirectList.isError, true, "Single-use 'list' grant must not be reusable across direct calls");
        manageTranscriptAccessPolicy({ on: true, _testAuthorizedOwner: "owner-list-svc" });

        // 8. ACS-PR4-RUN-001 / ACS-TEST-001: `transcript dump` alias parity
        const dumpOut = path.join(tempHome, "scratch-export", "dump-index.json");
        const dumpCli = runCli(
          ["transcript", "dump", "--parent", liveCoordId, "--sanitized", "--out", dumpOut, "--json"],
          multiEnv
        );
        assert.equal(dumpCli.status, 0, dumpCli.stderr);
        const dumpParsed = JSON.parse(dumpCli.stdout);
        assert.equal(dumpParsed.exportedCount, 4, "transcript dump --parent must export all 4 swarm sessions");
        assert.equal(fs.existsSync(dumpOut), true);

        // 9. ACS-PR4-RUN-002: exportSanitizedTranscript --json payload obeys maxOutputChars ceiling and keeps text synchronized
        const bigClampConv = "big-json-clamp-conv";
        const bigSteps = [];
        for (let s = 0; s < 120; s++) {
          bigSteps.push({
            step_index: s,
            type: "PLANNER_RESPONSE",
            content: `Step ${s} payload ` + "Z".repeat(90),
            tool_calls: [{ name: "run_command", args: { CommandLine: `echo step-${s}-command-args-check` } }],
            created_at: "2026-11-16T02:00:00Z"
          });
        }
        writeConvLines(brainDir, bigClampConv, bigSteps);
        const clampedRes = await exportSanitizedTranscript({
          conversationIds: [bigClampConv],
          sanitized: true,
          limit: 150,
          maxOutputChars: 4000
        });
        assert.equal(clampedRes.clamped, true, "Large export under 4000-char ceiling must set clamped=true");
        const { text: _dropText, ...clampedJsonPayload } = clampedRes;
        assert.ok(
          JSON.stringify(clampedJsonPayload, null, 2).length <= 4000,
          "Clamped JSON export payload must remain bounded by effectiveCeiling (ACS-PR4-RUN-002)"
        );
        assert.equal(clampedRes.sessions[0].displayedSteps, clampedRes.sessions[0].rows.length);
        assert.match(
          clampedRes.text,
          new RegExp(`Steps Shown: ${clampedRes.sessions[0].rows.length} of 120 \\(truncated\\)`),
          "Clamped Markdown Steps Shown must match actual retained rows"
        );
        assert.match(clampedRes.text, /clamped at safety ceiling/);

        // Medium ceiling where Markdown fits but pretty JSON trims: text must re-sync with clamped=true
        const medConv = "med-json-clamp-conv";
        const medSteps = [];
        for (let s = 0; s < 45; s++) {
          medSteps.push({
            step_index: s,
            type: "PLANNER_RESPONSE",
            content: `Step ${s} ` + "A".repeat(40),
            tool_calls: [{ name: "run_command", args: { CommandLine: `echo ${s}` } }],
            created_at: "2026-11-16T02:00:00Z"
          });
        }
        writeConvLines(brainDir, medConv, medSteps);
        const medClamped = await exportSanitizedTranscript({
          conversationIds: [medConv],
          sanitized: true,
          limit: 150,
          maxOutputChars: 8000
        });
        assert.equal(medClamped.clamped, true);
        assert.match(medClamped.text, /clamped at safety ceiling/, "Markdown text must carry clamping notice when JSON ceiling trimmed");
        assert.match(medClamped.text, new RegExp(`Steps Shown: ${medClamped.sessions[0].rows.length} of 45 \\(truncated\\)`));

        // Top-level and subcommand --help / --version conflict rejection
        for (const badHelpArgs of [
          ["--help", "--bogus"],
          ["--version", "--bogus"],
          ["transcript", "--help", "--bogus"],
          ["transcript", "list", "--parent", liveCoordId, "--help"]
        ]) {
          const badHelpRes = runCli(badHelpArgs, multiEnv);
          assert.notEqual(badHelpRes.status, 0, `Expected non-zero exit for conflicting help/version args: ${badHelpArgs.join(" ")}`);
        }
      } finally {
        if (prevTestBrain !== undefined) process.env.AGY_BRAIN_DIR = prevTestBrain;
        if (prevTestProfile !== undefined) process.env.AGY_TEST_PROFILE_DIR = prevTestProfile;
      }
    } finally {
      if (prevBrainEnv !== undefined) process.env.AGY_BRAIN_DIR = prevBrainEnv;
    }

    // ACS-RUN-TRANSCRIPT-CLAMP: boilerplate stripping before summary slicing, wider compact tool args, and widened compact read window
    const clampConv = "acs-run-transcript-clamp";
    const clampLogs = path.join(brainDir, clampConv, ".system_generated", "logs");
    fs.mkdirSync(clampLogs, { recursive: true });
    const longToolArg = "scratch/multi-agent/team-skill_and_pr_review_audit/specialist-1/report.md";
    const clampSteps = [
      {
        step_index: 1,
        type: "USER_INPUT",
        content: "Inspect transcript clamp fixes",
        created_at: "2026-11-16T03:00:00Z"
      },
      {
        step_index: 2,
        type: "GENERIC",
        status: "DONE",
        content:
          "A pre-tool hook changed the arguments of this tool call before it ran. Changed: CommandLine.\n\n" +
          "Created At: 2026-11-16T22:33:25-05:00\n" +
          "Completed At: 2026-11-16T22:33:29-05:00\n" +
          "Created At: 2026-11-16T22:33:25-05:00\n" +
          "Completed At: 2026-11-16T22:33:29-05:00\n" +
          "Command exited with code 0.\n\n" +
          "Command output:\n" +
          "SIGNAL_AFTER_BOILERPLATE_VISIBLE_OK " + "X".repeat(600),
        tool_calls: [{ name: "read_file", args: { Path: longToolArg } }],
        created_at: "2026-11-16T03:00:05Z"
      },
      ...Array.from({ length: 12 }, (_, idx) => ({
        step_index: 3 + idx,
        type: "GENERIC",
        status: "DONE",
        content: `Generic step ${3 + idx} ` + "D".repeat(650),
        created_at: `2026-11-16T03:00:${String(10 + idx).padStart(2, "0")}Z`
      }))
    ];
    fs.writeFileSync(path.join(clampLogs, "transcript.jsonl"), clampSteps.map((s) => JSON.stringify(s)).join("\n") + "\n");
    const clampSummary = await queryTranscript({
      conversationId: clampConv,
      summaryOnly: true,
      includeToolCalls: true
    });
    assert.match(
      clampSummary.text,
      /SIGNAL_AFTER_BOILERPLATE_VISIBLE_OK/,
      "query --summary must strip leading Created At / Completed At boilerplate before 120-char preview slice"
    );
    assert.ok(
      clampSummary.text.includes(longToolArg),
      "formatCompactToolList must preserve full 72-char path arguments without 33-char truncation"
    );
    const clampCompactRead = await readTranscript({
      conversationId: clampConv,
      mode: "compact",
      lastTurns: 10
    });
    assert.ok(
      clampCompactRead.text.length > 4500 && clampCompactRead.text.length <= 24500,
      `read --mode compact window must widen beyond 3800 chars (got ${clampCompactRead.text.length})`
    );
    assert.match(
      clampCompactRead.text,
      /D{600}/,
      "read --mode compact non-dialogue GENERIC step cap must widen beyond 300 chars"
    );

    console.log("✓ Parent policy CLI, runtime hook-grant verification, atomic concurrent grants, and ACS-RUN-008..010 + Wave 2 regressions verified");
  }

  console.log("\n--- 8. Two-Tier Ergonomics, Calibration Bounds, Deep Opt-In & Out Files ---");
  {
    // 8.1 Order-independent boilerplate stripping & spill tag preservation
    const orderSwapRaw = [
      "Created At: 2026-11-17T12:00:00-05:00",
      "Completed At: 2026-11-17T12:00:03-05:00",
      "A pre-tool hook changed the arguments of this tool call before it ran. Changed: CommandLine.",
      "Command exited with code 0.",
      "Command output:",
      "ACTUAL_ORDER_SWAP_PAYLOAD"
    ].join("\n");
    assert.equal(stripSummaryStepBoilerplate(orderSwapRaw), "ACTUAL_ORDER_SWAP_PAYLOAD");

    const spillRaw = [
      "The tool's output was truncated due to being too long. You can find the full output in a file at file:///home/u/.gemini/antigravity/brain/cid/.system_generated/steps/42/output.txt.",
      "Here is a preview with the middle of the output truncated:",
      "Created At: 2026-11-17T12:00:00-05:00",
      "Completed At: 2026-11-17T12:00:04-05:00",
      "Command exited with code 0.",
      "Command output:",
      "SPILL_BODY_HEAD_LINE"
    ].join("\n");
    assert.equal(stripSummaryStepBoilerplate(spillRaw), "[spill: steps/42] SPILL_BODY_HEAD_LINE");

    const sysWrappedRaw = [
      "The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.",
      "",
      "<SYSTEM_MESSAGE>",
      "[Message] timestamp=2026-11-17T17:00:00Z sender=parent-1 priority=MESSAGE_PRIORITY_HIGH content=SYSTEM_SIGNAL_OK",
      "</SYSTEM_MESSAGE>"
    ].join("\n");
    assert.equal(stripSummaryStepBoilerplate(sysWrappedRaw), "SYSTEM_SIGNAL_OK");

    // 8.2 Build rich compact + full sibling conversation for Tier A / Tier B tests
    const convErg = "conv-ergonomics-two-tier";
    const ergLogsDir = path.join(brainDir, convErg, ".system_generated", "logs");
    fs.mkdirSync(ergLogsDir, { recursive: true });
    const ergOutDir = path.join(tempHome, "erg-artifacts");
    fs.mkdirSync(ergOutDir, { recursive: true });

    const longThinking = "THINK_START " + "T".repeat(4500) + " THINK_END_MARKER";
    const longSingleLine = "LONG_LINE_START_" + "L".repeat(1250) + "_LONG_LINE_END";
    const multiLineScript = Array.from({ length: 12 }, (_, idx) => `line_${idx + 1}: echo STEP_LINE_${idx + 1}`).join("\n") + "\n" + "CMD_TAIL_KEEP_" + "X".repeat(2500);
    const longPathArg = "/home/paragon-ux/Antigravity/Sample-Repo/scratch/very_long_nested_directory_name/specialist-1/target_report.md";
    const mediumShortArg = "alpha_beta_gamma_delta_epsilon_zeta_eta_theta_iota_kappa_lambda_mu_nu_xi_omicron_pi_rho_sigma"; // ~95 chars (<256 B)

    const compactLines = [];
    const fullLines = [];
    let stepNum = 0;

    // Step 0..23: 8 turns x (USER_INPUT + ASSISTANT duplicate read_file x3 + GENERIC boiled output + longPath + mediumArg)
    for (let t = 0; t < 8; t++) {
      const ts = `2026-11-17T10:${String(t).padStart(2, "0")}:05Z`;
      const userObj = {
        step_index: stepNum++,
        type: "USER_INPUT",
        created_at: ts,
        content: `Turn ${t} user request checking ergo flow and pagination.`
      };
      compactLines.push(JSON.stringify(userObj));
      fullLines.push(JSON.stringify(userObj));

      const asstObj = {
        step_index: stepNum++,
        type: "PLANNER_RESPONSE",
        created_at: ts,
        content: `Turn ${t} assistant response analyzing path ${mediumShortArg}.`,
        thinking: t === 7 ? longThinking : `Short thought ${t}`,
        truncated_fields: t === 7 ? ["thinking", "tool_calls", "content"] : [],
        tool_calls: t === 7
          ? [
              { name: "run_command", args: { CommandLine: multiLineScript, WaitMsBeforeAsync: 5000 } },
              { name: "write_file", args: { Path: longPathArg, Content: "HDR\n" + "B".repeat(3200) + "\nEND_CONTENT_MARKER" } }
            ]
          : [
              { name: "read_file", args: { Path: longPathArg, StartLine: 1, EndLine: 100 } },
              { name: "read_file", args: { Path: longPathArg, StartLine: 1, EndLine: 100 } },
              { name: "read_file", args: { Path: longPathArg, StartLine: 1, EndLine: 100 } },
              { name: "custom_probe", args: { Note: mediumShortArg } }
            ]
      };
      const compactAsst = t === 7
        ? {
            ...asstObj,
            thinking: longThinking.slice(0, 500),
            content: `Turn ${t} assistant response clipped.`,
            tool_calls: [
              { name: "run_command", args: { CommandLine: multiLineScript.slice(0, 400), WaitMsBeforeAsync: 5000 } },
              { name: "write_file", args: { Path: longPathArg, Content: "HDR\n" + "B".repeat(400) } }
            ]
          }
        : asstObj;
      compactLines.push(JSON.stringify(compactAsst));
      fullLines.push(JSON.stringify(asstObj));

      const genObj = {
        step_index: stepNum++,
        type: "GENERIC",
        created_at: ts,
        content: t === 7
          ? longSingleLine
          : `Created At: 2026-11-17T05:${String(t).padStart(2, "0")}:05-05:00\nCompleted At: 2026-11-17T05:${String(t).padStart(2, "0")}:06-05:00\nCommand exited with code 0.\n\nCommand output:\nTurn ${t} clean payload ` + "P".repeat(1400)
      };
      compactLines.push(JSON.stringify(genObj));
      fullLines.push(JSON.stringify(genObj));
    }

    fs.writeFileSync(path.join(ergLogsDir, "transcript.jsonl"), compactLines.join("\n") + "\n", "utf8");
    fs.writeFileSync(path.join(ergLogsDir, "transcript_full.jsonl"), fullLines.join("\n") + "\n", "utf8");

    // 8.3 Tier A read default stays <= ~9.4 KB inline, strips Created At:, middle-elides Path, suppresses [0.1 KB], emits nextCursor
    const tierARead = runCli(["transcript", "read", "--id", convErg, "--last-turns", "8", "--json"]);
    assert.equal(tierARead.status, 0);
    const tierAReadJson = JSON.parse(tierARead.stdout);
    assert.equal(tierAReadJson.mode, "compact");
    assert.ok(tierAReadJson.clamped === true && tierAReadJson.nextCursor && Number.isInteger(tierAReadJson.nextCursor.offset));

    const tierAReadText = runCli(["transcript", "read", "--id", convErg, "--last-turns", "8"]);
    assert.equal(tierAReadText.status, 0);
    assert.ok(tierAReadText.stdout.length <= 9600, `Tier A read must stay under spillover (~9.6KB), got ${tierAReadText.stdout.length}`);
    assert.match(tierAReadText.stdout, /target_report\.md/, "Path middle-elide must keep basename visible in Tier A read");
    assert.ok(!tierAReadText.stdout.includes("[0.1 KB]"), "Short <256B args must not emit noisy [0.1 KB] suffix");
    assert.ok(!tierAReadText.stdout.includes("Created At: 2026-11-17T05:06:05"), "Compact non-dialogue generic step must strip top Created At boilerplate");
    assert.match(tierAReadText.stdout, /--offset \d+ --limit \d+/);

    // Follow explicit --offset / --limit pagination forward cleanly
    const page1 = await readTranscript({ conversationId: convErg, offset: 0, limit: 6 });
    assert.ok(!page1.isError && page1.displayedSteps >= 1 && page1.displayedSteps <= 6);
    assert.equal(page1.steps[0].step_index, 0);
    if (page1.nextCursor) {
      const page2 = await readTranscript({ conversationId: convErg, offset: page1.nextCursor.offset, limit: page1.nextCursor.limit });
      assert.ok(!page2.isError && page2.steps[0].step_index === page1.nextCursor.offset, "Explicit pagination must advance without skipping steps");
    }

    // 8.4 Tier A outline & tools stay <= 9.6 KB inline, collapse duplicates, compact UTC dates, and provide nextCursor
    const tierAOutline = runCli(["transcript", "outline", "--id", convErg, "--start", "0", "--end", "23"]);
    assert.equal(tierAOutline.status, 0);
    assert.ok(tierAOutline.stdout.length <= 9600, `Tier A outline must stay inline (got ${tierAOutline.stdout.length})`);
    assert.match(tierAOutline.stdout, /date=2026-11-17 UTC/);
    assert.match(tierAOutline.stdout, /\(10:00:05Z\)/);
    assert.match(tierAOutline.stdout, /read_file\(Path="[^"]*target_report\.md"\) \(x3\)/);

    const tierATools = runCli(["transcript", "tools", "--id", convErg, "--start", "0", "--end", "23", "--json"]);
    assert.equal(tierATools.status, 0);
    const tierAToolsJson = JSON.parse(tierATools.stdout);
    assert.equal(tierAToolsJson.clamped, true);
    assert.ok(tierAToolsJson.nextCursor && Number.isInteger(tierAToolsJson.nextCursor.end));

    // 8.5 Tier B --full un-clamps thinking (4.5K), single long line (1.25K), and LARGE_BODY args; Mode badge avoids (**full**) (**full**)
    const richAsstStep = stepNum - 2; // Turn 7 PLANNER_RESPONSE (has longThinking & multiLineScript)
    const richGenStep = stepNum - 1;  // Turn 7 GENERIC (has longSingleLine)
    const fullStepRes = runCli(["transcript", "step", "--id", convErg, "--step", String(richAsstStep), "--full"]);
    assert.equal(fullStepRes.status, 0);
    assert.match(fullStepRes.stdout, /THINK_END_MARKER/, "step --full must bypass 4000c thinking cap");
    assert.match(fullStepRes.stdout, /END_CONTENT_MARKER/, "step --full must bypass 240c LARGE_BODY_ARG_KEYS cap");
    assert.match(fullStepRes.stdout, /CMD_TAIL_KEEP_/, "step --full must preserve full 2.5KB CommandLine arg");

    const fullLineStepRes = runCli(["transcript", "step", "--id", convErg, "--step", String(richGenStep), "--full"]);
    assert.equal(fullLineStepRes.status, 0);
    assert.match(fullLineStepRes.stdout, /_LONG_LINE_END/, "step --full must bypass MAX_LINE_CHARS=1000 cap");

    // Default step and --max-chars > 24000 without --full must still honor 4,000c thinking, 1,000c line, and 240c LARGE_BODY clamps
    for (const extraFlags of [[], ["--max-chars", "50000"]]) {
      const clampedDefaultAsst = runCli(["transcript", "step", "--id", convErg, "--step", String(richAsstStep), ...extraFlags]);
      assert.equal(clampedDefaultAsst.status, 0);
      assert.equal(clampedDefaultAsst.stdout.includes("THINK_END_MARKER"), false, `step without --full must enforce 4,000c thinking clamp (${extraFlags.join(" ") || "default"})`);
      assert.equal(clampedDefaultAsst.stdout.includes("END_CONTENT_MARKER"), false, `step without --full must enforce 240c LARGE_BODY clamp (${extraFlags.join(" ") || "default"})`);
    }
    const nonFullLargeLine = runCli(["transcript", "step", "--id", convErg, "--step", String(richGenStep), "--max-chars", "50000"]);
    assert.equal(nonFullLargeLine.status, 0);
    assert.equal(nonFullLargeLine.stdout.includes("_LONG_LINE_END"), false, "step --max-chars > 24000 without --full must still enforce MAX_LINE_CHARS");

    // Single-step clamping header must not claim 'batch view' and must reserve wrapper/fence/notice bytes without double-truncation
    const singleClampedStep = runCli(["transcript", "step", "--id", convErg, "--step", String(richAsstStep), "--field", "tool_args", "--full", "--max-chars", "600"]);
    assert.equal(singleClampedStep.status, 0);
    assert.ok(!singleClampedStep.stdout.includes("clamped in batch view"), "Single-step clamp message must not say batch view");
    assert.ok(Buffer.byteLength(singleClampedStep.stdout, "utf8") <= 600);
    assert.match(singleClampedStep.stdout, /Step \d+ \(tool_args\) clamped at 600 chars/);

    const singleClampedCalls = runCli(["transcript", "step", "--id", convErg, "--step", String(richAsstStep), "--field", "tool_calls", "--full", "--max-chars", "600"]);
    assert.equal(singleClampedCalls.status, 0);
    assert.ok(Buffer.byteLength(singleClampedCalls.stdout, "utf8") <= 600);
    assert.match(singleClampedCalls.stdout, /Step \d+ \(tool_calls\) clamped at 600 chars/);
    assert.ok(singleClampedCalls.stdout.trimEnd().endsWith("```"), "clamped tool_calls must keep its closing json fence without blind double-truncation");

    // read --full --max-chars < 512 KB must not claim '(unclamped)', and tiny --max-chars stays bounded without cursor-losing blind cut
    const readFullCapped = runCli(["transcript", "read", "--id", convErg, "--mode", "full", "--full", "--max-chars", "5000"]);
    assert.equal(readFullCapped.status, 0);
    assert.equal(readFullCapped.stdout.includes("(unclamped)"), false, "read --full --max-chars 5000 must not claim (unclamped)");
    const readTiny = runCli(["transcript", "read", "--id", convErg, "--max-chars", "450"]);
    assert.equal(readTiny.status, 0);
    assert.ok(Buffer.byteLength(readTiny.stdout, "utf8") <= 450, `tiny read --max-chars 450 overshot: ${Buffer.byteLength(readTiny.stdout, "utf8")}`);

    // 8.6 --line-start / --line-end and --tail on tool_args:<Key> and validation failures
    const sliceCmdRes = runCli([
      "transcript", "step", "--id", convErg, "--step", String(richAsstStep),
      "--field", "tool_args:CommandLine", "--line-start", "2", "--line-end", "4"
    ]);
    assert.equal(sliceCmdRes.status, 0);
    assert.match(sliceCmdRes.stdout, /line_1: echo STEP_LINE_1/);
    assert.match(sliceCmdRes.stdout, /line_3: echo STEP_LINE_3/);
    assert.ok(!sliceCmdRes.stdout.includes("STEP_LINE_4"));
    assert.ok(!sliceCmdRes.stdout.includes("[0] `run_command`"));
    assert.match(sliceCmdRes.stdout, /\[Lines 2-4 of 17\]/);

    const tailArgsRes = runCli(["transcript", "step", "--id", convErg, "--step", String(richAsstStep), "--field", "tool_args", "--tail", "3"]);
    assert.equal(tailArgsRes.status, 0);
    assert.match(tailArgsRes.stdout, /END_CONTENT_MARKER/);
    assert.ok(!tailArgsRes.stdout.includes("STEP_LINE_1"));
    assert.match(tailArgsRes.stdout, /\[Lines 13-15 of 15\]/);

    for (const badCli of [
      ["transcript", "step", "--id", convErg, "--step", "1", "--line-start", "5", "--line-end", "2"],
      ["transcript", "step", "--id", convErg, "--step", "1", "--max-chars", "0"],
      ["transcript", "read", "--id", convErg, "--out", path.join(ergOutDir, "a.md"), "--output", path.join(ergOutDir, "b.md")]
    ]) {
      const badExit = runCli(badCli);
      assert.notEqual(badExit.status, 0, `Invalid flags must fail closed: ${badCli.join(" ")}`);
    }

    // 8.7 --out across read, outline, query, tools, step (small stdout summary, deep file output) + path guard
    const readOutFile = path.join(ergOutDir, "read_full.md");
    const outlineOutFile = path.join(ergOutDir, "outline_full.md");
    const queryOutFile = path.join(ergOutDir, "query_full.md");
    const stepOutFile = path.join(ergOutDir, "step_full.md");
    const readFullOutCli = runCli(["transcript", "read", "--id", convErg, "--mode", "full", "--full", "--include-thinking", "--last-turns", "8", "--out", readOutFile]);
    assert.equal(readFullOutCli.status, 0);
    assert.ok(readFullOutCli.stdout.length < 300, "CLI with --out must only print compact confirmation to stdout");
    const readFullDisk = fs.readFileSync(readOutFile, "utf8");
    assert.match(readFullDisk, /Mode: \*\*full\*\* \(unclamped\)/);
    assert.match(readFullDisk, /THINK_END_MARKER/);
    assert.match(readFullDisk, /END_CONTENT_MARKER/);

    const outlineOutCli = runCli(["transcript", "outline", "--id", convErg, "--full", "--out", outlineOutFile]);
    assert.equal(outlineOutCli.status, 0);
    assert.ok(fs.readFileSync(outlineOutFile, "utf8").includes("Step 23"));

    const queryOutCli = runCli(["transcript", "query", "--id", convErg, "--query", "THINK_END_MARKER", "--include-thinking", "--full", "--out", queryOutFile]);
    assert.equal(queryOutCli.status, 0);
    assert.ok(fs.readFileSync(queryOutFile, "utf8").includes("THINK_END_MARKER"));

    const stepOutCli = runCli(["transcript", "step", "--id", convErg, "--step", String(richAsstStep), "--full", "--out", stepOutFile]);
    assert.equal(stepOutCli.status, 0);
    assert.ok(fs.readFileSync(stepOutFile, "utf8").includes("CMD_TAIL_KEEP_"));

    for (const badOutTarget of [
      path.join(ergLogsDir, "evil.md"),
      path.join(tempHome, "benchmarks", "evil.json"),
      path.join(tempHome, "scripts", "evil.mjs")
    ]) {
      const deniedOut = runCli(["transcript", "read", "--id", convErg, "--out", badOutTarget]);
      assert.notEqual(deniedOut.status, 0, `Protected --out target must fail closed on read: ${badOutTarget}`);
    }

    // 8.8 export --sanitized strips Created At: order-independently and emits [spill: steps/N]
    const expErg = await exportSanitizedTranscript({ conversationIds: [convErg], sanitized: true });
    assert.ok(!expErg.isError);
    assert.ok(!expErg.text.includes("Created At: 2026-11-17T05:00:05"), "Sanitized export table must strip Created At metadata");
    assert.match(expErg.text, /Turn 0 clean payload/);

    console.log("✓ Two-tier ergonomics, Tier A inline bounds, Tier B --full/--line-start/--max-chars/--out, pagination cursors & sanitization verified");

    // 9. PR #7 audit regressions
    console.log("\n--- 9. PR #7 Audit Regressions (UTF-8 bounds, duplicate collapse, validation, --out --json, spill tags) ---");

    // 9.1 UTF-8 byte budget: multi-byte glyphs must not push inline output past ~10 KB
    const convUtf = "conv-utf8-bounds";
    const utfLogs = path.join(brainDir, convUtf, ".system_generated", "logs");
    fs.mkdirSync(utfLogs, { recursive: true });
    const utfLines = [];
    for (let s = 0; s < 40; s++) {
      utfLines.push(JSON.stringify({ step_index: s * 2, type: "USER_INPUT", created_at: "2026-11-17T10:00:00Z", content: `u${s} ` + "─✓→😀".repeat(230) }));
      utfLines.push(JSON.stringify({ step_index: s * 2 + 1, type: "PLANNER_RESPONSE", created_at: "2026-11-17T10:00:01Z", content: "答".repeat(700) }));
    }
    fs.writeFileSync(path.join(utfLogs, "transcript.jsonl"), utfLines.join("\n") + "\n");
    const utfRead = runCli(["transcript", "read", "--id", convUtf, "--last-turns", "40"]);
    assert.equal(utfRead.status, 0);
    assert.ok(Buffer.byteLength(utfRead.stdout, "utf8") <= 10000, `UTF-8 read must stay <= 10000 bytes, got ${Buffer.byteLength(utfRead.stdout, "utf8")}`);
    const utfOutline = runCli(["transcript", "outline", "--id", convUtf]);
    assert.equal(utfOutline.status, 0);
    assert.ok(Buffer.byteLength(utfOutline.stdout, "utf8") <= 10000, "UTF-8 outline must stay <= 10000 bytes");

    // 9.2 Oversized single step in tools/query --field must stay inline-bounded
    const convBig = "conv-oversized-single";
    const bigLogs = path.join(brainDir, convBig, ".system_generated", "logs");
    fs.mkdirSync(bigLogs, { recursive: true });
    fs.writeFileSync(
      path.join(bigLogs, "transcript.jsonl"),
      JSON.stringify({ step_index: 0, type: "PLANNER_RESPONSE", created_at: "2026-11-17T10:00:00Z", content: "x".repeat(20000), tool_calls: [{ name: "run_command", args: { CommandLine: "echo " + "Z".repeat(20000) } }] }) + "\n"
    );
    const bigTools = runCli(["transcript", "tools", "--id", convBig, "--mode", "compact"]);
    assert.equal(bigTools.status, 0);
    assert.ok(Buffer.byteLength(bigTools.stdout, "utf8") <= 10000, "tools on an oversized single step must stay inline-bounded");

    // 9.3 Distinct tool calls sharing a displayed prefix are not collapsed; true duplicates are
    const { formatCompactToolList } = await import("../lib/transcript-core.mjs");
    const distinct = formatCompactToolList([
      { name: "read_file", args: { Path: "a.mjs", StartLine: 1, EndLine: 150 } },
      { name: "read_file", args: { Path: "a.mjs", StartLine: 151, EndLine: 300 } }
    ]);
    assert.ok(!distinct.includes("(x2)"), "distinct read_file slices must not collapse");
    const dup = formatCompactToolList([
      { name: "read_file", args: { Path: "a.mjs", StartLine: 1, EndLine: 150 } },
      { name: "read_file", args: { Path: "a.mjs", StartLine: 1, EndLine: 150 } }
    ]);
    assert.ok(dup.includes("(x2)"), "identical read_file calls must collapse");

    // 9.4 stripSummaryStepBoilerplate: prose-only boilerplate yields empty, Windows spill path, dialogue untouched in read
    assert.equal(
      stripSummaryStepBoilerplate("Created At: 2026-11-17T12:00:00-05:00\nCompleted At: 2026-11-17T12:00:01-05:00\nCommand exited with code 0."),
      ""
    );
    assert.equal(
      stripSummaryStepBoilerplate("The tool's output was truncated due to being too long. You can find the full output in a file at file:///C:/x/.system_generated/steps/7/output.txt.\nHere is a preview:\nBODY"),
      "[spill: steps/7] BODY"
    );

    // 9.5 CLI validation of integer/range flags
    for (const badArgs of [
      ["transcript", "read", "--id", convErg, "--limit", "0"],
      ["transcript", "read", "--id", convErg, "--offset", "-1"],
      ["transcript", "read", "--id", convErg, "--last-turns", ""],
      ["transcript", "outline", "--id", convErg, "--start", "50", "--end", "10"],
      ["transcript", "query", "--id", convErg, "--start", "-1"],
      ["transcript", "step", "--id", convErg, "--step", "1", "--head", "0"],
      ["transcript", "step", "--id", convErg, "--step", "1", "--tail", "-2"],
      ["transcript", "step", "--id", convErg, "--step", "1", "--max-chars", "999999999"],
      ["transcript", "read", "--help=true"]
    ]) {
      const badRes = runCli(badArgs);
      assert.notEqual(badRes.status, 0, `Must fail closed: ${badArgs.join(" ")}`);
    }

    // 9.6 --out + --json keeps stdout compact (no steps/items payloads)
    const jsonOut = path.join(ergOutDir, "json_out.json");
    const jsonOutRes = runCli(["transcript", "read", "--id", convErg, "--full", "--mode", "full", "--last-turns", "8", "--out", jsonOut, "--json"]);
    assert.equal(jsonOutRes.status, 0);
    const jsonOutStdout = JSON.parse(jsonOutRes.stdout);
    assert.equal(jsonOutStdout.outputPath, jsonOut);
    assert.ok(jsonOutStdout.steps === undefined && jsonOutStdout.items === undefined, "--out --json stdout must omit raw step payloads");
    assert.ok(jsonOutRes.stdout.length < 2000, "--out --json stdout must stay compact");
    assert.ok(Array.isArray(JSON.parse(fs.readFileSync(jsonOut, "utf8")).steps), "--out --json file keeps the full payload");

    // 9.7 --out rejects UNC / device paths and hooks.json; missing tool_args key reports not present; line slice beyond end
    for (const badOut of ["//server/share/leak.md", "\\\\server\\share\\leak.md", path.join(ergOutDir, "hooks.json")]) {
      const badOutRes = runCli(["transcript", "read", "--id", convErg, "--out", badOut]);
      assert.notEqual(badOutRes.status, 0, `Unsafe --out must fail closed: ${badOut}`);
    }
    const missingKey = runCli(["transcript", "step", "--id", convErg, "--step", String(richGenStep - 1), "--field", "tool_args:NoSuchKey"]);
    assert.equal(missingKey.status, 0);
    assert.ok(!/\bundefined\b/.test(missingKey.stdout), "missing tool_args key must not print 'undefined'");
    const beyond = runCli(["transcript", "step", "--id", convErg, "--step", String(richAsstStep), "--field", "tool_args:CommandLine", "--line-start", "9999"]);
    assert.equal(beyond.status, 0);
    assert.match(beyond.stdout, /No lines in requested range/);

    console.log("✓ PR #7 audit regressions verified");

    // 9.8 --out --json artifact obeys the 512 KB deep-tier cap (and explicit --max-chars) with declared truncation
    const convHuge = "conv-huge-json-cap";
    const hugeLogs = path.join(brainDir, convHuge, ".system_generated", "logs");
    fs.mkdirSync(hugeLogs, { recursive: true });
    const hugeLines = [];
    for (let s = 0; s < 400; s++) {
      hugeLines.push(JSON.stringify({
        step_index: s,
        type: s % 2 === 0 ? "USER_INPUT" : "PLANNER_RESPONSE",
        created_at: "2026-11-17T10:00:00Z",
        content: `step ${s} ` + "W".repeat(3500),
        tool_calls: s % 2 === 1 ? [{ name: "run_command", args: { CommandLine: `echo ${s} ` + "Q".repeat(400) } }] : undefined
      }));
    }
    fs.writeFileSync(path.join(hugeLogs, "transcript.jsonl"), hugeLines.join("\n") + "\n");
    const hugeJsonFile = path.join(ergOutDir, "huge_cap.json");
    const hugeRes = runCli(["transcript", "query", "--id", convHuge, "--limit", "400", "--full", "--out", hugeJsonFile, "--json"]);
    assert.equal(hugeRes.status, 0, hugeRes.stderr);
    const hugeBytes = fs.statSync(hugeJsonFile).size;
    assert.ok(hugeBytes <= 512 * 1024, `--out --json must stay <= 512 KB, got ${hugeBytes}`);
    const hugeFile = JSON.parse(fs.readFileSync(hugeJsonFile, "utf8"));
    assert.equal(hugeFile.jsonTruncated, true, "oversized JSON artifact must declare truncation");
    assert.ok(hugeFile.jsonItemsIncluded > 0 && hugeFile.jsonItemsIncluded < hugeFile.jsonItemsTotal);
    assert.equal(hugeFile.items.length, hugeFile.jsonItemsIncluded);
    const hugeStdout = JSON.parse(hugeRes.stdout);
    assert.equal(hugeStdout.jsonTruncated, true);
    assert.ok(hugeRes.stdout.length < 2000, "stdout stays compact");

    const hugeOutlineJson = path.join(ergOutDir, "huge_outline_compact.json");
    const hugeOutlineRes = runCli(["transcript", "outline", "--id", convHuge, "--full", "--out", hugeOutlineJson, "--json"]);
    assert.equal(hugeOutlineRes.status, 0, hugeOutlineRes.stderr);
    const hugeOutlineParsed = JSON.parse(fs.readFileSync(hugeOutlineJson, "utf8"));
    assert.equal(hugeOutlineParsed.items.length, 400, "outline --full --json must project compact summary objects across all 400 steps under 512 KB");
    assert.equal(hugeOutlineParsed.items[0].content, undefined, "outline --full --json summary items must omit raw content");
    assert.equal(hugeOutlineParsed.items[1].tool_calls, undefined, "outline --full --json summary items must omit raw tool_calls");

    const smallCapFile = path.join(ergOutDir, "small_cap.json");
    const smallCapRes = runCli(["transcript", "outline", "--id", convHuge, "--full", "--max-chars", "20000", "--out", smallCapFile, "--json"]);
    assert.equal(smallCapRes.status, 0, smallCapRes.stderr);
    assert.ok(fs.statSync(smallCapFile).size <= 20000, "explicit --max-chars must bound the JSON artifact");

    const hugeMdFile = path.join(ergOutDir, "huge_cap.md");
    const hugeMdRes = runCli(["transcript", "read", "--id", convHuge, "--mode", "full", "--full", "--last-turns", "400", "--out", hugeMdFile]);
    assert.equal(hugeMdRes.status, 0, hugeMdRes.stderr);
    assert.ok(fs.statSync(hugeMdFile).size <= 512 * 1024, "Markdown --out artifact must stay <= 512 KB in bytes");

    // RR-ACS-RUN-001 exercises the bytes the CLI actually emits.
    const assertBounded = (result, limit) => {
      assert.equal(result.status, 0, result.stderr);
      assert.ok(Buffer.byteLength(result.stdout, "utf8") <= limit, "serialized stdout exceeded its byte budget");
      assert.ok(!result.stdout.includes("\uFFFD"), "UTF-8 output lost a code point");
    };
    for (const sub of ["read", "outline", "query", "tools"]) {
      const args = ["transcript", sub, "--id", convHuge, "--limit", "80"];
      for (const json of [[], ["--json"]]) {
        const inline = runCli([...args, ...json]);
        assertBounded(inline, 9200);
        const explicit = runCli([...args, ...json, "--max-chars", "5000"]);
        assertBounded(explicit, 5000);
        if (json.length) {
          JSON.parse(inline.stdout);
          JSON.parse(explicit.stdout);
        }
      }
    }
    const utfJson = runCli(["transcript", "read", "--id", convUtf, "--last-turns", "40", "--json", "--max-chars", "5000"]);
    assertBounded(utfJson, 5000);
    assert.match(utfJson.stdout, /[答✓]/);
    assert.equal(JSON.parse(utfJson.stdout).clamped, true);

    const readPageArgs = ["transcript", "read", "--id", convHuge, "--limit", "80", "--json", "--max-chars", "5000"];
    const firstPage = runCli([...readPageArgs, "--offset", "0"]);
    assertBounded(firstPage, 5000);
    const page = JSON.parse(firstPage.stdout);
    assert.equal(page.steps[0].step_index, 0);
    assert.equal(page.displayedSteps, page.steps.length);
    assert.equal(page.nextCursor.offset, page.steps.at(-1)._fileOrd + 1);
    const secondPage = runCli([...readPageArgs, "--offset", String(page.nextCursor.offset)]);
    assertBounded(secondPage, 5000);
    assert.equal(JSON.parse(secondPage.stdout).steps[0].step_index, page.nextCursor.offset);

    const forwardOutlineArgs = ["transcript", "outline", "--id", convHuge, "--json", "--max-chars", "5000"];
    const outlineFile = path.join(ergOutDir, "forward-outline.json");
    const savedOutline = runCli([...forwardOutlineArgs, "--start", "0", "--end", "20", "--out", outlineFile]);
    assert.equal(savedOutline.status, 0, savedOutline.stderr);
    assert.ok(fs.statSync(outlineFile).size <= 5000);
    const outlinePage = JSON.parse(fs.readFileSync(outlineFile, "utf8"));
    assert.equal(outlinePage.jsonTruncated, true);
    assert.equal(outlinePage.items[0].step_index, 0);
    assert.deepEqual(outlinePage.nextCursor, { start: outlinePage.items.at(-1).step_index + 1, end: 20 });
    assert.deepEqual(JSON.parse(savedOutline.stdout).nextCursor, outlinePage.nextCursor);
    const nextOutline = runCli([...forwardOutlineArgs, "--start", String(outlinePage.nextCursor.start), "--end", "20"]);
    assertBounded(nextOutline, 5000);
    assert.equal(JSON.parse(nextOutline.stdout).items[0].step_index, outlinePage.nextCursor.start);

    // Tail-limited outline (--limit 50 on 400 steps) must paginate backward without losing steps 0..349 in JSON or Markdown
    const tailOutlineJson = runCli(["transcript", "outline", "--id", convHuge, "--limit", "50", "--json", "--max-chars", "2000"]);
    assertBounded(tailOutlineJson, 2000);
    const tailOutlineParsed = JSON.parse(tailOutlineJson.stdout);
    assert.equal(tailOutlineParsed.jsonTruncated, true);
    assert.equal(tailOutlineParsed.items.at(-1).step_index, 399, "tail-limited outline JSON must retain latest steps");
    assert.equal(tailOutlineParsed.nextCursor.start, undefined, "tail-limited outline JSON must not overwrite backward cursor with forward start");
    assert.equal(tailOutlineParsed.nextCursor.end, tailOutlineParsed.items[0].step_index - 1);
    const tailOutlinePrev = runCli(["transcript", "outline", "--id", convHuge, "--limit", "50", "--end", String(tailOutlineParsed.nextCursor.end), "--json", "--max-chars", "2000"]);
    assertBounded(tailOutlinePrev, 2000);
    assert.equal(JSON.parse(tailOutlinePrev.stdout).items.at(-1).step_index, tailOutlineParsed.nextCursor.end);

    const tailOutlineMd = runCli(["transcript", "outline", "--id", convHuge, "--limit", "50", "--max-chars", "2000"]);
    assertBounded(tailOutlineMd, 2000);
    assert.match(tailOutlineMd.stdout, /Step 399 \|/);
    assert.match(tailOutlineMd.stdout, /--end \d+/);

    // count === 0 in serializeBoundedJsonPayload must not emit nextCursor pointing back at the un-fittable item
    const jsonTruncMetaReason = "Output exceeds the byte budget. Use a larger budget or a narrower selection.";
    const readZeroBudget = Buffer.byteLength(JSON.stringify({
      ...page,
      steps: [],
      displayedSteps: 0,
      nextCursor: { offset: 0, limit: 399 },
      jsonTruncated: true,
      jsonItemsIncluded: 0,
      jsonItemsTotal: page.steps.length,
      jsonTruncatedReason: jsonTruncMetaReason
    }) + "\n", "utf8") + 32;
    const tinyZeroItemJson = runCli(["transcript", "read", "--id", convHuge, "--json", "--max-chars", String(readZeroBudget)]);
    assertBounded(tinyZeroItemJson, readZeroBudget);
    const parsedZero = JSON.parse(tinyZeroItemJson.stdout);
    assert.equal(parsedZero.jsonTruncated, true);
    assert.equal(parsedZero.steps.length, 0, "zero-item read budget on 3.8KB steps must force 0-item read fallback");
    assert.ok(parsedZero.nextCursor && parsedZero.nextCursor.offset === 0 && parsedZero.nextCursor.limit > 0 && parsedZero.nextCursor.limit < 399,
      `count === 0 backward read must advance past un-fittable last item (got ${JSON.stringify(parsedZero.nextCursor)})`);

    const tinyForwardReadZero = runCli(["transcript", "read", "--id", convHuge, "--offset", "10", "--limit", "5", "--json", "--max-chars", String(readZeroBudget)]);
    assertBounded(tinyForwardReadZero, readZeroBudget);
    const parsedFwdZero = JSON.parse(tinyForwardReadZero.stdout);
    assert.equal(parsedFwdZero.steps.length, 0);
    assert.deepEqual(parsedFwdZero.nextCursor, { offset: 11, limit: 5 }, "count === 0 forward read must advance past un-fittable first item");

    const outlineZeroBudget = Buffer.byteLength(JSON.stringify({
      ...outlinePage,
      items: [],
      displayedCount: 0,
      nextCursor: { start: 11, end: 30 },
      jsonTruncated: true,
      jsonItemsIncluded: 0,
      jsonItemsTotal: 21,
      jsonTruncatedReason: jsonTruncMetaReason
    }) + "\n", "utf8") + 16;
    const tinyForwardOutlineZero = runCli(["transcript", "outline", "--id", convHuge, "--start", "10", "--end", "30", "--json", "--max-chars", String(outlineZeroBudget)]);
    assertBounded(tinyForwardOutlineZero, outlineZeroBudget);
    const parsedFwdOutlineZero = JSON.parse(tinyForwardOutlineZero.stdout);
    assert.equal(parsedFwdOutlineZero.jsonTruncated, true);
    assert.equal(parsedFwdOutlineZero.items.length, 0, "zero-item outline budget must force 0-item forward outline fallback");
    assert.deepEqual(parsedFwdOutlineZero.nextCursor, { start: 11, end: 30 }, "count === 0 forward outline must advance to next step");

    const batchSteps = ["0", "2", "4", "8"];
    const batch = runCli(["transcript", "step", "--id", convHuge, "--step", batchSteps.join(","), "--field", "content", "--json", "--max-chars", "8000"]);
    assertBounded(batch, 8000);
    const batchPage = JSON.parse(batch.stdout);
    assert.ok(batchPage.steps.length > 0 && batchPage.steps.length < batchSteps.length);
    assert.deepEqual(batchPage.stepIndices, batchPage.steps.map((entry) => entry.stepIndex));
    assert.equal("data" in batchPage, false, "Deduplicated batch step JSON must not repeat top-level data array");
    assert.equal("step" in batchPage.steps[0], false, "Projected batch step JSON must omit raw unselected step object");
    const remainder = await getStepDetail({ conversationId: convHuge, stepIndex: batchPage.nextCursor.step, full: true });
    assert.deepEqual(remainder.requestedSteps ?? [remainder.stepIndex], batchSteps.slice(batchPage.steps.length).map(Number));

    const stepArgs = ["transcript", "step", "--id", convUtf, "--step", "1", "--field", "content"];
    assertBounded(runCli([...stepArgs, "--max-chars", "600"]), 600);
    const stepJson = runCli([...stepArgs, "--json", "--max-chars", "600"]);
    assertBounded(stepJson, 600);
    assert.equal(JSON.parse(stepJson.stdout).stepIndex, 1);

    for (const json of [[], ["--json"]]) {
      const lowPath = path.join(ergOutDir, json.length ? "too-small.json" : "too-small.md");
      fs.writeFileSync(lowPath, "keep existing artifact");
      for (const output of [[], ["--out", lowPath]]) {
        const small = runCli(["transcript", "read", "--id", convUtf, "--max-chars", "80", ...json, ...output]);
        assert.equal(small.status, 1);
        assert.equal(small.stdout, "");
        assert.match(small.stderr, /too small.*transcript/i);
        if (json.length) assert.equal(JSON.parse(small.stderr).isError, true);
      }
      assert.equal(fs.readFileSync(lowPath, "utf8"), "keep existing artifact");
    }

    console.log("✓ --out --json and Markdown artifacts honor the 512 KB deep-tier cap");

    // ========================================================================
    // 10. PR #7 L46 Remediations (Option A Status, Compact Summary JSON, Export Bounds, Worker Cursors)
    // ========================================================================
    console.log("\n--- 10. PR #7 L46 Remediations (PR7-RUN-001..004, PR7-DOC-001) ---");

    // 10.1 PR7-RUN-001: Option A honest recent launch-restriction disclosure & non-destructive scan
    const l46StateDir = getStateDir();
    fs.mkdirSync(l46StateDir, { recursive: true });
    const nowMs = Date.now();
    const staleMs = nowMs - ACTIVE_SWARM_WINDOW_MS - 60000;
    const coordA = "coord-l46-opt-a";
    const coordB = "coord-l46-other-b";
    const childDenyId = "l46-child-deny-01";
    const childSelfId = "l46-child-self-02";
    const childAllowId = "l46-child-allow-03";
    const childStaleId = "l46-child-stale-04";
    const childStaleTsId = "l46-child-stalets-05";
    const childOtherId = "l46-child-other-06";
    const topDenyId = "l46-top-user-07";

    const writeStateFile = (fileName, data, mtimeMs = nowMs) => {
      const target = path.join(l46StateDir, fileName);
      fs.writeFileSync(target, typeof data === "string" ? data : JSON.stringify(data, null, 2), "utf8");
      const sec = mtimeMs / 1000;
      fs.utimesSync(target, sec, sec);
      return target;
    };

    const createdStatePaths = [];
    try {
      createdStatePaths.push(writeStateFile(`agy-session-${childDenyId}.json`, {
        lastSeenTime: nowMs,
        lineage: { isChildSession: true, isSwarmChild: true, parentConvId: coordA, rosterName: "w2-spec1", launchDirective: "deny" }
      }));
      createdStatePaths.push(writeStateFile(`agy-session-${childSelfId}.json`, {
        lastSeenTime: nowMs - 1000,
        lineage: { isChildSession: true, isSwarmChild: true, parentConvId: coordA, rosterName: "w2-spec2", launchDirective: "self-only" }
      }));
      createdStatePaths.push(writeStateFile(`agy-session-${childAllowId}.json`, {
        lastSeenTime: nowMs,
        lineage: { isChildSession: true, isSwarmChild: true, parentConvId: coordA, rosterName: "w2-lead", launchDirective: "allow" }
      }));
      createdStatePaths.push(writeStateFile(`agy-session-${childStaleId}.json`, {
        lastSeenTime: staleMs,
        lineage: { isChildSession: true, isSwarmChild: true, parentConvId: coordA, rosterName: "stale-mtime", launchDirective: "deny" }
      }, staleMs));
      createdStatePaths.push(writeStateFile(`agy-session-${childStaleTsId}.json`, {
        lastSeenTime: staleMs,
        lineage: { isChildSession: true, isSwarmChild: true, parentConvId: coordA, rosterName: "stale-ts", launchDirective: "deny" }
      }, nowMs));
      createdStatePaths.push(writeStateFile(`agy-session-${childOtherId}.json`, {
        lastSeenTime: nowMs,
        lineage: { isChildSession: true, isSwarmChild: true, parentConvId: coordB, rosterName: "other-spec", launchDirective: "deny" }
      }));
      createdStatePaths.push(writeStateFile(`agy-session-${topDenyId}.json`, {
        lastSeenTime: nowMs,
        lineage: { isTopLevelUserSession: true, isChildSession: false, parentConvId: null, launchDirective: "deny" }
      }));
      createdStatePaths.push(writeStateFile("agy-session-governance-state.json", {
        global: { lastSeenTime: nowMs },
        lineage: { isChildSession: true, parentConvId: coordA, launchDirective: "deny" }
      }));
      createdStatePaths.push(writeStateFile("agy-session-malformed-99.json", "{broken json"));
      const outsideSymTarget = path.join(tempHome, "outside-session.json");
      fs.writeFileSync(outsideSymTarget, JSON.stringify({ lastSeenTime: nowMs, lineage: { isChildSession: true, parentConvId: coordA, launchDirective: "deny" } }));
      const symStatePath = path.join(l46StateDir, "agy-session-symlinked.json");
      try {
        fs.symlinkSync(outsideSymTarget, symStatePath);
        createdStatePaths.push(symStatePath);
      } catch {}

      // Unscoped scan includes both cohorts (coordA deny+self-only + coordB deny = 3), ignoring allow/stale/top/legacy/corrupt/symlink
      const unscopedScan = scanRecentLaunchRestrictions();
      assert.equal(unscopedScan.restrictedCount, 3, "unscoped scan must find only valid recent deny/self-only children");
      assert.equal(unscopedScan.denyCount, 2);
      assert.equal(unscopedScan.selfOnlyCount, 1);

      // Owner-scoped scan isolates coordA's 2 restricted children (excludes coordB, excludes allow/stale/top/legacy/corrupt/symlink)
      const scopedScan = scanRecentLaunchRestrictions({ ownerId: coordA });
      assert.equal(scopedScan.scope, "recent-child-sessions");
      assert.equal(scopedScan.windowMs, ACTIVE_SWARM_WINDOW_MS);
      assert.equal(scopedScan.restrictedCount, 2);
      assert.equal(scopedScan.denyCount, 1);
      assert.equal(scopedScan.selfOnlyCount, 1);
      assert.deepEqual(
        scopedScan.sessions.map((s) => ({ id: s.conversationId, mode: s.mode, source: s.source })),
        [
          { id: childDenyId, mode: "deny", source: "launch-directive" },
          { id: childSelfId, mode: "self-only", source: "launch-directive" }
        ]
      );

      // Parent grants temporary Tier 3 allowlist then resets policy: Tier 4 restrictions remain disclosed honestly
      manageTranscriptAccessPolicy({ _testAuthorizedOwner: coordA, mode: "allowlist", allow: `@w2-spec1` });
      recordTranscriptHookGrant({ callerConvId: coordA, subcommand: "access", mode: "open", isMutation: true });
      const resetCli = runCli(["transcript", "access", "--reset", "--json"], { ...testEnv, GEMINI_CONVERSATION_ID: coordA });
      assert.equal(resetCli.status, 0, resetCli.stderr);
      const resetJson = JSON.parse(resetCli.stdout);
      assert.equal(resetJson.active, false);
      assert.equal(resetJson.mode, "open");
      assert.equal(resetJson.launchRestrictions.restrictedCount, 2);
      assert.equal(resetJson.launchRestrictions.denyCount, 1);
      assert.equal(resetJson.launchRestrictions.selfOnlyCount, 1);

      const statusTextCli = runCli(["transcript", "access", "--status"], { ...testEnv, GEMINI_CONVERSATION_ID: coordA });
      assert.equal(statusTextCli.status, 0);
      assert.match(statusTextCli.stdout, /Transcript Access Policy: OPEN \(parent CLI policy\)/);
      assert.match(statusTextCli.stdout, /Recently active launch-restricted children: 2/);
      assert.match(statusTextCli.stdout, /Launch directives: 1 deny, 1 self-only/);
      assert.match(statusTextCli.stdout, /Reset clears parent policy overrides; launch directives remain in effect/);

      // runStatus() plain-text output also discloses recent launch-restricted children instead of bare OPEN (default)
      const statusLogs = [];
      const prevConsoleLog = console.log;
      console.log = (line) => statusLogs.push(String(line));
      try {
        runStatus({ silent: false });
      } finally {
        console.log = prevConsoleLog;
      }
      const combinedRunStatus = statusLogs.join("\n");
      assert.match(combinedRunStatus, /OPEN \(parent CLI policy\)/);
      assert.match(combinedRunStatus, /Recent launch-restricted children: 3/);
      const cliStatusJson = runCli(["status", "--json"]);
      assert.ok(cliStatusJson.status === 0 || cliStatusJson.status === 1);
      const parsedInstallStatus = JSON.parse(cliStatusJson.stdout);
      assert.equal(parsedInstallStatus.details.transcriptAccess.launchRestrictions.restrictedCount, 3);
      assert.equal(fs.readFileSync(path.join(l46StateDir, `agy-session-${childDenyId}.json`), "utf8").includes("w2-spec1"), true);

      // Multi-coordinator --reset: when coordB holds an active policy, coordA --reset must align launchRestrictions with coordB
      manageTranscriptAccessPolicy({ _testAuthorizedOwner: coordB, off: true });
      try {
        recordTranscriptHookGrant({ callerConvId: coordA, subcommand: "access", mode: "open", isMutation: true });
        const crossResetCli = runCli(["transcript", "access", "--reset", "--json"], { ...testEnv, GEMINI_CONVERSATION_ID: coordA });
        assert.equal(crossResetCli.status, 0, crossResetCli.stderr);
        const crossResetJson = JSON.parse(crossResetCli.stdout);
        assert.equal(crossResetJson.ownerId, coordB);
        assert.equal(crossResetJson.launchRestrictions.restrictedCount, 1, "active coordB policy status must scope launchRestrictions to coordB");
        assert.equal(crossResetJson.launchRestrictions.sessions[0].conversationId, childOtherId);
      } finally {
        manageTranscriptAccessPolicy({ _testAuthorizedOwner: coordB, reset: true });
      }
    } finally {
      for (const p of createdStatePaths) {
        try { fs.unlinkSync(p); } catch {}
      }
    }

    // 10.2 PR7-RUN-002: query/read/outline/summary --summary --json project lightweight summary items
    const convSum = "conv-summary-json-10";
    const sumLogs = path.join(brainDir, convSum, ".system_generated", "logs");
    fs.mkdirSync(sumLogs, { recursive: true });
    const sumSteps = [];
    for (let s = 70; s <= 84; s++) {
      const isMatch = s >= 75; // 10 matching steps (75..84)
      sumSteps.push({
        step_index: s,
        type: s === 84 ? "PLANNER_RESPONSE" : (isMatch ? "GENERIC" : "PLANNER_RESPONSE"),
        status: s === 83 ? "ERROR" : "DONE",
        created_at: `2026-11-18T00:${String(s - 70).padStart(2, "0")}:00.000Z`,
        thinking: s === 84 ? "RAW_THINKING_MUST_NOT_APPEAR " + "T".repeat(4000) : undefined,
        content: isMatch
          ? (s === 84
              ? `STAGE_84 lead report ` + "R".repeat(12500)
              : `The tool's output was truncated due to being too long. You can find the full output in a file at file:///x/.system_generated/steps/${s}/output.txt.\nHere is a preview:\nSTAGE_${s} ${s === 83 ? "fatal error occurred" : "ok"}`)
          : `Unrelated step ${s}`,
        tool_calls: isMatch
          ? [{ name: "read_file", args: { Path: "/home/u/Antigravity/report.md", Content: "RAW_TOOL_BODY " + "B".repeat(12000) } }]
          : undefined
      });
    }
    fs.writeFileSync(path.join(sumLogs, "transcript.jsonl"), sumSteps.map((s) => JSON.stringify(s)).join("\n") + "\n");

    const sumQueryJson = runCli(["transcript", "query", "STAGE_", convSum, "--summary", "--json"]);
    assert.equal(sumQueryJson.status, 0, sumQueryJson.stderr);
    assert.ok(Buffer.byteLength(sumQueryJson.stdout, "utf8") <= 9200);
    const sumQueryParsed = JSON.parse(sumQueryJson.stdout);
    assert.equal(sumQueryParsed.matchedCount, 10);
    assert.equal(sumQueryParsed.displayedCount, 10, "compact summary JSON must retain all 10 matches despite 12 KB step 84");
    assert.equal(sumQueryParsed.items.length, 10);
    assert.equal(sumQueryParsed.jsonTruncated, undefined);
    const lastSumItem = sumQueryParsed.items[9];
    assert.equal(lastSumItem.step_index, 84);
    assert.equal(lastSumItem.type, "PLANNER_RESPONSE");
    assert.equal(lastSumItem.role, "assistant");
    assert.equal(lastSumItem.created_at, "2026-11-18T00:14:00Z");
    assert.equal(lastSumItem.status, "OK");
    assert.equal(lastSumItem.content, undefined);
    assert.equal(lastSumItem.thinking, undefined);
    assert.equal(lastSumItem.tool_calls, undefined);
    assert.match(lastSumItem.summary, /STAGE_84/);
    const errSumItem = sumQueryParsed.items.find((i) => i.step_index === 83);
    assert.equal(errSumItem.status, "ERROR");
    assert.match(errSumItem.summary, /\[ERROR\].*\[spill: steps\/83\]/);

    for (const subCmd of [
      ["transcript", "read", convSum, "--summary", "--json"],
      ["transcript", "outline", convSum, "--json"],
      ["transcript", "summary", convSum, "--json"]
    ]) {
      const aliasRes = runCli(subCmd);
      assert.equal(aliasRes.status, 0, aliasRes.stderr);
      const aliasParsed = JSON.parse(aliasRes.stdout);
      assert.ok(Buffer.byteLength(aliasRes.stdout, "utf8") <= 9200);
      assert.ok(aliasParsed.items.length >= 10 && aliasParsed.displayedCount === aliasParsed.items.length);
      assert.equal(aliasParsed.items[0].tool_calls, undefined);
      assert.equal(aliasParsed.items[0].content, undefined);
    }

    // Tight budget on compact summary truncates smoothly with non-empty items and valid cursor
    const tightSum = runCli(["transcript", "query", "STAGE_", convSum, "--summary", "--json", "--max-chars", "1200"]);
    assertBounded(tightSum, 1200);
    const tightParsed = JSON.parse(tightSum.stdout);
    assert.equal(tightParsed.jsonTruncated, true);
    assert.ok(tightParsed.items.length > 0 && tightParsed.items.length < 10);
    assert.equal(tightParsed.displayedCount, tightParsed.items.length);
    assert.equal(tightParsed.jsonItemsIncluded, tightParsed.items.length);

    // P3 regression: query --summary --start <N> (without --end) must preserve --start <N> in nextCursor & Markdown footer
    const startOnlySumMd = runCli(["transcript", "query", "STAGE_", convSum, "--summary", "--start", "76", "--limit", "4"]);
    assert.equal(startOnlySumMd.status, 0, startOnlySumMd.stderr);
    assert.match(startOnlySumMd.stdout, /Step 81 \|/);
    assert.match(startOnlySumMd.stdout, /Step 84 \|/);
    assert.equal(startOnlySumMd.stdout.includes("Step 80 |"), false);
    assert.match(startOnlySumMd.stdout, /--start 76 --end 80/, "non-clamped --start-only summary footer must preserve --start bound");

    const startOnlySumJson = runCli(["transcript", "query", "STAGE_", convSum, "--summary", "--start", "76", "--limit", "4", "--json"]);
    assert.equal(startOnlySumJson.status, 0, startOnlySumJson.stderr);
    const sosParsed = JSON.parse(startOnlySumJson.stdout);
    assert.deepEqual(sosParsed.items.map((it) => it.step_index), [81, 82, 83, 84]);
    assert.deepEqual(sosParsed.nextCursor, { start: 76, end: 80 });

    const startOnlyHop2 = runCli([
      "transcript", "query", "STAGE_", convSum, "--summary",
      "--start", String(sosParsed.nextCursor.start), "--end", String(sosParsed.nextCursor.end), "--limit", "4", "--json"
    ]);
    assert.equal(startOnlyHop2.status, 0, startOnlyHop2.stderr);
    const sosHop2 = JSON.parse(startOnlyHop2.stdout);
    assert.deepEqual(sosHop2.items.map((it) => it.step_index), [77, 78, 79, 80]);
    assert.deepEqual(sosHop2.nextCursor, { start: 76, end: 76 });

    const startOnlyHop3 = runCli([
      "transcript", "query", "STAGE_", convSum, "--summary",
      "--start", String(sosHop2.nextCursor.start), "--end", String(sosHop2.nextCursor.end), "--limit", "4", "--json"
    ]);
    assert.equal(startOnlyHop3.status, 0, startOnlyHop3.stderr);
    const sosHop3 = JSON.parse(startOnlyHop3.stdout);
    assert.deepEqual(sosHop3.items.map((it) => it.step_index), [76]);
    assert.equal(sosHop3.nextCursor, null);

    // P3 + summaryStart: when Markdown fits (maxResultsTruncated === false) and JSON overflows, serializeBoundedJsonPayload preserves --start
    const startOnlyJsonOverflow = runCli(["transcript", "query", "STAGE_", convSum, "--summary", "--start", "76", "--limit", "500", "--json", "--max-chars", "1200"]);
    assertBounded(startOnlyJsonOverflow, 1200);
    const sojoParsed = JSON.parse(startOnlyJsonOverflow.stdout);
    assert.equal(sojoParsed.jsonTruncated, true);
    assert.equal(sojoParsed.items.at(-1).step_index, 84);
    assert.deepEqual(sojoParsed.nextCursor, { start: 76, end: sojoParsed.items[0].step_index - 1 });

    // count === 0 backward !forward summary cursor preserves --start bound and drops cursor when exhausted (nextEnd < minStart)
    const sumZeroBudget = Buffer.byteLength(JSON.stringify({
      ...sosParsed,
      items: [],
      displayedCount: 0,
      nextCursor: { start: 76, end: 83 },
      jsonTruncated: true,
      jsonItemsIncluded: 0,
      jsonItemsTotal: 4,
      jsonTruncatedReason: jsonTruncMetaReason
    }) + "\n", "utf8") + 16;
    const startOnlyZeroBackward = runCli(["transcript", "query", "STAGE_", convSum, "--summary", "--start", "76", "--limit", "4", "--json", "--max-chars", String(sumZeroBudget)]);
    assertBounded(startOnlyZeroBackward, sumZeroBudget);
    const sozbParsed = JSON.parse(startOnlyZeroBackward.stdout);
    assert.equal(sozbParsed.jsonTruncated, true);
    assert.equal(sozbParsed.items.length, 0);
    assert.deepEqual(sozbParsed.nextCursor, { start: 76, end: 83 });

    const startOnlyZeroExhausted = runCli(["transcript", "query", "--id", convHuge, "--summary", "--start", "399", "--include-tools", "--full-args", "--json", "--max-chars", String(outlineZeroBudget)]);
    assertBounded(startOnlyZeroExhausted, outlineZeroBudget);
    const sozeParsed = JSON.parse(startOnlyZeroExhausted.stdout);
    assert.equal(sozeParsed.items.length, 0);
    assert.equal(sozeParsed.nextCursor, undefined, "exhausted single-step backward range must omit nextCursor");

    // 10.3 PR7-RUN-003 & PR7-DOC-001: unified sanitized export limits across stdout, --full, --max-chars, and --out
    const writeConvLines = (rootBrain, cid, steps) => {
      const dir = path.join(rootBrain, cid, ".system_generated", "logs");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "transcript.jsonl"), steps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
    };
    const expCoordId = "coord-l46-export-10";
    const expChildIds = [];
    for (let c = 1; c <= 9; c++) {
      const cid = `l46-exp-child-${c}`;
      expChildIds.push(cid);
      const childSteps = [
        {
          step_index: 0,
          type: "SYSTEM_MESSAGE",
          source: "SYSTEM",
          created_at: "2026-11-18T01:00:00Z",
          content: `[Message] timestamp=2026-11-18T01:00:00Z sender=${expCoordId} priority=MESSAGE_PRIORITY_HIGH content=Your assignment (recorded on the board as #${c} for @worker-${c}):\n[agy-transcript-access: deny]\nRun analysis ${c}`
        }
      ];
      for (let s = 1; s <= 18; s++) {
        childSteps.push({
          step_index: s,
          type: s % 2 === 1 ? "PLANNER_RESPONSE" : "GENERIC",
          status: "DONE",
          created_at: `2026-11-18T01:${String(s).padStart(2, "0")}:00Z`,
          thinking: "SECRET_EXPORT_THINKING_NEVER_LEAK",
          content: `Worker ${c} step ${s} 🚀🔥€— ` + "L".repeat(2500) + " TAIL_CONTENT_BODY_NEVER_LEAK",
          tool_calls: s % 2 === 1
            ? [{ name: "run_command", args: { CommandLine: `echo worker_${c}_step_${s} Bearer secret_tok_999` } }]
            : undefined
        });
      }
      writeConvLines(brainDir, cid, childSteps);
    }

    // (a) Markdown --out > 24 KB (< 524,288 B) retains ALL 9 child sessions instead of pretty-JSON-pruning at 64,000
    const prevExpBrain = process.env.AGY_BRAIN_DIR;
    process.env.AGY_BRAIN_DIR = brainDir;
    try {
      const cohortMdOut = path.join(ergOutDir, "cohort-index.md");
      const cohortMdCli = runCli(["transcript", "export", "--parent", expCoordId, "--sanitized", "--out", cohortMdOut]);
      assert.equal(cohortMdCli.status, 0, cohortMdCli.stderr);
      const cohortMdDisk = fs.readFileSync(cohortMdOut, "utf8");
      const cohortMdBytes = fs.statSync(cohortMdOut).size;
      assert.ok(cohortMdBytes > 24000 && cohortMdBytes <= 524288, `expected ~25-45 KB index, got ${cohortMdBytes}`);
      for (let c = 1; c <= 9; c++) {
        assert.ok(cohortMdDisk.includes(`@worker-${c}`), `Markdown --out must retain session ${c} well below 512 KB`);
      }
      assert.ok(!cohortMdDisk.includes("SECRET_EXPORT_THINKING_NEVER_LEAK"));
      assert.ok(!cohortMdDisk.includes("TAIL_CONTENT_BODY_NEVER_LEAK"));
      assert.ok(!cohortMdDisk.includes("secret_tok_999"));
      assert.ok(!cohortMdDisk.includes("\uFFFD"));

      // (b) Explicit --max-chars 32000 on Markdown --out honors Markdown bytes even though pretty JSON would be ~70 KB
      const cohortMdCapOut = path.join(ergOutDir, "cohort-md-32k.md");
      const cohortMdCapCli = runCli([
        "transcript", "export", "--parent", expCoordId, "--sanitized", "--max-chars", "35000", "--out", cohortMdCapOut
      ]);
      assert.equal(cohortMdCapCli.status, 0, cohortMdCapCli.stderr);
      const cohortMdCapBytes = fs.statSync(cohortMdCapOut).size;
      assert.ok(cohortMdCapBytes <= 35000);
      assert.ok(fs.readFileSync(cohortMdCapOut, "utf8").includes("@worker-9"), "Markdown budget must not shrink by pretty-JSON overhead");

      // (c) Stdout export --sanitized --json and Markdown both strictly obey 9,200 UTF-8 inline ceiling
      const inlineExpJsonCli = runCli(["transcript", "export", "--parent", expCoordId, "--sanitized", "--json"]);
      assertBounded(inlineExpJsonCli, 9200);
      const inlineExpJsonParsed = JSON.parse(inlineExpJsonCli.stdout);
      assert.equal(inlineExpJsonParsed.jsonTruncated, true);
      assert.equal(inlineExpJsonParsed.jsonSessionsTotal, 9);
      assert.ok(inlineExpJsonParsed.exportedCount >= 2 && inlineExpJsonParsed.exportedCount === inlineExpJsonParsed.sessions.length);

      const inlineExpMdCli = runCli(["transcript", "export", "--parent", expCoordId, "--sanitized"]);
      assertBounded(inlineExpMdCli, 9200);

      // (d) --full expands stdout JSON/Markdown to 524,288 B deep tier
      const fullExpJsonCli = runCli(["transcript", "export", "--parent", expCoordId, "--sanitized", "--full", "--json"]);
      assertBounded(fullExpJsonCli, 524288);
      assert.equal(JSON.parse(fullExpJsonCli.stdout).exportedCount, 9);

      // (e) Explicit --max-chars on export JSON (stdout & --out) + impossibly small budget preservation
      const cappedExpJsonOut = path.join(ergOutDir, "cohort-json-5k.json");
      const cappedExpJsonCli = runCli([
        "transcript", "export", "--parent", expCoordId, "--sanitized", "--max-chars", "5000", "--out", cappedExpJsonOut, "--json"
      ]);
      assert.equal(cappedExpJsonCli.status, 0, cappedExpJsonCli.stderr);
      const cappedExpBytes = fs.statSync(cappedExpJsonOut).size;
      assert.ok(cappedExpBytes <= 5000, `export JSON --out exceeded 5000 bytes: ${cappedExpBytes}`);
      const cappedExpParsed = JSON.parse(fs.readFileSync(cappedExpJsonOut, "utf8"));
      assert.equal(cappedExpParsed.jsonTruncated, true);
      assert.equal(cappedExpParsed.jsonSessionsIncluded, cappedExpParsed.sessions.length);
      const cappedExpStdout = JSON.parse(cappedExpJsonCli.stdout);
      assert.equal(cappedExpStdout.bytesWritten, cappedExpBytes);
      const cappedExpText = fs.readFileSync(cappedExpJsonOut, "utf8");
      const expectedExpLines = cappedExpText.split("\n").length - (cappedExpText.endsWith("\n") ? 1 : 0);
      assert.equal(cappedExpStdout.lineCount, expectedExpLines, "--out --json must report exact lineCount");
      assert.equal(cappedExpStdout.sessions, undefined);

      // Verify Markdown --out confirmations include exact `(<N> lines, <B> bytes)` for both `outline` and `export`
      const outLineTestMd = path.join(ergOutDir, "outline-lines.md");
      const outlineOutCli = runCli(["transcript", "outline", "--id", expChildIds[0], "--full", "--out", outLineTestMd]);
      assert.equal(outlineOutCli.status, 0, outlineOutCli.stderr);
      const outlineOutContent = fs.readFileSync(outLineTestMd, "utf8");
      const expectedOutlineLines = outlineOutContent.split("\n").length - (outlineOutContent.endsWith("\n") ? 1 : 0);
      const expectedOutlineBytes = Buffer.byteLength(outlineOutContent, "utf8");
      assert.match(
        outlineOutCli.stdout,
        new RegExp(`\\(${expectedOutlineLines} lines, ${expectedOutlineBytes} bytes\\)`),
        "--out text confirmation must print exact lineCount and bytesWritten"
      );

      const expLineTestMd = path.join(ergOutDir, "export-lines.md");
      const expOutCli = runCli(["transcript", "export", "--id", expChildIds[0], "--sanitized", "--out", expLineTestMd]);
      assert.equal(expOutCli.status, 0, expOutCli.stderr);
      const expOutContent = fs.readFileSync(expLineTestMd, "utf8");
      const expectedExpMdLines = expOutContent.split("\n").length - (expOutContent.endsWith("\n") ? 1 : 0);
      const expectedExpMdBytes = Buffer.byteLength(expOutContent, "utf8");
      assert.match(
        expOutCli.stdout,
        new RegExp(`1 session\\(s\\), ${expectedExpMdLines} lines, ${expectedExpMdBytes} bytes\\)`),
        "export --out text confirmation must print exact lineCount and bytesWritten"
      );

      // Impossibly small --max-chars must fail nonzero and leave existing artifact untouched
      const sentinelExportPath = path.join(ergOutDir, "preserve-export.json");
      fs.writeFileSync(sentinelExportPath, "keep-export-sentinel", "utf8");
      for (const fmtFlags of [[], ["--json"]]) {
        const tinyFail = runCli([
          "transcript", "export", "--parent", expCoordId, "--sanitized", "--max-chars", "80", "--out", sentinelExportPath, ...fmtFlags
        ]);
        assert.notEqual(tinyFail.status, 0, "impossibly small export budget must exit nonzero");
        assert.equal(tinyFail.stdout, "");
        assert.equal(fs.readFileSync(sentinelExportPath, "utf8"), "keep-export-sentinel");
      }
      const tooBigMax = runCli(["transcript", "export", "--id", expChildIds[0], "--sanitized", "--max-chars", "999999"]);
      assert.notEqual(tooBigMax.status, 0);

      // (f) Single-session export tail vs --start head cursor consistency + multi-session trimmed-row cursor honesty
      const singleExportTailFit = runCli([
        "transcript", "export", "--id", convHuge, "--sanitized", "--limit", "50", "--max-chars", "50000", "--json"
      ]);
      assert.equal(singleExportTailFit.status, 0, singleExportTailFit.stderr);
      const setf = JSON.parse(singleExportTailFit.stdout);
      assert.equal(setf.clamped, true);
      assert.equal(setf.sessions[0].rows[0].step, 350);
      assert.equal(setf.sessions[0].rows.at(-1).step, 399);
      assert.deepEqual(setf.nextCursor, { end: 349 });

      const singleExportTailClamp = runCli([
        "transcript", "export", "--id", convHuge, "--sanitized", "--limit", "50", "--max-chars", "3500", "--json"
      ]);
      assertBounded(singleExportTailClamp, 3500);
      const setc = JSON.parse(singleExportTailClamp.stdout);
      assert.equal(setc.sessions[0].rows.at(-1).step, 399, "single-session export byte-clamp without --start must retain tail rows");
      assert.deepEqual(setc.nextCursor, { end: setc.sessions[0].rows[0].step - 1 });

      const singleExportHeadClamp = runCli([
        "transcript", "export", "--id", convHuge, "--sanitized", "--start", "0", "--limit", "50", "--max-chars", "3500", "--json"
      ]);
      assertBounded(singleExportHeadClamp, 3500);
      const sehc = JSON.parse(singleExportHeadClamp.stdout);
      assert.equal(sehc.sessions[0].rows[0].step, 0, "single-session export with --start 0 must collect from head");
      assert.deepEqual(sehc.nextCursor, { start: sehc.sessions[0].rows.at(-1).step + 1 });

      // Multi-session export that trims rows across multiple sessions omits misleading single-session nextCursor
      assert.equal(cappedExpParsed.nextCursor, undefined, "multi-session export with trimmed retained rows must not skip trimmed rows via nextCursor");
      assert.match(cappedExpParsed.jsonTruncatedReason, /trimmed rows across multiple sessions/);

      // P2 regression: 2-session export (no --start) where A fits completely and B trims retains B's tail rows with exact cursor
      const convP2Small = "conv-p2-small-5";
      const convP2Large = "conv-p2-large-200";
      writeConvLines(brainDir, convP2Small, Array.from({ length: 5 }, (_, s) => ({
        step_index: s,
        type: s === 0 ? "USER_INPUT" : "PLANNER_RESPONSE",
        created_at: `2026-11-18T02:30:0${s}Z`,
        content: `Small session step ${s}`
      })));
      writeConvLines(brainDir, convP2Large, Array.from({ length: 200 }, (_, s) => ({
        step_index: s,
        type: s % 2 === 0 ? "USER_INPUT" : "PLANNER_RESPONSE",
        created_at: "2026-11-18T02:31:00Z",
        content: `Large session step ${s} ` + "M".repeat(90)
      })));

      const p2MultiTailClamp = runCli([
        "transcript", "export", "--id", `${convP2Small},${convP2Large}`, "--sanitized", "--limit", "160", "--max-chars", "6000", "--json"
      ]);
      assertBounded(p2MultiTailClamp, 6000);
      const p2Parsed = JSON.parse(p2MultiTailClamp.stdout);
      assert.equal(p2Parsed.jsonTruncated, true);
      assert.equal(p2Parsed.exportedCount, 2);
      assert.deepEqual(p2Parsed.sessions[0].rows.map((r) => r.step), [0, 1, 2, 3, 4]);
      assert.equal(p2Parsed.sessions[0].truncatedSteps, false);
      assert.equal(p2Parsed.sessions[1].convId, convP2Large);
      assert.equal(p2Parsed.sessions[1].truncatedSteps, true);
      assert.equal(p2Parsed.sessions[1].rows.at(-1).step, 199, "multi-session omitted-start export must tail-slice retained rows");
      const p2FirstKept = p2Parsed.sessions[1].rows[0].step;
      assert.ok(p2FirstKept > 40 && p2FirstKept < 199);
      assert.deepEqual(p2Parsed.nextCursor, { id: convP2Large, end: p2FirstKept - 1 });

      const p2FollowUp = runCli([
        "transcript", "export", "--id", p2Parsed.nextCursor.id, "--end", String(p2Parsed.nextCursor.end), "--sanitized", "--limit", "200", "--max-chars", "50000", "--json"
      ]);
      assert.equal(p2FollowUp.status, 0, p2FollowUp.stderr);
      const p2FollowParsed = JSON.parse(p2FollowUp.stdout);
      assert.equal(p2FollowParsed.sessions[0].rows[0].step, 0);
      assert.equal(p2FollowParsed.sessions[0].rows.at(-1).step, p2FirstKept - 1);
      assert.equal(p2FollowParsed.sessions[0].truncatedSteps, false);

      // Multi-session --limit truncation on 1 session without JSON byte overflow also emits exact single-incomplete nextCursor
      const p2MultiLimitOnly = runCli([
        "transcript", "export", "--id", `${convP2Small},${convP2Large}`, "--sanitized", "--limit", "50", "--max-chars", "50000", "--json"
      ]);
      assert.equal(p2MultiLimitOnly.status, 0, p2MultiLimitOnly.stderr);
      const p2LimParsed = JSON.parse(p2MultiLimitOnly.stdout);
      assert.equal(p2LimParsed.clamped, true);
      assert.equal(p2LimParsed.jsonTruncated, undefined);
      assert.equal(p2LimParsed.sessions[1].rows[0].step, 150);
      assert.equal(p2LimParsed.sessions[1].rows.at(-1).step, 199);
      assert.deepEqual(p2LimParsed.nextCursor, { id: convP2Large, end: 149 });
    } finally {
      if (prevExpBrain !== undefined) process.env.AGY_BRAIN_DIR = prevExpBrain;
      else delete process.env.AGY_BRAIN_DIR;
    }

    // 10.4 PR7-RUN-004: Worker-turn logical anchor (userTurns === 0) & Step 0 recovery without skips/duplicates
    const convWorker = "conv-worker-turns-22";
    const workerSteps = [
      {
        step_index: 0,
        type: "SYSTEM_MESSAGE",
        source: "SYSTEM",
        created_at: "2026-11-18T02:00:00Z",
        content: "[Message] sender=coord priority=MESSAGE_PRIORITY_HIGH content=Your assignment (recorded on the board as #1 for @worker-p3):\nInitial stage"
      },
      { step_index: 1, type: "PLANNER_RESPONSE", created_at: "2026-11-18T02:00:05Z", content: "Stage A started " + "A".repeat(300) },
      { step_index: 2, type: "GENERIC", created_at: "2026-11-18T02:00:06Z", content: "STEP_02_OK " + "B".repeat(250) },
      {
        step_index: 3,
        type: "SYSTEM_MESSAGE",
        source: "SYSTEM",
        created_at: "2026-11-18T02:00:07Z",
        content: "[Message] sender=coord priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #2"
      },
      {
        step_index: 4,
        type: "SYSTEM_MESSAGE",
        source: "SYSTEM",
        created_at: "2026-11-18T02:01:00Z",
        content: "[Message] sender=coord priority=MESSAGE_PRIORITY_HIGH content=@worker-p3 Stage C wakeup prompt"
      }
    ];
    for (let s = 5; s <= 13; s++) {
      workerSteps.push({ step_index: s, type: "GENERIC", created_at: `2026-11-18T02:01:${String(s).padStart(2, "0")}Z`, content: `Step ${s} output ` + "C".repeat(120) });
    }
    workerSteps.push({
      step_index: 14,
      type: "PLANNER_RESPONSE",
      created_at: "2026-11-18T02:02:14Z",
      content: "Writing UTF8 note",
      tool_calls: [{ name: "write_file", args: { Content: "WORKER_UTF8_🚀🔥€—_MARKER", Path: "scratch/utf8.txt" } }]
    });
    for (let s = 15; s <= 20; s++) {
      workerSteps.push({ step_index: s, type: "GENERIC", created_at: `2026-11-18T02:02:${String(s).padStart(2, "0")}Z`, content: `Post write step ${s} ` + "D".repeat(90) });
    }
    workerSteps.push({ step_index: 21, type: "PLANNER_RESPONSE", created_at: "2026-11-18T02:03:00Z", content: "Final short ASCII wrap-up" });
    writeConvLines(brainDir, convWorker, workerSteps);

    // Inline --last-turns 1 anchors on Step 4 (latest substantive wakeup SYSTEM_MESSAGE), NOT final Step 21 PLANNER_RESPONSE!
    const workerLast1 = runCli(["transcript", "read", convWorker, "--last-turns", "1"]);
    assert.equal(workerLast1.status, 0, workerLast1.stderr);
    assert.match(workerLast1.stdout, /WORKER_UTF8_🚀🔥€—_MARKER/, "promptless worker --last-turns 1 must keep tool step 14 in the current turn");
    assert.match(workerLast1.stdout, /Final short ASCII wrap-up/);
    assert.equal(workerLast1.stdout.includes("STEP_02_OK"), false, "earlier worker turn before Step 4 wakeup stays scoped out of last-turns 1");

    // When clamped at firstOrd = 21 (--max-chars 520), backward nextCursor reaches Step 0 with zero skips/duplicates!
    const clampedWorker520 = runCli(["transcript", "read", convWorker, "--last-turns", "1", "--max-chars", "520", "--json"]);
    assertBounded(clampedWorker520, 520);
    const cwParsed = JSON.parse(clampedWorker520.stdout);
    assert.equal(cwParsed.clamped, true);
    assert.equal(cwParsed.steps[0].step_index, 21);
    assert.ok(cwParsed.nextCursor && cwParsed.nextCursor.offset === 0, `expected offset 0 when firstOrd=21, got ${JSON.stringify(cwParsed.nextCursor)}`);
    assert.ok(cwParsed.nextCursor.limit <= 21 && cwParsed.nextCursor.limit > 0);

    // Walk explicitly from nextCursor forward and confirm every step 0..20 is visited with zero skips/duplicates
    const seenOrdinals = new Set();
    const collectedOrder = [];
    let cur = cwParsed.nextCursor;
    for (let hop = 0; hop < 30 && cur && cur.offset < 21; hop++) {
      const pageRes = await readTranscript({ conversationId: convWorker, offset: cur.offset, limit: cur.limit });
      assert.equal(pageRes.isError, undefined);
      for (const st of pageRes.steps) {
        assert.equal(seenOrdinals.has(st.step_index), false, `duplicate step ${st.step_index} during pagination`);
        seenOrdinals.add(st.step_index);
        collectedOrder.push(st.step_index);
      }
      cur = pageRes.nextCursor;
    }
    assert.equal(collectedOrder[0], 0, "pagination continuation must reach Step 0 first");
    assert.deepEqual(collectedOrder, Array.from({ length: 21 }, (_, idx) => idx), "every step 0..20 must be covered without skips or duplicates");

    console.log("✓ PR #7 L46 remediations verified (Option A status disclosure, compact summary JSON, unified sanitized export & worker cursors)");

    // 11. PR #8 L54 Output Normalization & Readable Bounded JSON
    console.log("\n--- 11. PR #8 L54 Output Normalization & Readable Bounded JSON ---");
    const convNorm = "conv-pr8-normalization";
    const normLogs = path.join(brainDir, convNorm, ".system_generated", "logs");
    fs.mkdirSync(normLogs, { recursive: true });
    const bigSingleLineJson = JSON.stringify({
      status: "ok",
      items: Array.from({ length: 18 }, (_, i) => ({
        step_index: i + 1,
        role: "generic",
        summary: `Item ${i + 1} verification payload with structured fields cleanly serialized`
      }))
    });
    assert.ok(bigSingleLineJson.length > 1300, "test fixture JSON must exceed MAX_LINE_CHARS (1000)");

    const normCompactSteps = [
      {
        step_index: 0,
        type: "USER_INPUT",
        source: "USER",
        created_at: "2026-11-18T03:00:00Z",
        content: "<USER_REQUEST>\r\nInspect normalized output\r\n\r\n\r\nPlease.\r\n</USER_REQUEST>"
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        status: "DONE",
        created_at: "2026-11-18T03:00:05Z",
        thinking: "Paragraph one.\r\n\r\n\r\nParagraph two.\r\n\r\n\r\n",
        content: "Checking tool execution.\r\n\r\n\r\nDone.",
        tool_calls: [
          {
            name: "run_command",
            args: {
              CommandLine: "\"echo hi\\r\\n\"",
              WaitMsBeforeAsync: "5000",
              IsDaemon: "false"
            }
          },
          {
            name: "write_file",
            args: {
              Content: "\"# Report\\nLine 2 \\\"quoted\\\" \\u0041\\\\tail\\u00\n<truncated 500 bytes>",
              Overwrite: "true",
              Path: "\"scratch/out.md\""
            }
          },
          {
            name: "replace_file_content",
            args: {
              CommandQuoted: "\"\\\"C:/Program Files/app.exe\\\" --flag1 --flag2\n<truncated 500 bytes>",
              WinQuoted: "\"\\\"C:\\\\temp\\\\run.exe\\\"\"",
              ReplacementChunks: "[{\"AllowMultiple\":\"false\",\"StartLine\":\"10\",\"TargetContent\":\"\\\"foo\\\\r\\\\nbar\\\"\"}]"
            }
          }
        ],
        truncated_fields: ["tool_calls"]
      },
      {
        step_index: 2,
        type: "GENERIC",
        source: "MODEL",
        status: "DONE",
        created_at: "2026-11-18T03:00:10Z",
        content: [
          "A pre-tool hook changed the arguments of this tool call before it ran. Changed: CommandLine.\r",
          "\r",
          "The tool's output was truncated due to being too long. You can find the full output in a file at file:///x/.system_generated/steps/42/output.txt.\r",
          "\r",
          "Here is a preview with the middle of the output truncated:\r",
          "Created At: 2026-11-17T22:00:10-05:00\r",
          "Completed At: 2026-11-17T22:00:12-05:00\r",
          "Created At: 2026-11-17T22:00:10-05:00\r",
          "Completed At: 2026-11-17T22:00:12-05:00\r",
          "Command exited with code 7.\r",
          "\r",
          "Command output:\r",
          bigSingleLineJson,
          "\r",
          "Body literal Created At: keep me\r",
          "NonJsonBlob:",
          "Q".repeat(1300)
        ].join("\n")
      },
      {
        step_index: 3,
        type: "GENERIC",
        source: "MODEL",
        status: "DONE",
        created_at: "2026-11-18T03:00:15Z",
        content: "Created At: 2026-11-17T22:00:15-05:00\r\nCompleted At: 2026-11-17T22:00:16-05:00\r\n"
      }
    ];
    for (let s = 4; s <= 12; s++) {
      normCompactSteps.push({
        step_index: s,
        type: "GENERIC",
        source: "MODEL",
        status: "DONE",
        created_at: `2026-11-18T03:01:${String(s).padStart(2, "0")}Z`,
        content: `Created At: 2026-11-17T22:01:00-05:00\r\nCompleted At: 2026-11-17T22:01:01-05:00\r\nTrailing step ${s} ` + "N".repeat(260)
      });
    }
    const normFullSteps = normCompactSteps.map((s) => ({ ...s }));
    normFullSteps[1] = {
      ...normCompactSteps[1],
      truncated_fields: [],
      tool_calls: [
        {
          name: "write_file",
          args: {
            Content: "[1, 2, 3]\r\nLine 2\r\n\r\n\r\nLine 3",
            FlagText: "true",
            NullText: "null",
            JsonText: "[1,2]",
            WinNative: "\"C:\\temp\\run.exe\"",
            Overwrite: true,
            WaitMsBeforeAsync: 5000
          }
        }
      ]
    };
    fs.writeFileSync(path.join(normLogs, "transcript.jsonl"), normCompactSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
    fs.writeFileSync(path.join(normLogs, "transcript_full.jsonl"), normFullSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");

    // 11.1 cleanMessageContent & Markdown rendering: CRLF, <thinking>, Created At deduping, single-line JSON pretty-print
    const cleanedCrlf = cleanMessageContent("a\r\nb\rc\r\n\r\n\r\nd", 500);
    assert.equal(cleanedCrlf.includes("\r"), false);
    assert.equal(cleanedCrlf, "a\nb\nc\n\nd");

    const step2Detail = runCli(["transcript", "step", "2", convNorm]);
    assert.equal(step2Detail.status, 0, step2Detail.stderr);
    assert.equal(step2Detail.stdout.includes("\r"), false, "step Markdown must strip CR characters");
    assert.equal(step2Detail.stdout.includes("Created At: 2026-11-17"), false, "step Markdown must strip duplicate leading Created At headers even after hook/spillover prefixes");
    assert.equal(step2Detail.stdout.includes("Completed At: 2026-11-17"), false, "step Markdown must strip duplicate leading Completed At headers even after hook/spillover prefixes");
    assert.match(step2Detail.stdout, /A pre-tool hook changed/, "step must preserve hook-changed notice");
    assert.match(step2Detail.stdout, /Here is a preview/, "step must preserve spillover preview notice");
    assert.match(step2Detail.stdout, /Command exited with code 7\./, "step must preserve exit code line");
    assert.match(step2Detail.stdout, /steps\/42\/output\.txt/, "step must preserve spillover URL");
    assert.match(step2Detail.stdout, /Body literal Created At: keep me/, "body Created At inside Command output must be preserved");
    assert.match(step2Detail.stdout, /"step_index": 18/, "single-line JSON output must pretty-print instead of mid-line clamping");
    assert.match(step2Detail.stdout, /\[line clamped\]/, "non-JSON single-line blob must still clamp at MAX_LINE_CHARS");

    const step2Full = runCli(["transcript", "step", "2", convNorm, "--full"]);
    assert.equal(step2Full.status, 0, step2Full.stderr);
    assert.match(step2Full.stdout, /"step_index": 18/, "step --full must also pretty-print bounded single-line JSON");
    assert.equal(step2Full.stdout.includes("[line clamped]"), false, "step --full must not line-clamp non-JSON lines");
    assert.equal(step2Full.stdout.includes("Created At: 2026-11-17"), false, "step --full must strip leading Created At headers after prefixes");

    const step1Read = runCli(["transcript", "read", convNorm, "--mode", "compact", "--offset", "1", "--limit", "1", "--include-thinking"]);
    assert.equal(step1Read.status, 0, step1Read.stderr);
    assert.equal(step1Read.stdout.includes("\r"), false);
    assert.ok(step1Read.stdout.includes("> Paragraph one.\n> \n> Paragraph two.\n> </thinking>"), "thinking block must collapse extra blank lines and trim trailing newlines before </thinking>");
    assert.ok(!step1Read.stdout.includes("> </thinking>".replace("</thinking>", "\n> </thinking>")));
    assert.ok(!step1Read.stdout.includes('Content="\\"# Report\\\\n'), "truncated compact Content must unwrap without double-escaping");
    assert.match(step1Read.stdout, /Content="# Report Line 2/, "unwrapped compact Content preview should be readable plain text");

    // 11.2 --field content and --field thinking on step normalize CRLF, headers, pretty JSON, and whitespace
    const step2Content = runCli(["transcript", "step", "2", convNorm, "--field", "content"]);
    assert.equal(step2Content.status, 0);
    assert.equal(step2Content.stdout.includes("\r"), false);
    assert.equal(step2Content.stdout.includes("Created At: 2026-11-17"), false);
    assert.match(step2Content.stdout, /"step_index": 18/, "step --field content must pretty-print bounded single-line JSON");
    const step2ContentSliced = runCli(["transcript", "step", "2", convNorm, "--field", "content", "--line-start", "6", "--line-end", "14"]);
    assert.equal(step2ContentSliced.status, 0);
    assert.match(step2ContentSliced.stdout, /"status": "ok"/);

    const step3EmptyHeaders = runCli(["transcript", "step", "3", convNorm, "--field", "content"]);
    assert.equal(step3EmptyHeaders.status, 0);
    assert.match(step3EmptyHeaders.stdout, /\(No content in step\)/);

    const step1Thinking = runCli(["transcript", "step", "1", convNorm, "--field", "thinking"]);
    assert.equal(step1Thinking.status, 0);
    assert.equal(step1Thinking.stdout.includes("\r"), false);
    assert.match(step1Thinking.stdout, /Paragraph one\.\n\nParagraph two\.$/m);

    // 11.3 Compact --json normalization decodes 1-layer compact args & containers + keeps _fileOrd, while full-source native literals stay intact
    const compactStep1Json = runCli(["transcript", "read", convNorm, "--mode", "compact", "--offset", "1", "--limit", "1", "--json"]);
    assert.equal(compactStep1Json.status, 0, compactStep1Json.stderr);
    const cs1 = JSON.parse(compactStep1Json.stdout);
    assert.equal(cs1.steps[0]._fileOrd, 1);
    assert.equal(cs1.steps[0].tool_calls[0].args.WaitMsBeforeAsync, 5000);
    assert.equal(cs1.steps[0].tool_calls[0].args.IsDaemon, false);
    assert.equal(cs1.steps[0].tool_calls[0].args.CommandLine, "echo hi\n");
    assert.equal(cs1.steps[0].tool_calls[1].args.Overwrite, true);
    assert.equal(cs1.steps[0].tool_calls[1].args.Path, "scratch/out.md");
    assert.match(cs1.steps[0].tool_calls[1].args.Content, /^# Report\nLine 2 "quoted" A\\tail\n<truncated 500 bytes>$/);
    assert.equal(
      cs1.steps[0].tool_calls[2].args.CommandQuoted,
      "\"C:/Program Files/app.exe\" --flag1 --flag2\n<truncated 500 bytes>",
      "truncated compact arg starting with quote must retain trailing --flag1 --flag2"
    );
    assert.equal(
      cs1.steps[0].tool_calls[2].args.WinQuoted,
      "\"C:\\temp\\run.exe\"",
      "compact quoted Windows path must decode 1 layer and preserve outer quotes + literal \\t/\\r backslashes"
    );
    assert.deepEqual(
      cs1.steps[0].tool_calls[2].args.ReplacementChunks,
      [{ AllowMultiple: false, StartLine: 10, TargetContent: "foo\nbar" }],
      "nested compact JSON containers must decode recursively"
    );

    const fullStep1Json = runCli(["transcript", "step", "1", convNorm, "--full", "--json"]);
    assert.equal(fullStep1Json.status, 0, fullStep1Json.stderr);
    const fs1 = JSON.parse(fullStep1Json.stdout);
    assert.equal(fs1.step.tool_calls[0].args.Content, "[1, 2, 3]\nLine 2\n\n\nLine 3");
    assert.equal(fs1.step.tool_calls[0].args.FlagText, "true", "native string 'true' in transcript_full.jsonl must remain string");
    assert.equal(fs1.step.tool_calls[0].args.NullText, "null", "native string 'null' in transcript_full.jsonl must remain string");
    assert.equal(fs1.step.tool_calls[0].args.JsonText, "[1,2]", "native string '[1,2]' in transcript_full.jsonl must remain string");
    assert.equal(fs1.step.tool_calls[0].args.WinNative, "\"C:\\temp\\run.exe\"", "native quoted Windows path in transcript_full.jsonl must keep outer quotes and backslashes");
    assert.equal(fs1.step.tool_calls[0].args.Overwrite, true);

    // Batch step (indices >= 3) on transcript_full.jsonl must also preserve native quoted Windows paths
    const fullBatchStep = runCli(["transcript", "step", "0,1,2", convNorm, "--field", "tool_args"]);
    assert.equal(fullBatchStep.status, 0, fullBatchStep.stderr);
    assert.ok(fullBatchStep.stdout.includes('\\"C:\\\\temp\\\\run.exe\\"'), "batch step on transcript_full.jsonl must preserve native outer quotes and backslashes");

    // 11.4 read file-fallback & query/tools Markdown parity across compact/auto/full
    const convOnlyFull = "conv-pr8-only-full";
    const onlyFullLogs = path.join(brainDir, convOnlyFull, ".system_generated", "logs");
    fs.mkdirSync(onlyFullLogs, { recursive: true });
    fs.writeFileSync(path.join(onlyFullLogs, "transcript_full.jsonl"), normFullSteps.slice(0, 2).map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
    const fallbackFullRead = runCli(["transcript", "read", convOnlyFull, "--offset", "1", "--limit", "1", "--json"]);
    assert.equal(fallbackFullRead.status, 0, fallbackFullRead.stderr);
    const ffr = JSON.parse(fallbackFullRead.stdout);
    assert.equal(ffr.steps[0].tool_calls[0].args.FlagText, "true", "read falling back to transcript_full.jsonl in compact mode must not coerce native strings");
    assert.equal(ffr.steps[0].tool_calls[0].args.WinNative, "\"C:\\temp\\run.exe\"");

    const convOnlyCompact = "conv-pr8-only-compact";
    const onlyCompactLogs = path.join(brainDir, convOnlyCompact, ".system_generated", "logs");
    fs.mkdirSync(onlyCompactLogs, { recursive: true });
    fs.writeFileSync(path.join(onlyCompactLogs, "transcript.jsonl"), normCompactSteps.slice(0, 2).map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
    const fallbackCompactRead = runCli(["transcript", "read", convOnlyCompact, "--mode", "full", "--offset", "1", "--limit", "1", "--json"]);
    assert.equal(fallbackCompactRead.status, 0, fallbackCompactRead.stderr);
    const fcr = JSON.parse(fallbackCompactRead.stdout);
    assert.equal(fcr.steps[0].tool_calls[0].args.WaitMsBeforeAsync, 5000, "read --mode full falling back to transcript.jsonl must decode compact args");
    assert.equal(fcr.steps[0].tool_calls[0].args.CommandLine, "echo hi\n");

    for (const qArgs of [
      ["transcript", "query", "echo hi", convNorm, "--mode", "compact", "--include-tools", "--field", "tool_calls"],
      ["transcript", "query", "echo hi", convNorm, "--mode", "compact", "--include-tools", "--field", "tool_args", "--full-args"],
      ["transcript", "query", "echo hi", convNorm, "--mode", "compact", "--include-tools", "--field", "tool_args:CommandLine"]
    ]) {
      const qFieldMd = runCli(qArgs);
      assert.equal(qFieldMd.status, 0, qFieldMd.stderr);
      assert.equal(qFieldMd.stdout.includes("\r"), false);
      assert.ok(!qFieldMd.stdout.includes('\\"echo hi\\\\r\\\\n\\"'), `compact query Markdown (${qArgs.join(" ")}) must unwrap compact args`);
      assert.match(qFieldMd.stdout, /echo hi/, "compact query Markdown must contain unwrapped CommandLine");
    }

    const toolsFullAutoMd = runCli(["transcript", "tools", "--id", convNorm, "--field", "tool_args:Content", "--full-args"]);
    assert.equal(toolsFullAutoMd.status, 0, toolsFullAutoMd.stderr);
    assert.equal(toolsFullAutoMd.stdout.includes("\r"), false, "auto query/tools on transcript_full.jsonl must normalize CRLF in Markdown --field output");

    const queryNormJson = runCli(["transcript", "query", "Command exited with code 7", convNorm, "--json"]);
    assert.equal(queryNormJson.status, 0);
    const qnj = JSON.parse(queryNormJson.stdout);
    assert.equal(qnj.items[0].content.includes("\r"), false);
    assert.equal(qnj.items[0].content.includes("Created At: 2026-11-17"), false);

    // 11.5 serializeBoundedJsonPayload emits 2-space pretty JSON when clamped page / single-step / batch / query / 0-item fits budget
    const clampedPrettyJson = runCli(["transcript", "read", convNorm, "--offset", "4", "--limit", "9", "--max-chars", "2200", "--json"]);
    assertBounded(clampedPrettyJson, 2200);
    assert.ok(clampedPrettyJson.stdout.includes("\n  \"steps\": [\n"), "clamped JSON page fitting within budget must remain 2-space indented");
    const cpParsed = JSON.parse(clampedPrettyJson.stdout);
    assert.equal(cpParsed.jsonTruncated, true);
    assert.ok(cpParsed.steps.length >= 2 && cpParsed.steps.length < 9);
    assert.equal(cpParsed.steps[0].content.includes("Created At: 2026-11-17"), false);

    const zeroItemPrettyJson = runCli(["transcript", "read", convNorm, "--offset", "2", "--limit", "5", "--max-chars", "780", "--json"]);
    assertBounded(zeroItemPrettyJson, 780);
    const zip = JSON.parse(zeroItemPrettyJson.stdout);
    assert.equal(zip.steps.length, 0, "oversized step 2 must force 0-item fallback under 780 bytes");
    assert.ok(zeroItemPrettyJson.stdout.includes("\n  \"steps\": []"), "0-item JSON fallback fitting budget should use 2-space indentation");

    // Deduplicated single-step projected JSON fits small content directly without raw-step bloat
    const singleStepPrettySelected = runCli(["transcript", "step", String(richAsstStep), convErg, "--field", "content", "--json", "--max-chars", "850"]);
    assertBounded(singleStepPrettySelected, 850);
    const ssps = JSON.parse(singleStepPrettySelected.stdout);
    assert.equal(ssps.jsonTruncated, undefined, "projected --field content omits raw step and fits cleanly in 850 bytes");
    assert.equal("step" in ssps, false, "projected --field content must not serialize unselected raw step");
    assert.equal(typeof ssps.data, "string");
    assert.ok(singleStepPrettySelected.stdout.includes("\n  \"stepIndex\":"), "single-step JSON must use 2-space indentation when it fits");

    const singleStepPrettySummary = runCli(["transcript", "step", String(richAsstStep), convErg, "--field", "thinking", "--json", "--max-chars", "750"]);
    assertBounded(singleStepPrettySummary, 750);
    const sspsum = JSON.parse(singleStepPrettySummary.stdout);
    assert.equal(sspsum.jsonTruncated, true);
    assert.equal(sspsum.jsonItemsIncluded, 0);
    assert.equal(sspsum.data, undefined);
    assert.ok(singleStepPrettySummary.stdout.includes("\n  \"stepIndex\":"), "single-step prettySummary must use 2-space indentation when it fits");

    const batchStepPrettyClamp = runCli(["transcript", "step", "4,5,6,7,8", convNorm, "--field", "content", "--json", "--max-chars", "1200"]);
    assertBounded(batchStepPrettyClamp, 1200);
    const bspc = JSON.parse(batchStepPrettyClamp.stdout);
    assert.equal(bspc.jsonTruncated, true);
    assert.ok(bspc.steps.length >= 1 && bspc.steps.length < 5);
    assert.ok(batchStepPrettyClamp.stdout.includes("\n  \"steps\": ["), "batch step clamped JSON must prefer 2-space pretty indentation when it fits");

    const queryPrettyClamp = runCli(["transcript", "query", "Trailing step", convNorm, "--json", "--max-chars", "1800"]);
    assertBounded(queryPrettyClamp, 1800);
    assert.ok(queryPrettyClamp.stdout.includes("\n  \"items\": ["), "query clamped JSON must prefer 2-space pretty indentation when it fits");

    // 11.6 outline/export compact decoding, mixed compactMatchIndices fallback, tc.arguments, truncated native quoted strings, and direct ESM fromCompact
    const outlineNormJson = runCli(["transcript", "outline", convNorm, "--json"]);
    assert.equal(outlineNormJson.status, 0, outlineNormJson.stderr);
    const onj = JSON.parse(outlineNormJson.stdout);
    const onjStep1 = onj.items.find((it) => it.step_index === 1);
    assert.ok(onjStep1);
    assert.ok(!onjStep1.summary.includes('\\"scratch/out.md\\"'), "outline default must decode compact tool args without hydrating transcript_full.jsonl");
    assert.match(onjStep1.summary, /Path="scratch\/out\.md"/);
    assert.match(onjStep1.summary, /CommandLine="echo hi"/);

    const outlineNormMd = runCli(["transcript", "outline", convNorm]);
    assert.equal(outlineNormMd.status, 0, outlineNormMd.stderr);
    assert.equal(outlineNormMd.stdout.includes("\r"), false);
    assert.match(outlineNormMd.stdout, /Path="scratch\/out\.md"/);

    const outlineNormFullArgs = runCli(["transcript", "outline", convNorm, "--full-args", "--json"]);
    assert.equal(outlineNormFullArgs.status, 0, outlineNormFullArgs.stderr);
    const onfaStep1 = JSON.parse(outlineNormFullArgs.stdout).items.find((it) => it.step_index === 1);
    assert.match(onfaStep1.summary, /FlagText="true"/, "outline --full-args must hydrate transcript_full.jsonl and preserve native strings");
    assert.match(onfaStep1.summary, /WinNative=/);

    const exportCompactOnly = runCli(["transcript", "export", "--id", convOnlyCompact, "--sanitized", "--json"]);
    assert.equal(exportCompactOnly.status, 0, exportCompactOnly.stderr);
    const eco = JSON.parse(exportCompactOnly.stdout);
    assert.ok(!eco.sessions[0].rows[1].tools.includes('\\"echo hi\\\\r\\\\n\\"'), "export on compact-only session must decode compact args");
    assert.match(eco.sessions[0].rows[1].tools, /run_command\(CommandLine="echo hi"\)/);

    const exportNormHydrated = runCli(["transcript", "export", "--id", convNorm, "--sanitized", "--json"]);
    assert.equal(exportNormHydrated.status, 0, exportNormHydrated.stderr);
    const enh = JSON.parse(exportNormHydrated.stdout);
    assert.match(enh.sessions[0].rows[1].tools, /^write_file\(/, "export must hydrate truncated_fields tool_calls from transcript_full.jsonl");

    // Mixed compactMatchIndices fallback + tc.arguments + truncated native "-prefixed string
    const convMixed = "conv-pr8-mixed-fallback";
    const mixedLogs = path.join(brainDir, convMixed, ".system_generated", "logs");
    fs.mkdirSync(mixedLogs, { recursive: true });
    const mixedCompactSteps = [
      {
        step_index: 0,
        type: "USER_INPUT",
        source: "USER",
        created_at: "2026-11-18T03:05:00Z",
        content: "Mixed fallback check"
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        status: "DONE",
        created_at: "2026-11-18T03:05:01Z",
        content: "Compact fallback step\r\n",
        tool_calls: [
          {
            name: "custom_arg_tool",
            arguments: {
              CommandLine: "\"mixed cmd\\r\\n\"",
              WaitMsBeforeAsync: "1234",
              NativeQuotedTail: "\"foo\" bar\n<truncated 10 bytes>"
            }
          }
        ]
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        status: "DONE",
        created_at: "2026-11-18T03:05:02Z",
        content: "Compact stub",
        tool_calls: [
          {
            name: "write_file",
            arguments: { FlagText: "\"true\"", WinNative: "\"\\\"C:\\\\temp\\\\run.exe\\\"\"" }
          }
        ],
        truncated_fields: ["tool_calls"]
      }
    ];
    const mixedFullSteps = [
      mixedCompactSteps[0],
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        status: "DONE",
        created_at: "2026-11-18T03:05:02Z",
        content: "Full step 2\r\n\r\n\r\nEnd.",
        tool_calls: [
          {
            name: "write_file",
            arguments: {
              FlagText: "true",
              WinNative: "\"C:\\temp\\run.exe\""
            }
          }
        ]
      }
    ];
    fs.writeFileSync(path.join(mixedLogs, "transcript.jsonl"), mixedCompactSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
    fs.writeFileSync(path.join(mixedLogs, "transcript_full.jsonl"), mixedFullSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");

    const mixedBatchStep = runCli(["transcript", "step", "1,2", convMixed, "--json"]);
    assert.equal(mixedBatchStep.status, 0, mixedBatchStep.stderr);
    const mbs = JSON.parse(mixedBatchStep.stdout);
    assert.equal(mbs.steps[0].step.tool_calls[0].arguments.CommandLine, "mixed cmd\n", "mixed batch step 1 must fall back to compact decoding");
    assert.equal(mbs.steps[0].step.tool_calls[0].arguments.WaitMsBeforeAsync, 1234);
    assert.equal(
      mbs.steps[0].step.tool_calls[0].arguments.NativeQuotedTail,
      "\"foo\" bar\n<truncated 10 bytes>",
      "truncated native string starting with quote must remain untouched when tail is not a valid escape fragment"
    );
    assert.equal(mbs.steps[1].step.tool_calls[0].arguments.FlagText, "true", "mixed batch step 2 from transcript_full.jsonl must keep native string");
    assert.equal(mbs.steps[1].step.tool_calls[0].arguments.WinNative, "\"C:\\temp\\run.exe\"");
    assert.equal(mbs.steps[1].step.content, "Full step 2\n\nEnd.");

    const mixedSingleStep1 = runCli(["transcript", "step", "1", convMixed, "--json"]);
    assert.equal(mixedSingleStep1.status, 0, mixedSingleStep1.stderr);
    const ms1 = JSON.parse(mixedSingleStep1.stdout);
    assert.equal(ms1.step.tool_calls[0].arguments.WaitMsBeforeAsync, 1234);
    assert.equal(ms1.step.tool_calls[0].arguments.NativeQuotedTail, "\"foo\" bar\n<truncated 10 bytes>");

    // Direct ESM fromCompact consistency across formatSingleStepDetail and formatTranscriptItem
    const directToolCalls = formatSingleStepDetail(normCompactSteps[1], 1, "tool_calls", { fromCompact: true });
    assert.equal(directToolCalls.data[0].args.WaitMsBeforeAsync, 5000);
    assert.equal(directToolCalls.data[0].args.CommandLine, "echo hi\n");
    assert.equal(directToolCalls.data[2].args.WinQuoted, "\"C:\\temp\\run.exe\"");
    assert.match(directToolCalls.text, /"WaitMsBeforeAsync": 5000/);

    for (const capBodies of [true, false]) {
      const directToolArgs = formatSingleStepDetail(normCompactSteps[1], 1, "tool_args", {
        fromCompact: true,
        capLargeFileBodies: capBodies
      });
      assert.equal(directToolArgs.data[0].args.WaitMsBeforeAsync, 5000);
      assert.equal(directToolArgs.data[2].args.WinQuoted, "\"C:\\temp\\run.exe\"", `capLargeFileBodies=${capBodies} must decode WinQuoted once without double-decoding`);
      assert.deepEqual(directToolArgs.data[2].args.ReplacementChunks, [{ AllowMultiple: false, StartLine: 10, TargetContent: "foo\nbar" }]);
      assert.match(directToolArgs.text, /"WaitMsBeforeAsync": 5000/);
    }

    const directArgKey = formatSingleStepDetail(normCompactSteps[1], 1, "tool_args:CommandLine", { fromCompact: true });
    assert.equal(directArgKey.data[0].value, "echo hi\n");
    assert.match(directArgKey.text, /echo hi/);

    const directAll = formatSingleStepDetail(normCompactSteps[1], 1, "all", { fromCompact: true });
    assert.equal(directAll.data.tool_calls[0].args.WaitMsBeforeAsync, 5000);
    assert.equal(directAll.step.content, "Checking tool execution.\n\nDone.");
    assert.match(directAll.text, /WaitMsBeforeAsync=5000/);
    assert.match(directAll.text, /> Paragraph one\./);

    const directItem = formatTranscriptItem(normCompactSteps[1], {
      includeThinking: true,
      includeToolCalls: true,
      fromCompact: true
    });
    assert.equal(directItem.includes("\r"), false);
    assert.match(directItem, /WaitMsBeforeAsync=5000/);
    assert.match(directItem, /Path="scratch\/out\.md"/);
    assert.ok(directItem.includes("> Paragraph one.\n> \n> Paragraph two.\n> </thinking>"));

    const directItemField = formatTranscriptItem(normCompactSteps[1], { field: "tool_args:CommandLine", fromCompact: true });
    assert.match(directItemField, /echo hi/);
    assert.equal(directItemField.includes('\\"echo hi\\\\r\\\\n\\"'), false);

    const directFullPreserved = formatSingleStepDetail(normFullSteps[1], 1, "tool_args", { fromCompact: false });
    assert.equal(directFullPreserved.data[0].args.FlagText, "true");
    assert.equal(directFullPreserved.data[0].args.WinNative, "\"C:\\temp\\run.exe\"");
    const directItemFullPreserved = formatTranscriptItem(normFullSteps[1], { includeToolCalls: true, fromCompact: false });
    assert.match(directItemFullPreserved, /FlagText="true"/);

    console.log("✓ PR #8 L54 normalization, JSON pretty-printing, compact arg decoding & pretty clamped pages verified");
  }

  // --- UX-ACS-011 & UX-ACS-012: Readable Top-Level Help & Focused Subcommand Help ---
  console.log("\n--- 11. CLI Help Ergonomics & Subcommand-Scoped Help (UX-ACS-011 / UX-ACS-012) ---");
  {
    const topHelp = runCli(["--help"]);
    assert.equal(topHelp.status, 0, topHelp.stderr);
    assert.match(topHelp.stdout, /Transcript Commands:/);
    assert.match(topHelp.stdout, /Lifecycle Commands:/);
    assert.match(topHelp.stdout, /Examples:/);
    assert.match(topHelp.stdout, /agy-context status/);
    assert.match(topHelp.stdout, /agy-context transcript health/);
    assert.match(topHelp.stdout, /agy-context transcript read --last-turns 3/);
    assert.match(topHelp.stdout, /agy-context transcript query/);
    const topMaxLine = Math.max(...topHelp.stdout.split(/\r?\n/).map((l) => l.length));
    assert.ok(topMaxLine <= 105, `Top-level --help line exceeded 105 chars (max=${topMaxLine})`);

    const noArgsHelp = runCli([]);
    assert.equal(noArgsHelp.status, 0);
    assert.equal(noArgsHelp.stdout, topHelp.stdout);

    const subHelpChecks = [
      [["transcript", "--help"], /Subcommands:/, /agy-context transcript <subcommand> --help/],
      [["transcript", "read", "--help"], /--last-turns/, /--outline/],
      [["transcript", "outline", "--help"], /--outline/, /--start/],
      [["transcript", "query", "--help"], /--roles.*system.*generic/s, /--full-args/],
      [["transcript", "grep", "--help"], /--query/, /--include-tools/],
      [["transcript", "step", "--help"], /--line-start/, /--tail/],
      [["transcript", "health", "--help"], /--json/, /agy-context transcript health/],
      [["transcript", "list", "--help"], /--lineage/, /--parent/],
      [["transcript", "export", "--help"], /--sanitized/, /--out/],
      [["transcript", "access", "--help"], /--self-only/, /--allow/],
      [["status", "--help"], /--json/, /agy-context status/],
      [["setup", "--help"], /--allow-degraded/, /--check/],
      [["uninstall", "--help"], /--restore-backups/, /agy-context uninstall/],
      [["restore-backups", "--help"], /hooks\.json\.bak/, /agy-context restore-backups/]
    ];
    for (const [args, flagRe, secondRe] of subHelpChecks) {
      const res = runCli(args);
      assert.equal(res.status, 0, `${args.join(" ")} must exit 0: ${res.stderr}`);
      assert.notEqual(res.stdout, topHelp.stdout, `${args.join(" ")} must print focused subcommand help, not top-level help`);
      assert.match(res.stdout, flagRe, `${args.join(" ")} missing expected flag/pattern ${flagRe}`);
      assert.match(res.stdout, secondRe, `${args.join(" ")} missing expected pattern ${secondRe}`);
      assert.match(res.stdout, /Examples:/, `${args.join(" ")} must include Examples:`);
      const maxLine = Math.max(...res.stdout.split(/\r?\n/).map((l) => l.length));
      assert.ok(maxLine <= 105, `${args.join(" ")} line exceeded 105 chars (max=${maxLine})`);
    }

    // assertCleanHelp must still reject conflicting flags with --help
    for (const badArgs of [
      ["transcript", "read", "--last-turns", "2", "--help"],
      ["setup", "--check", "--help"],
      ["uninstall", "--restore-backups", "--help"]
    ]) {
      const badRes = runCli(badArgs);
      assert.notEqual(badRes.status, 0, `Conflicting --help args must fail: ${badArgs.join(" ")}`);
    }
    console.log("✓ Top-level --help (<= 105 cols + examples) and all 14 subcommand --help topics verified");
  }

  // --- RUN-005 & RUN-006: Clean health --json stderr & darwin case-insensitive path containment ---
  console.log("\n--- 12. Health --json Stderr Hygiene (RUN-005) & Darwin Path Casing (RUN-006) ---");
  {
    const convRun005 = "conv-run005-silent-health";
    const run005Logs = path.join(brainDir, convRun005, ".system_generated", "logs");
    fs.mkdirSync(run005Logs, { recursive: true });
    fs.writeFileSync(
      path.join(run005Logs, "transcript.jsonl"),
      JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "Health check" }) + "\n",
      "utf-8"
    );
    const legacyRtkDir = path.join(tempHome, "legacy-rtk-090");
    createRtkShim(legacyRtkDir, "0.9.0");
    const legacyEnv = { ...testEnv, PATH: legacyRtkDir };
    if (process.platform === "win32") legacyEnv.Path = legacyRtkDir;
    const healthJsonRes = spawnSync(process.execPath, [cliScript, "transcript", "health", "--id", convRun005, "--json"], {
      env: legacyEnv,
      encoding: "utf-8"
    });
    assert.equal(healthJsonRes.status, 0, healthJsonRes.stderr);
    assert.equal(healthJsonRes.stderr.trim(), "", `health --json must emit zero stderr warnings even with legacy RTK (<1.1.0), got: ${healthJsonRes.stderr}`);
    const parsedHealth = JSON.parse(healthJsonRes.stdout);
    assert.equal(parsedHealth.rtkInfo, null);

    // RUN-006: extractConvId must fold path casing on both darwin and win32
    const mixedCaseBrainFile = path.join(brainDir.toUpperCase(), "Conv-Darwin-Case", ".system_generated", "logs", "transcript.jsonl");
    assert.equal(
      extractConvId(mixedCaseBrainFile, { strictBrainContainment: true, platform: "darwin" }),
      "Conv-Darwin-Case",
      "extractConvId must match mixed-case brain root on darwin (RUN-006)"
    );
    assert.equal(
      extractConvId(mixedCaseBrainFile, { strictBrainContainment: true, platform: "win32" }),
      "Conv-Darwin-Case",
      "extractConvId must match mixed-case brain root on win32 (RUN-006)"
    );
    console.log("✓ RUN-005 (silent health --json with legacy RTK) and RUN-006 (darwin/win32 case folding) verified");
  }

  // --- CodeQL Security & Linear-Time Regressions (#1, #6, #9-#15) ---
  console.log("\n--- 13. CodeQL Security & Linear-Time Regressions (#1, #6, #9-#15) ---");
  {
    // #9: data:image/...;base64,... stays linear-time on repeated `data:image/` runs
    const evilDataImg = "data:image/".repeat(20_000) + "base64";
    const tImg = performance.now();
    cleanMessageContent(evilDataImg, 4000);
    assert.ok(performance.now() - tImg < 200, "cleanMessageContent data:image stripping must stay linear-time");

    // #10-#14: stripSummaryStepBoilerplate stays linear-time on spillover repeats and trailing newline runs
    const spillPrefix =
      "The tool's output was truncated due to being too long. You can find the full output in a file at file:///steps/0/output.txt";
    const tSpill = performance.now();
    stripSummaryStepBoilerplate(spillPrefix + "/steps/0/output.txt".repeat(20_000));
    assert.ok(performance.now() - tSpill < 200, "stripSummaryStepBoilerplate spill banner must stay linear-time");

    const tTrail = performance.now();
    stripSummaryStepBoilerplate("\n".repeat(100) + "a", { stripWrappers: true });
    assert.ok(performance.now() - tTrail < 50, "stripSummaryStepBoilerplate closing-tag stripping must not backtrack exponentially");
    assert.equal(stripSummaryStepBoilerplate("<USER_REQUEST>\nHello\n\n</USER_REQUEST>\n", { stripWrappers: true }), "Hello");

    // #6 & #15: sanitized export escapes `\` before `|` and summary query handles >50 consecutive `\n` in USER_INPUT linearly
    const convCodeql = "conv-codeql-sec";
    const codeqlLogs = path.join(brainDir, convCodeql, ".system_generated", "logs");
    fs.mkdirSync(codeqlLogs, { recursive: true });
    fs.writeFileSync(
      path.join(codeqlLogs, "transcript.jsonl"),
      [
        JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>\n" + "\n".repeat(100) + "a\\|b" }),
        JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", content: "grep 'foo\\|bar' src/" })
      ].join("\n") + "\n",
      "utf-8"
    );
    const tQuery = performance.now();
    const qRes = await queryTranscript({ conversationId: convCodeql, summaryOnly: true });
    assert.ok(performance.now() - tQuery < 500, "queryTranscript USER_INPUT summary stripping must not backtrack exponentially");
    assert.equal(qRes.isError, undefined);

    const expRes = await exportSanitizedTranscript({ conversationIds: [convCodeql], sanitized: true });
    assert.equal(expRes.isError, undefined);
    assert.ok(expRes.text.includes("foo\\\\\\|bar"), `Sanitized table cell must escape backslashes before pipes: ${expRes.text}`);

    // #1: overlong query patterns fall back to literal regex safely while normal regex queries keep working
    const normalRx = getCompiledRegex("foo|bar");
    assert.ok(normalRx.test("BAR"));
    const hugeRx = getCompiledRegex("(a+)+".repeat(150));
    assert.equal(hugeRx.test("aaaaaaaaaa"), false, "Overlong regex patterns must fall back to literal matching");
    assert.equal(hugeRx.test("(a+)+".repeat(150)), true);
    console.log("✓ CodeQL regressions (#1, #6, #9-#15) verified in linear time");
  }

  // --- Wave 0 IND-SEC-004: Tier 4 grant enforcement without GEMINI_CONVERSATION_ID & subcommand-bound grant consumption ---
  console.log("\n--- 14. Wave 0 Tier 4 Grant Enforcement & Error-Path Isolation (IND-SEC-004) ---");
  {
    const t4Parent = "conv-t4-parent-ind004";
    const t4Child = "conv-t4-child-ind004";
    for (const cid of [t4Parent, t4Child]) {
      const logDir = path.join(brainDir, cid, ".system_generated", "logs");
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(
        path.join(logDir, "transcript.jsonl"),
        JSON.stringify({ step_index: 0, type: "USER_INPUT", content: `transcript for ${cid}` }) + "\n",
        "utf-8"
      );
    }
    const t4ChildState = path.join(getStateDir(), `agy-session-${t4Child}.json`);
    fs.writeFileSync(
      t4ChildState,
      JSON.stringify({
        pollCount: 0,
        denials: 0,
        lineage: { isChildSession: true, parentConvId: t4Parent, launchDirective: "deny" }
      }),
      "utf-8"
    );
    const prevEnvConv = process.env.GEMINI_CONVERSATION_ID;
    delete process.env.GEMINI_CONVERSATION_ID;
    try {
      // Direct read of restricted child's parent or deny-locked child without a hook grant must fail closed even without GEMINI_CONVERSATION_ID
      const blockedParentRead = await readTranscript({ conversationId: t4Parent, lastTurns: 1 });
      assert.equal(blockedParentRead.isError, true, "Unverified read of Tier 4 child's parent must fail closed (IND-SEC-004)");
      const blockedChildRead = await readTranscript({ conversationId: t4Child, lastTurns: 1 });
      assert.equal(blockedChildRead.isError, true, "Unverified read of Tier 4 deny-locked child must fail closed (IND-SEC-004)");

      // Unrelated conversation remains unaffected (ACS-ARCH-001 preserved)
      const unrelatedRead = await readTranscript({ conversationId: "conv-codeql-sec", lastTurns: 1 });
      assert.ok(!unrelatedRead.isError, "Unrelated conversation must remain accessible under Tier 4 lock on another cohort");

      // Valid PreToolUse hook grant still allows authorized parent inspection
      recordTranscriptHookGrant({ callerConvId: t4Parent, subcommand: "read", targetConvId: t4Parent, mode: "open" });
      const authorizedParentRead = await readTranscript({ conversationId: t4Parent, lastTurns: 1 });
      assert.ok(!authorizedParentRead.isError, "Authorized PreToolUse hook grant must succeed under Tier 4 lock");

      // Error-path consumeTranscriptAccessGrant({ subcommand: 'query' }) must NOT steal a pending 'read' grant
      recordTranscriptHookGrant({ callerConvId: t4Parent, subcommand: "read", targetConvId: t4Parent, mode: "open" });
      consumeTranscriptAccessGrant({ subcommand: "query", targetConvId: t4Parent });
      const survivingRead = await readTranscript({ conversationId: t4Parent, lastTurns: 1 });
      assert.ok(!survivingRead.isError, "Mismatched subcommand error-path consume must not steal pending read grant (IND-SEC-004)");

      // Boost Pass IND-SEC-004: internal lib/transcript-core.mjs error paths (export/step) must NOT steal a pending 'read' grant
      recordTranscriptHookGrant({ callerConvId: t4Parent, subcommand: "read", targetConvId: t4Parent, mode: "open" });
      const badExport = await exportSanitizedTranscript({ conversationIds: [t4Parent], sanitized: false });
      assert.equal(badExport.isError, true);
      const badStep = await getStepDetail({ conversationId: t4Parent, stepIndex: "not-a-step" });
      assert.equal(badStep.isError, true);
      const survivingRead2 = await readTranscript({ conversationId: t4Parent, lastTurns: 1 });
      assert.ok(!survivingRead2.isError, "Internal export/step error paths must pass { subcommand } and never steal a pending read grant");
    } finally {
      if (prevEnvConv !== undefined) process.env.GEMINI_CONVERSATION_ID = prevEnvConv;
      try { fs.unlinkSync(t4ChildState); } catch {}
    }
    console.log("✓ IND-SEC-004: Tier 4 grant enforcement without GEMINI_CONVERSATION_ID & subcommand-bound grant cleanup verified");
  }

  // --- Boost Pass FRIC-SEC-001 SYNC-MIRROR: >512 KiB Step 0 USER_INPUT lineage classification ---
  {
    const hugeConv = "conv-boost-huge-step0";
    const hugeLogs = path.join(tempHome, ".gemini", "antigravity", "brain", hugeConv, ".system_generated", "logs");
    fs.mkdirSync(hugeLogs, { recursive: true });
    fs.writeFileSync(
      path.join(hugeLogs, "transcript.jsonl"),
      JSON.stringify({ step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", content: "A".repeat(600000) }) + "\n",
      "utf-8"
    );
    const listed = listTranscriptConversations({ limit: 50, includeLineage: true });
    const found = listed.conversations.find((c) => c.conversationId === hugeConv);
    assert.ok(found, "Huge Step 0 conversation must appear in listTranscriptConversations");
    assert.equal(found.sessionKind, "top-level", ">512 KiB Step 0 USER_INPUT must classify as top-level (FRIC-SEC-001 SYNC-MIRROR)");
    console.log("✓ Boost Pass FRIC-SEC-001 SYNC-MIRROR (>512 KiB Step 0 lineage) verified");
  }

  // --- Wave 2 + Boost Pass PR13-RUN-001, PR13-RUN-007 & FRIC-RUN-004: Schedule & Backoff Classifier Parity ---
  {
    assert.equal(
      isSwarmPollSchedule({ Prompt: "Check project tests on task-9", TimerCondition: "conv-1/task-9" }),
      false,
      "Conditioned task-* watchdog must not classify as swarm poll (PR13-RUN-001)"
    );
    assert.equal(
      isRemoteCiPollSchedule({ DurationSeconds: 45, Prompt: "Check GitHub Actions CI & CodeQL status" }),
      true,
      "Remote CI schedule must classify cleanly (FRIC-RUN-004)"
    );
    assert.equal(
      isRemoteCiPollSchedule({ DurationSeconds: 60, Prompt: "Check status of Sample-App GitHub Actions CI workflow" }),
      true,
      "GitHub Actions CI prompt must classify as remote CI (FRIC-RUN-004 Boost)"
    );
    assert.equal(
      isSwarmPollSchedule({ DurationSeconds: 60, Prompt: "Check status of Sample-App GitHub Actions CI workflow" }),
      false,
      "GitHub Actions CI prompt must not classify as swarm poll (FRIC-RUN-004 Boost)"
    );
    assert.equal(
      isRemoteCiPollSchedule({ DurationSeconds: 60, Prompt: "Check on PR #14 build status" }),
      true,
      "PR #14 build status prompt must classify as remote CI"
    );
    assert.equal(
      isRemoteCiPollSchedule({ DurationSeconds: 60, Prompt: "Check status of deployment job" }),
      true,
      "Deployment job status prompt must classify as remote CI"
    );
    assert.equal(
      isRemoteCiPollSchedule({ DurationSeconds: 45, Prompt: "Check background task-4 status", TimerCondition: "conv-1/task-4" }),
      false,
      "Local task watchdog must not classify as remote CI"
    );
    assert.equal(
      extractTaskBackoffKey("manage_task", { TaskId: "2239" }),
      "task-2239",
      "Bare numeric TaskId '2239' must normalize to 'task-2239' (PR13-RUN-007)"
    );
    assert.equal(extractRemoteCiBackoffKey({ Prompt: "Check PR #14 build status" }), "remote-ci:pr-14");
    assert.equal(extractRemoteCiBackoffKey({ Prompt: "Check PR #15 build status" }), "remote-ci:pr-15");

    // §3.2: checkContextHealth() must scope remote CI backoff per PR key with 15-min decay (no cross-PR false pollingViolations)
    const ciHealthConv = "conv-boost-ci-health";
    const ciHealthLogs = path.join(tempHome, ".gemini", "antigravity", "brain", ciHealthConv, ".system_generated", "logs");
    fs.mkdirSync(ciHealthLogs, { recursive: true });
    fs.writeFileSync(
      path.join(ciHealthLogs, "transcript.jsonl"),
      [
        JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "Check CI on PR #14 and PR #15", created_at: "2026-11-21T10:00:00Z" }),
        JSON.stringify({
          step_index: 1,
          type: "PLANNER_RESPONSE",
          created_at: "2026-11-21T10:00:05Z",
          tool_calls: [{ name: "schedule", args: { DurationSeconds: 30, Prompt: "Check PR #14 build status" } }]
        }),
        JSON.stringify({
          step_index: 2,
          type: "PLANNER_RESPONSE",
          created_at: "2026-11-21T10:00:10Z",
          tool_calls: [{ name: "schedule", args: { DurationSeconds: 30, Prompt: "Check PR #15 build status" } }]
        }),
        JSON.stringify({
          step_index: 3,
          type: "PLANNER_RESPONSE",
          created_at: "2026-11-21T10:20:00Z",
          tool_calls: [{ name: "schedule", args: { DurationSeconds: 30, Prompt: "Check PR #14 build status" } }]
        })
      ].join("\n") + "\n"
    );
    const ciHealthRes = await checkContextHealth({ conversationId: ciHealthConv });
    assert.ok(!ciHealthRes.isError, ciHealthRes.error);
    assert.equal(ciHealthRes.metrics.pollingViolations, 0, "Per-PR remote CI buckets + 15-min decay must report 0 pollingViolations (§3.2)");
    assert.equal(ciHealthRes.metrics.legalChecks, 3, "All 3 remote CI checks across PR #14, PR #15, and decayed PR #14 must be legal");
    console.log("✓ Wave 2 + Boost Pass PR13-RUN-001, PR13-RUN-007 & FRIC-RUN-004 classifier & health parity verified");
  }

  // --- 15. Wave 3 Regressions (PT-SEC-001, PT-SVC-001, PT-RUN-004, PT-INFO-001, 1B.3) ---
  console.log("\n--- 15. Wave 3 Regressions (PT-SEC-001, PT-SVC-001, PT-RUN-004, PT-INFO-001, 1B.3) ---");
  {
    // PT-SEC-001: Dangling intermediate symlink `--out scratch/link/out.md -> <profile>/.gemini/config/newdir` rejected
    const ptSecWs = path.join(tempHome, "pt-sec-001-ws");
    const ptSecScratch = path.join(ptSecWs, "scratch");
    const danglingLink = path.join(ptSecScratch, "link");
    const protectedNewDir = path.join(tempHome, ".gemini", "config", "newdir");
    fs.mkdirSync(ptSecScratch, { recursive: true });
    let madeDangling = false;
    try {
      fs.symlinkSync(protectedNewDir, danglingLink, os.platform() === "win32" ? "junction" : "dir");
      madeDangling = true;
    } catch (err) {
      if (err?.code !== "EPERM") throw err;
    }
    if (madeDangling) {
      const danglingOut = path.join(danglingLink, "out.md");
      const resExport = runCli(["transcript", "export", "--id", "conv-codeql-sec", "--sanitized", "--out", danglingOut], testEnv);
      assert.notEqual(resExport.status, 0, "PT-SEC-001: dangling intermediate symlink into ~/.gemini/config/newdir must be rejected");
      assert.match(resExport.stderr, /Refusing '--out'|protected/i);
      assert.equal(fs.existsSync(protectedNewDir), false, "PT-SEC-001: protected newdir must never be created");
    }

    // PT-SVC-001: 600+ truncated steps in queryTranscript(..., { mode: "auto" }) returns accurate matches with single-pass transcript_full.jsonl read
    const convSvc = "conv-pt-svc-001-batch";
    const svcLogs = path.join(brainDir, convSvc, ".system_generated", "logs");
    fs.mkdirSync(svcLogs, { recursive: true });
    const compactRows = [];
    const fullRows = [];
    const hitSteps = new Set([10, 325, 650]);
    for (let i = 1; i <= 650; i++) {
      const base = {
        step_index: i,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: new Date(1760000000000 + i * 1000).toISOString()
      };
      compactRows.push(JSON.stringify({ ...base, content: `Compact truncated filler step ${i}`, truncated_fields: ["content"] }));
      fullRows.push(JSON.stringify({
        ...base,
        content: hitSteps.has(i) ? `Full payload step ${i} PT_SVC_001_UNIQUE_NEEDLE` : `Full payload step ${i} routine text`
      }));
    }
    fs.writeFileSync(path.join(svcLogs, "transcript.jsonl"), compactRows.join("\n") + "\n", "utf-8");
    fs.writeFileSync(path.join(svcLogs, "transcript_full.jsonl"), fullRows.join("\n") + "\n", "utf-8");

    const origCreateReadStream = fs.createReadStream;
    let fullStreamOpens = 0;
    fs.createReadStream = function wrappedCreateReadStream(filePathArg, ...rest) {
      if (String(filePathArg).endsWith("transcript_full.jsonl")) fullStreamOpens++;
      return origCreateReadStream.call(this, filePathArg, ...rest);
    };
    let svcQuery;
    try {
      svcQuery = await queryTranscript({
        conversationId: convSvc,
        query: "PT_SVC_001_UNIQUE_NEEDLE",
        mode: "auto",
        maxResults: 20
      });
    } finally {
      fs.createReadStream = origCreateReadStream;
    }
    assert.ok(!svcQuery.isError, svcQuery.text);
    assert.equal(fullStreamOpens, 1, `PT-SVC-001: transcript_full.jsonl must be read in a single streaming pass (got ${fullStreamOpens})`);
    assert.equal(svcQuery.displayedCount, 3, "PT-SVC-001: all 3 hydrated matches across 650 truncated steps must be returned");
    for (const s of hitSteps) {
      assert.ok(svcQuery.text.includes(`Full payload step ${s} PT_SVC_001_UNIQUE_NEEDLE`), `PT-SVC-001: missing match for step ${s}`);
    }

    // PT-RUN-004: scanRecentLaunchRestrictions() unlinks expired agy-session-*.json (> 1h mtime) while preserving fresh ones and agy-session-governance-state.json
    const stateDir = getStateDir();
    fs.mkdirSync(stateDir, { recursive: true });
    const expiredJson = path.join(stateDir, "agy-session-expired-pt004.json");
    const expiredLock = path.join(stateDir, "agy-session-expired-pt004.lock");
    const freshJson = path.join(stateDir, "agy-session-fresh-pt004.json");
    const govStateJson = path.join(stateDir, "agy-session-governance-state.json");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

    fs.writeFileSync(expiredJson, JSON.stringify({ conversationId: "expired-pt004", lineage: { isChildSession: true, launchDirective: "deny" } }), "utf-8");
    fs.utimesSync(expiredJson, twoHoursAgo, twoHoursAgo);
    fs.writeFileSync(expiredLock, "123:0\n", "utf-8");
    fs.utimesSync(expiredLock, twoHoursAgo, twoHoursAgo);
    fs.writeFileSync(govStateJson, JSON.stringify({ global: { pollCount: 0 } }), "utf-8");
    fs.utimesSync(govStateJson, twoHoursAgo, twoHoursAgo);
    fs.writeFileSync(freshJson, JSON.stringify({
      conversationId: "fresh-pt004",
      lastSeenTime: Date.now(),
      lineage: { isChildSession: true, parentConvId: "parent-pt004", launchDirective: "deny" }
    }), "utf-8");

    try {
      const scanRes = scanRecentLaunchRestrictions();
      assert.equal(fs.existsSync(expiredJson), false, "PT-RUN-004: expired agy-session-*.json (>1h) must be unlinked");
      assert.equal(fs.existsSync(expiredLock), false, "PT-RUN-004: expired agy-session-*.lock (>1h) must be unlinked");
      assert.equal(fs.existsSync(freshJson), true, "PT-RUN-004: fresh agy-session-*.json must be preserved");
      assert.equal(fs.existsSync(govStateJson), true, "PT-RUN-004: agy-session-governance-state.json must never be unlinked");
      assert.ok(scanRes.sessions.some((s) => s.conversationId === "fresh-pt004"), "PT-RUN-004: fresh restricted child must be reported");
    } finally {
      for (const f of [expiredJson, expiredLock, freshJson]) { try { fs.unlinkSync(f); } catch {} }
    }

    // PT-INFO-001: health / list / access --help consume matching grants (without stealing mismatched grants)
    const grantsDir = path.join(stateDir, "grants");
    const listGrantFiles = () => (fs.existsSync(grantsDir) ? fs.readdirSync(grantsDir).filter((f) => f.startsWith("grant-") && f.endsWith(".json")) : []);
    for (const f of listGrantFiles()) { try { fs.unlinkSync(path.join(grantsDir, f)); } catch {} }
    for (const sub of ["health", "list", "access"]) {
      recordTranscriptHookGrant({ callerConvId: "conv-pt-info-001", subcommand: sub, mode: "open" });
      assert.equal(listGrantFiles().length, 1, `PT-INFO-001: expected 1 pending grant for '${sub}'`);
      const helpRes = runCli(["transcript", sub, "--help"], testEnv);
      assert.equal(helpRes.status, 0, helpRes.stderr);
      assert.equal(listGrantFiles().length, 0, `PT-INFO-001: 'transcript ${sub} --help' must consume matching grant`);
    }
    recordTranscriptHookGrant({ callerConvId: "conv-pt-info-001", subcommand: "read", mode: "open" });
    const nonStealingHelp = runCli(["transcript", "health", "--help"], testEnv);
    assert.equal(nonStealingHelp.status, 0, nonStealingHelp.stderr);
    assert.equal(listGrantFiles().length, 1, "PT-INFO-001: 'health --help' must not steal a pending 'read' grant");
    consumeTranscriptAccessGrant({ subcommand: "read" });
    assert.equal(listGrantFiles().length, 0);

    // 1B.3: exportSanitizedTranscript emits sanitized: true and does NOT emit l6Safe
    const sanitizedJsonRes = await exportSanitizedTranscript({ conversationIds: ["conv-codeql-sec"], sanitized: true, outputFormat: "json" });
    assert.ok(!sanitizedJsonRes.isError, sanitizedJsonRes.text);
    assert.equal(sanitizedJsonRes.sanitized, true, "1B.3: exportSanitizedTranscript result must emit sanitized: true");
    assert.equal(Object.prototype.hasOwnProperty.call(sanitizedJsonRes, "l6Safe"), false, "1B.3: exportSanitizedTranscript result must NOT emit l6Safe");
    const parsedSanitized = JSON.parse(sanitizedJsonRes._serializedJson);
    assert.equal(parsedSanitized.sanitized, true, "1B.3: serialized JSON must emit sanitized: true");
    assert.equal(Object.prototype.hasOwnProperty.call(parsedSanitized, "l6Safe"), false, "1B.3: serialized JSON must NOT emit l6Safe");
    const cliSanitizedJson = runCli(["transcript", "export", "--id", "conv-codeql-sec", "--sanitized", "--json"], testEnv);
    assert.equal(cliSanitizedJson.status, 0, cliSanitizedJson.stderr);
    const parsedCliSanitized = JSON.parse(cliSanitizedJson.stdout);
    assert.equal(parsedCliSanitized.sanitized, true);
    assert.equal("l6Safe" in parsedCliSanitized, false);

    console.log("✓ Wave 3 regressions (PT-SEC-001, PT-SVC-001, PT-RUN-004, PT-INFO-001, 1B.3) verified");

    // ========================================================================
    // 16. L61 Quota-Sink Remediations: getStepDetail JSON Dedup, --summary 100 Default & Cohort Health
    // ========================================================================
    console.log("\n--- 16. L61 Quota-Sink Remediations (getStepDetail dedup, --summary 100, Cohort Health) ---");

    // 16.1 Deduplicated getStepDetail JSON contract across single/batch and all/projected fields
    const convDedup = "conv-l61-dedup-step";
    const dedupLogs = path.join(brainDir, convDedup, ".system_generated", "logs");
    fs.mkdirSync(dedupLogs, { recursive: true });
    const dedupSteps = [
      { step_index: 0, type: "USER_INPUT", content: "Inspect step payload", created_at: "2026-11-22T10:00:00Z" },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        thinking: "T".repeat(1200),
        content: "Checking tool execution.",
        tool_calls: [{ name: "run_command", args: { CommandLine: "echo hi", WaitMsBeforeAsync: 5000 } }],
        created_at: "2026-11-22T10:00:01Z"
      }
    ];
    fs.writeFileSync(path.join(dedupLogs, "transcript_full.jsonl"), dedupSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf-8");

    const dedupSingleAll = runCli(["transcript", "step", "1", convDedup, "--json"], testEnv);
    assert.equal(dedupSingleAll.status, 0, dedupSingleAll.stderr);
    const dsa = JSON.parse(dedupSingleAll.stdout);
    assert.ok(dsa.step && dsa.step.step_index === 1, "Single-step --field all must emit step");
    assert.equal("data" in dsa, false, "Single-step --field all must omit duplicate data field");

    const dedupSingleField = runCli(["transcript", "step", "1", convDedup, "--field", "tool_args", "--json"], testEnv);
    assert.equal(dedupSingleField.status, 0, dedupSingleField.stderr);
    const dsf = JSON.parse(dedupSingleField.stdout);
    assert.ok(Array.isArray(dsf.data) && dsf.data.length > 0, "Single-step projected field must emit data");
    assert.equal("step" in dsf, false, "Single-step projected field must omit unselected raw step");
    assert.ok(dedupSingleField.stdout.length < dedupSingleAll.stdout.length, "Projected --field tool_args JSON must be smaller than raw --field all JSON");

    const dedupBatchAll = runCli(["transcript", "step", "0,1", convDedup, "--json"], testEnv);
    assert.equal(dedupBatchAll.status, 0, dedupBatchAll.stderr);
    const dba = JSON.parse(dedupBatchAll.stdout);
    assert.equal("data" in dba, false, "Batch --field all must omit duplicate top-level data array");
    assert.equal(dba.steps.length, 2);
    assert.ok(dba.steps[0].step && !("data" in dba.steps[0]), "Batch --field all steps[] must emit step without duplicate data");

    const dedupBatchField = runCli(["transcript", "step", "0,1", convDedup, "--field", "content", "--json"], testEnv);
    assert.equal(dedupBatchField.status, 0, dedupBatchField.stderr);
    const dbf = JSON.parse(dedupBatchField.stdout);
    assert.equal("data" in dbf, false, "Batch projected field must omit duplicate top-level data array");
    assert.equal(dbf.steps.length, 2);
    assert.ok(typeof dbf.steps[0].data === "string" && !("step" in dbf.steps[0]), "Batch projected steps[] must emit data without raw step");
    assert.ok(dedupBatchField.stdout.length < dedupBatchAll.stdout.length, "Batch projected --field content JSON must avoid raw-step bloat");

    // 16.2 query --summary defaultMaxResults (100 non-full, 500 with --full), compact outline --full & query --full LARGE_BODY cap (ACS-BUG-01)
    const convSum100 = "conv-l61-summary-100";
    const sum100Logs = path.join(brainDir, convSum100, ".system_generated", "logs");
    fs.mkdirSync(sum100Logs, { recursive: true });
    const rows75 = Array.from({ length: 75 }, (_, i) =>
      JSON.stringify({ step_index: i, type: "PLANNER_RESPONSE", status: "DONE", content: `s${i}`, created_at: "2026-11-22T10:00:00Z" })
    );
    fs.writeFileSync(path.join(sum100Logs, "transcript.jsonl"), rows75.join("\n") + "\n", "utf-8");
    const sum75Cli = runCli(["transcript", "query", "--id", convSum100, "--summary", "--json", "--full"], testEnv);
    assert.equal(sum75Cli.status, 0, sum75Cli.stderr);
    const sum75Parsed = JSON.parse(sum75Cli.stdout);
    assert.equal(sum75Parsed.matchedCount, 75);
    assert.equal(sum75Parsed.displayedCount, 75, "query --summary without --limit must retain all 75 steps");
    assert.equal(sum75Parsed.clamped, false);

    const convSum120 = "conv-l61-summary-120";
    const sum120Logs = path.join(brainDir, convSum120, ".system_generated", "logs");
    fs.mkdirSync(sum120Logs, { recursive: true });
    const rows120 = Array.from({ length: 120 }, (_, i) =>
      JSON.stringify({ step_index: i, type: "PLANNER_RESPONSE", status: "DONE", content: `k${i}`, created_at: "2026-11-22T10:00:00Z" })
    );
    fs.writeFileSync(path.join(sum120Logs, "transcript.jsonl"), rows120.join("\n") + "\n", "utf-8");
    const sum120NonFull = await queryTranscript({ conversationId: convSum120, summaryOnly: true, maxOutputChars: 32000 });
    assert.equal(sum120NonFull.matchedCount, 120);
    assert.equal(sum120NonFull.displayedCount, 100, "non-full query --summary default cap must be 100 steps");
    assert.equal(sum120NonFull.clamped, true);
    assert.deepEqual(sum120NonFull.nextCursor, { end: 19 });

    const sum120Full = await queryTranscript({ conversationId: convSum120, summaryOnly: true, full: true });
    assert.equal(sum120Full.matchedCount, 120);
    assert.equal(sum120Full.displayedCount, 120, "query --summary --full must raise default step cap to 500 and return all 120 steps");
    assert.equal(sum120Full.clamped, false);

    // ACS-BUG-01: query --roles all --include-tools --full returns >5 steps (up to 500) and keeps LARGE_BODY_ARG_KEYS summarized unless --full-args
    const convFullQuery = "conv-l61-query-full-bug01";
    const fullQueryLogs = path.join(brainDir, convFullQuery, ".system_generated", "logs");
    fs.mkdirSync(fullQueryLogs, { recursive: true });
    const hugeWriteBody = "REPORT_HEADER\n" + "R".repeat(3000) + "\nREPORT_TAIL_MARKER";
    const fullQuerySteps = Array.from({ length: 15 }, (_, i) => ({
      step_index: i,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: `Audit step ${i}`,
      tool_calls: i === 14
        ? [{ name: "write_file", args: { Path: "/repo/report.md", Content: hugeWriteBody } }]
        : [{ name: "read_file", args: { Path: `/repo/src/f${i}.js`, StartLine: 1, EndLine: 200 } }],
      created_at: "2026-11-22T10:00:00Z"
    }));
    fs.writeFileSync(path.join(fullQueryLogs, "transcript.jsonl"), fullQuerySteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf-8");
    const qFullRes = await queryTranscript({ conversationId: convFullQuery, roles: ["all"], includeToolCalls: true, full: true });
    assert.equal(qFullRes.displayedCount, 15, "query --full without --limit must return all 15 steps instead of capping at 5");
    assert.equal(qFullRes.clamped, false);
    assert.equal(qFullRes.text.includes("REPORT_TAIL_MARKER"), false, "query --full without --full-args must keep LARGE_BODY_ARG_KEYS summarized");

    const qFullWithArgs = await queryTranscript({ conversationId: convFullQuery, roles: ["all"], includeToolCalls: true, full: true, fullArgs: true });
    assert.equal(qFullWithArgs.displayedCount, 15);
    assert.equal(qFullWithArgs.text.includes("REPORT_TAIL_MARKER"), true, "query --full --full-args must unclamp LARGE_BODY_ARG_KEYS");

    const outlineFullRes = await queryTranscript({ conversationId: convFullQuery, summaryOnly: true, includeToolCalls: true, full: true });
    assert.equal(outlineFullRes.displayedCount, 15);
    assert.equal(outlineFullRes.text.includes("REPORT_TAIL_MARKER"), false, "outline/summary --full must keep per-line tool summaries compact");
    assert.ok(Buffer.byteLength(outlineFullRes.text, "utf8") < 4000, "compact summary --full over 15 steps must stay tiny");

    // 13.3 Multi-ID & --parent cohort transcript health + zero-trust grant enforcement
    const cohortParent = "conv-l61-cohort-parent";
    const cohortWorkerA = "conv-l61-cohort-w1";
    const cohortWorkerB = "conv-l61-cohort-w2";
    for (const [cid, lines] of [
      [cohortParent, [{ step_index: 0, type: "USER_INPUT", content: "Run cohort audit", created_at: "2026-11-22T10:00:00Z" }]],
      [
        cohortWorkerA,
        [
          { step_index: 0, type: "SYSTEM_MESSAGE", content: `[Message] sender=${cohortParent} priority=HIGH content=Worker A`, created_at: "2026-11-22T10:00:01Z" },
          { step_index: 1, type: "PLANNER_RESPONSE", content: "Done A", tool_calls: [{ name: "read_file", args: { Path: "a.js" } }], created_at: "2026-11-22T10:00:02Z" }
        ]
      ],
      [
        cohortWorkerB,
        [
          { step_index: 0, type: "SYSTEM_MESSAGE", content: `[Message] sender=${cohortParent} priority=HIGH content=Worker B`, created_at: "2026-11-22T10:00:03Z" },
          {
            step_index: 1,
            type: "PLANNER_RESPONSE",
            content: "Polling swarm illegally",
            tool_calls: [{ name: "schedule", args: { DurationSeconds: 30, Prompt: "Check swarm board progress" } }],
            created_at: "2026-11-22T10:00:04Z"
          }
        ]
      ]
    ]) {
      const d = path.join(brainDir, cid, ".system_generated", "logs");
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "transcript.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
    }

    const multiHealthJson = runCli(["transcript", "health", "--id", `${cohortWorkerA},${cohortWorkerB}`, "--json"], testEnv);
    assert.equal(multiHealthJson.status, 0, multiHealthJson.stderr);
    const mhj = JSON.parse(multiHealthJson.stdout);
    assert.equal(mhj.sessionCount, 2);
    assert.equal(mhj.parentFilter, null);
    assert.equal(mhj.totals.totalSteps, 4);
    assert.equal(mhj.totals.toolCalls, 2);
    assert.equal(mhj.totals.pollingViolations, 1);
    assert.match(mhj.status, /^WARNING/);
    assert.deepEqual(mhj.sessions.map((s) => s.convId), [cohortWorkerA, cohortWorkerB]);

    const repeatHealthMd = runCli(["transcript", "stats", "--id", cohortWorkerA, "--id", cohortWorkerB], testEnv);
    assert.equal(repeatHealthMd.status, 0, repeatHealthMd.stderr);
    assert.match(repeatHealthMd.stdout, /Cohort Context Health Report: WARNING.*2 sessions/);
    assert.match(repeatHealthMd.stdout, new RegExp(cohortWorkerA));
    assert.match(repeatHealthMd.stdout, new RegExp(cohortWorkerB));

    const parentHealthJson = runCli(["transcript", "health", "--parent", cohortParent, "--json"], testEnv);
    assert.equal(parentHealthJson.status, 0, parentHealthJson.stderr);
    const phj = JSON.parse(parentHealthJson.stdout);
    assert.equal(phj.parentFilter, cohortParent);
    assert.equal(phj.sessionCount, 2);
    assert.equal(phj.totals.pollingViolations, 1);

    const parentCurHealth = runCli(["transcript", "info", "--parent", "current", "--json"], {
      ...testEnv,
      GEMINI_CONVERSATION_ID: cohortParent
    });
    assert.equal(parentCurHealth.status, 0, parentCurHealth.stderr);
    assert.equal(JSON.parse(parentCurHealth.stdout).parentFilter, cohortParent);

    // Validation error checks for cohort health
    for (const badArgs of [
      ["transcript", "health", "--parent", ""],
      ["transcript", "health", "--parent", cohortParent, "--id", cohortWorkerA],
      ["transcript", "health", "--id", `${cohortWorkerA},current`],
      ["transcript", "health", "--parent", "conv-l61-no-children"]
    ]) {
      const badRes = runCli(badArgs, testEnv);
      assert.equal(badRes.status, 1, `Expected error for ${badArgs.join(" ")}`);
    }

    // Zero-trust Tier 4 launch-restriction grant enforcement on health --parent & --id multi without GEMINI_CONVERSATION_ID
    const t4HealthChildFile = path.join(stateDir, `agy-session-${cohortWorkerA}.json`);
    fs.writeFileSync(
      t4HealthChildFile,
      JSON.stringify({
        conversationId: cohortWorkerA,
        lastSeenTime: Date.now(),
        lineage: { isChildSession: true, isSwarmChild: true, parentConvId: cohortParent, launchDirective: "deny" }
      }),
      "utf-8"
    );
    const noEnvHealth = { ...testEnv };
    delete noEnvHealth.GEMINI_CONVERSATION_ID;
    try {
      const ungrantedParentHealth = runCli(["transcript", "health", "--parent", cohortParent, "--json"], noEnvHealth);
      assert.equal(ungrantedParentHealth.status, 1, "Tier 4 active child must block ungranted health --parent without GEMINI_CONVERSATION_ID");

      const ungrantedMultiHealth = runCli(["transcript", "health", "--id", `${cohortWorkerA},${cohortWorkerB}`, "--json"], noEnvHealth);
      assert.equal(ungrantedMultiHealth.status, 1, "Tier 4 active child must block ungranted health --id multi without GEMINI_CONVERSATION_ID");

      // Mismatched grant must fail
      recordTranscriptHookGrant({ callerConvId: cohortParent, subcommand: "health", targetConvId: "parent:other-parent", mode: "open" });
      const mismatchParentHealth = runCli(["transcript", "health", "--parent", cohortParent, "--json"], noEnvHealth);
      assert.equal(mismatchParentHealth.status, 1, "Mismatched parent: grant must be rejected on health --parent");

      // Matching parent: grant succeeds once and is consumed atomically
      recordTranscriptHookGrant({ callerConvId: cohortParent, subcommand: "health", targetConvId: `parent:${cohortParent}`, mode: "open" });
      const grantedParentHealth = runCli(["transcript", "health", "--parent", cohortParent, "--json"], noEnvHealth);
      assert.equal(grantedParentHealth.status, 0, grantedParentHealth.stderr);
      assert.equal(JSON.parse(grantedParentHealth.stdout).sessionCount, 2);
      const replayParentHealth = runCli(["transcript", "health", "--parent", cohortParent, "--json"], noEnvHealth);
      assert.equal(replayParentHealth.status, 1, "Single-use parent: grant must be consumed on first health --parent call");

      // Matching multi: grant succeeds once and is consumed atomically
      const multiKey = `multi:${[cohortWorkerA, cohortWorkerB].sort().join(",")}`;
      recordTranscriptHookGrant({ callerConvId: cohortParent, subcommand: "health", targetConvId: multiKey, mode: "open" });
      const grantedMultiHealth = runCli(["transcript", "health", "--id", `${cohortWorkerB},${cohortWorkerA}`, "--json"], noEnvHealth);
      assert.equal(grantedMultiHealth.status, 0, grantedMultiHealth.stderr);
      assert.equal(JSON.parse(grantedMultiHealth.stdout).sessionCount, 2);
      const replayMultiHealth = runCli(["transcript", "health", "--id", `${cohortWorkerA},${cohortWorkerB}`, "--json"], noEnvHealth);
      assert.equal(replayMultiHealth.status, 1, "Single-use multi: grant must be consumed on first health --id multi call");

      // ACS-SEC-01: self-only Tier 4 child must also block ungranted multi: health without GEMINI_CONVERSATION_ID
      fs.writeFileSync(
        t4HealthChildFile,
        JSON.stringify({
          conversationId: cohortWorkerA,
          lastSeenTime: Date.now(),
          lineage: { isChildSession: true, isSwarmChild: true, parentConvId: cohortParent, launchDirective: "self-only" }
        }),
        "utf-8"
      );
      const ungrantedSelfOnlyMulti = runCli(["transcript", "health", "--id", `${cohortWorkerA},${cohortWorkerB}`, "--json"], noEnvHealth);
      assert.equal(ungrantedSelfOnlyMulti.status, 1, "ACS-SEC-01: self-only Tier 4 child must block ungranted multi: health without GEMINI_CONVERSATION_ID");

      // Real piped EPIPE early-close regression: > 100 KB stdout into early-closing consumer must exit 0 with empty stderr
      const epipeConv = "conv-epipe-stress-16";
      const epipeLogsDir = path.join(brainDir, epipeConv, ".system_generated", "logs");
      fs.mkdirSync(epipeLogsDir, { recursive: true });
      const epipeLines = [
        JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Run big audit", created_at: "2026-11-22T02:00:00Z" })
      ];
      for (let i = 1; i <= 180; i++) {
        epipeLines.push(JSON.stringify({
          step_index: i,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: `Step ${i} large payload: ${"A".repeat(900)}`,
          created_at: `2026-11-22T02:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`
        }));
      }
      fs.writeFileSync(path.join(epipeLogsDir, "transcript.jsonl"), epipeLines.join("\n") + "\n", "utf8");
      const epipeResult = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cliScript, "transcript", "query", "--id", epipeConv, "--roles", "all", "--full"], {
          env: { ...testEnv, GEMINI_CONVERSATION_ID: epipeConv },
          stdio: ["ignore", "pipe", "pipe"]
        });
        let gotOut = "";
        let gotErr = "";
        let destroyed = false;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          gotOut += chunk;
          if (!destroyed && gotOut.split("\n").length >= 6) {
            destroyed = true;
            child.stdout.destroy();
          }
        });
        child.stderr.on("data", (chunk) => { gotErr += chunk; });
        child.on("error", reject);
        child.on("close", (code, signal) => resolve({ code, signal, gotOut, gotErr, destroyed }));
      });
      assert.equal(epipeResult.destroyed, true, "EPIPE test must close stdout early after receiving >= 5 lines");
      assert.equal(epipeResult.code, 0, `Piped EPIPE early-close must exit 0 (got code=${epipeResult.code}, signal=${epipeResult.signal}, stderr=${epipeResult.gotErr})`);
      assert.equal(epipeResult.gotErr, "", `Piped EPIPE early-close must emit zero stderr stack trace (got: ${epipeResult.gotErr})`);
      fs.rmSync(path.join(brainDir, epipeConv), { recursive: true, force: true });
    } finally {
      try { fs.unlinkSync(t4HealthChildFile); } catch {}
      for (const f of listGrantFiles()) { try { fs.unlinkSync(path.join(grantsDir, f)); } catch {} }
    }

    console.log("✓ Section 16 (L61 getStepDetail dedup, --summary 100 default, cohort health & Tier 4 grants) verified");
  }

  console.log("\n--- 17. Day-One Audit Regressions (SEC-004, SEC-006, RUN-001..004) ---");
  {
    // SEC-004 & R2-RUN-001: catastrophic/polynomial/case-folded ReDoS patterns fall back to literal matching while truly /i-disjoint regexes stay active
    const evilPatterns = [
      "(a+)+!", "(a?a?)+!", "(a{0,1}a{0,1})+!", "((a|aa))+!", "(?:(a|aa))+!",
      "(a|aa)?".repeat(16) + "!", "(a|aa)".repeat(25) + "!", "a?".repeat(26) + "a".repeat(26) + "!",
      "(a){1,99}".repeat(6) + "!", "a{1,99}A{1,99}".repeat(3) + "!", "a{1,99}b?".repeat(6) + "!",
      "a+A+a+!", "a+A+!", "[A-Z]+[a-z]+!", "(a)+(a)+(a)+!", "a.*a.*a.*!",
      "[a-z]+[a-b]+[a-c]+!", "\\w+a+\\w+!", "a+b?a+!", "a+b*a+!",
      "a+a+a+a+a+a+!", "\\S+\\w+\\S+\\w+\\S+!", "\\w+\\d+\\w+\\d+\\w+!", "a.*a.*a.*a.*a.*!"
    ];
    const t0 = performance.now();
    for (const pat of evilPatterns) {
      assert.equal(getCompiledRegex(pat).test("a".repeat(64) + "X"), false, `SEC-004 ${pat} must not hang`);
    }
    assert.ok(performance.now() - t0 < 50, "SEC-004 catastrophic & polynomial regexes must run in < 50ms via literal fallback");
    assert.equal(getCompiledRegex("ERROR|DENIED").test("found denied"), true, "SEC-004 normal alternation regex preserved");
    assert.equal(getCompiledRegex("step\\s+\\d+").test("step 42"), true, "SEC-004 disjoint wildcard regex preserved");
    assert.equal(getCompiledRegex("[a-z]+[0-9]+").test("step42"), true, "R2-RUN-001 benign /i-disjoint char classes must stay regex");
    assert.equal(getCompiledRegex("[0-9]+[:.-][0-9]+").test("12.34"), true, "R2-RUN-001 benign numeric punctuation pattern must stay regex");
    assert.equal(getCompiledRegex("colou?r").test("color"), true, "SEC-004 benign optional char preserved");
    assert.equal(getCompiledRegex("https?://\\S+").test("https://example.com"), true, "SEC-004 benign URL regex preserved");
    assert.equal(getCompiledRegex("\\w+@\\w+\\.\\w+").test("a@b.co"), true, "SEC-004 benign email regex preserved");
    assert.equal(getCompiledRegex("foo.*bar.*baz").test("foo 1 bar 2 baz"), true, "SEC-004 benign 2-wildcard regex preserved");

    // SEC-006: !transcriptFound does not branch on AGY_TEST_PROFILE_DIR
    const sec006Policy = findGoverningPolicyForCaller(
      { activeOwnerId: "p-owner", policies: { "p-owner": { ownerId: "p-owner", mode: "deny", allow: [], deny: [] } } },
      "brand-new-session",
      { transcriptFound: false, isTopLevelUserSession: false, isChildSession: false, parentConvId: null, rosterName: null }
    );
    assert.equal(sec006Policy, null, "SEC-006 !transcriptFound must match production behavior without AGY_TEST_PROFILE_DIR override");

    // RUN-001: outline supports --roles, --query, --last-turns
    const r1Conv = "dayone-outline-test";
    const r1Logs = path.join(brainDir, r1Conv, ".system_generated", "logs");
    fs.mkdirSync(r1Logs, { recursive: true });
    fs.writeFileSync(path.join(r1Logs, "transcript.jsonl"), [
      JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "FIRST_TURN_ALPHA", created_at: "2026-11-23T01:00:00Z" }),
      JSON.stringify({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", content: "Reply 1", created_at: "2026-11-23T01:00:01Z" }),
      JSON.stringify({ step_index: 2, source: "USER_EXPLICIT", type: "USER_INPUT", content: "SECOND_TURN_BETA", created_at: "2026-11-23T01:00:02Z" }),
      JSON.stringify({ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", content: "Reply 2", created_at: "2026-11-23T01:00:03Z" })
    ].join("\n") + "\n");
    const outlineRoles = runCli(["transcript", "outline", r1Conv, "--roles", "user", "--last-turns", "1", "--json"]);
    assert.equal(outlineRoles.status, 0, outlineRoles.stderr);
    const outlineItems = JSON.parse(outlineRoles.stdout).items;
    assert.equal(outlineItems.length, 1, "RUN-001 outline --roles user --last-turns 1 must return only last user turn");
    assert.equal(outlineItems[0].step_index, 2);
    const outlineQuery = runCli(["transcript", "outline", r1Conv, "--query", "FIRST_TURN_ALPHA", "--json"]);
    assert.equal(outlineQuery.status, 0, outlineQuery.stderr);
    assert.deepEqual(JSON.parse(outlineQuery.stdout).items.map((x) => x.step_index), [0], "RUN-001 outline --query must filter steps");

    // RUN-002: step rejects undocumented --mode
    const stepBadMode = runCli(["transcript", "step", "0", r1Conv, "--mode", "full"]);
    assert.notEqual(stepBadMode.status, 0, "RUN-002 step --mode must fail fast");
    assert.match(stepBadMode.stderr, /Unknown flag/i);

    // RUN-003: access rejects conflicting --status + mutation flags, and isStatusOnly checks denyChildren/ttl
    for (const conflictArgs of [["--status", "--ttl", "60"], ["--status", "--deny-children"], ["--status", "--off"]]) {
      const conflictRes = runCli(["transcript", "access", ...conflictArgs]);
      assert.notEqual(conflictRes.status, 0, `RUN-003 access ${conflictArgs.join(" ")} must fail`);
      assert.match(conflictRes.stderr, /Conflicting flags/i);
    }
    const ttlMut = manageTranscriptAccessPolicy({ status: true, denyChildren: true, ttl: 120, _testAuthorizedOwner: "run003-owner" });
    assert.equal(ttlMut.mode, "deny", "RUN-003 manageTranscriptAccessPolicy must not short-circuit on status+denyChildren");
    assert.equal(ttlMut.ttlMs, 120000, "RUN-003 manageTranscriptAccessPolicy must apply ttlMs when provided");
    manageTranscriptAccessPolicy({ on: true, _testAuthorizedOwner: "run003-owner" });

    // RUN-004: isProtectedInternalOutPath allows brain/<id>/scratch/logs/* while blocking non-user brain logs/ and ..
    assert.equal(isProtectedInternalOutPath(path.join(brainDir, r1Conv, "scratch", "logs", "report.md")), false, "RUN-004 scratch/logs/ must be allowed for --out");
    assert.equal(isProtectedInternalOutPath(path.join(brainDir, r1Conv, "logs", "report.md")), true, "RUN-004 direct brain/<id>/logs/ must stay blocked");
    assert.equal(isProtectedInternalOutPath(path.join(brainDir, r1Conv, "scratch", "logs", "..", "..", "logs", "report.md")), true, "RUN-004 traversal out of scratch must stay blocked");

    fs.rmSync(path.join(brainDir, r1Conv), { recursive: true, force: true });
    console.log("✓ Section 17 (SEC-004 ReDoS, SEC-006 auth parity, RUN-001..004 CLI & --out parity) verified");
  }
} finally {
  fs.rmSync(tempHome, { recursive: true, force: true });
}

console.log("\n=================================================");
console.log("ALL 2.0 TRANSCRIPT CORE & CLI TESTS PASSED!");
console.log("=================================================");
