#!/usr/bin/env node

/**
 * Agy-Context-Saver: Universal Execution Governor Hook for Antigravity
 *
 * Enforces:
 * - Layer 1: Hard Polling Ban. Intercepts manage_task(Action='status') and artificial
 *   schedule polling timers; enforces native Reactive Wakeup.
 * - Layer 2: Fast Synchronous Execution. Automatically upgrades WaitMsBeforeAsync
 *   to ensure fast commands (<10s) complete synchronously without premature backgrounding.
 *
 * Performance:
 * - Ultra-fast fail-open bailout (< 1ms) for non-governed tools without full JSON parsing.
 */

import fs from "node:fs";
import process from "node:process";

function respond(obj) {
  const json = JSON.stringify(obj);
  process.stdout.write(json + "\n");
  process.exit(0);
}

function failOpen() {
  respond({ decision: "allow" });
}

try {
  const inputRaw = fs.readFileSync(0, "utf-8");
  if (!inputRaw || !inputRaw.trim()) {
    failOpen();
  }

  // Fast-path bailout (< 1ms): avoid JSON parsing overhead if not targeting governed tools
  if (!inputRaw.includes("manage_task") && !inputRaw.includes("schedule") && !inputRaw.includes("run_command")) {
    failOpen();
  }

  const payload = JSON.parse(inputRaw);
  const toolCall = payload.toolCall || {};
  const toolName = toolCall.name || "";
  const args = toolCall.args || {};

  // Layer 1: Ban manage_task(Action='status') polling
  if (toolName === "manage_task") {
    const action = String(args.Action || args.action || "").replace(/^["']|["']$/g, "").trim().toLowerCase();
    if (action === "status") {
      respond({
        decision: "deny",
        reason: "Antigravity Execution Governance (Layer 1): Background polling with manage_task('status') is denied to protect context stability. Stop calling tools and yield the turn. Antigravity's native Reactive Wakeup (<SYSTEM_MESSAGE>) will automatically resume execution upon task completion."
      });
    }
    respond({ decision: "allow" });
  }

  // Layer 1: Ban schedule used as artificial polling timer
  if (toolName === "schedule") {
    const prompt = String(args.Prompt || args.prompt || "").replace(/^["']|["']$/g, "").trim().toLowerCase();
    const cond = String(args.TimerCondition || args.timerCondition || "").replace(/^["']|["']$/g, "").trim().toLowerCase();
    const isTaskPoll =
      cond.startsWith("task-") ||
      cond.includes("task") ||
      prompt.includes("check on") ||
      prompt.includes("background task") ||
      prompt.includes("still running") ||
      prompt.includes("test suite");

    if (isTaskPoll) {
      respond({
        decision: "deny",
        reason: "Antigravity Execution Governance (Layer 1): Using schedule as a polling timer for background tasks is denied. Yield the turn and rely on native Reactive Wakeup."
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
