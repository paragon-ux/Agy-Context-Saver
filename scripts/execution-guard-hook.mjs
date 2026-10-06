#!/usr/bin/env node

/**
 * Agy-Context-Saver: Intelligent Execution Governor Hook for Antigravity
 *
 * Enforces:
 * - Layer 1: Context Protection with Safe Harbors.
 *   - Blocks unnecessary rapid busy-wait polling loops and short (<120s) polling timers.
 *   - Safe Harbor: Allows polling when debugging potentially hung/stuck background tasks.
 *   - Safe Harbor: Allows polling for /teamwork-preview and subagent coordination workflows.
 *   - Safe Harbor: Allows watchdog timers (>= 120s) to catch processes that fail to exit.
 * - Layer 2: Fast Synchronous Execution.
 *   - Automatically upgrades WaitMsBeforeAsync on fast commands (<10s) to complete synchronously.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function respond(obj) {
  const json = JSON.stringify(obj);
  process.stdout.write(json + "\n");
  process.exit(0);
}

function failOpen() {
  respond({ decision: "allow" });
}

const STATE_FILE = path.join(os.tmpdir(), "agy-poll-state.json");

function getPollState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function savePollState(state) {
  try {
    const keys = Object.keys(state);
    if (keys.length > 100) {
      for (const k of keys.slice(0, keys.length - 100)) {
        delete state[k];
      }
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), "utf-8");
  } catch {}
}

function isTeamworkOrSubagentContext(inputRaw, payload, args) {
  const text = (inputRaw + " " + JSON.stringify(args) + " " + (payload.conversationId || "")).toLowerCase();
  return (
    text.includes("teamwork") ||
    text.includes("subagent") ||
    text.includes("teamwork_preview") ||
    payload.toolCall?.name === "manage_subagents" ||
    payload.toolCall?.name === "invoke_subagent"
  );
}

function isDebuggingOrStuckContext(inputRaw, args) {
  if (process.env.AGY_ALLOW_POLL === "1" || process.env.DEBUG === "1") {
    return true;
  }
  const text = (inputRaw + " " + JSON.stringify(args)).toLowerCase();
  const debugKeywords = [
    "debug",
    "stuck",
    "hung",
    "deadlock",
    "diagnos",
    "troubleshoot",
    "timeout",
    "not exiting",
    "unresponsive",
    "frozen",
    "investigate"
  ];
  return debugKeywords.some((kw) => text.includes(kw));
}

try {
  const inputRaw = fs.readFileSync(0, "utf-8");
  if (!inputRaw || !inputRaw.trim()) {
    failOpen();
  }

  // Fast-path bailout (< 1ms): skip JSON parsing if no governed tools are present
  if (!inputRaw.includes("manage_task") && !inputRaw.includes("schedule") && !inputRaw.includes("run_command")) {
    failOpen();
  }

  const payload = JSON.parse(inputRaw);
  const toolCall = payload.toolCall || {};
  const toolName = toolCall.name || "";
  const args = toolCall.args || {};

  // Layer 1: Intelligent Governor for manage_task
  if (toolName === "manage_task") {
    const action = String(args.Action || args.action || "").replace(/^["']|["']$/g, "").trim().toLowerCase();

    // Only 'status' represents polling. kill, list, send_input are always allowed.
    if (action !== "status") {
      respond({ decision: "allow" });
    }

    // Safe Harbor 1: Teamwork / Subagent workflows are never blocked
    if (isTeamworkOrSubagentContext(inputRaw, payload, args)) {
      respond({ decision: "allow" });
    }

    // Safe Harbor 2: Explicit debugging or diagnosing stuck/hung tasks is never blocked
    if (isDebuggingOrStuckContext(inputRaw, args)) {
      respond({ decision: "allow" });
    }

    // Safe Harbor 3: State-aware rate limiter
    const taskId = String(args.TaskId || args.taskId || "default").trim();
    const convId = payload.conversationId || "global";
    const stateKey = `${convId}:${taskId}`;
    const now = Date.now();
    const state = getPollState();
    const entry = state[stateKey] || { count: 0, lastTime: 0, stepIdx: 0 };
    const timeSinceLast = (now - entry.lastTime) / 1000;
    const currentStep = payload.stepIdx || 0;

    // Allow the first status check on any task (e.g. diagnosing why it hasn't exited)
    if (entry.count === 0) {
      state[stateKey] = { count: 1, lastTime: now, stepIdx: currentStep };
      savePollState(state);
      respond({ decision: "allow" });
    }

    // Allow periodic checks if at least 30 seconds have elapsed
    if (timeSinceLast >= 30) {
      state[stateKey] = { count: 1, lastTime: now, stepIdx: currentStep };
      savePollState(state);
      respond({ decision: "allow" });
    }

    // Allow if non-consecutive (more than 2 intervening steps have occurred)
    if (currentStep > 0 && entry.stepIdx > 0 && (currentStep - entry.stepIdx) > 2) {
      state[stateKey] = { count: 1, lastTime: now, stepIdx: currentStep };
      savePollState(state);
      respond({ decision: "allow" });
    }

    // Rapid consecutive busy-polling (<30s and consecutive steps) without debug context -> DENY
    entry.count++;
    state[stateKey] = { count: entry.count, lastTime: now, stepIdx: currentStep };
    savePollState(state);

    respond({
      decision: "deny",
      reason: `Antigravity Execution Governance (Layer 1): Rapid task polling detected for '${taskId}' (${Math.round(timeSinceLast)}s since last check). Status was already retrieved recently. If the task is running normally, stop calling tools and yield the turn for native Reactive Wakeup (<SYSTEM_MESSAGE>). If the task is hung, deadlocked, or not exiting properly, add a debug reason or terminate it with manage_task(Action='kill').`
    });
  }

  // Layer 1: Intelligent Governor for schedule
  if (toolName === "schedule") {
    const prompt = String(args.Prompt || args.prompt || "").replace(/^["']|["']$/g, "").trim().toLowerCase();
    const cond = String(args.TimerCondition || args.timerCondition || "").replace(/^["']|["']$/g, "").trim().toLowerCase();
    const duration = Number(args.DurationSeconds || args.durationSeconds || 0);

    // Safe Harbor 1: Teamwork / Subagent workflows are never blocked
    if (isTeamworkOrSubagentContext(inputRaw, payload, args)) {
      respond({ decision: "allow" });
    }

    // Safe Harbor 2: Explicit debugging or stuck task monitoring is never blocked
    if (isDebuggingOrStuckContext(inputRaw, args)) {
      respond({ decision: "allow" });
    }

    const isTaskPoll =
      cond.startsWith("task-") ||
      cond.includes("task") ||
      prompt.includes("check on") ||
      prompt.includes("background task") ||
      prompt.includes("still running") ||
      prompt.includes("test suite");

    // Watchdog timers (>= 120s) to catch processes that might not exit: ALLOWED
    if (isTaskPoll && duration >= 120) {
      respond({ decision: "allow" });
    }

    // Short artificial polling timers (< 120s, e.g. 15s, 30s) without debug context: DENIED
    if (isTaskPoll && duration < 120) {
      respond({
        decision: "deny",
        reason: "Antigravity Execution Governance (Layer 1): Short artificial polling timers (<120s) for background tasks are denied to prevent context bloat. Stop calling tools and yield the turn for native Reactive Wakeup. For watchdog monitoring of potentially hung tasks, use a duration of >= 120s or include a debug reason."
      });
    }

    respond({ decision: "allow" });
  }

  // Layer 2: Maximize WaitMsBeforeAsync on non-daemon run_command
  if (toolName === "run_command") {
    const isDaemon = args.IsDaemon === true || args.isDaemon === true;
    const waitMs = args.WaitMsBeforeAsync !== undefined ? args.WaitMsBeforeAsync : args.waitMsBeforeAsync;
    const targetMaxWait = Number(process.env.AGY_MAX_WAIT_MS) || 10000;

    if (!isDaemon && (waitMs === undefined || waitMs < targetMaxWait)) {
      respond({
        decision: "allow",
        overwrite: {
          WaitMsBeforeAsync: targetMaxWait
        }
      });
    }
    respond({ decision: "allow" });
  }

  failOpen();
} catch (err) {
  failOpen();
}
