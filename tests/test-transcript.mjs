import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CircularRingBuffer,
  cleanMessageContent,
  extractConvId,
  readTranscript,
  queryTranscript,
  getStepDetail,
  checkContextHealth,
  getRequiredBackoffSeconds,
  listTranscriptConversations,
  exportSanitizedTranscript,
  stripSummaryStepBoilerplate,
  inspectTranscriptLineageFromFile,
  manageTranscriptAccessPolicy,
  recordTranscriptHookGrant,
  consumeTranscriptAccessGrant
} from "../lib/transcript-core.mjs";
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
    assert.ok(cleaned.includes("https://example.com/"), "URL tokens must NOT be treated as base64");
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
    const longCommand = "mkdir -p scratch/agy-squad/live-w2/squad-squad1/specialist-1 && sed -n '1,15p' scripts/state-dir.mjs > scratch/agy-squad/live-w2/squad-squad1/specialist-1/slice-a.txt && echo FULL_ARGS_END_MARKER_OK";
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
    console.log("✓ Unified health evaluator enforces timestamped backoff parity without false-flagging kill/list");
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

      // 2b. Redaction before 36-char tool truncation, L6 non-priority body key omission, --start/--end, malformed lines, and empty transcript
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

      // 3. transcript export --parent <parentUuid> --sanitized --out <path> produces L6-safe index
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
    const longToolArg = "scratch/agy-squad/squad-skill_and_pr_review_audit/specialist-1/report.md";
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
    const longPathArg = "/home/paragon-ux/Antigravity/Agy-Squad/scratch/very_long_nested_directory_name/specialist-1/target_report.md";
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

    // Single-step clamping header must not claim 'batch view'
    const singleClampedStep = runCli(["transcript", "step", "--id", convErg, "--step", String(richAsstStep), "--field", "tool_args", "--full", "--max-chars", "600"]);
    assert.equal(singleClampedStep.status, 0);
    assert.ok(!singleClampedStep.stdout.includes("clamped in batch view"), "Single-step clamp message must not say batch view");
    assert.ok(Buffer.byteLength(singleClampedStep.stdout, "utf8") <= 600);
    assert.match(singleClampedStep.stdout, /clamped at 600 (?:bytes|chars)/);

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
    const hugeRes = runCli(["transcript", "outline", "--id", convHuge, "--full", "--out", hugeJsonFile, "--json"]);
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

    const batchSteps = ["0", "2", "4", "8"];
    const batch = runCli(["transcript", "step", "--id", convHuge, "--step", batchSteps.join(","), "--field", "content", "--json", "--max-chars", "15000"]);
    assertBounded(batch, 15000);
    const batchPage = JSON.parse(batch.stdout);
    assert.ok(batchPage.steps.length > 0 && batchPage.steps.length < batchSteps.length);
    assert.deepEqual(batchPage.stepIndices, batchPage.steps.map((entry) => entry.stepIndex));
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
  }
} finally {
  fs.rmSync(tempHome, { recursive: true, force: true });
}

console.log("\n=================================================");
console.log("ALL 2.0 TRANSCRIPT CORE & CLI TESTS PASSED!");
console.log("=================================================");
