/**
 * Section 3 PreToolUse Guard: `manage_task` & `schedule` proportional backoff ledger,
 * remote CI timers, conditioned watchdog auto-clamping, and 5-strike circuit breaker.
 */

import fs from "node:fs";
import path from "node:path";
import { getBrainDirs } from "../../lib/path-guards.mjs";
import {
  BACKOFF_UUID_RE,
  REMOTE_CI_BUCKET_TTL_MS,
  getRequiredBackoffSeconds,
  cleanGovernanceArg,
  normalizeTaskKeyFromId,
  extractTaskBackoffKey,
  hasValidTaskTimerCondition,
  hasValidSubagentTimerCondition,
  isTaskPollSchedule,
  isRemoteCiPollSchedule,
  extractRemoteCiBackoffKey,
  isSwarmPollSchedule,
  isSubagentPollSchedule,
  stepBackoffState
} from "../../lib/backoff.mjs";
import {
  STATE_TTL_MS,
  MAX_TASK_BACKOFF_ENTRIES,
  TASK_TAIL_BYTES,
  TASK_QUIET_MS,
  respond,
  updateSessionState,
  readTail,
  scanTaskMarkers
} from "./common.mjs";

function pruneTaskBackoff(session, convId, now = Date.now(), ctx = {}) {
  if (!session.taskBackoff || typeof session.taskBackoff !== "object" || Array.isArray(session.taskBackoff)) {
    session.taskBackoff = {};
    return;
  }
  const entries = Object.entries(session.taskBackoff);
  let convTranscript = null;
  let convTasksDir = null;
  if (convId && convId !== "global" && entries.length > 0) {
    for (const bDir of getBrainDirs({ activeTranscriptPath: ctx?.transcriptPath || "" })) {
      const sysDir = path.join(bDir, convId, ".system_generated");
      const ct = path.join(sysDir, "logs", "transcript.jsonl");
      const cd = path.join(sysDir, "tasks");
      if (fs.existsSync(ct) || fs.existsSync(cd)) {
        if (fs.existsSync(ct)) convTranscript = ct;
        convTasksDir = cd;
        break;
      }
    }
  }

  const tail = convTranscript ? readTail(convTranscript, TASK_TAIL_BYTES) : null;
  let fullTextLoaded = false;
  let fullText = null;
  const getFullOnce = () => {
    if (!fullTextLoaded) {
      fullTextLoaded = true;
      if (convTranscript && tail && !tail.whole) { try { fullText = fs.readFileSync(convTranscript, "utf-8"); } catch {} }
    }
    return fullText;
  };

  const kept = [];
  for (const [key, entry] of entries) {
    if (!entry || typeof entry !== "object") continue;
    const activityTs = Math.max(entry.lastPollTime || 0, entry.lastSeenTime || 0);
    const isRemoteCi = key === "remote-ci" || key.startsWith("remote-ci:");
    if (activityTs > 0 && (now - activityTs) >= (isRemoteCi ? REMOTE_CI_BUCKET_TTL_MS : STATE_TTL_MS)) continue;

    if (convId && convId !== "global" && !isRemoteCi && !BACKOFF_UUID_RE.test(key)) {
      try {
        const stripped = key.replace(/^task-/i, "");
        const taskName = /^task-/i.test(key) ? key : `task-${stripped}`;
        let state = tail ? scanTaskMarkers(tail.text, taskName) : null;
        if (!state && tail && !tail.whole) {
          const full = getFullOnce();
          if (full) state = scanTaskMarkers(full, taskName);
        }
        if (!state && convTasksDir) {
          for (const p of [path.join(convTasksDir, `${taskName}.log`), path.join(convTasksDir, `${key}.log`), path.join(convTasksDir, `${stripped}.log`)]) {
            try { state = (now - fs.statSync(p).mtimeMs) > TASK_QUIET_MS ? "COMPLETED" : "RUNNING"; break; } catch {}
          }
        }
        if (state === "COMPLETED") continue;
      } catch {}
    }
    kept.push([key, entry]);
  }

  kept.sort((a, b) => Math.max(b[1].lastPollTime || 0, b[1].lastSeenTime || 0) - Math.max(a[1].lastPollTime || 0, a[1].lastSeenTime || 0));
  session.taskBackoff = Object.fromEntries(kept.slice(0, MAX_TASK_BACKOFF_ENTRIES));
}

