import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CircularRingBuffer,
  cleanMessageContent,
  readTranscript,
  queryTranscript,
  getStepDetail,
  checkContextHealth,
  getRequiredBackoffSeconds,
  manageTranscriptAccessPolicy,
  recordTranscriptHookGrant
} from "../lib/transcript-core.mjs";
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

    //6. Parent resets policy back to OPEN
    recordTranscriptHookGrant({ callerConvId: "parent-owner", subcommand: "access", mode: "open", isMutation: true });
    const unlockRes = runCli(["transcript", "access", "--on", "--json"]);
    assert.equal(unlockRes.status, 0, "Authorized parent transcript access --on must succeed");
    const unlockJson = JSON.parse(unlockRes.stdout);
    assert.equal(unlockJson.mode, "open");
    assert.equal(unlockJson.active, false);

    console.log("✓ Parent policy CLI, runtime hook-grant verification, self-only core containment, and anti-spoofing verified");
  }
} finally {
  fs.rmSync(tempHome, { recursive: true, force: true });
}

console.log("\n=================================================");
console.log("ALL 2.0 TRANSCRIPT CORE & CLI TESTS PASSED!");
console.log("=================================================");
