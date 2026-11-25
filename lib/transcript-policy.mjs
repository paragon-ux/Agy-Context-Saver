/**
 * Per-session transcript isolation state: one tiny policy file plus parent lookup.
 * Modes: open (default), self-only, deny. A policy set by a session applies to its descendants.
 */

import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "../scripts/state-dir.mjs";
import { getBrainDirs } from "./path-guards.mjs";

export const POLICY_MODES = ["open", "self-only", "deny"];
const MAX_DEPTH = 6;

export function getPolicyFile() {
  return path.join(getStateDir(), "transcript-policy.json");
}

export function readPolicies() {
  try {
    const data = JSON.parse(fs.readFileSync(getPolicyFile(), "utf-8"));
    return data?.version === 1 && data.policies && typeof data.policies === "object" ? data.policies : {};
  } catch { return {}; }
}

export function setPolicy(ownerId, mode) {
  if (!ownerId) throw new Error("GEMINI_CONVERSATION_ID is not set; run this from inside an Antigravity session.");
  if (!POLICY_MODES.includes(mode)) throw new Error(`Invalid mode '${mode}': expected ${POLICY_MODES.join(", ")}.`);
  const policies = readPolicies();
  if (mode === "open") delete policies[ownerId]; else policies[ownerId] = { mode };
  const file = getPolicyFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, policies }, null, 2));
  fs.renameSync(tmp, file);
  return policies;
}

export function hasRestrictivePolicy(policies = readPolicies()) {
  return Object.values(policies).some((p) => p?.mode === "self-only" || p?.mode === "deny");
}

/** Reads the head of a session transcript: { found, isChild, parentId }. */
export function getLineage(convId, brainDirs = getBrainDirs()) {
  for (const dir of brainDirs) {
    for (const name of ["transcript.jsonl", "transcript_full.jsonl"]) {
      const file = path.join(dir, convId, ".system_generated", "logs", name);
      try {
        const fd = fs.openSync(file, "r");
        const buf = Buffer.alloc(65536);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        const lines = buf.toString("utf-8", 0, n).split("\n").filter(Boolean).slice(0, 24);
        for (const line of lines) {
          let item = null;
          try { item = JSON.parse(line); } catch { continue; }
          if (item.type !== "SYSTEM_MESSAGE" && item.source !== "SYSTEM") return { found: true, isChild: false, parentId: null };
          const content = typeof item.content === "string" ? item.content : "";
          if (content.includes("new board message")) continue;
          const senders = [...content.matchAll(/\[Message\][^\n]*?\bsender=([a-zA-Z0-9_-]{4,})/g)];
          if (senders.length) return { found: true, isChild: true, parentId: senders[senders.length - 1][1] };
        }
        return { found: true, isChild: false, parentId: null };
      } catch {}
    }
  }
  return { found: false, isChild: false, parentId: null };
}

/**
 * Effective mode for a caller: the nearest ancestor policy wins. A caller that cannot be
 * identified fails closed to self-only whenever any restrictive policy exists.
 */
export function getEffectiveMode(convId, policies = readPolicies(), brainDirs = getBrainDirs()) {
  if (!hasRestrictivePolicy(policies)) return { mode: "open", restricted: false };
  const unknown = !convId || convId === "global";
  let cur = unknown ? null : getLineage(convId, brainDirs);
  if (unknown || !cur.found) return { mode: "self-only", restricted: true, unknown: true };
  for (let depth = 0; cur.parentId && depth < MAX_DEPTH; depth++) {
    const mode = policies[cur.parentId]?.mode;
    if (mode === "self-only" || mode === "deny") return { mode, restricted: true, ownerId: cur.parentId };
    cur = getLineage(cur.parentId, brainDirs);
  }
  return { mode: "open", restricted: false };
}

/** Top-level session: not a child and not under a restrictive policy (or transcript not yet written). */
export function isTopLevelUnrestricted(convId, policies = readPolicies()) {
  const lin = !convId || convId === "global" ? { found: false } : getLineage(convId);
  if (lin.found && lin.isChild) return false;
  return !getEffectiveMode(convId, policies).restricted;
}