function getOrCreateTaskBucket(session, key, now = Date.now()) {
  if (!session.taskBackoff || typeof session.taskBackoff !== "object" || Array.isArray(session.taskBackoff)) session.taskBackoff = {};
  if (!session.taskBackoff[key] || typeof session.taskBackoff[key] !== "object") {
    session.taskBackoff[key] = { pollCount: 0, lastPollTime: 0, denials: 0, lastSeenTime: now };
  }
  return session.taskBackoff[key];
}

function recordDenialOrBreaker(session, bucket, now, breakerReason, denyReason) {
  if (bucket) { bucket.denials = (bucket.denials || 0) + 1; bucket.lastSeenTime = now; }
  session.denials = (session.denials || 0) + 1;
  const n = bucket ? Math.max(bucket.denials, session.denials) : session.denials;
  return n >= 5 ? { decision: "force_ask", reason: breakerReason(n) } : { decision: "deny", reason: denyReason(n) };
}

function runScheduleBackoff(convId, ctx, { kind, key, duration, hasValidCond, breakerReason, denyReason }) {
  const { result } = updateSessionState(convId, (session, now) => {
    pruneTaskBackoff(session, convId, now, ctx);
    const bucket = key ? getOrCreateTaskBucket(session, key, now) : null;
    const stateRef = bucket || session;
    const prevLevel = stateRef.pollCount || 0;
    const step = stepBackoffState(kind, stateRef, { durationSec: duration, hasValidCond, nowMs: now, hasValidTs: true });
    if (!step.allowed) {
      return { updatePollTime: false, result: recordDenialOrBreaker(session, bucket, now, (n) => breakerReason(n, step, prevLevel), (n) => denyReason(n, step, prevLevel)) };
    }
    if (bucket) { bucket.lastSeenTime = now; bucket.denials = 0; }
    session.denials = 0;
    return { updatePollTime: true, result: step.clamped ? { decision: "allow", overwrite: { DurationSeconds: step.effectiveDuration } } : { decision: "allow" } };
  });
  respond(result);
}

export function denyRunningTask(taskId, convId, taskToken = "", ctx = {}) {
  const { result } = updateSessionState(convId, (session, now) => {
    pruneTaskBackoff(session, convId, now, ctx);
    const taskKey = normalizeTaskKeyFromId(taskId, taskToken);
    const bucket = taskKey ? getOrCreateTaskBucket(session, taskKey, now) : null;
    const pollCount = bucket ? bucket.pollCount : session.pollCount;
    const lastPoll = bucket ? bucket.lastPollTime : session.lastPollTime;
    const reqSec = Math.max(30, getRequiredBackoffSeconds(pollCount));
    const elapsedMs = lastPoll ? Math.max(0, now - lastPoll) : 0;
    const elapsedSec = Math.floor(elapsedMs / 1000);
    const condTarget = taskKey || `task-${taskId}`;
    const condEx = convId && convId !== "global" ? `${convId}/${condTarget}` : condTarget;
    const timing = pollCount === 0 && lastPoll === 0
      ? `Use manage_task(Action='status', TaskId='${condEx}') for Check #1 (immediate, 0s) or Pure Yield`
      : elapsedMs >= reqSec * 1000
        ? `${elapsedSec}s elapsed — backoff window is satisfied for manage_task(Action='status'), but reading raw task logs while RUNNING remains prohibited`
        : `Diagnostic check #${pollCount + 1} requires at least ${reqSec}s elapsed (${elapsedSec}s elapsed, ${Math.max(1, Math.ceil((reqSec * 1000 - elapsedMs) / 1000))}s remaining)`;

    return {
      updatePollTime: false,
      result: recordDenialOrBreaker(
        session, bucket, now,
        (n) => `[CIRCUIT BREAKER ACTIVATED] Autonomous loop suspended: reading task log '${taskId}' attempted prematurely ${n} times during active backoff window. User confirmation required to proceed.`,
        () => `Antigravity Execution Governance: Task '${taskId}' is actively RUNNING. Reading task logs in .system_generated during execution is strictly prohibited to prevent polling loops. ${timing}. Use Pure Yield (end turn; no 'schedule'/status card; await <SYSTEM_MESSAGE> on completion; manage_task(Action='kill') is always allowed at 0s if hung).`
      )
    };
  });
  respond(result);
}

