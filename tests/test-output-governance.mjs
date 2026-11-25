#!/usr/bin/env node

/**
 * Agy-Context-Saver v2.0.0 Output Governance & Forensic Dereferencing Tests
 *
 * Verifies:
 * 1. Safe-Harbor bounded read_file (<=150 lines) and `rtk read` on `.system_generated/steps/<step>/output.txt`
 * 2. Unbounded read_file / view_file on spillover denies and routes to bounded read_file or rtk read
 * 3. Lifecycle-gated `rtk read` / native inspection on task logs (RUNNING backoff vs COMPLETED)
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
  const clearTestSessionStates = () => {
    for (const id of ["conv-test-live", "conv-test-multi", "conv-other-caller-1", "conv-other-caller-2", "conv-other-caller-3", "conv-other-caller-4", "conv-test-custom", "Jane Doe Conv"]) {
      for (const norm of [id, id.replace(/[^a-zA-Z0-9_-]/g, "_"), id.replace(/-/g, "_")]) {
        try { fs.unlinkSync(path.join(getStateDir(), `agy-session-${norm}.json`)); } catch {}
      }
    }
  };
  clearTestSessionStates();

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

  // PR9-RUN-002 + v2.1.2 Boost Pass: symmetrical bounded read_file (<=150L) allowed on COMPLETED task log;
  // unbounded read_file on >45 KiB completed task log denied with --head-lines/--tail-lines guidance
  assert.equal(cmdBigCat.reason.includes("read_file"), false, ">45 KiB shell task-log denial focuses on rtk read bounds");
  const rfBigCompletedBounded = invokeHook({
    conversationId: convLive,
    toolCall: { name: "read_file", args: { Path: bigLogTok, StartLine: 1, EndLine: 150 } }
  });
  assert.equal(rfBigCompletedBounded.decision, "allow", "Bounded read_file <=150L on COMPLETED task log allowed symmetrically with spillovers");
  const rfBigCompletedUnbounded = invokeHook({
    conversationId: convLive,
    toolCall: { name: "read_file", args: { Path: bigLogTok } }
  });
  assert.equal(rfBigCompletedUnbounded.decision, "deny");
  assert.match(rfBigCompletedUnbounded.reason, /--tail-lines 150/);
  assert.match(rfBigCompletedUnbounded.reason, /--head-lines 150/);

  const rfBigSpillUnbounded = invokeHook({
    conversationId: convLive,
    cwd: os.tmpdir(),
    toolCall: { name: "read_file", args: { Path: ".system_generated/steps/103/output.txt" } }
  });
  assert.equal(rfBigSpillUnbounded.decision, "deny");
  assert.match(rfBigSpillUnbounded.reason, /--tail-lines 150/);
  assert.match(rfBigSpillUnbounded.reason, /--head-lines 150/);

  // PR9-TEST-001: tail -n 50 on <=45 KiB completed log allowed; UNKNOWN task logs deny auto-rewrites and allow explicit rtk read
  const cmdCompletedTail = invokeHook({
    conversationId: convLive,
    toolCall: { name: "run_command", args: { CommandLine: "tail -n 50 tasks/task-live-1.log", WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(cmdCompletedTail.decision, "allow");
  assert.equal(cmdCompletedTail.overwrite?.CommandLine, "rtk read tasks/task-live-1.log --tail-lines 50");

  for (const unknownAutoCmd of [
    "cat tasks/task-unknown-99.log",
    "head -n 50 tasks/task-unknown-99.log",
    "tail -n 50 tasks/task-unknown-99.log"
  ]) {
    const outUnk = invokeHook({
      conversationId: convLive,
      toolCall: { name: "run_command", args: { CommandLine: unknownAutoCmd, WaitMsBeforeAsync: 5000 } }
    });
    assert.equal(outUnk.decision, "deny", `UNKNOWN task log must deny auto-rewrite: ${unknownAutoCmd}`);
  }
  const outUnkExplicit = invokeHook({
    conversationId: convLive,
    toolCall: { name: "run_command", args: { CommandLine: "rtk read tasks/task-unknown-99.log", WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(outUnkExplicit.decision, "allow", "Explicit rtk read on UNKNOWN task log stays allowed");

  // PR9-RUN-003 + PR9-RUN-007: Line-bound parsing (-- -m, 0, 999999, -m150, =150) & fail-closed env prefixes
  for (const badBoundCmd of [
    `rtk read ${bigLogTok} -- -m`,
    `rtk read --head-lines 999999 ${bigLogTok}`,
    `rtk read --head-lines 0 ${bigLogTok}`,
    `head -n 999999 ${bigLogTok}`,
    `rtk read --head-lines 150 --tail-lines 999999 ${bigLogTok}`,
    "FOO=1 cat tasks/task-live-1.log",
    "AGY_BRAIN_DIR=/tmp cat tasks/task-live-1.log",
    "rtk read -l .system_generated/steps/102/output.txt package.json"
  ]) {
    const outBad = invokeHook({
      conversationId: convLive,
      toolCall: { name: "run_command", args: { CommandLine: badBoundCmd, WaitMsBeforeAsync: 5000 } }
    });
    assert.equal(outBad.decision, "deny", `Oversized/bypass/env-prefixed command must be denied: ${badBoundCmd}`);
  }

  for (const okBoundCmd of [
    `rtk read -m150 ${bigLogTok}`,
    `rtk read --head-lines=150 ${bigLogTok}`,
    `rtk read --level minimal --head-lines 150 ${bigLogTok}`
  ]) {
    const outOk = invokeHook({
      conversationId: convLive,
      toolCall: { name: "run_command", args: { CommandLine: okBoundCmd, WaitMsBeforeAsync: 5000 } }
    });
    assert.equal(outOk.decision, "allow", `Valid bounded rtk read must be allowed: ${okBoundCmd} (${outOk.reason || ""})`);
  }

  // PR9-RUN-001: Multi-operand smuggling vectors blocked (using fresh convId so RUNNING strikes do not hit 5-strike force_ask)
  const convMulti = "conv-test-multi";
  const multiDir = path.join(tempBrainDir, convMulti, ".system_generated");
  fs.mkdirSync(path.join(multiDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(multiDir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(multiDir, "tasks", "task-done-m.log"), "done\n", "utf-8");
  fs.writeFileSync(path.join(multiDir, "tasks", "task-run-m.log"), "running\n", "utf-8");
  fs.writeFileSync(
    path.join(multiDir, "logs", "transcript.jsonl"),
    [
      JSON.stringify({ step_index: 1, type: "SYSTEM_MESSAGE", content: `Task id "${convMulti}/task-done-m" finished with result:\nok` }),
      JSON.stringify({ step_index: 2, type: "SYSTEM_MESSAGE", content: `Tool is running as a background task with task id: ${convMulti}/task-run-m` })
    ].join("\n") + "\n",
    "utf-8"
  );

  for (const smuggleCmd of [
    "cat .system_generated/steps/1/output.txt .system_generated/logs/transcript.jsonl",
    "cat tasks/task-done-m.log ~/.local/state/agy-context-saver/transcript-access.json",
    "cat tasks/task-done-m.log tasks/task-unknown-m.log",
    "cat tasks/task-done-m.log package.json",
    "cat .system_generated/steps/102/output.txt tasks/task-done-m.log",
    "rtk read tasks/nonexistent-m.log ~/.local/state/agy-context-saver/transcript-access.json",
    "rtk read --head-lines 150 .system_generated/steps/103/output.txt package.json"
  ]) {
    const outSmuggle = invokeHook({
      conversationId: convMulti,
      toolCall: { name: "run_command", args: { CommandLine: smuggleCmd, WaitMsBeforeAsync: 5000 } }
    });
    assert.equal(outSmuggle.decision, "deny", `Multi-operand smuggling must be denied: ${smuggleCmd}`);
  }

  const runningPiggyback = invokeHook({
    conversationId: convMulti,
    toolCall: { name: "run_command", args: { CommandLine: "cat tasks/task-done-m.log tasks/task-run-m.log", WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(runningPiggyback.decision, "deny");
  assert.match(runningPiggyback.reason, /actively RUNNING/, "Piggybacked running task log must trigger Check 2 backoff");

  const runningPiggybackFirst = invokeHook({
    conversationId: convMulti,
    toolCall: { name: "run_command", args: { CommandLine: "cat tasks/task-run-m.log tasks/task-done-m.log", WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(runningPiggybackFirst.decision, "deny");
  assert.match(runningPiggybackFirst.reason, /actively RUNNING/, "Running task log before completed log must still trigger Check 2 backoff");

  // PR9-RUN-004, PR9-RUN-005, PR9-RUN-006: ~/ expansion, cross-session relative, custom basename, and quoted space paths
  const convTilde = "conv-test-tilde";
  const tildeDir = path.join(hermetic.profileDir, ".gemini", "antigravity", "brain", convTilde, ".system_generated");
  fs.mkdirSync(path.join(tildeDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(tildeDir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(tildeDir, "tasks", "task-run-til.log"), "running\n", "utf-8");
  fs.writeFileSync(path.join(tildeDir, "tasks", "task-big-til.log"), "z".repeat(48 * 1024), "utf-8");
  fs.writeFileSync(
    path.join(tildeDir, "logs", "transcript.jsonl"),
    [
      JSON.stringify({ step_index: 1, type: "SYSTEM_MESSAGE", content: `Tool is running as a background task with task id: ${convTilde}/task-run-til` }),
      JSON.stringify({ step_index: 2, type: "SYSTEM_MESSAGE", content: `Task id "${convTilde}/task-big-til" finished with result:\nok` })
    ].join("\n") + "\n",
    "utf-8"
  );

  const tildeRunOut = invokeHook({
    conversationId: "conv-other-caller-1",
    toolCall: { name: "run_command", args: { CommandLine: `rtk read ~/.gemini/antigravity/brain/${convTilde}/.system_generated/tasks/task-run-til.log`, WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(tildeRunOut.decision, "deny");
  assert.match(tildeRunOut.reason, /actively RUNNING/);

  const tildeBigCat = invokeHook({
    conversationId: "global",
    toolCall: { name: "run_command", args: { CommandLine: `cat ~/.gemini/antigravity/brain/${convTilde}/.system_generated/tasks/task-big-til.log`, WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(tildeBigCat.decision, "deny");
  assert.match(tildeBigCat.reason, /--head-lines 150/);

  const relCrossRun = invokeHook({
    conversationId: "conv-other-caller-2",
    cwd: os.tmpdir(),
    toolCall: { name: "run_command", args: { CommandLine: `rtk read ${convMulti}/.system_generated/tasks/task-run-m.log`, WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(relCrossRun.decision, "deny");
  assert.match(relCrossRun.reason, /actively RUNNING/);

  // PR9-RUN-008: Leading ./ and brain-cwd relative cross-session paths
  for (const [callerId, hookCwd] of [
    ["conv-other-caller-3", os.tmpdir()],
    ["conv-other-caller-4", tempBrainDir]
  ]) {
    const dotSlashCrossRun = invokeHook({
      conversationId: callerId,
      cwd: hookCwd,
      toolCall: { name: "run_command", args: { CommandLine: `rtk read ./${convMulti}/.system_generated/tasks/task-run-m.log`, WaitMsBeforeAsync: 5000 } }
    });
    assert.equal(dotSlashCrossRun.decision, "deny", `Leading ./ cross-session RUNNING log must deny from cwd=${hookCwd}`);
    assert.match(dotSlashCrossRun.reason, /actively RUNNING/);

    const dotSlashSpillBig = invokeHook({
      conversationId: convLive,
      cwd: hookCwd,
      toolCall: { name: "run_command", args: { CommandLine: `cat ./${convLive}/.system_generated/steps/103/output.txt`, WaitMsBeforeAsync: 5000 } }
    });
    assert.equal(dotSlashSpillBig.decision, "deny", `Leading ./ >45 KiB spillover must deny from cwd=${hookCwd}`);
    assert.match(dotSlashSpillBig.reason, /--head-lines 150/);
  }

  // Non-task-prefixed filename (tasks/custom.log)
  const customConv = "conv-test-custom";
  const customDir = path.join(tempBrainDir, customConv, ".system_generated");
  fs.mkdirSync(path.join(customDir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(customDir, "tasks", "custom.log"), "active custom log\n", "utf-8");
  const customRunOut = invokeHook({
    conversationId: customConv,
    toolCall: { name: "run_command", args: { CommandLine: "rtk read tasks/custom.log", WaitMsBeforeAsync: 5000 } }
  });
  assert.equal(customRunOut.decision, "deny");
  assert.match(customRunOut.reason, /actively RUNNING/);

  // Quoted paths containing spaces
  const spaceConv = "Jane Doe Conv";
  const spaceSysDir = path.join(tempBrainDir, spaceConv, ".system_generated");
  fs.mkdirSync(path.join(spaceSysDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(spaceSysDir, "tasks"), { recursive: true });
  const spaceLog = path.join(spaceSysDir, "tasks", "task-space-1.log").replace(/\\/g, "/");
  fs.writeFileSync(spaceLog, "q".repeat(48 * 1024), "utf-8");
  fs.writeFileSync(
    path.join(spaceSysDir, "logs", "transcript.jsonl"),
    JSON.stringify({ step_index: 1, type: "SYSTEM_MESSAGE", content: `Task id "${spaceConv}/task-space-1" finished with result:\nok` }) + "\n",
    "utf-8"
  );
  assert.equal(
    invokeHook({
      conversationId: spaceConv,
      toolCall: { name: "run_command", args: { CommandLine: `cat "${spaceLog}"`, WaitMsBeforeAsync: 5000 } }
    }).decision,
    "deny"
  );
  assert.equal(
    invokeHook({
      conversationId: spaceConv,
      toolCall: { name: "run_command", args: { CommandLine: `head -n 150 "${spaceLog}"`, WaitMsBeforeAsync: 5000 } }
    }).decision,
    "deny"
  );
  assert.equal(
    invokeHook({
      conversationId: spaceConv,
      toolCall: { name: "run_command", args: { CommandLine: `rtk read --tail-lines 150 "${spaceLog}"`, WaitMsBeforeAsync: 5000 } }
    }).decision,
    "allow"
  );
  const rfSpaceCompleted = invokeHook({
    conversationId: spaceConv,
    toolCall: { name: "read_file", args: { Path: spaceLog } }
  });
  assert.equal(rfSpaceCompleted.decision, "deny");
  assert.match(rfSpaceCompleted.reason, /--tail-lines 150/);

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

  // UX-ACS-002: Degraded mode (no RTK anywhere) allows bounded head/tail -n 150 on completed task logs
  // while keeping running task logs, unbounded cat/head, and raw transcripts denied
  {
    const degradedProfile = fs.mkdtempSync(path.join(os.tmpdir(), "agy-degraded-outgov-"));
    const emptyBinDir = path.join(degradedProfile, "empty-bin");
    fs.mkdirSync(emptyBinDir, { recursive: true });
    const degradedEnv = {
      ...process.env,
      AGY_TEST_PROFILE_DIR: degradedProfile,
      AGY_BRAIN_DIR: tempBrainDir,
      PATH: emptyBinDir
    };
    if (process.platform === "win32") degradedEnv.Path = emptyBinDir;
    const invokeDegraded = (payload) => {
      const res = spawnSync(process.execPath, [hookScript], {
        input: JSON.stringify(payload),
        encoding: "utf-8",
        env: degradedEnv
      });
      assert.equal(res.status, 0, `Degraded hook failed: ${res.stderr}`);
      return JSON.parse(res.stdout.trim());
    };
    try {
      const degradedTailDone = invokeDegraded({
        conversationId: convLive,
        toolCall: { name: "run_command", args: { CommandLine: "tail -n 150 tasks/task-legacy-99.log", WaitMsBeforeAsync: 5000 } }
      });
      assert.equal(degradedTailDone.decision, "allow", "Degraded mode must allow bounded tail -n 150 on completed task log");

      const degradedHeadDone = invokeDegraded({
        conversationId: convLive,
        toolCall: { name: "run_command", args: { CommandLine: "head -n 100 tasks/task-legacy-99.log", WaitMsBeforeAsync: 5000 } }
      });
      assert.equal(degradedHeadDone.decision, "allow", "Degraded mode must allow bounded head -n 100 on completed task log");

      const degradedCatDone = invokeDegraded({
        conversationId: convLive,
        toolCall: { name: "run_command", args: { CommandLine: "cat tasks/task-legacy-99.log", WaitMsBeforeAsync: 5000 } }
      });
      assert.equal(degradedCatDone.decision, "deny", "Degraded mode must deny unbounded cat on completed task log");
      assert.equal(degradedCatDone.reason.includes("rtk read"), false, "Degraded denial must not recommend missing rtk read");
      assert.match(degradedCatDone.reason, /head -n 150|tail -n 150/);

      const degradedOversizedHead = invokeDegraded({
        conversationId: convLive,
        toolCall: { name: "run_command", args: { CommandLine: "head -n 200 tasks/task-legacy-99.log", WaitMsBeforeAsync: 5000 } }
      });
      assert.equal(degradedOversizedHead.decision, "deny", "Degraded mode must deny head -n >150 on completed task log");

      const degradedPlusTail = invokeDegraded({
        conversationId: convLive,
        toolCall: { name: "run_command", args: { CommandLine: "tail -n +1 tasks/task-legacy-99.log", WaitMsBeforeAsync: 5000 } }
      });
      assert.equal(degradedPlusTail.decision, "deny", "Degraded mode must deny tail -n +1 on completed task log");

      const degradedRunningTask = invokeDegraded({
        conversationId: customConv,
        toolCall: { name: "run_command", args: { CommandLine: "tail -n 150 tasks/custom.log", WaitMsBeforeAsync: 5000 } }
      });
      assert.equal(degradedRunningTask.decision, "deny", "Degraded mode must still deny actively RUNNING task logs");
      assert.match(degradedRunningTask.reason, /actively RUNNING/);

      const degradedRfDone = invokeDegraded({
        conversationId: convLive,
        toolCall: { name: "read_file", args: { Path: legacyLog } }
      });
      assert.equal(degradedRfDone.decision, "deny");
      assert.equal(degradedRfDone.reason.includes("rtk read"), false, "Degraded read_file denial must not recommend rtk read");
      assert.match(degradedRfDone.reason, /tail -n 150/);
      assert.match(degradedRfDone.reason, /bounded slice.*read_file/i, "Degraded unbounded read_file denial must recommend bounded read_file (UX-ACS-R2-002)");

      // UX-ACS-R2-002: Degraded mode allows bounded read_file (<= 150 lines) on COMPLETED task logs (Windows ARM64 safe harbor)
      // while strictly denying oversized slices (> 150 lines), RUNNING logs, and UNKNOWN logs
      const degradedRfBoundedDone = invokeDegraded({
        conversationId: convLive,
        toolCall: { name: "read_file", args: { Path: legacyLog, StartLine: 1, EndLine: 150 } }
      });
      assert.equal(
        degradedRfBoundedDone.decision,
        "allow",
        "Degraded mode must allow bounded read_file (<= 150 lines) on completed task log (UX-ACS-R2-002)"
      );

      const degradedRfOversizedDone = invokeDegraded({
        conversationId: convLive,
        toolCall: { name: "read_file", args: { Path: legacyLog, StartLine: 1, EndLine: 200 } }
      });
      assert.equal(
        degradedRfOversizedDone.decision,
        "deny",
        "Degraded mode must deny read_file slices > 150 lines on completed task log (UX-ACS-R2-002)"
      );

      const degradedRfRunning = invokeDegraded({
        conversationId: customConv,
        toolCall: { name: "read_file", args: { Path: path.join(customDir, "tasks", "custom.log"), StartLine: 1, EndLine: 150 } }
      });
      assert.equal(
        degradedRfRunning.decision,
        "deny",
        "Degraded mode must strictly deny bounded read_file on RUNNING task logs (UX-ACS-R2-002)"
      );
      assert.match(degradedRfRunning.reason, /actively RUNNING/);

      const degradedRfUnknown = invokeDegraded({
        conversationId: convLive,
        toolCall: { name: "read_file", args: { Path: path.join(convDir, "tasks", "task-missing-unknown.log"), StartLine: 1, EndLine: 150 } }
      });
      assert.equal(
        degradedRfUnknown.decision,
        "deny",
        "Degraded mode must strictly deny bounded read_file on UNKNOWN task logs (UX-ACS-R2-002)"
      );

      const degradedTranscript = invokeDegraded({
        conversationId: convLive,
        toolCall: { name: "run_command", args: { CommandLine: `head -n 150 "${path.join(convDir, "logs", "transcript.jsonl")}"`, WaitMsBeforeAsync: 5000 } }
      });
      assert.equal(degradedTranscript.decision, "allow", "Native bounded transcript reads are allowed again");
    } finally {
      fs.rmSync(degradedProfile, { recursive: true, force: true });
    }
  }

  // RUN-002: Ordinary workspace `tasks/*.log` files must NOT be falsely jailed as Antigravity internal task logs
  {
    const wsTasksDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ws-tasks-"));
    try {
      const nestedLog = path.join(wsTasksDir, "logs", "tasks", "worker.log");
      const topTaskLog = path.join(wsTasksDir, "tasks", "deploy.log");
      fs.mkdirSync(path.dirname(nestedLog), { recursive: true });
      fs.mkdirSync(path.dirname(topTaskLog), { recursive: true });
      fs.writeFileSync(nestedLog, "INFO boot\nERROR timeout\n", "utf-8");
      fs.writeFileSync(topTaskLog, "deploy step 1\ndeploy ok\n", "utf-8");

      const rfNestedAbs = invokeHook({
        conversationId: convLive,
        cwd: wsTasksDir,
        toolCall: { name: "read_file", args: { Path: nestedLog, StartLine: 1, EndLine: 50 } }
      });
      assert.equal(rfNestedAbs.decision, "allow", `Workspace abs logs/tasks/worker.log must be allowed (${rfNestedAbs.reason || ""})`);

      const rfNestedRel = invokeHook({
        conversationId: convLive,
        cwd: wsTasksDir,
        toolCall: { name: "read_file", args: { Path: "logs/tasks/worker.log", StartLine: 1, EndLine: 50 } }
      });
      assert.equal(rfNestedRel.decision, "allow", `Workspace rel logs/tasks/worker.log must be allowed (${rfNestedRel.reason || ""})`);

      const rfTopAbs = invokeHook({
        conversationId: convLive,
        cwd: wsTasksDir,
        toolCall: { name: "read_file", args: { Path: topTaskLog, StartLine: 1, EndLine: 50 } }
      });
      assert.equal(rfTopAbs.decision, "allow", `Freshly written workspace abs tasks/deploy.log must be allowed (${rfTopAbs.reason || ""})`);

      const rfTopRel = invokeHook({
        conversationId: convLive,
        cwd: wsTasksDir,
        toolCall: { name: "read_file", args: { Path: "tasks/deploy.log", StartLine: 1, EndLine: 50 } }
      });
      assert.equal(rfTopRel.decision, "allow", `Existing workspace rel tasks/deploy.log must be allowed (${rfTopRel.reason || ""})`);

      const pipeNestedAbs = invokeHook({
        conversationId: convLive,
        cwd: wsTasksDir,
        toolCall: { name: "run_command", args: { CommandLine: `cat "${nestedLog.replace(/\\/g, "/")}" | grep ERROR`, WaitMsBeforeAsync: 5000 } }
      });
      assert.equal(pipeNestedAbs.decision, "allow", `Piped cat on workspace logs/tasks/worker.log must be allowed (${pipeNestedAbs.reason || ""})`);

      const pipeNestedRel = invokeHook({
        conversationId: convLive,
        cwd: wsTasksDir,
        toolCall: { name: "run_command", args: { CommandLine: "cat logs/tasks/worker.log | grep ERROR", WaitMsBeforeAsync: 5000 } }
      });
      assert.equal(pipeNestedRel.decision, "allow", `Piped cat on relative logs/tasks/worker.log must be allowed (${pipeNestedRel.reason || ""})`);

      // Meanwhile real internal `.system_generated/tasks/` and brain-relative `tasks/task-live-1.log` stay gated
      const stillGatedBrain = invokeHook({
        conversationId: convLive,
        cwd: wsTasksDir,
        toolCall: { name: "run_command", args: { CommandLine: "cat tasks/task-live-1.log | grep ok", WaitMsBeforeAsync: 5000 } }
      });
      assert.equal(stillGatedBrain.decision, "deny", "Piped cat on real brain-relative tasks/task-live-1.log must stay denied");

      // Workspace symlinks pointing into `.system_generated/tasks/` MUST remain gated (no symlink bypass)
      if (process.platform !== "win32") {
        const realBrainTasksDir = path.join(tempBrainDir, convLive, ".system_generated", "tasks");
        const symlinkedTasksDir = path.join(wsTasksDir, "sym", "tasks");
        fs.mkdirSync(path.dirname(symlinkedTasksDir), { recursive: true });
        fs.symlinkSync(realBrainTasksDir, symlinkedTasksDir);

        const rfSymlinkDir = invokeHook({
          conversationId: convLive,
          cwd: wsTasksDir,
          toolCall: { name: "read_file", args: { Path: "sym/tasks/task-live-1.log", StartLine: 1, EndLine: 50 } }
        });
        assert.equal(rfSymlinkDir.decision, "deny", "Symlinked workspace dir pointing to .system_generated/tasks must be denied on read_file");

        const catSymlinkDir = invokeHook({
          conversationId: convLive,
          cwd: wsTasksDir,
          toolCall: { name: "run_command", args: { CommandLine: "cat sym/tasks/task-live-1.log | grep ok", WaitMsBeforeAsync: 5000 } }
        });
        assert.equal(catSymlinkDir.decision, "deny", "Symlinked workspace dir pointing to .system_generated/tasks must be denied on piped cat");

        const symlinkedFile = path.join(wsTasksDir, "tasks", "alias-live.log");
        fs.symlinkSync(path.join(realBrainTasksDir, "task-live-1.log"), symlinkedFile);
        const rfSymlinkFile = invokeHook({
          conversationId: convLive,
          cwd: wsTasksDir,
          toolCall: { name: "read_file", args: { Path: "tasks/alias-live.log", StartLine: 1, EndLine: 50 } }
        });
        assert.equal(rfSymlinkFile.decision, "deny", "Symlinked workspace tasks/alias-live.log -> running brain task log must be denied");
      }
    } finally {
      fs.rmSync(wsTasksDir, { recursive: true, force: true });
    }
  }
  console.log("✓ Lifecycle-gated task log backoff, completion handling, workspace tasks/*.log exemption (RUN-002), and degraded-mode bounds verified");
} finally {
  if (oldBrain) process.env.AGY_BRAIN_DIR = oldBrain;
  else delete process.env.AGY_BRAIN_DIR;
  try { fs.rmSync(tempBrainDir, { recursive: true, force: true }); } catch {}
}

hermetic.cleanup();
console.log("\n=================================================");
console.log("ALL OUTPUT GOVERNANCE & FORENSIC TESTS PASSED 100%!");
console.log("=================================================");
