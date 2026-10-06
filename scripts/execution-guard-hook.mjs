#!/usr/bin/env node

/**
 * Agy-Context-Saver: Intelligent Execution Governor Hook for Antigravity
 *
 * Enforces:
 * - Layer 1: Context Protection with Safe Harbors & 3-Tier Circuit Breaker.
 *   - Blocks unnecessary rapid busy-wait polling loops and short (<120s) polling timers.
 *   - Tier 1 (1-2 denials): Informative guidance to yield turn for native Reactive Wakeup.
 *   - Tier 2 (3-4 denials): Escalated critical warning alerting agent of transcript degradation.
 *   - Tier 3 (5+ denials): Automatic escalation to 'force_ask' to freeze autonomous runaway execution.
 *   - Safe Harbor: Allows polling when debugging potentially hung/stuck background tasks.
 *   - Safe Harbor: Allows polling for /teamwork-preview and subagent coordination workflows.
 *   - Safe Harbor: Allows watchdog timers (>= 120s) to catch processes that fail to exit.
 * - Layer 2: Fast Synchronous Execution.
 *   - Automatically upgrades WaitMsBeforeAsync on fast commands (<10s) to complete synchronously.
 *
 * Performance Optimizations:
 * - O(1) Fast-path string scan before JSON.parse (<1ms overhead)
 * - TTL-based state eviction (1-hour window) and max entry capping (50 items)
 * - Atomic write operations using tempfile + rename to prevent corruption under concurrency
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
const STATE_TTL_MS = 3600000; // 1 hour TTL
const MAX_STATE_ENTRIES = 50; // Hard cap on tracked task/conversation keys

function getPollState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      const now = Date.now();
      const filtered = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (v && typeof v.lastTime === "number" && (now - v.lastTime) < STATE_TTL_MS) {
          filtered[k] = v;
        }
      }
      return filtered;
    }
  } catch {}
  return {};
}

function savePollState(state) {
  try {
    const now = Date.now();
    // Evict expired entries and sort by most recent
    const entries = Object.entries(state)
      .filter(([_, v]) => v && typeof v.lastTime === "number" && (now - v.lastTime) < STATE_TTL_MS)
      .sort((a, b) => (b[1].lastTime || 0) - (a[1].lastTime || 0));

    const prunedState = {};
    for (const [k, v] of entries.slice(0, MAX_STATE_ENTRIES)) {
      prunedState[k] = v;
    }

    const json = JSON.stringify(prunedState);
    const tmpFile = `${STATE_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmpFile, json, "utf-8");
    try {
      fs.renameSync(tmpFile, STATE_FILE);
    } catch {
      // Fallback if atomic rename is blocked on the OS
      fs.writeFileSync(STATE_FILE, json, "utf-8");
      try { fs.unlinkSync(tmpFile); } catch {}
    }
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
  if (
    !inputRaw.includes("manage_task") &&
    !inputRaw.includes("schedule") &&
    !inputRaw.includes("run_command") &&
    !inputRaw.includes("view_file")
  ) {
    failOpen();
  }

  const payload = JSON.parse(inputRaw);
  const toolCall = payload.toolCall || payload.tool_call || {};
  const toolName = String(toolCall.name || toolCall.tool_name || "").trim().toLowerCase();
  const args = toolCall.args || toolCall.arguments || {};

  // Layer 1: Transcript Read Enforcement for view_file
  if (toolName === "view_file") {
    const rawPath = String(args.AbsolutePath || args.absolutePath || args.targetFile || args.path || "").trim();
    const normalizedPath = rawPath.replace(/\\/g, "/");
    const transcriptRegex = /\/brain\/([^/]+)\/\.system_generated\/logs\/transcript(?:_full)?\.jsonl$/i;
    const match = normalizedPath.match(transcriptRegex);

    if (match || /\/\.system_generated\/logs\/transcript(?:_full)?\.jsonl$/i.test(normalizedPath)) {
      const convId = match ? match[1] : "current";
      respond({
        decision: "deny",
        reason: `Antigravity Execution Governance: Reading raw transcript JSONL files directly via view_file is blocked to prevent severe context bloat and token degradation. Please call the MCP tool read_transcript(conversationId="${convId}", mode="compact") or query_transcript(...) instead.`
      });
    }
    respond({ decision: "allow" });
  }

  // Layer 1: Intelligent Governor for manage_task
  if (toolName === "manage_task") {
    const action = String(args.Action || args.action || "").replace(/^["']|["']$/g, "").trim().toLowerCase();

    // kill, send_input are always allowed immediately
    if (action !== "status" && action !== "list") {
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

    // Evasive Loophole Protection: manage_task(Action='list')
    if (action === "list") {
      const convId = payload.conversationId || "global";
      const listKey = `${convId}:manage_task_list`;
      const now = Date.now();
      const state = getPollState();
      const listEntry = state[listKey] || { count: 0, denials: 0, lastTime: 0, stepIdx: 0 };
      const timeSinceLast = (now - listEntry.lastTime) / 1000;
      const currentStep = payload.stepIdx || 0;

      // Allow initial list, spaced calls (>=15s), non-consecutive calls, or clock reset
      if (listEntry.count === 0 || timeSinceLast < 0 || timeSinceLast >= 15 || (currentStep > 0 && listEntry.stepIdx > 0 && (currentStep - listEntry.stepIdx) > 2)) {
        state[listKey] = { count: 1, denials: 0, lastTime: now, stepIdx: currentStep };
        savePollState(state);
        respond({ decision: "allow" });
      }

      const denialCount = (listEntry.denials || 0) + 1;
      listEntry.count++;
      listEntry.denials = denialCount;
      state[listKey] = { count: listEntry.count, denials: denialCount, lastTime: now, stepIdx: currentStep };
      savePollState(state);

      if (denialCount >= 5) {
        respond({
          decision: "force_ask",
          reason: `[CIRCUIT BREAKER ACTIVATED] Autonomous loop suspended: manage_task(Action='list') has been denied ${denialCount} consecutive times. Halting autonomous execution to prevent transcript corruption. User confirmation required to proceed.`
        });
      }

      respond({
        decision: "deny",
        reason: `Antigravity Execution Governance: Rapid task list polling detected (${Math.round(timeSinceLast)}s since last check). Task list was already retrieved recently. Stop calling tools and yield the turn for native Reactive Wakeup.`
      });
    }

    // Safe Harbor 3: State-aware rate limiter for manage_task(Action='status')
    const taskId = String(args.TaskId || args.taskId || "default").trim();
    const convId = payload.conversationId || "global";
    const stateKey = `${convId}:${taskId}`;
    const now = Date.now();
    const state = getPollState();
    const entry = state[stateKey] || { count: 0, denials: 0, lastTime: 0, stepIdx: 0 };
    const timeSinceLast = (now - entry.lastTime) / 1000;
    const currentStep = payload.stepIdx || 0;

    // Allow the first status check on any task (e.g. diagnosing why it hasn't exited)
    if (entry.count === 0) {
      state[stateKey] = { count: 1, denials: 0, lastTime: now, stepIdx: currentStep };
      savePollState(state);
      respond({ decision: "allow" });
    }

    // Allow periodic checks if at least 30 seconds have elapsed or on clock reset
    if (timeSinceLast < 0 || timeSinceLast >= 30) {
      state[stateKey] = { count: 1, denials: 0, lastTime: now, stepIdx: currentStep };
      savePollState(state);
      respond({ decision: "allow" });
    }

    // Allow if non-consecutive (more than 2 intervening steps have occurred)
    if (currentStep > 0 && entry.stepIdx > 0 && (currentStep - entry.stepIdx) > 2) {
      state[stateKey] = { count: 1, denials: 0, lastTime: now, stepIdx: currentStep };
      savePollState(state);
      respond({ decision: "allow" });
    }

    // Rapid consecutive busy-polling (<30s and consecutive steps) without debug context
    const denialCount = (entry.denials || 0) + 1;
    entry.count++;
    entry.denials = denialCount;
    state[stateKey] = { count: entry.count, denials: denialCount, lastTime: now, stepIdx: currentStep };
    savePollState(state);

    // Tier 3 Circuit Breaker: 5 or more consecutive denials -> force_ask to freeze autonomous loop
    if (denialCount >= 5) {
      respond({
        decision: "force_ask",
        reason: `[CIRCUIT BREAKER ACTIVATED] Autonomous loop suspended: Tool call '${toolName}' for '${taskId}' has been denied ${denialCount} consecutive times. Halting autonomous execution to prevent transcript corruption. User confirmation required to proceed.`
      });
    }

    // Tier 2 Circuit Breaker: 3-4 consecutive denials -> escalated critical warning
    if (denialCount >= 3) {
      respond({
        decision: "deny",
        reason: `[CRITICAL CIRCUIT BREAKER: Repeated Denials (Attempt ${denialCount})] Rapid task polling for '${taskId}' is strictly blocked (${Math.round(timeSinceLast)}s since last check). Stop calling tools and yield the turn immediately for native Reactive Wakeup (<SYSTEM_MESSAGE>). If the task is unresponsive, add an explicit debug reason or terminate it with manage_task(Action='kill'). Repeated attempts will trigger autonomous freeze.`
      });
    }

    // Tier 1 Circuit Breaker: 1-2 denials -> standard guidance
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
      prompt.includes("check task") ||
      (prompt.includes("check") && prompt.includes("task")) ||
      prompt.includes("background task") ||
      prompt.includes("still running") ||
      prompt.includes("test suite");

    // Watchdog timers (>= 120s) to catch processes that might not exit: ALLOWED
    if (isTaskPoll && duration >= 120) {
      respond({ decision: "allow" });
    }

    // Short artificial polling timers (< 120s, e.g. 15s, 30s) without debug context: DENIED with circuit breaker
    if (isTaskPoll && duration < 120) {
      const scheduleKey = `${payload.conversationId || "global"}:schedule_poll`;
      const schedState = getPollState();
      const schedEntry = schedState[scheduleKey] || { denials: 0 };
      const schedDenials = (schedEntry.denials || 0) + 1;
      schedState[scheduleKey] = { denials: schedDenials, lastTime: Date.now() };
      savePollState(schedState);

      // Tier 3: 5 or more consecutive denials -> force_ask
      if (schedDenials >= 5) {
        respond({
          decision: "force_ask",
          reason: `[CIRCUIT BREAKER ACTIVATED] Autonomous loop suspended: schedule short polling timer has been denied ${schedDenials} consecutive times. Halting autonomous execution to prevent transcript corruption. User confirmation required to proceed.`
        });
      }

      // Tier 2: 3-4 consecutive denials -> critical warning
      if (schedDenials >= 3) {
        respond({
          decision: "deny",
          reason: `[CRITICAL CIRCUIT BREAKER: Repeated Denials (Attempt ${schedDenials})] Short artificial polling timers (<120s) for background tasks are strictly blocked. Stop calling tools and yield the turn immediately for native Reactive Wakeup. For watchdog monitoring of hung tasks, use a duration of >= 120s or include an explicit debug reason.`
        });
      }

      // Tier 1: 1-2 denials -> standard guidance
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
