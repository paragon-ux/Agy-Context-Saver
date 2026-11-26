/**
 * Read-only transcript health report: turns, steps, raw size, and polling events per session.
 * Zero dependencies beyond the shared path helpers and polling classifiers.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { getLineage, readPolicies, getEffectiveMode } from "./transcript-policy.mjs";
import { getBrainDirs, resolveRealOrAncestorPath } from "./path-guards.mjs";
import {
  BACKOFF_UUID_RE,
  extractTaskBackoffKey,
  extractRemoteCiBackoffKey,
  hasValidTaskTimerCondition,
  hasValidSubagentTimerCondition,
  isTaskPollSchedule,
  isRemoteCiPollSchedule,
  isSwarmPollSchedule,
  isSubagentPollSchedule,
  stepBackoffState
} from "./backoff.mjs";

const MAX_LINES = 100000;
const MAX_CHILD_SCAN = 300;
const HIGH_TURN_COUNT = 40;

function findTranscript(convId, brainDirs) {
  for (const dir of brainDirs) {
    for (const name of ["transcript.jsonl", "transcript_full.jsonl"]) {
      const file = path.join(dir, convId, ".system_generated", "logs", name);
      const expected = path.join(resolveRealOrAncestorPath(dir), convId, ".system_generated", "logs", name);
      if (resolveRealOrAncestorPath(file) === expected && fs.existsSync(file)) return expected;
    }
  }
  return null;
}

// A child's first system message carries `sender=<parent id>`; scan only the head of each transcript.
function findChildIds(parentId, brainDirs) {
  const found = [];
  for (const dir of brainDirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    const recent = names.filter((n) => BACKOFF_UUID_RE.test(n) && n !== parentId).map((id) => {
      const file = findTranscript(id, [dir]);
      let mtime = 0;
      try { mtime = file ? fs.statSync(file).mtimeMs : 0; } catch {}
      return { id, file, mtime };
    }).filter((e) => e.file).sort((a, b) => b.mtime - a.mtime).slice(0, MAX_CHILD_SCAN);
    for (const { id } of recent) {
      if (getLineage(id, [dir]).parentId === parentId && !found.includes(id)) found.push(id);
    }
  }
  return found;
}

function classify(pollingEvents, userTurns) {
  if (pollingEvents > 3) return "CRITICAL";
  if (pollingEvents > 0 || userTurns > HIGH_TURN_COUNT) return "WARNING";
  return "HEALTHY";
}

async function analyze(file, id) {
  const m = { turns: 0, modelTurns: 0, steps: 0, toolCalls: 0, rawBytes: 0, pollingEvents: 0, corruptLines: 0 };
  const buckets = new Map();
  const bucket = (key) => {
    const k = key || "";
    if (!buckets.has(k)) buckets.set(k, { pollCount: 0, lastPollTime: 0, pendingWatchdog: null });
    return buckets.get(k);
  };
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    if (!fs.fstatSync(fd).isFile() || resolveRealOrAncestorPath(file) !== file ||
        (process.platform === "linux" && fs.realpathSync.native(`/proc/self/fd/${fd}`) !== file)) {
      throw new Error("Transcript must be a contained regular file.");
    }
  } catch (err) { fs.closeSync(fd); throw err; }
  const stream = fs.createReadStream(file, { fd, autoClose: true, encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (++m.steps > MAX_LINES) { m.steps--; break; }
    m.rawBytes += Buffer.byteLength(line);
    let item;
    try { item = JSON.parse(line); } catch { m.corruptLines++; continue; }
    if (!item || typeof item !== "object") continue;
    if (item.type === "USER_INPUT") m.turns++;
    if (item.type === "PLANNER_RESPONSE") m.modelTurns++;
    if (!Array.isArray(item.tool_calls)) continue;
    const nowMs = item.created_at ? Date.parse(item.created_at) : NaN;
    const hasValidTs = Number.isFinite(nowMs);
    for (const tc of item.tool_calls) {
      if (!tc || typeof tc !== "object") continue;
      m.toolCalls++;
      const name = tc.tool_name || tc.name;
      const args = tc.args || tc.arguments || {};
      const secs = Number(args.DurationSeconds || args.durationSeconds || args.duration || 0);
      let res = null;
      if (name === "manage_task") {
        const action = String(args.Action || args.action || "").replace(/^["']|["']$/g, "").trim().toLowerCase();
        if (action === "status") res = stepBackoffState("manage_task", bucket(extractTaskBackoffKey("manage_task", args)), { nowMs, hasValidTs });
      } else if (name === "schedule") {
        if (isSwarmPollSchedule(args)) res = { violation: true };
        else if (isSubagentPollSchedule(args)) res = stepBackoffState("subagent_schedule", bucket(extractTaskBackoffKey("schedule", args)), { durationSec: secs, hasValidCond: hasValidSubagentTimerCondition(args), nowMs, hasValidTs });
        else if (isRemoteCiPollSchedule(args)) res = stepBackoffState("remote_ci_schedule", bucket(extractRemoteCiBackoffKey(args)), { durationSec: secs, nowMs, hasValidTs });
        else if (isTaskPollSchedule(args)) res = stepBackoffState("task_schedule", bucket(extractTaskBackoffKey("schedule", args)), { durationSec: secs, hasValidCond: hasValidTaskTimerCondition(args), nowMs, hasValidTs });
      }
      if (res?.violation) m.pollingEvents++;
    }
  }
  } finally { rl.close(); stream.destroy(); }
  return { id, file, status: classify(m.pollingEvents, m.turns), ...m };
}

/** Resolves selectors, then analyzes each transcript. Returns `{ sessions }` or `{ error }`. */
export async function checkTranscriptHealth({ ids = [], parent = null, callerConvId = (process.env.GEMINI_CONVERSATION_ID || "").trim(), activeTranscriptPath = "" } = {}) {
  const brainDirs = getBrainDirs({ activeTranscriptPath });
  const envId = callerConvId;
  const effective = getEffectiveMode(callerConvId, readPolicies(), brainDirs);
  if (effective.mode === "deny") return { error: "Transcript health is disabled for this session (transcript access: deny)." };
  if (effective.restricted && (effective.unknown || parent !== null)) return { error: "Transcript health may inspect only the identified caller session." };
  let targets = ids.flatMap((v) => String(v).split(",")).map((v) => v.trim()).filter(Boolean);
  if (parent !== null && targets.length) return { error: "Pass either --id or --parent, not both." };
  if (parent !== null) {
    const parentId = parent === "current" ? envId : String(parent).trim();
    if (!parentId) return { error: "Cannot resolve '--parent current': GEMINI_CONVERSATION_ID is not set. Pass a parent UUID." };
    if (!BACKOFF_UUID_RE.test(parentId)) return { error: `Invalid parent id '${parentId}': expected a UUID.` };
    targets = findChildIds(parentId, brainDirs);
    if (!targets.length) return { error: `No child sessions found for parent ${parentId}.` };
  } else if (!targets.length) {
    if (!envId) return { error: "No session selected: pass --id <uuid[,uuid]> or --parent <uuid|current>, or set GEMINI_CONVERSATION_ID." };
    targets = [envId];
  }
  targets = targets.map((id) => id === "current" ? callerConvId : id);
  if (effective.mode === "self-only" && targets.some((id) => id !== callerConvId)) return { error: "Transcript health may inspect only the caller session." };
  const sessions = [];
  for (const id of [...new Set(targets)]) {
    if (!BACKOFF_UUID_RE.test(id)) return { error: `Invalid session id '${id}': expected a UUID.` };
    const file = findTranscript(id, brainDirs);
    if (!file) return { error: `No transcript found for session ${id}.` };
    sessions.push(await analyze(file, id));
  }
  return { sessions };
}

export function formatTranscriptHealth({ sessions }) {
  const lines = [];
  for (const s of sessions) {
    lines.push(
      `${s.id}: ${s.status}`,
      `  turns: ${s.turns} user, ${s.modelTurns} model | steps: ${s.steps} | tool calls: ${s.toolCalls}`,
      `  raw size: ${(s.rawBytes / 1024).toFixed(1)} KiB | polling events: ${s.pollingEvents}${s.corruptLines ? ` | unparsed lines: ${s.corruptLines}` : ""}`
    );
  }
  return lines.join("\n");
}
