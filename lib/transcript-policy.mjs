/**
 * Per-session transcript isolation state: one tiny policy file plus parent lookup.
 * Modes: open (default), self-only, deny. A policy set by a session applies to its descendants.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getStateDir } from "../scripts/state-dir.mjs";
import { getBrainDirs, resolveRealOrAncestorPath } from "./path-guards.mjs";

export const POLICY_MODES = ["open", "self-only", "deny"];
const MAX_DEPTH = 6;

export function getPolicyFile() {
  return path.join(getStateDir(), "transcript-policy.json");
}

export function readPolicies({ strict = false } = {}) {
  try {
    const data = JSON.parse(fs.readFileSync(getPolicyFile(), "utf-8"));
    if (data?.version !== 1 || !data.policies || typeof data.policies !== "object" || Array.isArray(data.policies) ||
        Object.values(data.policies).some((p) => !p || !["self-only", "deny"].includes(p.mode))) {
      throw new Error("Invalid transcript policy state.");
    }
    return data.policies;
  } catch (err) {
    if (err.code === "ENOENT") return {};
    if (strict) throw err;
    // A corrupt policy must not silently remove existing restrictions.
    return { unresolved: { mode: "deny" } };
  }
}

export function setPolicy(ownerId, mode) {
  if (!/^[a-zA-Z0-9_-]{4,}$/.test(ownerId || "")) throw new Error("No valid caller session; run this from inside an Antigravity session.");
  if (!POLICY_MODES.includes(mode)) throw new Error(`Invalid mode '${mode}': expected ${POLICY_MODES.join(", ")}.`);
  const file = getPolicyFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      try { fs.writeFileSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const recovery = `${lock}.recovery`;
      let recoveryFd;
      try {
        recoveryFd = fs.openSync(recovery, "wx", 0o600);
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        const pid = Number(fs.readFileSync(lock, "utf-8"));
        let alive = true;
        try { process.kill(pid, 0); } catch (e) { if (e.code === "ESRCH") alive = false; }
        if (age > 3000 && !alive) fs.unlinkSync(lock);
      } catch (e) { if (!["ENOENT", "EEXIST"].includes(e.code)) throw e; }
      finally {
        if (recoveryFd !== undefined) { fs.closeSync(recoveryFd); fs.unlinkSync(recovery); }
      }
      if (Date.now() >= deadline) throw new Error("Timed out locking transcript policies.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    const policies = readPolicies({ strict: true });
    if (mode === "open") delete policies[ownerId]; else policies[ownerId] = { mode };
    if (!Object.keys(policies).length) {
      try { fs.unlinkSync(file); } catch (err) { if (err.code !== "ENOENT") throw err; }
    } else {
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, policies }, null, 2), { flag: "wx", mode: 0o600 });
      fs.renameSync(tmp, file);
    }
    return policies;
  } finally {
    try {
      try { fs.unlinkSync(tmp); } catch (err) { if (err.code !== "ENOENT") throw err; }
    } finally { fs.unlinkSync(lock); }
  }
}

export function hasRestrictivePolicy(policies = readPolicies()) {
  return Object.values(policies).some((p) => p?.mode === "self-only" || p?.mode === "deny");
}

/** Reads only the launch header; later quoted messages cannot redefine the parent. */
export function getLineage(convId, brainDirs = getBrainDirs()) {
  if (!/^[a-zA-Z0-9_-]{4,}$/.test(convId || "")) return { found: false, unresolved: true };
  for (const dir of brainDirs) {
    for (const name of ["transcript.jsonl", "transcript_full.jsonl"]) {
      const file = path.join(dir, convId, ".system_generated", "logs", name);
      let fd;
      try {
        if (resolveRealOrAncestorPath(file) !== path.join(resolveRealOrAncestorPath(dir), convId, ".system_generated", "logs", name)) return { found: false, unresolved: true };
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
        if (!fs.fstatSync(fd).isFile()) continue;
        const buf = Buffer.alloc(524288);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        const lines = buf.toString("utf-8", 0, n).split("\n").filter((line) => line.trim()).slice(0, 24);
        let boardSender = null;
        for (let i = 0; i < lines.length; i++) {
          let item;
          try { item = JSON.parse(lines[i]); }
          catch { return { found: false, unresolved: true }; }
          if (!item || typeof item !== "object") return { found: false, unresolved: true };
          if (i === 0 && (item.type === "USER_INPUT" || item.source === "USER_EXPLICIT")) {
            return { found: true, isChild: false, parentId: null };
          }
          if (item.type !== "SYSTEM_MESSAGE" && item.source !== "SYSTEM") break;
          const content = typeof item.content === "string" ? item.content : "";
          // The first message header belongs to the coordinator, before any prompt-body quotes.
          const sender = content.match(/\[Message\][^\n]*?\bsender=([a-zA-Z0-9_-]{4,})\b/)?.[1];
          if (!sender) continue;
          const board = content.includes("content=[swarm] new board message");
          const assignment = /Your assignment \(recorded on the board as #\d+ for @[a-zA-Z0-9_-]+\):/.exec(content);
          if (assignment) {
            const headers = content.slice(0, assignment.index).matchAll(/\[Message\][^\n]*?\bsender=([a-zA-Z0-9_-]{4,})\b/g);
            let coordinator = sender;
            for (const header of headers) coordinator = header[1];
            return { found: true, isChild: true, parentId: coordinator };
          }
          if (!board) return { found: true, isChild: true, parentId: sender };
          boardSender ||= sender;
        }
        if (boardSender) return { found: true, isChild: true, parentId: boardSender };
        return { found: false, unresolved: true };
      } catch (err) {
        if (err.code !== "ENOENT") return { found: false, unresolved: true };
      } finally { if (fd !== undefined) fs.closeSync(fd); }
    }
  }
  return { found: false, unresolved: true };
}

/** The nearest ancestor policy wins; incomplete ancestry fails closed. */
export function getEffectiveMode(convId, policies = readPolicies(), brainDirs = getBrainDirs()) {
  if (!hasRestrictivePolicy(policies)) return { mode: "open", restricted: false };
  const closed = () => ({ mode: Object.values(policies).some((p) => p?.mode === "deny") ? "deny" : "self-only", restricted: true, unknown: true });
  if (!convId || convId === "global") return closed();
  const visited = new Set();
  let id = convId;
  for (let depth = 0; depth <= MAX_DEPTH; depth++) {
    if (visited.has(id)) return closed();
    visited.add(id);
    const cur = getLineage(id, brainDirs);
    if (!cur.found || cur.unresolved) return closed();
    if (!cur.parentId) return { mode: "open", restricted: false };
    const mode = policies[cur.parentId]?.mode;
    if (mode === "self-only" || mode === "deny") return { mode, restricted: true, ownerId: cur.parentId };
    id = cur.parentId;
  }
  return closed();
}

export function isTopLevelUnrestricted(convId, policies = readPolicies(), brainDirs = getBrainDirs()) {
  const lin = getLineage(convId, brainDirs);
  if (lin.isChild || (hasRestrictivePolicy(policies) && (!lin.found || lin.unresolved))) return false;
  return !getEffectiveMode(convId, policies, brainDirs).restricted;
}
