/**
 * Pure proportional backoff, polling-schedule classification, and bucket state machine.
 * Zero filesystem dependencies — shared between `lib/transcript-core.mjs` and PreToolUse task guards.
 */

export const BACKOFF_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const REMOTE_CI_BUCKET_TTL_MS = 15 * 60 * 1000;

/**
 * Proportional backoff schedule for task diagnostic polls and watchdogs:
 * Level 0 -> 0s, Level 1 -> 30s, Level 2 -> 75s, Level 3 -> 188s, Level 4 -> 469s, Level 5+ -> 600s.
 */
export function getRequiredBackoffSeconds(pollCount) {
  if (pollCount <= 0) return 0;
  return Math.min(600, Math.round(30 * Math.pow(2.5, Math.max(0, pollCount - 1))));
}

/**
 * Proportional backoff schedule for direct `invoke_subagent` stall watchdogs:
 * Level 0 -> 180s, Level 1 -> 450s, Level 2+ -> 600s.
 */
export function getRequiredSubagentBackoffSeconds(pollCount) {
  return Math.min(600, Math.round(180 * Math.pow(2.5, Math.max(0, pollCount))));
}

export function cleanGovernanceArg(val) {
  return String(val || "").replace(/^["']|["']$/g, "").trim();
}

export function normalizeTaskKeyFromId(taskId, taskToken = "") {
  const cleanTok = cleanGovernanceArg(taskToken).replace(/\\/g, "/");
  const baseMatch = cleanTok.match(/(?:^|\/)([^/]+)\.log$/i);
  if (baseMatch && baseMatch[1]) return baseMatch[1].toLowerCase();
  const clean = cleanGovernanceArg(taskId);
  if (!clean) return null;
  const taskMatch = clean.match(/(?:^|\/)(task-[a-z0-9_-]+)$/i);
  if (taskMatch) return taskMatch[1].toLowerCase();
  const tail = clean.includes("/") ? clean.slice(clean.lastIndexOf("/") + 1).trim() : clean;
  if (!tail) return null;
  return /^task-/i.test(tail) ? tail.toLowerCase() : `task-${tail.toLowerCase()}`;
}

export function extractTaskBackoffKey(toolName, args = {}) {
  if (toolName === "manage_task") {
    const raw = cleanGovernanceArg(args.TaskId || args.taskId);
    if (!raw) return null;
    const taskMatch = raw.match(/(?:^|\/)(task-[a-z0-9_-]+)$/i);
    if (taskMatch) return taskMatch[1].toLowerCase();
    const tail = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1).trim() : raw;
    if (!tail) return null;
    return /^\d+$/.test(tail) ? `task-${tail}` : tail.toLowerCase();
  }

  if (toolName === "schedule") {
    const cond = cleanGovernanceArg(args.TimerCondition || args.timerCondition);
    const condLower = cond.toLowerCase();
    if (cond && condLower !== "any" && condLower !== "never" && !/\s/.test(cond)) {
      const taskMatch = cond.match(/(?:^|\/)(task-[a-z0-9_-]+)$/i);
      if (taskMatch) return taskMatch[1].toLowerCase();
      if (BACKOFF_UUID_RE.test(cond)) return condLower;
      const tail = cond.includes("/") ? cond.slice(cond.lastIndexOf("/") + 1).trim() : cond;
      if (tail) return /^\d+$/.test(tail) ? `task-${tail}` : tail.toLowerCase();
    }
    const prompt = cleanGovernanceArg(args.Prompt || args.prompt);
    const promptTask = prompt.match(/\b(task-[a-z0-9_-]+)\b/i);
    if (promptTask) return promptTask[1].toLowerCase();
    const promptUuid = prompt.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
    if (promptUuid) return promptUuid[1].toLowerCase();
  }

  return null;
}

export function hasValidTaskTimerCondition(args = {}) {
  const cond = cleanGovernanceArg(args.TimerCondition || args.timerCondition);
  const condLower = cond.toLowerCase();
  return Boolean(cond) && condLower !== "any" && condLower !== "never" && !/\s/.test(cond);
}

export function hasValidSubagentTimerCondition(args = {}) {
  const cond = cleanGovernanceArg(args.TimerCondition || args.timerCondition);
  const condLower = cond.toLowerCase();
  if (!cond || condLower === "any" || condLower === "never" || /\s/.test(cond)) return false;
  if (/(?:^|\/)task-[a-z0-9_-]+$/i.test(cond) || condLower.includes("task")) return false;
  return true;
}

function isDaemonCron(args) {
  const isDaemon = args.IsDaemon === true || args.isDaemon === true;
  const cron = String(args.CronExpression || args.cronExpression || "").trim();
  return isDaemon && Boolean(cron);
}

export function isTaskPollSchedule(args = {}) {
  if (isDaemonCron(args)) return false;
  const prompt = cleanGovernanceArg(args.Prompt || args.prompt).toLowerCase();
  const cond = cleanGovernanceArg(args.TimerCondition || args.timerCondition).toLowerCase();
  return (
    cond.startsWith("task-") ||
    cond.includes("task") ||
    prompt.includes("check on") ||
    prompt.includes("check task") ||
    prompt.includes("background task") ||
    prompt.includes("still running") ||
    prompt.includes("test suite") ||
    ((prompt.includes("check") || prompt.includes("status") || prompt.includes("poll") || prompt.includes("monitor") || prompt.includes("wait")) &&
      (prompt.includes("task") || prompt.includes("process") || prompt.includes("job") || prompt.includes("test") || prompt.includes("command") || prompt.includes("suite")))
  );
}

/**
 * Detects backoff-compliant remote CI `schedule` timers (GitHub Actions, CodeQL, `gh pr checks`,
 * PR builds, deployments) where no local `task-X` `TimerCondition` exists (FRIC-RUN-004).
 */
export function isRemoteCiPollSchedule(args = {}) {
  if (isDaemonCron(args)) return false;
  const prompt = cleanGovernanceArg(args.Prompt || args.prompt).toLowerCase();
  const cond = cleanGovernanceArg(args.TimerCondition || args.timerCondition).toLowerCase();
  if (/(?:^|\/)task-[a-z0-9_-]+$/i.test(cond) || cond.includes("task") || BACKOFF_UUID_RE.test(cond)) return false;
  if (/\b(?:background task|task-\d+|subagent|subagents)\b/i.test(prompt)) return false;
  if (
    /(?:^|[\s'"`(])\/swarm\b/i.test(prompt) ||
    /\b(?:swarm_wait|swarm_monitor|swarm\s+(?:board|worker|status)|board\s+message|worker\s+status)\b/i.test(prompt)
  ) {
    return false;
  }
  const hasRemoteCiMarker =
    /\b(?:ci|github actions|workflow|codeql|pr checks|gh pr checks|gh run|remote checks|check runs?|pipeline|pull request|build status|status checks?|merge checks?|deploy(?:ment)?|release\s+(?:build|check|workflow|pipeline)|actions?\s+run)\b/i.test(prompt) ||
    /\bpr\s*#\d+\b/i.test(prompt);
  return (
    hasRemoteCiMarker &&
    /\b(?:check|status|poll|monitor|wait|watch|complete|finish|result|pass|scan|green|ready|job|build|workflow|run)\b/i.test(prompt)
  );
}

export function extractRemoteCiBackoffKey(args = {}) {
  const prompt = cleanGovernanceArg(args.Prompt || args.prompt).toLowerCase();
  const prMatch = prompt.match(/\bpr\s*#?(\d+)\b/i) || prompt.match(/\bpull\s+request\s*#?(\d+)\b/i);
  if (prMatch) return `remote-ci:pr-${prMatch[1]}`;
  const runMatch = prompt.match(/\brun\s*#?(\d{5,})\b/i);
  if (runMatch) return `remote-ci:run-${runMatch[1]}`;
  return "remote-ci";
}

/**
 * Detects one-shot `schedule` timers polling `/swarm` boards or workers instead of relying on
 * `swarm_wait` + `swarm_monitor`. Narrowed so ordinary reminders mentioning bare "board" pass.
 */
export function isSwarmPollSchedule(args = {}) {
  if (isDaemonCron(args)) return false;
  const prompt = cleanGovernanceArg(args.Prompt || args.prompt).toLowerCase();
  const cond = cleanGovernanceArg(args.TimerCondition || args.timerCondition).toLowerCase();
  if (/(?:^|\/)task-[a-z0-9_-]+$/i.test(cond)) return false;
  if (isRemoteCiPollSchedule(args)) return false;
  return (
    /(?:^|[\s'"`(])\/swarm\b/i.test(prompt) ||
    /\b(?:swarm_wait|swarm_monitor|swarm\s+(?:board|worker|status)|board\s+message)\b/i.test(prompt) ||
    (cond === "any" &&
      !/\b(?:subagent|subagents)\b/i.test(prompt) &&
      /\b(?:check|status|poll|monitor|wait|worker)\b/i.test(prompt))
  );
}

export function isSubagentPollSchedule(args = {}) {
  if (isDaemonCron(args)) return false;
  if (isSwarmPollSchedule(args)) return false;
  const prompt = cleanGovernanceArg(args.Prompt || args.prompt).toLowerCase();
  const cond = cleanGovernanceArg(args.TimerCondition || args.timerCondition).toLowerCase();
  if (/(?:^|\/)task-[a-z0-9_-]+$/i.test(cond) || cond.includes("task")) return false;
  return /\b(?:subagent|subagents)\b/i.test(prompt) || BACKOFF_UUID_RE.test(cond);
}

/**
 * Evaluates and advances a backoff bucket for `manage_task`, `subagent_schedule`,
 * `remote_ci_schedule`, or `task_schedule`. Shared by `checkContextHealth` and hook task guards.
 */
export function stepBackoffState(kind, bucket, options = {}) {
  const {
    durationSec = 0,
    hasValidCond = false,
    nowMs = NaN,
    hasValidTs = Number.isFinite(nowMs),
    decayMs = REMOTE_CI_BUCKET_TTL_MS
  } = options;
  const pollCount = Number(bucket.pollCount) || 0;
  const lastPollTime = Number(bucket.lastPollTime) || 0;

  if (kind === "manage_task") {
    const pending = bucket.pendingWatchdog && typeof bucket.pendingWatchdog === "object" ? bucket.pendingWatchdog : null;
    const displayRequiredSec = pending
      ? (Number(pending.requiredSec) || 30)
      : (pollCount === 0 ? 0 : getRequiredBackoffSeconds(pollCount));
    const requiredSec = pending ? Math.max(0, displayRequiredSec - 2) : displayRequiredSec;
    if (!hasValidTs) {
      return { allowed: false, clamped: false, violation: true, requiredSec, displayRequiredSec, elapsedMs: 0, reason: "missing_timestamp" };
    }
    const elapsedMs = lastPollTime > 0 ? Math.max(0, nowMs - lastPollTime) : Infinity;
    if (elapsedMs < requiredSec * 1000) {
      return { allowed: false, clamped: false, violation: true, requiredSec, displayRequiredSec, elapsedMs, reason: "cooldown" };
    }
    if (pending) delete bucket.pendingWatchdog;
    else bucket.pollCount = pollCount + 1;
    bucket.lastPollTime = nowMs;
    return { allowed: true, clamped: false, violation: false, requiredSec, displayRequiredSec, elapsedMs, consumedWatchdog: Boolean(pending) };
  }

  if (kind === "subagent_schedule") {
    const requiredSec = getRequiredSubagentBackoffSeconds(pollCount);
    if (!hasValidCond || !Number.isFinite(durationSec) || durationSec < 30) {
      return { allowed: false, clamped: false, violation: true, requiredSec, displayRequiredSec: requiredSec, effectiveDuration: durationSec };
    }
    const clamped = durationSec < requiredSec;
    const effectiveDuration = clamped ? requiredSec : durationSec;
    bucket.pollCount = pollCount + 1;
    if (hasValidTs) bucket.lastPollTime = nowMs;
    return { allowed: true, clamped, violation: clamped, requiredSec, displayRequiredSec: requiredSec, effectiveDuration };
  }

  if (kind === "remote_ci_schedule") {
    let effPollCount = pollCount;
    if (hasValidTs && lastPollTime > 0 && (nowMs - lastPollTime) >= decayMs) {
      effPollCount = 0;
      bucket.pollCount = 0;
    }
    const requiredSec = Math.max(30, getRequiredBackoffSeconds(effPollCount));
    if (!Number.isFinite(durationSec) || durationSec < 15) {
      return { allowed: false, clamped: false, violation: true, requiredSec, displayRequiredSec: requiredSec, effectiveDuration: durationSec };
    }
    const clamped = durationSec < requiredSec;
    const effectiveDuration = clamped ? requiredSec : durationSec;
    bucket.pollCount = Math.max(1, effPollCount) + 1;
    if (hasValidTs) bucket.lastPollTime = nowMs;
    return { allowed: true, clamped, violation: clamped, requiredSec, displayRequiredSec: requiredSec, effectiveDuration };
  }

  if (kind === "task_schedule") {
    const requiredSec = Math.max(30, getRequiredBackoffSeconds(pollCount));
    if (!hasValidCond || !Number.isFinite(durationSec) || durationSec < 15) {
      return { allowed: false, clamped: false, violation: true, requiredSec, displayRequiredSec: requiredSec, effectiveDuration: durationSec };
    }
    const clamped = durationSec < requiredSec;
    const effectiveDuration = clamped ? requiredSec : durationSec;
    bucket.pollCount = Math.max(1, pollCount) + 1;
    if (hasValidTs) bucket.lastPollTime = nowMs;
    bucket.pendingWatchdog = { armedAt: hasValidTs ? nowMs : 0, requiredSec, durationSec: effectiveDuration };
    return { allowed: true, clamped, violation: clamped, requiredSec, displayRequiredSec: requiredSec, effectiveDuration };
  }

  throw new Error(`Unsupported backoff kind: ${kind}`);
}
