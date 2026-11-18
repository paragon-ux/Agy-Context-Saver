#!/usr/bin/env node

/**
 * Agy-Context-Saver v2.0.0 Output Governance & Forensic Dereferencing Tests
 *
 * Verifies:
 * 1. Safe-Harbor bounded read_file (<=150 lines) and `rtk read` on `.system_generated/steps/<step>/output.txt`
 * 2. Unbounded read_file / view_file on spillover denies and routes to bounded read_file or rtk read
 * 3. Lifecycle-gated `rtk read` / native inspection on task logs (RUNNING backoff vs COMPLETED)
 * 4. CLI `agy-context transcript step|read|query` CRLF stripping and field extraction
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setupHermeticTestEnv, HERMETIC_CONV_ID } from "./helpers/hermetic-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookScript = path.resolve(__dirname, "../scripts/execution-guard-hook.mjs");
const cliScript = path.resolve(__dirname, "../bin/agy-context.mjs");

console.log("Running Agy-Context-Saver v2.0.0 Output Inspection Governance Tests...\n");
const hermetic = await setupHermeticTestEnv({ forceShim: true, shimVersion: "1.1.0" });

function invokeHook(payload) {
  const res = spawnSync(process.execPath, [hookScript], {
    input: JSON.stringify(payload),
    encoding: "utf-8"
  });
  assert.equal(res.status, 0, `Hook failed with status ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

function invokeCli(args) {
  const res = spawnSync(process.execPath, [cliScript, ...args], {
    encoding: "utf-8"
  });
  assert.equal(res.status, 0, `CLI failed (${res.status}): ${res.stderr}`);
  return res.stdout;
}

// --- Group 1: Safe-Harbor rtk read & Bounded read_file for Runtime Spillover Files ---
console.log("--- Group 1: Spillover Safe Harbor ---");
{
  const unboundedView = invokeHook({
    toolCall: {
      name: "read_file",
      args: { Path: "/home/user/.gemini/antigravity/brain/session-123/.system_generated/steps/507/output.txt" }
    }
  });
  assert.equal(unboundedView.decision, "deny");
  assert.match(unboundedView.reason, /rtk read/);

  const boundedRead = invokeHook({
    toolCall: {
      name: "read_file",
      args: { Path: "/home/user/.gemini/antigravity/brain/session-123/.system_generated/steps/507/output.txt", StartLine: 1, EndLine: 150 }
    }
  });
  assert.equal(boundedRead.decision, "allow");

  const catSpill = invokeHook({
    toolCall: {
      name: "run_command",
      args: { CommandLine: "cat .system_generated/steps/102/output.txt", WaitMsBeforeAsync: 5000 }
    }
  });
  assert.equal(catSpill.decision, "allow");
  assert.equal(catSpill.overwrite?.CommandLine, "rtk read .system_generated/steps/102/output.txt");

  const rtkSpill = invokeHook({
    toolCall: {
      name: "run_command",
      args: { CommandLine: "rtk read .system_generated/steps/102/output.txt", WaitMsBeforeAsync: 5000 }
    }
  });
  assert.equal(rtkSpill.decision, "allow");

  const rfSpillUnbounded = invokeHook({
    toolCall: {
      name: "read_file",
      args: { Path: "/home/user/.gemini/antigravity/brain/session-123/.system_generated/steps/507/output.txt" }
    }
  });
  assert.equal(rfSpillUnbounded.decision, "deny");
  assert.match(rfSpillUnbounded.reason, /rtk read/);

  const sedSpill = invokeHook({
    toolCall: {
      name: "run_command",
      args: { CommandLine: "sed -n '1,5p' .system_generated/steps/102/output.txt", WaitMsBeforeAsync: 5000 }
    }
  });
  assert.equal(sedSpill.decision, "deny");
  console.log("✓ Spillover bounded read_file (<=150L), unchained `rtk read`, and unrewritten deny verified");
}

// --- Group 2: Lifecycle-Gated Task Output Inspection ---
console.log("\n--- Group 2: Lifecycle-Gated Task Output Inspection ---");
const tempBrainDir = path.join(os.tmpdir(), `agy-test-brain-${Date.now()}`);
const oldBrain = process.env.AGY_BRAIN_DIR;
process.env.AGY_BRAIN_DIR = tempBrainDir;

try {
  const convLive = "conv-test-live";
  const convDir = path.join(tempBrainDir, convLive, ".system_generated");
  fs.mkdirSync(path.join(convDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(convDir, "tasks"), { recursive: true });
  const liveLog = path.join(convDir, "tasks", "task-live-1.log");
  const transcriptFile = path.join(convDir, "logs", "transcript.jsonl");

  const { getStateDir } = await import("../scripts/state-dir.mjs");
  try { fs.unlinkSync(path.join(getStateDir(), "agy-session-conv-test-live.json")); } catch {}
  try { fs.unlinkSync(path.join(getStateDir(), "agy-session-conv_test_live.json")); } catch {}

  fs.writeFileSync(liveLog, "Running output in progress...\n", "utf-8");
  fs.writeFileSync(
    transcriptFile,
    JSON.stringify({
      step_index: 1,
      type: "SYSTEM_MESSAGE",
      content: `Tool is running as a background task with task id: ${convLive}/task-live-1\nTask logs are available at: ${liveLog}`
    }) + "\n",
    "utf-8"
  );

  // RUNNING task log denied with Proportional Backoff for both read_file & run_command
  const rfRunning = invokeHook({
    conversationId: convLive,
    toolCall: { name: "read_file", args: { Path: liveLog.replace(/\\/g, "/") } }
  });
  assert.equal(rfRunning.decision, "deny");
  assert.match(rfRunning.reason, /actively RUNNING/);

  const cmdRunning = invokeHook({
    conversationId: convLive,
    toolCall: { name: "run_command", args: { CommandLine: "rtk read tasks/task-live-1.log", WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(cmdRunning.decision, "deny");
  assert.match(cmdRunning.reason, /actively RUNNING/);

  // Quiet >15s without finish marker stays RUNNING
  const pastTime = (Date.now() - 30000) / 1000;
  fs.utimesSync(liveLog, pastTime, pastTime);
  const stillRunning = invokeHook({
    conversationId: convLive,
    toolCall: { name: "run_command", args: { CommandLine: "rtk read tasks/task-live-1.log", WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(stillRunning.decision, "deny");
  assert.match(stillRunning.reason, /actively RUNNING/);

  // Mark finished in transcript -> native read_file routes to rtk read, unchained rtk read ALLOWED
  fs.appendFileSync(
    transcriptFile,
    JSON.stringify({
      step_index: 2,
      type: "SYSTEM_MESSAGE",
      content: `Task id "${convLive}/task-live-1" finished with result:\nAll tests passed.`
    }) + "\n",
    "utf-8"
  );

  const rfCompleted = invokeHook({
    conversationId: convLive,
    toolCall: { name: "read_file", args: { Path: liveLog.replace(/\\/g, "/") } }
  });
  assert.equal(rfCompleted.decision, "deny");
  assert.match(rfCompleted.reason, /rtk read/);

  const cmdCompleted = invokeHook({
    conversationId: convLive,
    toolCall: { name: "run_command", args: { CommandLine: "rtk read tasks/task-live-1.log", WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(cmdCompleted.decision, "allow");

  // Completed task logs <= 45 KiB allow cat/head/tail auto-rewritten via rtk read; unrewritten sed stays denied
  const cmdCompletedHead = invokeHook({
    conversationId: convLive,
    toolCall: { name: "run_command", args: { CommandLine: "head -n 50 tasks/task-live-1.log", WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(cmdCompletedHead.decision, "allow");
  assert.equal(cmdCompletedHead.overwrite?.CommandLine, "rtk read tasks/task-live-1.log --head-lines 50");

  const cmdCompletedCat = invokeHook({
    conversationId: convLive,
    toolCall: { name: "run_command", args: { CommandLine: "cat tasks/task-live-1.log", WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(cmdCompletedCat.decision, "allow");
  assert.equal(cmdCompletedCat.overwrite?.CommandLine, "rtk read tasks/task-live-1.log");

  const cmdCompletedSed = invokeHook({
    conversationId: convLive,
    toolCall: { name: "run_command", args: { CommandLine: "sed -n '1,5p' tasks/task-live-1.log", WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(cmdCompletedSed.decision, "deny");

  // Completed task logs > 45 KiB require --head-lines/--tail-lines even after rtk rewrite
  const bigLog = path.join(convDir, "tasks", "task-live-big.log");
  fs.writeFileSync(bigLog, "x".repeat(48 * 1024), "utf-8");
  fs.appendFileSync(
    transcriptFile,
    JSON.stringify({
      step_index: 3,
      type: "SYSTEM_MESSAGE",
      content: `Task id "${convLive}/task-live-big" finished with result:\nLarge output complete.`
    }) + "\n",
    "utf-8"
  );
  const bigLogTok = bigLog.replace(/\\/g, "/");

  const cmdBigCat = invokeHook({
    conversationId: convLive,
    toolCall: { name: "run_command", args: { CommandLine: `cat ${bigLogTok}`, WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(cmdBigCat.decision, "deny");
  assert.match(cmdBigCat.reason, /--head-lines 150/);
  assert.match(cmdBigCat.reason, /--tail-lines 150/);

  const cmdBigHead = invokeHook({
    conversationId: convLive,
    toolCall: { name: "run_command", args: { CommandLine: `head -n 150 ${bigLogTok}`, WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(cmdBigHead.decision, "allow");
  assert.equal(cmdBigHead.overwrite?.CommandLine, `rtk read ${bigLogTok} --head-lines 150`);

  const cmdBigTail = invokeHook({
    conversationId: convLive,
    toolCall: { name: "run_command", args: { CommandLine: `tail -n 150 ${bigLogTok}`, WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(cmdBigTail.decision, "allow");
  assert.equal(cmdBigTail.overwrite?.CommandLine, `rtk read ${bigLogTok} --tail-lines 150`);

  // Relative >45 KiB task logs and step spillovers must resolve against brain dir even from an unrelated workspace cwd
  const cmdRelBigCat = invokeHook({
    conversationId: convLive,
    cwd: os.tmpdir(),
    toolCall: { name: "run_command", args: { CommandLine: "cat tasks/task-live-big.log", WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(cmdRelBigCat.decision, "deny");
  assert.match(cmdRelBigCat.reason, /--head-lines 150/);
  assert.match(cmdRelBigCat.reason, /--tail-lines 150/);

  const cmdRelBigHead = invokeHook({
    conversationId: convLive,
    cwd: os.tmpdir(),
    toolCall: { name: "run_command", args: { CommandLine: "head -n 150 tasks/task-live-big.log", WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(cmdRelBigHead.decision, "allow");
  assert.equal(cmdRelBigHead.overwrite?.CommandLine, "rtk read tasks/task-live-big.log --head-lines 150");

  const bigSpillDir = path.join(convDir, "steps", "103");
  fs.mkdirSync(bigSpillDir, { recursive: true });
  fs.writeFileSync(path.join(bigSpillDir, "output.txt"), "y".repeat(48 * 1024), "utf-8");

  const cmdRelBigSpillCat = invokeHook({
    conversationId: convLive,
    cwd: os.tmpdir(),
    toolCall: { name: "run_command", args: { CommandLine: "cat .system_generated/steps/103/output.txt", WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(cmdRelBigSpillCat.decision, "deny");
  assert.match(cmdRelBigSpillCat.reason, /--head-lines 150/);
  assert.match(cmdRelBigSpillCat.reason, /--tail-lines 150/);

  const cmdRelBigSpillTail = invokeHook({
    conversationId: convLive,
    cwd: os.tmpdir(),
    toolCall: { name: "run_command", args: { CommandLine: "tail -n 150 .system_generated/steps/103/output.txt", WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(cmdRelBigSpillTail.decision, "allow");
  assert.equal(cmdRelBigSpillTail.overwrite?.CommandLine, "rtk read .system_generated/steps/103/output.txt --tail-lines 150");

  // Legacy task log > 5m quiet without markers falls back to completed
  const legacyLog = path.join(convDir, "tasks", "task-legacy-99.log");
  fs.writeFileSync(legacyLog, "Old session output\n", "utf-8");
  const oldTime = (Date.now() - 360000) / 1000;
  fs.utimesSync(legacyLog, oldTime, oldTime);
  assert.equal(
    invokeHook({
      conversationId: convLive,
      toolCall: { name: "run_command", args: { CommandLine: "rtk read tasks/task-legacy-99.log", WaitMsBeforeAsync: 5000 } }
    }).decision,
    "allow"
  );
  console.log("✓ Lifecycle-gated task log backoff and completion handling verified");
} finally {
  if (oldBrain) process.env.AGY_BRAIN_DIR = oldBrain;
  else delete process.env.AGY_BRAIN_DIR;
  try { fs.rmSync(tempBrainDir, { recursive: true, force: true }); } catch {}
}

// --- Group 3: CLI Forensic Extraction & Git CRLF Warning Stripping ---
console.log("\n--- Group 3: CLI Step Extraction & CRLF Warning Stripping ---");
{
  const stepText = invokeCli(["transcript", "step", "--id", HERMETIC_CONV_ID, "--step", "1", "--field", "content"]);
  assert.match(stepText, /Step 1 Content/);

  const crlfDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-crlf-cli-"));
  try {
    const convId = "crlf-cli-conv";
    const logsDir = path.join(crlfDir, convId, ".system_generated", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const tFile = path.join(logsDir, "transcript.jsonl");
    fs.writeFileSync(
      tFile,
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: new Date().toISOString(),
        content: "Building...\nwarning: in the working copy of 'sample.ts', LF will be replaced by CRLF the next time Git touches it\nok 1 - build passed\n"
      }) + "\n",
      "utf-8"
    );

    const out = invokeCli(["transcript", "read", "--file", tFile, "--last-turns", "1"]);
    assert.equal(out.includes("will be replaced by"), false);
    assert.match(out, /ok 1 - build passed/);
  } finally {
    fs.rmSync(crlfDir, { recursive: true, force: true });
  }
  console.log("✓ CLI surgical step extraction and CRLF warning stripping verified");
}

hermetic.cleanup();
console.log("\n=================================================");
console.log("ALL OUTPUT GOVERNANCE & FORENSIC TESTS PASSED 100%!");
console.log("=================================================");