export function handleTaskOrSchedule(ctx) {
  const { toolName, args, convId } = ctx;

  if (toolName === "manage_task") {
    const action = cleanGovernanceArg(args.Action || args.action).toLowerCase();
    if (action !== "status") respond({ decision: "allow" });
    const { result } = updateSessionState(convId, (session, now) => {
      pruneTaskBackoff(session, convId, now, ctx);
      const taskId = cleanGovernanceArg(args.TaskId || args.taskId);
      if (taskId && !session.taskIds.includes(taskId)) session.taskIds.push(taskId);
      const taskKey = extractTaskBackoffKey("manage_task", args);
      const bucket = taskKey ? getOrCreateTaskBucket(session, taskKey, now) : null;
      const stateRef = bucket || session;
      const prevLevel = stateRef.pollCount || 0;
      const step = stepBackoffState("manage_task", stateRef, { nowMs: now, hasValidTs: true });
      if (!step.allowed) {
        const elapsedSec = Math.floor(step.elapsedMs / 1000);
        const remSec = Math.max(1, Math.ceil((Math.max(step.requiredSec, step.displayRequiredSec) * 1000 - step.elapsedMs) / 1000));
        return {
          updatePollTime: false,
          result: recordDenialOrBreaker(
            session, bucket, now,
            (n) => `[CIRCUIT BREAKER ACTIVATED] Autonomous loop suspended: manage_task('${action}') called prematurely ${n} times during active backoff window across tasks [${session.taskIds.join(", ")}]. User confirmation required to proceed.`,
            (n) => `Antigravity Execution Governance: Proportional Backoff Active (Level ${prevLevel}${taskKey ? ` for '${taskKey}'` : ""}, ${n} denial${n > 1 ? "s" : ""}). Diagnostic check #${prevLevel + 1} requires at least ${step.displayRequiredSec}s elapsed since previous check (${elapsedSec}s elapsed, ${remSec}s remaining). Use Pure Yield (end turn; no 'schedule'/status card; await <SYSTEM_MESSAGE> on completion; manage_task(Action='kill') is always allowed at 0s if hung).`
          )
        };
      }
      if (bucket) { bucket.lastSeenTime = now; bucket.denials = 0; }
      session.denials = 0;
      return { updatePollTime: true, result: { decision: "allow" } };
    });
    respond(result);
  }

  if (toolName === "schedule") {
    const duration = Number(args.DurationSeconds || args.durationSeconds || args.duration || 0);
    const rawCond = cleanGovernanceArg(args.TimerCondition || args.timerCondition);

    if (isRemoteCiPollSchedule(args)) {
      runScheduleBackoff(convId, ctx, {
        kind: "remote_ci_schedule", key: extractRemoteCiBackoffKey(args), duration, hasValidCond: true,
        breakerReason: (n, s) => `[CIRCUIT BREAKER ACTIVATED] Autonomous loop suspended: remote CI polling timer denied ${n} times. Retry 'schedule' with DurationSeconds >= ${s.requiredSec}, or confirm with the user to proceed.`,
        denyReason: (n, s) => `Antigravity Execution Governance: Remote CI schedule timer duration too short (${duration}s < 15s minimum; ${n} denial${n > 1 ? "s" : ""}). Retry 'schedule' with DurationSeconds >= ${s.requiredSec} (no local task-X TimerCondition is required for remote CI checks).`
      });
    }

    if (isSwarmPollSchedule(args)) {
      const { result } = updateSessionState(convId, (session, now) => ({
        updatePollTime: false,
        result: recordDenialOrBreaker(
          session, null, now,
          (n) => `[CIRCUIT BREAKER ACTIVATED] Autonomous loop suspended: /swarm schedule polling attempted ${n} times. Use 'swarm_wait' for '/swarm' (the dedicated 'swarm_monitor' daemon cron checks for stalls). User confirmation required to proceed.`,
          () => "Antigravity Execution Governance: Using one-shot 'schedule' timers to poll a '/swarm' board is strictly prohibited. Call 'swarm_wait' directly without a 'schedule' timer (it sleeps at zero token cost and wakes immediately when any board message arrives, while the dedicated 'swarm_monitor' daemon cron handles stall detection)."
        )
      }));
      respond(result);
    }

    if (isSubagentPollSchedule(args)) {
      const subKey = extractTaskBackoffKey("schedule", args);
      const hasValidCond = hasValidSubagentTimerCondition(args);
      const condHint = rawCond && hasValidCond ? rawCond : (subKey || "<subagentConvId>");
      runScheduleBackoff(convId, ctx, {
        kind: "subagent_schedule", key: subKey, duration, hasValidCond,
        breakerReason: (n, s) => `[CIRCUIT BREAKER ACTIVATED] Autonomous loop suspended: direct subagent schedule polling denied ${n} times. Retry 'schedule' with DurationSeconds >= ${s.requiredSec} and TimerCondition="${condHint}", or confirm with the user to proceed.`,
        denyReason: (n, s) => `Antigravity Execution Governance: ${!hasValidCond ? "Unconditioned subagent polling timers are prohibited." : `Direct subagent stall watchdog duration too short (${duration}s < 30s minimum).`} (${n} denial${n > 1 ? "s" : ""}). Prefer Pure Yield (end turn; no 'schedule' timer; subagents notify automatically on completion), or if opting into a stall watchdog retry 'schedule' with DurationSeconds >= ${s.requiredSec} and TimerCondition="${condHint}".`
      });
    }

    if (isTaskPollSchedule(args)) {
      const taskKey = extractTaskBackoffKey("schedule", args);
      const hasValidCond = hasValidTaskTimerCondition(args);
      const condHint = hasValidCond ? rawCond : (convId && convId !== "global" ? `${convId}/${taskKey || "task-X"}` : (taskKey || "task-X"));
      runScheduleBackoff(convId, ctx, {
        kind: "task_schedule", key: taskKey, duration, hasValidCond,
        breakerReason: (n, s) => `[CIRCUIT BREAKER ACTIVATED] Autonomous loop suspended: schedule polling timer denied ${n} times. Retry 'schedule' with DurationSeconds >= ${s.requiredSec} and TimerCondition="${condHint}", or confirm with the user to proceed.`,
        denyReason: (n, s, lvl) => `Antigravity Execution Governance: ${!hasValidCond ? "Unconditioned task polling timers are prohibited because they do not auto-cancel when the task finishes." : `Task watchdog timer duration too short (${duration}s < 15s minimum).`} (Level ${lvl}${taskKey ? ` for '${taskKey}'` : ""}, ${n} denial${n > 1 ? "s" : ""}). Prefer Pure Yield (end turn; no 'schedule'/status card; await <SYSTEM_MESSAGE>), or if opting into a stall watchdog retry 'schedule' with DurationSeconds >= ${s.requiredSec} and TimerCondition="${condHint}".`
      });
    }
  }

  respond({ decision: "allow" });
}
