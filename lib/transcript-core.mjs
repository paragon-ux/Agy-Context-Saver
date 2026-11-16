/**
 * Agy-Context-Saver: Hardened Streaming Transcript & Health Engine (v2.0.2)
 *
 * Zero-dependency ESM core powering the `bin/agy-context.mjs` CLI.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { findExistingRtk } from "../scripts/provision-rtk.mjs";
import { getStateDir } from "../scripts/state-dir.mjs";

export const MAX_LINE_CHARS = 1000;
export const MAX_TURN_CHARS = 6000;
export const MAX_OUTPUT_CHARS = 24000;
export const MAX_FIELD_CHARS = 24000;
export const ACTIVE_SWARM_WINDOW_MS = 5 * 60 * 1000;
export const MAX_BOUNDED_READ_STEPS = 200;
export const MAX_HEALTH_LINES = 100000;
export const TRANSCRIPT_ACCESS_DEFAULT_TTL_MS = 3600000;
export const HOOK_GRANT_TTL_MS = 10000;
let processVerifiedGrant = null;
let processClaimedGrantMeta = null;

/**
 * Fixed-capacity O(1) circular ring buffer (`ring`, `head`, `count`)
 * eliminating O(n) `Array.shift()` overhead during large transcript streams.
 */
export class CircularRingBuffer {
  constructor(capacity) {
    this.cap = Math.max(1, Math.floor(Number(capacity) || 1));
    this.ring = new Array(this.cap);
    this.head = 0;
    this.count = 0;
  }

  push(item) {
    this.ring[this.head] = item;
    this.head = (this.head + 1) % this.cap;
    if (this.count < this.cap) {
      this.count++;
    }
  }

  toArray() {
    if (this.count === 0) return [];
    const out = new Array(this.count);
    const start = this.count < this.cap ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      out[i] = this.ring[(start + i) % this.cap];
    }
    return out;
  }
}

export function getProfileHomeDir() {
  return process.env.AGY_TEST_PROFILE_DIR || os.homedir();
}

export function getBrainDir() {
  return process.env.AGY_BRAIN_DIR || path.join(getProfileHomeDir(), ".gemini", "antigravity", "brain");
}

export function getBrainDirs() {
  if (process.env.AGY_BRAIN_DIR && process.env.AGY_BRAIN_DIR.trim()) {
    return [process.env.AGY_BRAIN_DIR.trim()];
  }
  const home = getProfileHomeDir();
  const candidates = [
    path.join(home, ".gemini", "antigravity", "brain"),
    path.join(home, ".gemini", "antigravity-cli", "brain"),
    path.join(home, ".gemini", "antigravity-ide", "brain")
  ];
  const existing = candidates.filter((dir) => fs.existsSync(dir));
  return existing.length > 0 ? existing : [candidates[0]];
}

export function isContainedInAnyBrainDir(targetPath, brainDirs = getBrainDirs(), selfConvId = null) {
  for (const dir of brainDirs) {
    const checkDir = selfConvId ? path.join(dir, String(selfConvId)) : dir;
    if (isContainedInDir(targetPath, checkDir)) {
      return dir;
    }
  }
  return null;
}

export function extractConvId(p, { strictBrainContainment = false } = {}) {
  const rawStr = String(p || "");
  try {
    const targetResolved = realOrNull(rawStr) || path.resolve(rawStr);
    const norm = (s) => (os.platform() === "win32" ? s.toLowerCase() : s);
    const candidateDirs =
      process.env.AGY_BRAIN_DIR && process.env.AGY_BRAIN_DIR.trim()
        ? getBrainDirs()
        : Array.from(
            new Set([
              ...getBrainDirs(),
              path.join(getProfileHomeDir(), ".gemini", "antigravity", "brain"),
              path.join(getProfileHomeDir(), ".gemini", "antigravity-cli", "brain"),
              path.join(getProfileHomeDir(), ".gemini", "antigravity-ide", "brain")
            ])
          );
    for (const candidateDir of candidateDirs) {
      const brainRoot = realOrNull(candidateDir) || path.resolve(candidateDir);
      const rel = path.relative(norm(brainRoot), norm(targetResolved));
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        const origRel = path.relative(brainRoot, targetResolved);
        const segments = origRel.split(path.sep).filter(Boolean);
        const firstSeg = segments[0];
        if (firstSeg && firstSeg !== "." && firstSeg !== "..") {
          if (strictBrainContainment && segments.length === 1 && firstSeg.toLowerCase().endsWith(".jsonl")) {
            return null;
          }
          return firstSeg;
        }
      }
    }
  } catch {}
  if (strictBrainContainment) {
    return null;
  }
  const normalized = rawStr.replace(/\\/g, "/");
  const brainMatch = normalized.match(/\/brain\/([^/]+)\//);
  if (brainMatch) return brainMatch[1];
  const logsMatch = normalized.match(/\/([^/]+)\/\.system_generated\/logs\//);
  if (logsMatch) return logsMatch[1];
  return path.basename(normalized, path.extname(normalized));
}

export function getTranscriptAccessPolicyPath() {
  return path.join(getStateDir(), "transcript-access.json");
}

function normalizePatternList(rawList) {
  if (!rawList) return [];
  const arr = Array.isArray(rawList)
    ? rawList
    : String(rawList)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  return Array.from(new Set(arr.map((s) => String(s).trim()).filter(Boolean)));
}

export function readTranscriptAccessStore() {
  const filePath = getTranscriptAccessPolicyPath();
  const now = Date.now();
  const baseStore = {
    version: 1,
    activeOwnerId: null,
    policies: {},
    lastHookGrant: null,
    lastAccessMutationGrant: null
  };
  try {
    if (!fs.existsSync(filePath)) return baseStore;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!parsed || typeof parsed !== "object") return baseStore;

    const policies = {};
    const rawPolicies = parsed.policies && typeof parsed.policies === "object" ? parsed.policies : {};
    for (const [ownerId, pol] of Object.entries(rawPolicies)) {
      if (!pol || typeof pol !== "object") continue;
      const updatedAt = Number(pol.updatedAt || pol.createdAt || 0);
      const ttlMs = Number(pol.ttlMs) > 0 ? Number(pol.ttlMs) : TRANSCRIPT_ACCESS_DEFAULT_TTL_MS;
      if (updatedAt > 0 && (now - updatedAt) < ttlMs) {
        policies[ownerId] = {
          ownerId: String(pol.ownerId || ownerId),
          mode: ["open", "allowlist", "self-only", "deny"].includes(pol.mode) ? pol.mode : "open",
          allow: normalizePatternList(pol.allow),
          deny: normalizePatternList(pol.deny),
          createdAt: Number(pol.createdAt || updatedAt),
          updatedAt,
          ttlMs
        };
      }
    }

    let activeOwnerId = parsed.activeOwnerId && policies[parsed.activeOwnerId] ? parsed.activeOwnerId : null;
    if (!activeOwnerId) {
      const sortedOwners = Object.values(policies).sort((a, b) => b.updatedAt - a.updatedAt);
      if (sortedOwners.length > 0) activeOwnerId = sortedOwners[0].ownerId;
    }

    const lastHookGrant =
      parsed.lastHookGrant &&
      typeof parsed.lastHookGrant === "object" &&
      typeof parsed.lastHookGrant.ts === "number" &&
      (now - parsed.lastHookGrant.ts) < HOOK_GRANT_TTL_MS
        ? parsed.lastHookGrant
        : null;

    const lastAccessMutationGrant =
      parsed.lastAccessMutationGrant &&
      typeof parsed.lastAccessMutationGrant === "object" &&
      typeof parsed.lastAccessMutationGrant.ts === "number" &&
      (now - parsed.lastAccessMutationGrant.ts) < HOOK_GRANT_TTL_MS
        ? parsed.lastAccessMutationGrant
        : null;

    return {
      version: 1,
      activeOwnerId,
      policies,
      lastHookGrant,
      lastAccessMutationGrant
    };
  } catch {
    return baseStore;
  }
}

export function writeTranscriptAccessStore(store) {
  const dir = getStateDir();
  const filePath = getTranscriptAccessPolicyPath();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify(
      {
        version: 1,
        activeOwnerId: store.activeOwnerId || null,
        policies: store.policies || {},
        lastHookGrant: store.lastHookGrant || null,
        lastAccessMutationGrant: store.lastAccessMutationGrant || null
      },
      null,
      2
    );
    const tmpFile = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmpFile, payload, "utf-8");
    try {
      fs.renameSync(tmpFile, filePath);
    } catch {
      fs.writeFileSync(filePath, payload, "utf-8");
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  } catch {}
}

export function getGrantsDir() {
  return path.join(getStateDir(), "grants");
}

function listFreshGrantRecords(prefix = "grant-") {
  const dir = getGrantsDir();
  if (!fs.existsSync(dir)) return [];
  const now = Date.now();
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const full = path.join(dir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, "utf-8"));
      if (!parsed || typeof parsed !== "object" || typeof parsed.ts !== "number" || (now - parsed.ts) >= HOOK_GRANT_TTL_MS) {
        try { fs.unlinkSync(full); } catch {}
        continue;
      }
      out.push({ filePath: full, grant: parsed });
    } catch {
      try {
        const st = fs.statSync(full);
        if ((now - st.mtimeMs) >= HOOK_GRANT_TTL_MS) fs.unlinkSync(full);
      } catch {}
    }
  }
  out.sort((a, b) => b.grant.ts - a.grant.ts);
  return out;
}

function claimGrantFileAtomically(filePath) {
  const claimedPath = `${filePath}.claimed.${process.pid}.${crypto.randomUUID()}`;
  try {
    fs.renameSync(filePath, claimedPath);
  } catch {
    return null;
  }
  try {
    const raw = fs.readFileSync(claimedPath, "utf-8");
    try { fs.unlinkSync(claimedPath); } catch {}
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.ts === "number" && (Date.now() - parsed.ts) < HOOK_GRANT_TTL_MS) {
      return parsed;
    }
    return null;
  } catch {
    try { fs.unlinkSync(claimedPath); } catch {}
    return null;
  }
}

export function recordTranscriptHookGrant({
  callerConvId = "global",
  subcommand = "read",
  targetConvId = null,
  mode = "open",
  isMutation = false
} = {}) {
  const grantsDir = getGrantsDir();
  const now = Date.now();
  const prefix = isMutation ? "mut-" : "grant-";
  const payloadObj = isMutation
    ? { callerConvId, ts: now, isMutation: true }
    : { callerConvId, subcommand, targetConvId, mode, ts: now };

  // Prune expired files Opportunistically
  listFreshGrantRecords("grant-");
  listFreshGrantRecords("mut-");

  try {
    fs.mkdirSync(grantsDir, { recursive: true });
    const filePath = path.join(grantsDir, `${prefix}${now}-${process.pid}-${crypto.randomUUID()}.json`);
    const fd = fs.openSync(filePath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(payloadObj), "utf-8");
    } finally {
      fs.closeSync(fd);
    }
    if (!isMutation) {
      processVerifiedGrant = payloadObj;
      processClaimedGrantMeta = { filePath, grant: payloadObj };
    }
  } catch {}
}

function hasActiveLaunchRestrictedSession() {
  const envConvId = process.env.GEMINI_CONVERSATION_ID && process.env.GEMINI_CONVERSATION_ID.trim();
  if (!envConvId) return false;
  const safeId = String(envConvId).replace(/[^a-zA-Z0-9_-]/g, "_");
  const sessionFile = path.join(getStateDir(), `agy-session-${safeId}.json`);
  try {
    if (!fs.existsSync(sessionFile)) return false;
    const st = fs.statSync(sessionFile);
    if ((Date.now() - st.mtimeMs) > ACTIVE_SWARM_WINDOW_MS) return false;
    const parsed = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
    const dirVal = parsed?.lineage?.launchDirective;
    return dirVal === "deny" || dirVal === "self-only";
  } catch {
    return false;
  }
}

export function canonicalizeTranscriptSubcommand(sub) {
  const s = String(sub || "").trim().toLowerCase();
  if (s === "read" || s === "outline" || s === "summary") return "read";
  if (s === "query" || s === "grep" || s === "search" || s === "find" || s === "tools") return "query";
  if (s === "step") return "step";
  if (s === "health" || s === "stats" || s === "info") return "health";
  if (s === "list" || s === "ls") return "list";
  if (s === "export" || s === "dump") return "export";
  if (s === "resolve") return "resolve";
  return s;
}

export function clearProcessTranscriptGrant() {
  processVerifiedGrant = null;
  processClaimedGrantMeta = null;
}

export function consumeTranscriptAccessGrant() {
  if (processClaimedGrantMeta?.filePath) {
    try { fs.unlinkSync(processClaimedGrantMeta.filePath); } catch {}
  }
  processVerifiedGrant = null;
  processClaimedGrantMeta = null;
  const envConvId = process.env.GEMINI_CONVERSATION_ID && process.env.GEMINI_CONVERSATION_ID.trim();
  const records = listFreshGrantRecords("grant-");
  for (const rec of records) {
    if (envConvId ? rec.grant.callerConvId === envConvId : records.length === 1) {
      claimGrantFileAtomically(rec.filePath);
      break;
    }
  }
}

function grantMatchesRequest(grant, reqCanon, targetConvId, isImplicitCurrent, envConvId) {
  if (envConvId && grant.callerConvId && grant.callerConvId !== "global" && grant.callerConvId !== envConvId) {
    return { matches: false, reason: "caller" };
  }
  const grantCanon = canonicalizeTranscriptSubcommand(grant.subcommand);
  if (!reqCanon || !grantCanon || reqCanon !== grantCanon) {
    return { matches: false, reason: "subcommand", grantCanon };
  }
  if (grant.mode === "self-only") {
    if (reqCanon === "list") {
      return { matches: false, reason: "self-only-list" };
    }
    if (targetConvId !== null && (!grant.callerConvId || grant.callerConvId === "global" || targetConvId !== grant.callerConvId)) {
      return { matches: false, reason: "self-only-cross" };
    }
  }
  if (targetConvId !== null && grant.targetConvId) {
    const isGrantCurrent = String(grant.targetConvId).toLowerCase() === "current";
    if (isGrantCurrent ? !isImplicitCurrent : targetConvId !== grant.targetConvId) {
      return { matches: false, reason: "target" };
    }
  }
  return { matches: true };
}

/**
 * Defense-in-depth runtime verification inside transcript-core.mjs:
 * When any parent policy restriction or active launch-directive restriction exists,
 * verifies that PreToolUse issued a fresh (< 10s), operation-bound single-use capability grant
 * stored atomically per invocation so concurrent workers never overwrite each other.
 */
export function verifyTranscriptCoreAccess({
  targetConvId = null,
  subcommand = "read",
  consumeGrant = true,
  isImplicitCurrent = false
} = {}) {
  const store = readTranscriptAccessStore();
  const activePolicies = Object.values(store.policies || {}).filter(
    (p) => p.mode !== "open" || (Array.isArray(p.deny) && p.deny.length > 0) || (Array.isArray(p.allow) && p.allow.length > 0)
  );
  const hasRestriction = activePolicies.length > 0 || hasActiveLaunchRestrictedSession();
  if (!hasRestriction) {
    if (consumeGrant) {
      processVerifiedGrant = null;
      processClaimedGrantMeta = null;
    }
    return { allowed: true, mode: "open", hasRestriction: false };
  }

  const reqCanon = canonicalizeTranscriptSubcommand(subcommand);
  const envConvId = process.env.GEMINI_CONVERSATION_ID && process.env.GEMINI_CONVERSATION_ID.trim();
  const freshRecords = listFreshGrantRecords("grant-");

  let grant = null;
  let claimedMeta = null;

  // 1. Prefer exact matching disk grant file (atomic claim when consumeGrant === true)
  for (const rec of freshRecords) {
    const check = grantMatchesRequest(rec.grant, reqCanon, targetConvId, isImplicitCurrent, envConvId);
    if (check.matches) {
      if (consumeGrant) {
        const claimed = claimGrantFileAtomically(rec.filePath);
        if (claimed) {
          grant = claimed;
          claimedMeta = null;
          break;
        }
      } else {
        grant = rec.grant;
        claimedMeta = rec;
        break;
      }
    }
  }

  // 2. Fall back to single mismatched disk grant (for explicit subcommand/target/self-only errors) or process-cached grant
  if (!grant && freshRecords.length > 0) {
    const fallbackRec =
      (envConvId ? freshRecords.find((r) => r.grant.callerConvId === envConvId) : null) ||
      (freshRecords.length === 1 ? freshRecords[0] : null);
    if (fallbackRec) {
      if (consumeGrant) {
        grant = claimGrantFileAtomically(fallbackRec.filePath);
      } else {
        grant = fallbackRec.grant;
        claimedMeta = fallbackRec;
      }
    }
  }
  if (!grant && processVerifiedGrant && (Date.now() - processVerifiedGrant.ts) < HOOK_GRANT_TTL_MS) {
    if (!processClaimedGrantMeta?.filePath || !fs.existsSync(processClaimedGrantMeta.filePath)) {
      // Only reuse in-process preflight grant if its file wasn't already claimed by a concurrent caller
      if (!processClaimedGrantMeta?.filePath) {
        grant = processVerifiedGrant;
      }
    }
  }

  if (!grant) {
    processVerifiedGrant = null;
    processClaimedGrantMeta = null;
    return {
      allowed: false,
      hasRestriction: true,
      error:
        "Antigravity Execution Governance: Transcript access is currently restricted by parent governance policy; direct or unverified transcript-core invocation outside an authorized PreToolUse CLI call is blocked."
    };
  }

  const grantCanon = canonicalizeTranscriptSubcommand(grant.subcommand);
  if (!reqCanon || !grantCanon || reqCanon !== grantCanon) {
    if (claimedMeta?.filePath) claimGrantFileAtomically(claimedMeta.filePath);
    processVerifiedGrant = null;
    processClaimedGrantMeta = null;
    return {
      allowed: false,
      hasRestriction: true,
      error: `Antigravity Execution Governance: Capability grant subcommand mismatch (grant authorized '${grant.subcommand}', but '${subcommand}' was requested).`
    };
  }

  if (grant.mode === "self-only") {
    if (reqCanon === "list") {
      if (claimedMeta?.filePath) claimGrantFileAtomically(claimedMeta.filePath);
      processVerifiedGrant = null;
      processClaimedGrantMeta = null;
      return {
        allowed: false,
        hasRestriction: true,
        error: `Antigravity Execution Governance: 'agy-context transcript ${subcommand}' is disabled in self-only mode (caller: ${grant.callerConvId}).`
      };
    }
    if (targetConvId !== null && (!grant.callerConvId || grant.callerConvId === "global" || targetConvId !== grant.callerConvId)) {
      if (claimedMeta?.filePath) claimGrantFileAtomically(claimedMeta.filePath);
      processVerifiedGrant = null;
      processClaimedGrantMeta = null;
      return {
        allowed: false,
        hasRestriction: true,
        error: `Antigravity Execution Governance: Cross-session transcript inspection of '${targetConvId}' is disabled in self-only mode (caller: ${grant.callerConvId}).`
      };
    }
  }

  if (targetConvId !== null && grant.targetConvId) {
    const isGrantCurrent = String(grant.targetConvId).toLowerCase() === "current";
    if (isGrantCurrent ? !isImplicitCurrent : targetConvId !== grant.targetConvId) {
      if (claimedMeta?.filePath) claimGrantFileAtomically(claimedMeta.filePath);
      processVerifiedGrant = null;
      processClaimedGrantMeta = null;
      return {
        allowed: false,
        hasRestriction: true,
        error: `Antigravity Execution Governance: Capability grant target mismatch (grant authorized '${grant.targetConvId}', but '${targetConvId}' was requested).`
      };
    }
  }

  if (consumeGrant) {
    processVerifiedGrant = null;
    processClaimedGrantMeta = null;
  } else {
    processVerifiedGrant = grant;
    processClaimedGrantMeta = claimedMeta;
  }

  return {
    allowed: true,
    hasRestriction: true,
    mode: grant.mode || "open",
    callerConvId: grant.callerConvId,
    targetConvId: grant.targetConvId || null,
    subcommand: grant.subcommand || null
  };
}

export function formatTranscriptAccessStatus(store = null) {
  const current = store || readTranscriptAccessStore();
  const policies = Object.values(current.policies || {}).sort((a, b) => b.updatedAt - a.updatedAt);
  const activePolicy =
    (current.activeOwnerId && current.policies?.[current.activeOwnerId]) ||
    policies[0] ||
    null;

  if (!activePolicy || (activePolicy.mode === "open" && activePolicy.allow.length === 0 && activePolicy.deny.length === 0)) {
    return {
      active: false,
      mode: "open",
      ownerId: activePolicy ? activePolicy.ownerId : null,
      allow: [],
      deny: [],
      policiesCount: policies.length,
      text: "Transcript Access Policy: OPEN (default — all sessions permitted)"
    };
  }

  const expiresSec = Math.max(0, Math.round(((activePolicy.updatedAt + activePolicy.ttlMs) - Date.now()) / 1000));
  const allowStr = activePolicy.allow.length > 0 ? activePolicy.allow.join(", ") : "(none)";
  const denyStr = activePolicy.deny.length > 0 ? activePolicy.deny.join(", ") : "(none)";
  const text = [
    `Transcript Access Policy: ${activePolicy.mode.toUpperCase()}`,
    `- Owner Session: ${activePolicy.ownerId}`,
    `- Mode: ${activePolicy.mode}`,
    `- Allow List: ${allowStr}`,
    `- Deny List: ${denyStr}`,
    `- Expires In: ${expiresSec}s`
  ].join("\n");

  return {
    active: true,
    mode: activePolicy.mode,
    ownerId: activePolicy.ownerId,
    allow: activePolicy.allow,
    deny: activePolicy.deny,
    createdAt: activePolicy.createdAt,
    updatedAt: activePolicy.updatedAt,
    ttlMs: activePolicy.ttlMs,
    expiresInSec: expiresSec,
    policiesCount: policies.length,
    text
  };
}

export function manageTranscriptAccessPolicy(options = {}) {
  const store = readTranscriptAccessStore();
  const isStatusOnly =
    Boolean(options.status) &&
    !options.off &&
    !options.on &&
    !options.reset &&
    !options.selfOnly &&
    options.mode === undefined &&
    options.allow === undefined &&
    options.deny === undefined;

  if (isStatusOnly) {
    return formatTranscriptAccessStatus(store);
  }

  const activePolicies = Object.values(store.policies || {}).filter(
    (p) => p.mode !== "open" || (Array.isArray(p.deny) && p.deny.length > 0) || (Array.isArray(p.allow) && p.allow.length > 0)
  );
  const mutRecords = listFreshGrantRecords("mut-");
  const mutGrantFromDisk = mutRecords.length > 0 ? claimGrantFileAtomically(mutRecords[0].filePath) : null;
  const mutGrant = mutGrantFromDisk || store.lastAccessMutationGrant;
  let ownerId = options._testAuthorizedOwner || null;

  if (!ownerId) {
    if (mutGrant && (Date.now() - mutGrant.ts) < HOOK_GRANT_TTL_MS) {
      ownerId = mutGrant.callerConvId;
    } else if (activePolicies.length > 0 || hasActiveLaunchRestrictedSession()) {
      throw new Error(
        "Antigravity Execution Governance: Unauthorized 'agy-context transcript access' mutation outside PreToolUse while a parent policy restriction is active."
      );
    } else {
      ownerId =
        (process.env.GEMINI_CONVERSATION_ID && process.env.GEMINI_CONVERSATION_ID.trim()) ||
        store.activeOwnerId ||
        "local-operator";
    }
  }

  // Consume single-use mutation grant and invalidate prior process grant
  store.lastAccessMutationGrant = null;
  store.lastHookGrant = null;
  processVerifiedGrant = null;
  processClaimedGrantMeta = null;

  if (ownerId !== "local-operator" && ownerId !== "global") {
    delete store.policies["local-operator"];
    delete store.policies["global"];
  }

  const now = Date.now();
  let ttlMs = TRANSCRIPT_ACCESS_DEFAULT_TTL_MS;
  if (options.ttl !== undefined) {
    const ttlSec = Number(options.ttl);
    if (!Number.isFinite(ttlSec) || !Number.isInteger(ttlSec) || ttlSec <= 0) {
      throw new Error(`Invalid '--ttl' value '${options.ttl}': expected a positive integer number of seconds.`);
    }
    ttlMs = ttlSec * 1000;
  }

  if (options.on || options.reset || options.mode === "open") {
    if (options.allow === undefined && options.deny === undefined) {
      delete store.policies[ownerId];
      if (store.activeOwnerId === ownerId) {
        const remaining = Object.values(store.policies).sort((a, b) => b.updatedAt - a.updatedAt);
        store.activeOwnerId = remaining.length > 0 ? remaining[0].ownerId : null;
      }
      writeTranscriptAccessStore(store);
      return formatTranscriptAccessStatus(store);
    }
  }

  const existing = store.policies[ownerId] || {
    ownerId,
    mode: "open",
    allow: [],
    deny: [],
    createdAt: now,
    updatedAt: now,
    ttlMs
  };

  let nextMode = existing.mode;
  if (options.off || options.denyChildren) {
    nextMode = "deny";
  } else if (options.selfOnly) {
    nextMode = "self-only";
  } else if (options.on || options.reset) {
    nextMode = "open";
  } else if (options.mode !== undefined) {
    const m = String(options.mode).trim().toLowerCase();
    if (!["open", "allowlist", "self-only", "deny"].includes(m)) {
      throw new Error(`Invalid --mode '${options.mode}'. Expected 'open', 'allowlist', 'self-only', or 'deny'.`);
    }
    nextMode = m;
  } else if (options.allow !== undefined && existing.mode === "open") {
    // Auto-upgrade to allowlist when --allow is supplied without --mode
    nextMode = "allowlist";
  }

  const nextAllow = options.allow !== undefined ? normalizePatternList(options.allow) : existing.allow;
  const nextDeny = options.deny !== undefined ? normalizePatternList(options.deny) : existing.deny;

  store.policies[ownerId] = {
    ownerId,
    mode: nextMode,
    allow: nextAllow,
    deny: nextDeny,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    ttlMs
  };
  store.activeOwnerId = ownerId;
  writeTranscriptAccessStore(store);
  return formatTranscriptAccessStatus(store);
}

function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function isContainedInDir(targetPath, parentDir) {
  const realTarget = realOrNull(targetPath);
  const realParent = realOrNull(parentDir);
  if (!realTarget || !realParent) return false;
  const norm = (p) => (os.platform() === "win32" ? p.toLowerCase() : p);
  const nt = norm(realTarget);
  const np = norm(realParent);
  return nt === np || nt.startsWith(np.endsWith(path.sep) ? np : np + path.sep);
}

function siblingModePath(filePath, mode) {
  const isFull = mode === "full";
  if (isFull && filePath.endsWith("transcript.jsonl")) {
    const fullCandidate = filePath.replace(/transcript\.jsonl$/, "transcript_full.jsonl");
    if (fs.existsSync(fullCandidate)) return fullCandidate;
  }
  if (!isFull && filePath.endsWith("transcript_full.jsonl")) {
    const compactCandidate = filePath.replace(/transcript_full\.jsonl$/, "transcript.jsonl");
    if (fs.existsSync(compactCandidate)) return compactCandidate;
  }
  return filePath;
}

function scanBrainTranscripts(brainDirOrDirs) {
  const brainDirs = Array.isArray(brainDirOrDirs) ? brainDirOrDirs : [brainDirOrDirs];
  const candidates = [];
  for (const brainDir of brainDirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(brainDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const d of entries) {
      if (!d.isDirectory() && !d.isSymbolicLink()) continue;
      const compactPath = path.join(brainDir, d.name, ".system_generated", "logs", "transcript.jsonl");
      const fullPath = path.join(brainDir, d.name, ".system_generated", "logs", "transcript_full.jsonl");
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(compactPath).mtimeMs;
      } catch {
        try {
          mtimeMs = fs.statSync(fullPath).mtimeMs;
        } catch {
          continue;
        }
      }
      candidates.push({ convId: d.name, mtimeMs, brainDir });
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates;
}

const STANDALONE_DIRECTIVE_LINE_RE = /^(?:@[a-zA-Z0-9_-]+\s+)?\[agy-transcript-access:\s*(deny|self-only|allow)\]\s*$/i;

function extractFirstLineDirectiveFromText(bodyText) {
  if (!bodyText || typeof bodyText !== "string") return null;
  let cleaned = bodyText.replace(/<\/SYSTEM_MESSAGE>[\s\S]*$/i, "");
  cleaned = cleaned.replace(/^\s*<USER_REQUEST>\s*/i, "");
  for (const line of cleaned.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(STANDALONE_DIRECTIVE_LINE_RE);
    return m ? m[1].toLowerCase() : null;
  }
  return null;
}

/**
 * Inspects initial transcript JSONL steps (up to 48 header lines before execution turns)
 * to classify session kind (`swarm`, `subagent`, `top-level`, `unknown`) and extract `parentConvId` and `rosterName`.
 *
 * SYNC-MIRROR: Must match `getCallerLineage()` in `scripts/execution-guard-hook.mjs`.
 */
export function inspectTranscriptLineageFromFile(filePath) {
  const empty = {
    transcriptFound: false,
    isTopLevelUserSession: false,
    isChildSession: false,
    isSwarmChild: false,
    parentConvId: null,
    rosterName: null,
    sessionKind: "unknown",
    launchDirective: null,
    birthTimeMs: 0
  };
  if (!filePath || !fs.existsSync(filePath)) return empty;

  const MAX_HEADER_LINES = 48;
  let birthTimeMs = 0;
  let headStr = "";
  try {
    const st = fs.statSync(filePath);
    const candidates = [st.birthtimeMs, st.ctimeMs, st.mtimeMs].filter((n) => Number.isFinite(n) && n > 0);
    if (candidates.length > 0) birthTimeMs = Math.min(...candidates);

    const MAX_HEADER_BYTES = 524288;
    const CHUNK_SIZE = 16384;
    const chunks = [];
    let totalRead = 0;
    let newlineCount = 0;
    const fd = fs.openSync(filePath, "r");
    try {
      while (totalRead < MAX_HEADER_BYTES) {
        const toRead = Math.min(CHUNK_SIZE, MAX_HEADER_BYTES - totalRead);
        const buf = Buffer.alloc(toRead);
        const bytesRead = fs.readSync(fd, buf, 0, toRead, totalRead);
        if (bytesRead <= 0) break;
        const slice = buf.subarray(0, bytesRead);
        chunks.push(slice);
        totalRead += bytesRead;
        for (let b = 0; b < bytesRead; b++) {
          if (slice[b] === 10) newlineCount++;
        }
        if (newlineCount >= MAX_HEADER_LINES) break;
      }
      headStr = Buffer.concat(chunks).toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return empty;
  }

  let isTopLevelUserSession = false;
  let isChildSession = false;
  let isSwarmChild = false;
  let parentConvId = null;
  let boardFallbackSender = null;
  let rosterName = null;
  let launchDirective = null;
  let line0Parsed = false;

  const lines = headStr.split(/\r?\n/).filter((l) => l.trim()).slice(0, MAX_HEADER_LINES);
  for (let i = 0; i < lines.length; i++) {
    let item = null;
    try {
      item = JSON.parse(lines[i]);
      if (i === 0) line0Parsed = true;
    } catch {
      continue;
    }
    const content = typeof item?.content === "string" ? item.content : "";
    if (i === 0 && (item?.type === "USER_INPUT" || item?.source === "USER_EXPLICIT")) {
      isTopLevelUserSession = true;
      launchDirective = extractFirstLineDirectiveFromText(content);
      break;
    }

    if (item?.type === "SYSTEM_MESSAGE" || item?.source === "SYSTEM") {
      const senderMatch = content.match(/\[Message\][^\n]*\bsender=([a-zA-Z0-9_-]{4,})\b/);
      const isBoardNotification = content.includes("content=[swarm] new board message");
      if (senderMatch) {
        isChildSession = true;
        if (isBoardNotification) {
          if (!boardFallbackSender) boardFallbackSender = senderMatch[1];
        } else if (!parentConvId) {
          parentConvId = senderMatch[1];
        }
      }

      const swarmAssignMatch = content.match(
        /Your assignment \(recorded on the board as #\d+ for @([a-zA-Z0-9_-]+)\):([\s\S]*)$/
      );
      if (swarmAssignMatch) {
        isChildSession = true;
        isSwarmChild = true;
        const assignPrefix = content.slice(0, swarmAssignMatch.index);
        const assignSenders = [...assignPrefix.matchAll(/\[Message\][^\n]*\bsender=([a-zA-Z0-9_-]{4,})\b/g)];
        if (assignSenders.length > 0) {
          parentConvId = assignSenders[assignSenders.length - 1][1];
        } else if (senderMatch) {
          parentConvId = senderMatch[1];
        }
        rosterName = swarmAssignMatch[1];
        const dir = extractFirstLineDirectiveFromText(swarmAssignMatch[2]);
        if (dir) launchDirective = dir;
        break;
      }

      if (senderMatch && i === 0 && !isBoardNotification) {
        const msgBodyMatch = content.match(/\bpriority=MESSAGE_PRIORITY_[A-Z_]+\s+content=([\s\S]*)$/);
        if (msgBodyMatch) {
          const dir = extractFirstLineDirectiveFromText(msgBodyMatch[1]);
          if (dir) launchDirective = dir;
        }
      }
    } else if (i > 0) {
      break;
    }
  }
  if (!parentConvId && boardFallbackSender) {
    parentConvId = boardFallbackSender;
  }

  const transcriptFound = lines.length > 0 && line0Parsed;
  const sessionKind = isSwarmChild
    ? "swarm"
    : isChildSession
      ? "subagent"
      : isTopLevelUserSession
        ? "top-level"
        : "unknown";

  return {
    transcriptFound,
    isTopLevelUserSession,
    isChildSession,
    isSwarmChild,
    parentConvId,
    rosterName,
    sessionKind,
    launchDirective,
    birthTimeMs
  };
}

/**
 * Counts non-empty JSONL lines in a transcript file without JSON.parse overhead.
 */
export function countTranscriptStepsFast(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return 0;
  const CHUNK_SIZE = 65536;
  const buf = Buffer.allocUnsafe(CHUNK_SIZE);
  let count = 0;
  let lineHasNonWs = false;
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    while (true) {
      const bytesRead = fs.readSync(fd, buf, 0, CHUNK_SIZE, null);
      if (bytesRead <= 0) break;
      for (let i = 0; i < bytesRead; i++) {
        const byte = buf[i];
        if (byte === 10) {
          if (lineHasNonWs) {
            count++;
            lineHasNonWs = false;
          }
        } else if (byte !== 13 && byte !== 32 && byte !== 9) {
          lineHasNonWs = true;
        }
      }
    }
    if (lineHasNonWs) count++;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return count;
}

function listTranscriptConversationsInternal({
  limit = 10,
  parentId = null,
  includeLineage = false
} = {}) {
  const brainDirs = getBrainDirs();
  let resolvedParentId = null;
  if (parentId !== null && parentId !== undefined) {
    const trimmedParent = String(parentId).trim();
    if (!trimmedParent) {
      throw new Error("Flag '--parent' must be a non-empty conversation ID or 'current'.");
    }
    if (trimmedParent.toLowerCase() === "current") {
      const envId = process.env.GEMINI_CONVERSATION_ID && process.env.GEMINI_CONVERSATION_ID.trim();
      if (!envId) {
        throw new Error("Cannot resolve '--parent current': GEMINI_CONVERSATION_ID is not set. Pass an explicit parent UUID.");
      }
      resolvedParentId = envId;
    } else {
      resolvedParentId = trimmedParent;
    }
  }

  const byId = new Map();
  for (const dir of brainDirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    const brainRootName = path.basename(path.dirname(dir)) || dir;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of entries) {
      if (!d.isDirectory() || d.isSymbolicLink()) continue;
      const name = d.name;
      const convDir = path.join(dir, name);
      const compactFile = path.join(convDir, ".system_generated", "logs", "transcript.jsonl");
      const fullFile = path.join(convDir, ".system_generated", "logs", "transcript_full.jsonl");
      const targetFile = fs.existsSync(compactFile) ? compactFile : fs.existsSync(fullFile) ? fullFile : null;
      if (!targetFile) continue;
      if (!isContainedInDir(targetFile, convDir) || !isContainedInDir(targetFile, dir)) continue;
      try {
        const stat = fs.statSync(targetFile);
        const prev = byId.get(name);
        if (!prev || stat.mtimeMs > prev.mtimeMs) {
          byId.set(name, {
            conversationId: name,
            updatedAt: stat.mtime.toISOString(),
            mtimeMs: stat.mtimeMs,
            bytes: stat.size,
            filePath: realOrNull(targetFile) || targetFile,
            brainRoot: brainRootName
          });
        }
      } catch {}
    }
  }

  let entries = Array.from(byId.values()).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const wantMetadata = Boolean(includeLineage || resolvedParentId);

  if (resolvedParentId) {
    const filtered = [];
    for (const item of entries) {
      const lineage = inspectTranscriptLineageFromFile(item.filePath);
      if (lineage.parentConvId === resolvedParentId) {
        filtered.push({ ...item, _lineage: lineage });
      }
    }
    entries = filtered;
  }

  const sliced = entries.slice(0, limit).map((item) => {
    const base = {
      conversationId: item.conversationId,
      updatedAt: item.updatedAt,
      bytes: item.bytes
    };
    if (!wantMetadata) return base;
    const lineage = item._lineage || inspectTranscriptLineageFromFile(item.filePath);
    const stepCount = countTranscriptStepsFast(item.filePath);
    return {
      ...base,
      stepCount,
      parentConvId: lineage.parentConvId,
      rosterName: lineage.rosterName,
      isChildSession: lineage.isChildSession,
      isSwarmChild: lineage.isSwarmChild,
      isTopLevelUserSession: lineage.isTopLevelUserSession,
      sessionKind: lineage.sessionKind,
      brainRoot: item.brainRoot
    };
  });

  return {
    brainDirs,
    total: entries.length,
    parentFilter: resolvedParentId,
    includeLineage: wantMetadata,
    conversations: sliced
  };
}

/**
 * Lists conversations across all brain roots with optional `--parent` filtering and `--lineage` metadata.
 * Enforces `verifyTranscriptCoreAccess({ subcommand: "list" })` at the library boundary (`L39`).
 */
export function listTranscriptConversations({
  limit = 10,
  parentId = null,
  includeLineage = false
} = {}) {
  const access = verifyTranscriptCoreAccess({
    subcommand: "list",
    consumeGrant: true
  });
  if (!access.allowed) {
    return { isError: true, text: access.error, error: access.error };
  }
  return listTranscriptConversationsInternal({ limit, parentId, includeLineage });
}

/**
 * Resolves a conversation ID or explicit transcript file path.
 *
 * Security & disambiguation rules:
 * - When `explicitFile` (`--file`) is given, it must exist, be a file, and end with `.jsonl`.
 * - When `conversationId` is omitted or `"current"`, checks `GEMINI_CONVERSATION_ID`, else scans
 *   `getBrainDirs()`. If >= 2 transcripts were modified in the last 5 minutes (active swarm),
 *   returns a clear disambiguation error listing candidate UUIDs.
 * - Unless `explicitFile` or `allowExternalPaths` is true, enforces `fs.realpathSync` containment
 *   inside `realpath(brainDir)`.
 */
export function resolveTranscriptPath(target, mode = "compact", options = {}) {
  const {
    explicitFile = null,
    allowExternalPaths = false,
    subcommand = "read",
    retainGrantForFallback = false
  } = options;
  const isFull = mode === "full";
  const fileName = isFull ? "transcript_full.jsonl" : "transcript.jsonl";
  const brainDirs = getBrainDirs();
  const brainDir = brainDirs[0];

  const hasExplicitFile = explicitFile !== null && explicitFile !== undefined && String(explicitFile).trim() !== "";
  const rawTargetInput = String(target || "").trim();
  const isImplicitCurrent = !hasExplicitFile && (!rawTargetInput || rawTargetInput.toLowerCase() === "current");

  const preAccess = verifyTranscriptCoreAccess({ subcommand, consumeGrant: false, isImplicitCurrent });
  if (!preAccess.allowed) {
    return { error: preAccess.error, isGovernanceError: true };
  }

  const failResolution = (errorMsg, extra = {}) => {
    if (!retainGrantForFallback) {
      consumeTranscriptAccessGrant();
    }
    return { error: errorMsg, ...extra };
  };

  const enforceResolvedFileContainment = (candidatePath) => {
    if (preAccess.mode === "self-only") {
      if (
        !preAccess.callerConvId ||
        preAccess.callerConvId === "global" ||
        !isContainedInAnyBrainDir(candidatePath, brainDirs, preAccess.callerConvId)
      ) {
        return failResolution(
          `Antigravity Execution Governance: Cross-session '--file' access outside '${preAccess.callerConvId}' is disabled in self-only mode.`,
          { isGovernanceError: true }
        );
      }
    } else if (preAccess.hasRestriction && !isContainedInAnyBrainDir(candidatePath, brainDirs)) {
      return failResolution(
        `Security containment error: '--file' path '${candidatePath}' escapes brain directory scope [${brainDirs.join(", ")}] while a transcript access policy is active.`,
        { isGovernanceError: true }
      );
    }
    return null;
  };

  const finalizeResolution = (filePath, convId) => {
    if (preAccess.hasRestriction && !convId) {
      return failResolution(
        `Security containment error: unable to derive a valid conversation directory inside brain directories for '${filePath}'.`,
        { isGovernanceError: true }
      );
    }
    const postAccess = verifyTranscriptCoreAccess({
      targetConvId: convId,
      subcommand,
      consumeGrant: !retainGrantForFallback,
      isImplicitCurrent
    });
    if (!postAccess.allowed) {
      return { error: postAccess.error, isGovernanceError: true };
    }
    return { filePath, convId };
  };

  // 0. Explicit --file operator path
  if (hasExplicitFile) {
    const fileStr = String(explicitFile).trim();
    if (!fileStr.toLowerCase().endsWith(".jsonl")) {
      return failResolution(`Invalid --file path '${fileStr}': explicit transcript file must end with .jsonl.`);
    }
    const resolvedFile = path.resolve(fileStr);
    if (!fs.existsSync(resolvedFile)) {
      return failResolution(`Transcript file not found at --file path: '${resolvedFile}'.`);
    }
    const realFile = realOrNull(resolvedFile);
    if (!realFile) {
      return failResolution(`Unable to resolve realpath for --file path: '${resolvedFile}'.`);
    }
    try {
      if (!fs.statSync(realFile).isFile()) {
        return failResolution(`Invalid --file path '${resolvedFile}': target is not a regular file.`);
      }
    } catch (err) {
      return failResolution(`Unable to stat --file path '${resolvedFile}': ${err.message}`);
    }
    const modeCandidate = siblingModePath(realFile, mode);
    const finalPath = realOrNull(modeCandidate) || modeCandidate;
    try {
      if (!fs.statSync(finalPath).isFile()) {
        return failResolution(`Invalid --file path '${finalPath}': target is not a regular file.`);
      }
    } catch (err) {
      return failResolution(`Unable to stat --file path '${finalPath}': ${err.message}`);
    }
    const containmentErr = enforceResolvedFileContainment(finalPath);
    if (containmentErr) return containmentErr;
    return finalizeResolution(
      finalPath,
      extractConvId(finalPath, { strictBrainContainment: preAccess.hasRestriction })
    );
  }

  // 1. Omitted or "current": check GEMINI_CONVERSATION_ID, else scan <brainDirs> with active-swarm disambiguation
  let raw = rawTargetInput;
  if (!raw || raw.toLowerCase() === "current") {
    if (process.env.GEMINI_CONVERSATION_ID && process.env.GEMINI_CONVERSATION_ID.trim()) {
      raw = process.env.GEMINI_CONVERSATION_ID.trim();
    } else if (preAccess.mode === "self-only" && preAccess.callerConvId && preAccess.callerConvId !== "global") {
      raw = preAccess.callerConvId;
    } else {
      const candidates = scanBrainTranscripts(brainDirs);
      const now = Date.now();
      const recent = candidates.filter((c) => (now - c.mtimeMs) <= ACTIVE_SWARM_WINDOW_MS);

      if (recent.length >= 2) {
        const listing = recent
          .map((c) => `- ${c.convId} (modified ${Math.max(0, Math.round((now - c.mtimeMs) / 1000))}s ago)`)
          .join("\n");
        return failResolution(
          `Ambiguous active conversation: ${recent.length} transcripts in [${brainDirs.join(", ")}] were modified in the last 5 minutes (active swarm). Specify an explicit --id <uuid>:\n${listing}`,
          { candidates: recent.map((c) => c.convId) }
        );
      }
      if (recent.length === 1) {
        raw = recent[0].convId;
      } else if (candidates.length > 0) {
        raw = candidates[0].convId;
      } else {
        return failResolution(
          `No conversation transcripts found in brain directories [${brainDirs.join(", ")}]. Specify --id <uuid> or --file <path>.`
        );
      }
    }
  }

  // 2. Reject path traversal / external path tokens in --id unless allowExternalPaths is explicitly enabled
  const normalized = raw.replace(/\\/g, "/");
  if (!allowExternalPaths || preAccess.hasRestriction) {
    if (raw.includes("\0") || raw.includes("..") || raw.includes("/") || raw.includes("\\") || normalized.endsWith(".jsonl")) {
      return failResolution(
        `Invalid conversation ID '${raw}': must be a bare conversation UUID/folder inside brain directory. Use --file <path> for explicit external .jsonl files.`
      );
    }
  }

  // 3. Direct file path (legacy compatibility when allowExternalPaths === true and no restriction is active)
  if (allowExternalPaths && !preAccess.hasRestriction && normalized.endsWith(".jsonl") && fs.existsSync(normalized)) {
    const modeCandidate = siblingModePath(normalized, mode);
    const finalPath = realOrNull(modeCandidate) || modeCandidate;
    const containmentErr = enforceResolvedFileContainment(finalPath);
    if (containmentErr) return containmentErr;
    return finalizeResolution(
      finalPath,
      extractConvId(finalPath, { strictBrainContainment: preAccess.hasRestriction })
    );
  }

  // 4. UUID / Directory resolution under each <brainDir>/<id>
  const searchedCandidates = [];
  for (const dir of brainDirs) {
    const expectedSessionDir = path.join(dir, normalized);
    const checkBrainCandidate = (candidatePath) => {
      const realCandidate = realOrNull(candidatePath);
      if (!realCandidate) {
        return failResolution(`Unable to resolve realpath for '${candidatePath}'.`);
      }
      if ((!allowExternalPaths || preAccess.hasRestriction) && (!isContainedInDir(realCandidate, dir) || !isContainedInDir(realCandidate, expectedSessionDir))) {
        return failResolution(
          `Security containment error: resolved path '${realCandidate}' escapes conversation directory '${expectedSessionDir}'.`,
          { isGovernanceError: true }
        );
      }
      const derivedConvId = extractConvId(realCandidate, { strictBrainContainment: preAccess.hasRestriction }) || normalized;
      return finalizeResolution(realCandidate, derivedConvId);
    };

    const brainCandidate = path.join(expectedSessionDir, ".system_generated", "logs", fileName);
    searchedCandidates.push(brainCandidate);
    if (fs.existsSync(brainCandidate)) {
      return checkBrainCandidate(brainCandidate);
    }
    if (isFull) {
      const compactFallback = path.join(expectedSessionDir, ".system_generated", "logs", "transcript.jsonl");
      if (fs.existsSync(compactFallback)) {
        return checkBrainCandidate(compactFallback);
      }
    } else {
      const fullFallback = path.join(expectedSessionDir, ".system_generated", "logs", "transcript_full.jsonl");
      if (fs.existsSync(fullFallback)) {
        return checkBrainCandidate(fullFallback);
      }
    }
  }

  // 5. Legacy local relative/absolute directory path (only when allowExternalPaths === true and no restriction is active)
  if (allowExternalPaths && !preAccess.hasRestriction) {
    const localCandidate = path.resolve(normalized, ".system_generated", "logs", fileName);
    if (fs.existsSync(localCandidate)) {
      const realLocal = realOrNull(localCandidate) || localCandidate;
      return finalizeResolution(realLocal, extractConvId(realLocal));
    }
    const directCandidate = path.resolve(normalized, fileName);
    if (fs.existsSync(directCandidate)) {
      const realDirect = realOrNull(directCandidate) || directCandidate;
      return finalizeResolution(realDirect, extractConvId(realDirect));
    }
  }

  return failResolution(`Transcript not found for target: '${target}'. Searched: ${searchedCandidates.join(", ")}`);
}

function isUrlTokenAtOffset(str, offset) {
  let start = offset;
  while (start > 0 && !/\s/.test(str[start - 1])) {
    start--;
  }
  const tokenPrefix = str.slice(start, offset + 12);
  return /(?:https?|ftp|file|ssh|git|ws|wss):\/\//i.test(tokenPrefix);
}

function isLikelyRawBase64(token) {
  if (token.length < 256) return false;
  // Must not have '=' anywhere except up to 2 trailing padding chars
  const eqIdx = token.indexOf("=");
  if (eqIdx !== -1 && eqIdx < token.length - 2) return false;
  if (eqIdx !== -1 && !/={1,2}$/.test(token)) return false;

  // Preserve hex hashes / SHAs: pure lowercase hex OR hex containing digits 0-9
  if (/^[0-9a-f]+$/.test(token)) return false;
  if (/^[0-9a-fA-F]+$/.test(token) && /[0-9]/.test(token)) return false;

  // Preserve single-case snake_case / kebab-case / CONSTANT identifiers (e.g. long_symbol_name_...)
  if (/^[a-z_-]+$/.test(token) || /^[A-Z_-]+$/.test(token)) return false;

  // Standard or URL-safe base64 length check (mod 4 === 0, or unpadded URL-safe with _/-)
  const hasPlusSlashEq = /[+/=]/.test(token);
  const hasUrlSafe = /[_-]/.test(token);
  if (!hasPlusSlashEq && !hasUrlSafe) {
    // Alphanumeric-only token >= 256: require valid base64 quartet alignment and mixed/non-hex content
    if (token.length % 4 !== 0) return false;
  }
  return true;
}

/**
 * Sanitizes message content:
 * 1. Strips data:image base64 URIs, large non-URL/non-hex base64 payloads (>=256 chars),
 *    and Git CRLF/LF warnings BEFORE `maxChars` slicing.
 * 2. Clamps any line exceeding MAX_LINE_CHARS (even single-line logs without newlines).
 * 3. Slices to `maxChars` using either verbose banner or clean `...` ellipsis.
 */
export function cleanMessageContent(content, maxChars = MAX_TURN_CHARS, options = {}) {
  if (content === null || content === undefined) return "";
  const { truncationStyle = "banner" } = options;
  let text = typeof content === "string" ? content : JSON.stringify(content, null, 2);

  // Fast-path: short text without base64 or CRLF warning noise
  if (text.length <= 120 && !text.includes("base64") && !text.includes("will be replaced by")) {
    return truncationStyle === "ellipsis" && text.length > maxChars
      ? text.slice(0, Math.max(0, maxChars - 3)).trimEnd() + "..."
      : text;
  }

  // Cap pathological multi-MB inputs at a generous ceiling before regex passes, never at small maxChars
  const SANITIZE_CAP = Math.max(maxChars * 8, 512 * 1024);
  let wasPreCapped = false;
  const rawOrigLength = text.length;
  if (text.length > SANITIZE_CAP) {
    text = text.slice(0, SANITIZE_CAP);
    wasPreCapped = true;
  }

  // 1. Strip embedded data:image/...;base64,... BEFORE maxChars slicing
  if (text.includes("base64")) {
    text = text.replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=_-]+/g, "[Embedded Media/Binary Omitted]");
  }

  // 2. Strip tightened raw base64 payloads (>=256 chars, non-URL, non-pure-hex) BEFORE maxChars slicing
  if (text.length >= 256) {
    text = text.replace(/[A-Za-z0-9+/=_-]{256,}/g, (match, offset, fullStr) => {
      if (isUrlTokenAtOffset(fullStr, offset)) return match;
      if (!isLikelyRawBase64(match)) return match;
      return "[Binary/Base64 Payload Omitted]";
    });
  }

  // 3. Strip Git CRLF/LF line-ending diagnostic warning noise BEFORE maxChars slicing
  if (text.includes("will be replaced by")) {
    text = text.replace(
      /(?:#\s*)?warning:\s*(?:in the working copy of [^,\r\n]+,\s*)?(?:CRLF will be replaced by LF|LF will be replaced by CRLF)[^\r\n]*(?:\r?\n)?/gi,
      ""
    );
  }

  // 4. Always clamp lines exceeding MAX_LINE_CHARS, even for single-line logs without newlines
  if (text.length > MAX_LINE_CHARS && truncationStyle !== "ellipsis") {
    const lines = text.split("\n");
    let changed = false;
    const clampedLines = lines.map((l) => {
      if (l.length > MAX_LINE_CHARS) {
        changed = true;
        return l.slice(0, MAX_LINE_CHARS) + " ... [line clamped]";
      }
      return l;
    });
    if (changed) {
      text = clampedLines.join("\n");
    }
  }

  const effectiveLength = wasPreCapped ? rawOrigLength : text.length;
  if (effectiveLength > maxChars || text.length > maxChars) {
    if (truncationStyle === "ellipsis") {
      const collapsed = text.replace(/\s+/g, " ").trim();
      if (collapsed.length <= maxChars) return collapsed;
      return collapsed.slice(0, Math.max(0, maxChars - 3)).trimEnd() + "...";
    }
    const omitted = Math.max(effectiveLength - maxChars, 0);
    return text.slice(0, maxChars) + `\n\n... [Content Truncated (${omitted} chars omitted to preserve token budget)] ...`;
  }
  return text;
}

function unwrapCompactArgValue(v) {
  if (typeof v !== "string") return v;
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const parsed = JSON.parse(v);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Keep original string if not valid JSON string literal
    }
  }
  return v;
}

const LARGE_BODY_ARG_KEYS = new Set(["Content", "content", "Replacement", "Target", "CodeContent", "brief"]);

export function formatArgumentDescriptor(k, v, options = {}) {
  const { fullArgs = false } = options;
  const val = unwrapCompactArgValue(v);
  if (typeof val === "string") {
    if (fullArgs && LARGE_BODY_ARG_KEYS.has(k) && val.length > 600) {
      const preview = val.replace(/[\r\n\t]+/g, " ").slice(0, 240).trim();
      const sizeKb = (Buffer.byteLength(val, "utf8") / 1024).toFixed(1);
      return `${k}="${preview}..." [${sizeKb} KB body; use 'step --step <N> --field tool_args' for full text]`;
    }
    if (fullArgs || (val.length <= 80 && !val.includes("\n"))) {
      return `${k}=${JSON.stringify(val)}`;
    }
    const preview = val.replace(/[\r\n\t]+/g, " ").slice(0, 50).trim();
    const sizeKb = (Buffer.byteLength(val, "utf8") / 1024).toFixed(1);
    return `${k}="${preview}..." [${sizeKb} KB]`;
  }
  if (typeof val === "number" || typeof val === "boolean" || val === null) {
    return `${k}=${val}`;
  }
  if (fullArgs) {
    return `${k}=${JSON.stringify(val)}`;
  }
  if (Array.isArray(val)) {
    return `${k}=[Array(${val.length})]`;
  }
  if (typeof val === "object") {
    const keys = Object.keys(val);
    return `${k}={Object(${keys.length} keys)}`;
  }
  return `${k}=${String(val).slice(0, 60)}`;
}

const KEY_ARG_PRIORITY = [
  "Path", "path", "TargetFile", "targetFile", "AbsolutePath",
  "CommandLine", "command", "query", "SearchQuery", "Pattern",
  "TaskId", "taskId", "Action", "action", "url", "Url", "Prompt", "prompt"
];

export function formatCompactToolList(toolCalls, options = {}) {
  const { fullArgs = false } = options;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return "";
  return toolCalls
    .map((tc) => {
      const name = tc.name || tc.tool_name || "unknown_tool";
      const args = tc.args || tc.arguments || {};
      const keys = Object.keys(args);
      if (keys.length === 0) return `${name}()`;
      if (fullArgs) {
        const allPairs = Object.entries(args)
          .map(([k, v]) => formatArgumentDescriptor(k, v, { fullArgs: true }))
          .join(", ");
        return `${name}(${allPairs})`;
      }
      let chosenKey = KEY_ARG_PRIORITY.find((k) => Object.prototype.hasOwnProperty.call(args, k) && args[k] !== undefined && args[k] !== "");
      if (!chosenKey) chosenKey = keys[0];
      const val = unwrapCompactArgValue(args[chosenKey]);
      let valStr;
      if (typeof val === "string") {
        const flat = val.replace(/\s+/g, " ").trim();
        valStr = flat.length > 36 ? `${flat.slice(0, 33)}...` : flat;
        valStr = JSON.stringify(valStr);
      } else if (typeof val === "number" || typeof val === "boolean" || val === null) {
        valStr = String(val);
      } else {
        valStr = Array.isArray(val) ? `[${val.length}]` : "{...}";
      }
      return `${name}(${chosenKey}=${valStr})`;
    })
    .join(", ");
}

export function normalizeRoleLabel(item) {
  const type = String(item?.type || "UNKNOWN").toUpperCase();
  if (type === "USER_INPUT") return "USER";
  if (type === "PLANNER_RESPONSE") return "ASSISTANT";
  if (type === "SUBAGENT_RESPONSE") return "SUBAGENT";
  return type;
}

export function isStructuredErrorItem(item) {
  if (!item || typeof item !== "object") return false;
  if (String(item.status || "").toUpperCase() === "ERROR") return true;
  if (item.error !== undefined && item.error !== null && item.error !== false) return true;
  if (item.isError === true) return true;
  if (Array.isArray(item.tool_calls)) {
    for (const tc of item.tool_calls) {
      if (!tc || typeof tc !== "object") continue;
      if (String(tc.status || "").toUpperCase() === "ERROR") return true;
      if (tc.error !== undefined && tc.error !== null && tc.error !== false) return true;
      if (tc.isError === true) return true;
    }
  }
  const type = String(item.type || "").toUpperCase();
  if ((type === "GENERIC" || type === "TOOL_RESULT") && typeof item.content === "string") {
    const header = item.content.split(/\r?\n\r?\nCommand output:/)[0].slice(0, 600);
    if (/(?:^|\n)Command exited with code (?!0\b)\d+\./.test(header)) return true;
    if (/(?:^|\n)Encountered error in tool execution:/.test(header)) return true;
  }
  return false;
}

export function formatTranscriptItem(item, options = {}) {
  const {
    includeThinking = false,
    includeToolCalls = false,
    fullArgs = false,
    field = null,
    maxContentChars = MAX_TURN_CHARS
  } = options;
  const stepIdx = item.step_index !== undefined ? item.step_index : "?";
  const role = normalizeRoleLabel(item);
  const time = item.created_at ? item.created_at.replace(/\.\d+Z$/, "Z") : "";
  const timeStr = time ? ` (${time})` : "";
  const errorBadge = isStructuredErrorItem(item) ? " [ERROR]" : "";

  const normalizedField = field ? String(field).trim() : null;
  if (normalizedField && normalizedField !== "all") {
    const single = formatSingleStepDetail(item, stepIdx, normalizedField, { capLargeFileBodies: true });
    return single.text;
  }

  const parts = [];
  parts.push(`### [Step ${stepIdx} | ${role}]${errorBadge}${timeStr}`);

  if (includeThinking && item.thinking) {
    const cleanThinking = cleanMessageContent(item.thinking, 4000);
    parts.push(`> <thinking>\n> ${cleanThinking.split("\n").join("\n> ")}\n> </thinking>`);
  }

  if ((includeToolCalls || fullArgs || role === "ASSISTANT") && Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
    const tcSummary = item.tool_calls.map((tc) => {
      const name = tc.name || tc.tool_name || "unknown_tool";
      const args = tc.args || tc.arguments || {};
      const compactArgs = Object.entries(args)
        .map(([k, v]) => formatArgumentDescriptor(k, v, { fullArgs }))
        .join(", ");
      return `- \`${name}(${compactArgs})\``;
    });
    parts.push(`**Tool Calls (${item.tool_calls.length}):**\n${tcSummary.join("\n")}`);
  }

  if (item.content) {
    const cleaned = cleanMessageContent(item.content, maxContentChars);
    if (cleaned.trim()) {
      parts.push(cleaned.trim());
    }
  }

  return parts.join("\n\n");
}

const regexCache = new Map();
const MAX_REGEX_CACHE_ENTRIES = 100;

export function getCompiledRegex(pattern) {
  if (!pattern || typeof pattern !== "string") return null;
  const cached = regexCache.get(pattern);
  if (cached) return cached;

  let rx;
  try {
    rx = new RegExp(pattern, "i");
  } catch {
    rx = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }

  if (regexCache.size >= MAX_REGEX_CACHE_ENTRIES) {
    const firstKey = regexCache.keys().next().value;
    regexCache.delete(firstKey);
  }
  regexCache.set(pattern, rx);
  return rx;
}

export async function batchFindFullSteps(fullPath, stepIndicesSet) {
  const result = new Map();
  if (!stepIndicesSet || stepIndicesSet.size === 0 || !fullPath) return result;

  let fileStream;
  let rl;
  try {
    fileStream = fs.createReadStream(fullPath, { encoding: "utf-8" });
    rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (stepIndicesSet.has(item.step_index)) {
          result.set(item.step_index, item);
          if (result.size >= stepIndicesSet.size) {
            break;
          }
        }
      } catch {}
    }
  } catch {} finally {
    if (rl) rl.close();
    if (fileStream) fileStream.destroy();
  }
  return result;
}

export async function findFullStep(fullPath, targetStepIndex) {
  const map = await batchFindFullSteps(fullPath, new Set([targetStepIndex]));
  return map.get(targetStepIndex) || null;
}

function itemMatchesRole(item, roleSet, matchAllRoles) {
  if (matchAllRoles) return true;
  const type = String(item.type || "").toUpperCase();
  if (roleSet.has("user") && type === "USER_INPUT") return true;
  if (roleSet.has("assistant") && type === "PLANNER_RESPONSE") return true;
  if (roleSet.has("subagent") && type === "SUBAGENT_RESPONSE") return true;
  if (roleSet.has("generic") && type === "GENERIC") return true;
  if (roleSet.has("system") && type === "SYSTEM_MESSAGE") return true;
  if (roleSet.has("tool") && Array.isArray(item.tool_calls) && item.tool_calls.length > 0) return true;
  if (roleSet.has("error") && isStructuredErrorItem(item)) return true;
  return false;
}

function itemMatchesQuery(item, queryRegex) {
  if (!queryRegex) return true;
  if (typeof item.content === "string" && queryRegex.test(item.content)) return true;
  if (item.content && typeof item.content !== "string" && queryRegex.test(JSON.stringify(item.content))) return true;
  if (typeof item.thinking === "string" && queryRegex.test(item.thinking)) return true;
  if (Array.isArray(item.tool_calls) && item.tool_calls.length > 0 && queryRegex.test(JSON.stringify(item.tool_calls))) return true;
  return false;
}

/**
 * Bounded streaming reader for Antigravity compact & full transcripts.
 */
export async function readTranscript({
  conversationId,
  filePath: explicitFile,
  mode = "compact",
  lastTurns = 3,
  offset,
  limit,
  includeThinking = false,
  allowExternalPaths = false
} = {}) {
  const resolved = resolveTranscriptPath(conversationId, mode, {
    explicitFile,
    allowExternalPaths,
    subcommand: "read"
  });
  if (resolved.error) {
    return { isError: true, text: resolved.error, error: resolved.error, candidates: resolved.candidates };
  }

  const { filePath, convId } = resolved;
  const hasExplicitPagination = offset !== undefined || limit !== undefined;
  const parsedLastTurns = Number(lastTurns);
  const effectiveLastTurns = Number.isFinite(parsedLastTurns) ? parsedLastTurns : 3;

  const pageOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const pageLimit = Math.min(MAX_BOUNDED_READ_STEPS, Math.max(1, Math.floor(Number(limit) || 50)));
  const ringCap = effectiveLastTurns > 0
    ? Math.min(2000, Math.max(100, effectiveLastTurns * 25))
    : MAX_BOUNDED_READ_STEPS;

  const ringBuffer = hasExplicitPagination ? null : new CircularRingBuffer(ringCap);
  const pageLines = hasExplicitPagination ? [] : null;

  let fileStream;
  let rl;
  let totalStepsCount = 0;

  try {
    fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
    rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (hasExplicitPagination) {
        if (totalStepsCount >= pageOffset && pageLines.length < pageLimit) {
          pageLines.push(trimmed);
        }
        totalStepsCount++;
        if (pageLines.length >= pageLimit) {
          break;
        }
      } else {
        totalStepsCount++;
        ringBuffer.push(trimmed);
      }
    }
  } catch (err) {
    const msg = `Error reading transcript stream: ${err.message}`;
    return { isError: true, text: msg, error: msg };
  } finally {
    if (rl) rl.close();
    if (fileStream) fileStream.destroy();
  }

  if (totalStepsCount === 0) {
    const msg = `Transcript is empty at: ${filePath}`;
    return { convId, filePath, mode, totalSteps: 0, selectedSteps: 0, displayedSteps: 0, clamped: false, steps: [], text: msg };
  }

  const rawLines = hasExplicitPagination ? pageLines : ringBuffer.toArray();
  const items = [];
  for (let i = 0; i < rawLines.length; i++) {
    try {
      const parsed = JSON.parse(rawLines[i]);
      if (parsed._ordinal === undefined) parsed._ordinal = i;
      items.push(parsed);
    } catch {
      // Tolerates incomplete trailing flushes during concurrent writes
    }
  }

  let selected = items;
  if (!hasExplicitPagination && effectiveLastTurns > 0) {
    const userTurnItems = items.filter((it) => it.type === "USER_INPUT");
    const turnItems = userTurnItems.length > 0
      ? userTurnItems
      : items.filter((it) => it.type === "PLANNER_RESPONSE");
    const cutoff = Math.max(0, turnItems.length - effectiveLastTurns);
    const anchor = turnItems[cutoff];
    if (anchor) {
      const minStep = anchor.step_index !== undefined ? anchor.step_index : anchor._ordinal;
      selected = items.filter((it) => (it.step_index !== undefined ? it.step_index : it._ordinal) >= minStep);
    }
  }

  const maxWindowChars = mode === "compact" ? 3800 : MAX_OUTPUT_CHARS;
  const buildHeader = (displayedCount) => {
    const scopeDesc = hasExplicitPagination
      ? `page offset=${pageOffset}, limit=${pageLimit}`
      : effectiveLastTurns > 0
        ? `${effectiveLastTurns} turns`
        : `all (bounded window ${selected.length} steps)`;
    return [
      `# Conversation Transcript: \`${convId}\``,
      `- Mode: **${mode}** (${path.basename(filePath)})`,
      `- Total Steps in Log: ${hasExplicitPagination ? `${totalStepsCount}+ (paged)` : totalStepsCount}`,
      `- Displayed Steps: ${displayedCount} (showing last ${scopeDesc})`,
      "",
      "---",
      ""
    ].join("\n");
  };

  // Reserve exact header space based on worst-case header size, then rebuild header with actual count
  const provisionalHeaderLen = buildHeader(selected.length).length + 16;
  const formattedBlocks = [];
  const displayedItems = [];
  let currentLength = provisionalHeaderLen;
  let clamped = false;

  if (hasExplicitPagination) {
    for (let i = 0; i < selected.length; i++) {
      const item = selected[i];
      const isDialogueTurn =
        item.type === "USER_INPUT" ||
        item.type === "PLANNER_RESPONSE" ||
        item.type === "SUBAGENT_RESPONSE";
      const block = formatTranscriptItem(item, {
        includeThinking,
        includeToolCalls: true,
        maxContentChars: mode === "compact" && !isDialogueTurn ? 300 : MAX_TURN_CHARS
      });
      if (currentLength + block.length + 6 > maxWindowChars && formattedBlocks.length > 0) {
        clamped = true;
        break;
      }
      formattedBlocks.push(block);
      displayedItems.push(item);
      currentLength += block.length + 6;
    }
  } else {
    for (let i = selected.length - 1; i >= 0; i--) {
      const item = selected[i];
      const isDialogueTurn =
        item.type === "USER_INPUT" ||
        item.type === "PLANNER_RESPONSE" ||
        item.type === "SUBAGENT_RESPONSE";
      const block = formatTranscriptItem(item, {
        includeThinking,
        includeToolCalls: true,
        maxContentChars: mode === "compact" && !isDialogueTurn ? 300 : MAX_TURN_CHARS
      });
      if (currentLength + block.length + 6 > maxWindowChars && formattedBlocks.length > 0) {
        clamped = true;
        break;
      }
      formattedBlocks.unshift(block);
      displayedItems.unshift(item);
      currentLength += block.length + 6;
    }
  }

  const header = buildHeader(formattedBlocks.length);
  let fullOutput = header + formattedBlocks.join("\n\n---\n\n");
  if (clamped) {
    const ceilingLabel = mode === "compact" ? "3.8 KB inline" : "24 KB";
    fullOutput += `\n\n... [Transcript display clamped at ${ceilingLabel} safety ceiling; use \`agy-context transcript step --id ${convId} --step <N,M,K|N-M> [--field tool_args|content]\` or \`agy-context transcript query --id ${convId} --summary\`] ...`;
  }

  return {
    convId,
    filePath,
    mode,
    totalSteps: totalStepsCount,
    selectedSteps: selected.length,
    displayedSteps: formattedBlocks.length,
    clamped,
    steps: displayedItems,
    text: fullOutput
  };
}

const MAX_BATCH_STEPS = 200;

export function parseStepSelector(stepIndex, startStep, endStep) {
  const indexSet = new Set();
  let isMulti = false;

  const hasStart = startStep !== undefined && startStep !== null && startStep !== "";
  const hasEnd = endStep !== undefined && endStep !== null && endStep !== "";

  if (hasStart || hasEnd) {
    if (!hasStart || !hasEnd) {
      return { error: "Error: Both '--start' and '--end' must be provided when specifying a step range." };
    }
    const s = Number(startStep);
    const e = Number(endStep);
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < s) {
      return { error: `Error: Invalid step range start=${startStep}, end=${endStep} (expected non-negative integers with end >= start).` };
    }
    if (e - s + 1 > MAX_BATCH_STEPS) {
      return { error: `Error: Step range ${s}..${e} exceeds maximum batch size of ${MAX_BATCH_STEPS} steps.` };
    }
    isMulti = true;
    for (let idx = s; idx <= e; idx++) {
      indexSet.add(idx);
    }
  }

  if (stepIndex !== undefined && stepIndex !== null && stepIndex !== "") {
    if (typeof stepIndex === "number") {
      if (!Number.isInteger(stepIndex) || stepIndex < 0) {
        return { error: `Error: 'stepIndex' must be a non-negative integer (received: ${stepIndex}).` };
      }
      indexSet.add(stepIndex);
    } else if (Array.isArray(stepIndex)) {
      isMulti = true;
      for (const part of stepIndex) {
        const sub = parseStepSelector(part);
        if (sub.error) return sub;
        for (const idx of sub.indices) indexSet.add(idx);
      }
    } else {
      const raw = String(stepIndex).trim();
      if (/^\d+$/.test(raw)) {
        indexSet.add(Number(raw));
      } else if (/^\d+(?:\s*(?:,|-|\.\.)\s*\d+)+$/.test(raw)) {
        isMulti = true;
        const segments = raw.split(",").map((s) => s.trim()).filter(Boolean);
        for (const seg of segments) {
          const rangeMatch = seg.match(/^(\d+)\s*(?:-|\.\.)\s*(\d+)$/);
          if (rangeMatch) {
            const s = Number(rangeMatch[1]);
            const e = Number(rangeMatch[2]);
            if (e < s) {
              return { error: `Error: Invalid step range '${seg}' (end must be >= start).` };
            }
            if (e - s + 1 > MAX_BATCH_STEPS) {
              return { error: `Error: Step range '${seg}' exceeds maximum batch size of ${MAX_BATCH_STEPS} steps.` };
            }
            for (let idx = s; idx <= e; idx++) indexSet.add(idx);
          } else if (/^\d+$/.test(seg)) {
            indexSet.add(Number(seg));
          } else {
            return { error: `Error: 'stepIndex' must be a number, comma-separated list, or range (received: ${stepIndex}).` };
          }
        }
      } else {
        return { error: `Error: 'stepIndex' must be a number (received: ${stepIndex}).` };
      }
    }
  }

  if (indexSet.size === 0) {
    return { error: `Error: 'stepIndex' must be a number (received: ${stepIndex}).` };
  }
  if (indexSet.size > MAX_BATCH_STEPS) {
    return { error: `Error: Requested ${indexSet.size} steps, exceeding maximum batch size of ${MAX_BATCH_STEPS}.` };
  }

  const indices = Array.from(indexSet).sort((a, b) => a - b);
  if (indices.length > 1) isMulti = true;
  return { indices, isMulti };
}

function applyLineSlice(str, { headLines, tailLines } = {}) {
  if (!str || typeof str !== "string") return str;
  const h = Number(headLines);
  const t = Number(tailLines);
  if (Number.isFinite(h) && h > 0) {
    const lines = str.split("\n");
    if (lines.length > h) return lines.slice(0, h).join("\n");
    if (lines.length === 1 && str.length > h * 120) return str.slice(0, h * 120);
  }
  if (Number.isFinite(t) && t > 0) {
    const lines = str.split("\n");
    if (lines.length > t) return lines.slice(-t).join("\n");
    if (lines.length === 1 && str.length > t * 120) return str.slice(-(t * 120));
  }
  return str;
}

export function formatSingleStepDetail(step, numIndex, field, options = {}) {
  const { maxFieldChars = MAX_FIELD_CHARS, capLargeFileBodies = false, headLines, tailLines } = options;
  const f = field ? String(field).trim() : "all";
  const effectiveStep = (headLines || tailLines) && step && typeof step.content === "string"
    ? { ...step, content: applyLineSlice(step.content, { headLines, tailLines }) }
    : step;

  if (f === "content") {
    const val = String(effectiveStep.content || "(No content in step)");
    const body = val.length > maxFieldChars
      ? `${val.slice(0, maxFieldChars)}\n... [Step ${numIndex} truncated in batch view; run --step ${numIndex} [--tail <lines>] for full 24 KB view]`
      : val;
    const text = `### Step ${numIndex} Content\n\n${body}`;
    return { stepIndex: numIndex, field: f, step: effectiveStep, data: effectiveStep.content ?? null, text };
  }

  if (f === "thinking") {
    const val = applyLineSlice(String(step.thinking || "(No thinking block in step)"), { headLines, tailLines });
    const body = val.length > maxFieldChars
      ? `${val.slice(0, maxFieldChars)}\n... [Step ${numIndex} truncated in batch view; run --step ${numIndex} for full 24 KB view]`
      : val;
    const text = `### Step ${numIndex} Thinking\n\n${body}`;
    return { stepIndex: numIndex, field: f, step, data: step.thinking ?? null, text };
  }

  if (f === "tool_calls") {
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    const val = JSON.stringify(calls, null, 2);
    const text = `### Step ${numIndex} Tool Calls (${calls.length})\n\`\`\`json\n${val.slice(0, maxFieldChars)}\n\`\`\``;
    return { stepIndex: numIndex, field: f, step, data: calls, text };
  }

  if (f === "tool_args" || f.startsWith("tool_args:")) {
    const argName = f.includes(":") ? f.slice(f.indexOf(":") + 1).trim() : null;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    if (calls.length === 0) {
      const text = `Step ${numIndex} contains no tool calls.`;
      return { stepIndex: numIndex, field: f, step, data: [], text };
    }

    const mappedCalls = calls.map((tc, idx) => {
      const name = tc.name || tc.tool_name || "unknown_tool";
      const tcArgs = tc.args || tc.arguments || {};
      if (!capLargeFileBodies) {
        return { index: idx, name, args: tcArgs };
      }
      const displayArgs = {};
      for (const [k, v] of Object.entries(tcArgs)) {
        const un = unwrapCompactArgValue(v);
        if (typeof un === "string" && LARGE_BODY_ARG_KEYS.has(k) && un.length > 600) {
          displayArgs[k] = `${un.slice(0, 300)}... [${un.length} chars; use 'step --step ${numIndex} --field tool_args' for full text]`;
        } else {
          displayArgs[k] = un;
        }
      }
      return { index: idx, name, args: tcArgs, displayArgs };
    });

    if (argName) {
      const extracted = mappedCalls.map((entry) => ({
        index: entry.index,
        name: entry.name,
        hasKey: Object.prototype.hasOwnProperty.call(entry.args, argName),
        value: entry.args[argName]
      }));

      let text;
      if (extracted.length === 1) {
        const displayVal = typeof extracted[0].value === "string"
          ? extracted[0].value
          : JSON.stringify(extracted[0].value, null, 2);
        text = `### Step ${numIndex} Argument: \`${argName}\`\n\n${String(displayVal).slice(0, maxFieldChars)}`;
      } else {
        const sections = extracted.map((entry) => {
          const valStr = entry.hasKey
            ? (typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value, null, 2))
            : "(not present)";
          return `- **[${entry.index}] \`${entry.name}\`**:\n${String(valStr)}`;
        });
        text = `### Step ${numIndex} Argument: \`${argName}\` (across ${extracted.length} tool calls)\n\n${sections.join("\n\n").slice(0, maxFieldChars)}`;
      }
      return { stepIndex: numIndex, field: f, step, data: extracted, text };
    }

    let text;
    if (mappedCalls.length === 1) {
      const renderedArgs = mappedCalls[0].displayArgs || mappedCalls[0].args;
      text = `### Step ${numIndex} Tool Arguments (1 tool call: \`${mappedCalls[0].name}\`)\n\`\`\`json\n${JSON.stringify(renderedArgs, null, 2).slice(0, maxFieldChars)}\n\`\`\``;
    } else {
      const blocks = mappedCalls.map(
        (entry) => `#### [${entry.index}] \`${entry.name}\`\n\`\`\`json\n${JSON.stringify(entry.displayArgs || entry.args, null, 2)}\n\`\`\``
      );
      text = `### Step ${numIndex} Tool Arguments (${mappedCalls.length} tool calls)\n\n${blocks.join("\n\n").slice(0, maxFieldChars)}`;
    }
    return { stepIndex: numIndex, field: f, step, data: mappedCalls.map(({ index, name, args }) => ({ index, name, args })), text };
  }

  const formatted = formatTranscriptItem(effectiveStep, {
    includeThinking: true,
    includeToolCalls: true,
    fullArgs: true,
    maxContentChars: maxFieldChars
  });
  return { stepIndex: numIndex, field: "all", step: effectiveStep, data: effectiveStep, text: formatted };
}

/**
 * Surgical single-step or multi-step batch extraction (`step` subcommand / `stepIndex` mode).
 * Supports `--step N`, `--step N,M,K`, `--step N-M` / `N..M`, and `--start N --end M`,
 * plus `tool_args` and `tool_args:<Key>` across ALL `step.tool_calls[0..N]`.
 */
export async function getStepDetail({
  conversationId,
  filePath: explicitFile,
  stepIndex,
  startStep,
  endStep,
  field,
  headLines,
  tailLines,
  allowExternalPaths = false
} = {}) {
  const parsedSelector = parseStepSelector(stepIndex, startStep, endStep);
  if (parsedSelector.error) {
    consumeTranscriptAccessGrant();
    return { isError: true, text: parsedSelector.error, error: parsedSelector.error };
  }

  const { indices, isMulti } = parsedSelector;
  const targetSet = new Set(indices);

  let resolvedFull;
  let resolvedCompact;
  try {
    resolvedFull = resolveTranscriptPath(conversationId, "full", {
      explicitFile,
      allowExternalPaths,
      subcommand: "step",
      retainGrantForFallback: true
    });
    if (resolvedFull.error && (explicitFile || resolvedFull.isGovernanceError)) {
      return { isError: true, text: resolvedFull.error, error: resolvedFull.error, candidates: resolvedFull.candidates };
    }
    resolvedCompact = resolveTranscriptPath(conversationId, "compact", {
      explicitFile,
      allowExternalPaths,
      subcommand: "step",
      retainGrantForFallback: false
    });
  } finally {
    consumeTranscriptAccessGrant();
  }

  if (resolvedCompact.error && !resolvedFull.filePath) {
    return { isError: true, text: resolvedCompact.error, error: resolvedCompact.error, candidates: resolvedCompact.candidates };
  }

  let usedConvId = resolvedFull.convId || resolvedCompact.convId;
  let usedFilePath = resolvedFull.filePath || resolvedCompact.filePath;
  const foundMap = new Map();

  if (resolvedFull && resolvedFull.filePath && fs.existsSync(resolvedFull.filePath)) {
    const fullMatches = await batchFindFullSteps(resolvedFull.filePath, targetSet);
    for (const [k, v] of fullMatches.entries()) {
      foundMap.set(k, v);
    }
  }

  if (foundMap.size < targetSet.size) {
    const missingSet = new Set(indices.filter((idx) => !foundMap.has(idx)));
    if (
      resolvedCompact &&
      resolvedCompact.filePath &&
      resolvedCompact.filePath !== resolvedFull.filePath &&
      fs.existsSync(resolvedCompact.filePath)
    ) {
      if (foundMap.size === 0) usedFilePath = resolvedCompact.filePath;
      const compactMatches = await batchFindFullSteps(resolvedCompact.filePath, missingSet);
      for (const [k, v] of compactMatches.entries()) {
        foundMap.set(k, v);
      }
    }
  }

  if (!isMulti) {
    const numIndex = indices[0];
    const step = foundMap.get(numIndex);
    if (!step) {
      const msg = `Step index ${numIndex} not found in transcript.`;
      return { isError: true, text: msg, error: msg };
    }
    const single = formatSingleStepDetail(step, numIndex, field, { headLines, tailLines });
    return {
      convId: usedConvId,
      filePath: usedFilePath,
      stepIndex: numIndex,
      field: single.field,
      step: single.step,
      data: single.data,
      text: single.text
    };
  }

  const foundSteps = [];
  const missingSteps = [];
  const perStepMaxChars = Math.max(2000, Math.min(8000, Math.floor(MAX_FIELD_CHARS / Math.max(1, indices.length))));
  for (const idx of indices) {
    const step = foundMap.get(idx);
    if (step) {
      foundSteps.push(
        formatSingleStepDetail(step, idx, field, {
          maxFieldChars: perStepMaxChars,
          capLargeFileBodies: indices.length >= 3,
          headLines,
          tailLines
        })
      );
    } else {
      missingSteps.push(idx);
    }
  }

  if (foundSteps.length === 0) {
    const msg = `Step indices [${indices.join(", ")}] not found in transcript.`;
    return { isError: true, text: msg, error: msg };
  }

  const normalizedField = foundSteps[0].field;
  const blocks = foundSteps.map((s) => s.text);
  let joined = blocks.join("\n\n---\n\n");
  if (joined.length > MAX_FIELD_CHARS) {
    joined = joined.slice(0, MAX_FIELD_CHARS) + "\n\n... [Batch step output clamped at 24,000-character safety ceiling] ...";
  }

  return {
    convId: usedConvId,
    filePath: usedFilePath,
    stepIndex: foundSteps[0].stepIndex,
    stepIndices: foundSteps.map((s) => s.stepIndex),
    requestedSteps: indices,
    missingSteps,
    field: normalizedField,
    steps: foundSteps.map((s) => ({ stepIndex: s.stepIndex, step: s.step, data: s.data })),
    data: foundSteps.map((s) => ({ stepIndex: s.stepIndex, data: s.data })),
    text: joined
  };
}

/**
 * Forensic streaming query engine across Antigravity transcripts.
 */
export async function queryTranscript(args = {}) {
  const {
    conversationId,
    filePath: explicitFile,
    query,
    roles = ["all"],
    mode = "auto",
    startStep,
    endStep,
    lastTurns,
    includeThinking = false,
    includeToolCalls = false,
    fullArgs = false,
    maxResults,
    summaryOnly = false,
    stepIndex,
    field,
    allowExternalPaths = false,
    subcommand = "query"
  } = args;

    if (stepIndex !== undefined && stepIndex !== null) {
    return getStepDetail({
      conversationId,
      filePath: explicitFile,
      stepIndex,
      startStep,
      endStep,
      field,
      allowExternalPaths
    });
  }

  const effectiveSubcommand =
    canonicalizeTranscriptSubcommand(subcommand) === "read" && Boolean(summaryOnly) && !query
      ? "read"
      : "query";

  const normalizedField = field ? String(field).trim() : null;
  const fieldImpliesTools = Boolean(
    normalizedField === "tool_args" ||
    normalizedField === "tool_calls" ||
    (normalizedField && normalizedField.startsWith("tool_args:"))
  );
  const effectiveFullArgs = Boolean(fullArgs || fieldImpliesTools);
  const effectiveIncludeTools = Boolean(includeToolCalls || effectiveFullArgs);

  const resolved = resolveTranscriptPath(conversationId, mode === "full" ? "full" : "compact", {
    explicitFile,
    allowExternalPaths,
    subcommand: effectiveSubcommand
  });
  if (resolved.error) {
    return { isError: true, text: resolved.error, error: resolved.error, candidates: resolved.candidates };
  }

  const { filePath, convId } = resolved;
  const verifiedParentDir = path.dirname(realOrNull(filePath) || filePath);
  const rawFullSiblingPath = filePath.endsWith("transcript_full.jsonl")
    ? filePath
    : filePath.replace(/transcript\.jsonl$/, "transcript_full.jsonl");
  let fullSiblingPath = null;
  if (rawFullSiblingPath === filePath) {
    fullSiblingPath = filePath;
  } else if (fs.existsSync(rawFullSiblingPath)) {
    const realSibling = realOrNull(rawFullSiblingPath);
    try {
      if (realSibling && fs.statSync(realSibling).isFile() && isContainedInDir(realSibling, verifiedParentDir)) {
        fullSiblingPath = realSibling;
      }
    } catch {}
  }

  const roleList = Array.isArray(roles)
    ? roles
    : String(roles || "user,assistant").split(",").map((s) => s.trim()).filter(Boolean);
  const roleSet = new Set(roleList.map((r) => String(r).toLowerCase()));
  const matchAllRoles = roleSet.has("all");

  const queryRegex = getCompiledRegex(query);
  const isPlainLiteral = Boolean(query && /^[A-Za-z0-9_ -]+$/.test(query));

  const hasExplicitStepRange =
    startStep !== undefined &&
    startStep !== null &&
    endStep !== undefined &&
    endStep !== null &&
    Number.isFinite(Number(startStep)) &&
    Number.isFinite(Number(endStep)) &&
    Number(endStep) >= Number(startStep);
  const rangeSpan = hasExplicitStepRange
    ? Math.min(500, Math.floor(Number(endStep)) - Math.floor(Number(startStep)) + 1)
    : 0;
  const defaultMaxResults = hasExplicitStepRange
    ? (summaryOnly || normalizedField ? Math.max(30, rangeSpan) : Math.max(5, rangeSpan))
    : (summaryOnly ? 30 : (normalizedField ? 25 : 5));
  const parsedMax = Number(maxResults);
  const effectiveMaxResults = Number.isFinite(parsedMax) && parsedMax > 0 ? Math.floor(parsedMax) : defaultMaxResults;

  const parsedLastTurns = Number(lastTurns);
  const effectiveLastTurns = Number.isFinite(parsedLastTurns) && parsedLastTurns > 0 ? Math.floor(parsedLastTurns) : 0;

  // Ring buffer capacity must hold all steps within the last N dialogue turns, never collapsing turns to steps
  const ringCap = effectiveLastTurns > 0
    ? Math.max(effectiveMaxResults, effectiveLastTurns * 25, 200)
    : effectiveMaxResults;

  const compactRing = new CircularRingBuffer(ringCap);
  const userTurnStepRing = effectiveLastTurns > 0 ? new CircularRingBuffer(effectiveLastTurns) : null;
  const plannerTurnStepRing = effectiveLastTurns > 0 ? new CircularRingBuffer(effectiveLastTurns) : null;

  // For ACS-MCP-02: collect compact lines with truncated_fields when query missed compact snippet in mode="auto"
  const truncatedCandidateSteps = [];
  const hydratedMatchesRing = new CircularRingBuffer(ringCap);
  let totalHydratedMatches = 0;

  let compactMatchedCount = 0;
  let lineOrdinal = 0;
  let fileStream;
  let rl;

  const flushTruncatedCandidates = async (batchIndices) => {
    if (batchIndices.length === 0 || mode !== "auto") return;
    if (!fullSiblingPath || !fs.existsSync(fullSiblingPath)) return;
    const fullMap = await batchFindFullSteps(fullSiblingPath, new Set(batchIndices));
    for (const stepIdx of batchIndices) {
      const fullItem = fullMap.get(stepIdx);
      if (!fullItem) continue;
      if (!itemMatchesRole(fullItem, roleSet, matchAllRoles)) continue;
      if (!itemMatchesQuery(fullItem, queryRegex)) continue;
      totalHydratedMatches++;
      hydratedMatchesRing.push(fullItem);
    }
  };

  try {
    fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
    rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      lineOrdinal++;

      // PERF-12: Raw-line prefilter for plain literal queries, BUT never skip truncated lines in mode="auto" or turn-anchor lines when lastTurns is set
      const mayHaveTruncatedTail = mode === "auto" && Boolean(queryRegex) && line.includes('"truncated_fields"');
      const lineMatchesPrefilter = !isPlainLiteral || queryRegex.test(line) || mayHaveTruncatedTail;
      const mayBeTurnAnchor =
        effectiveLastTurns > 0 && (line.includes('"USER_INPUT"') || line.includes('"PLANNER_RESPONSE"'));
      if (!lineMatchesPrefilter && !mayBeTurnAnchor) continue;

      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }

      const stepIdx = item.step_index !== undefined ? item.step_index : lineOrdinal;
      if (item.step_index === undefined) item._ordinal = lineOrdinal;

      if (effectiveLastTurns > 0) {
        if (item.type === "USER_INPUT") {
          userTurnStepRing.push(stepIdx);
        } else if (item.type === "PLANNER_RESPONSE") {
          plannerTurnStepRing.push(stepIdx);
        }
      }

      if (!lineMatchesPrefilter) continue;

      if (startStep !== undefined && stepIdx < Number(startStep)) continue;
      if (endStep !== undefined && stepIdx > Number(endStep)) continue;

      const hasTruncatedFields = Array.isArray(item.truncated_fields) && item.truncated_fields.length > 0;
      const roleMayBeTruncated = !matchAllRoles && roleSet.has("tool") && hasTruncatedFields && item.truncated_fields.includes("tool_calls");
      const roleMatched = itemMatchesRole(item, roleSet, matchAllRoles);

      if (!roleMatched && !(mode === "auto" && roleMayBeTruncated)) {
        continue;
      }

      const matchedCompact = roleMatched && itemMatchesQuery(item, queryRegex);
      if (matchedCompact) {
        compactMatchedCount++;
        compactRing.push(item);
      } else if (
        mode === "auto" &&
        (queryRegex || roleMayBeTruncated) &&
        hasTruncatedFields &&
        item.step_index !== undefined &&
        filePath !== fullSiblingPath
      ) {
        truncatedCandidateSteps.push(item.step_index);
        // Bound candidate batch in RAM when lastTurns is not filtering at the end
        if (!effectiveLastTurns && truncatedCandidateSteps.length >= 500) {
          const batch = truncatedCandidateSteps.splice(0, truncatedCandidateSteps.length);
          await flushTruncatedCandidates(batch);
        }
      }
    }
  } catch (err) {
    const msg = `Error streaming transcript: ${err.message}`;
    return { isError: true, text: msg, error: msg };
  } finally {
    if (rl) rl.close();
    if (fileStream) fileStream.destroy();
  }

  // Compute dialogue-turn cutoff if lastTurns > 0 (prefer USER_INPUT anchors with PLANNER_RESPONSE fallback, matching readTranscript)
  let minTurnStep = 0;
  const activeTurnRing =
    userTurnStepRing && userTurnStepRing.count > 0 ? userTurnStepRing : plannerTurnStepRing;
  if (activeTurnRing && activeTurnRing.count > 0) {
    minTurnStep = activeTurnRing.toArray()[0];
  }

  if (truncatedCandidateSteps.length > 0) {
    const remaining = minTurnStep > 0
      ? truncatedCandidateSteps.filter((idx) => idx >= minTurnStep)
      : truncatedCandidateSteps;
    for (let i = 0; i < remaining.length; i += 500) {
      await flushTruncatedCandidates(remaining.slice(i, i + 500));
    }
  }

  // Merge compact matches and hydrated truncated-tail matches
  const compactItems = compactRing.toArray().filter((it) => {
    const idx = it.step_index !== undefined ? it.step_index : (it._ordinal || 0);
    return idx >= minTurnStep;
  });
  const tailItems = hydratedMatchesRing.toArray().filter((it) => {
    const idx = it.step_index !== undefined ? it.step_index : (it._ordinal || 0);
    return idx >= minTurnStep;
  });

  const mergedMap = new Map();
  for (const it of compactItems) {
    const key = it.step_index !== undefined ? it.step_index : `ord:${it._ordinal}`;
    mergedMap.set(key, it);
  }
  for (const it of tailItems) {
    const key = it.step_index !== undefined ? it.step_index : `ord:${it._ordinal}`;
    mergedMap.set(key, it);
  }

  const mergedItems = Array.from(mergedMap.values()).sort((a, b) => {
    const idxA = a.step_index !== undefined ? a.step_index : (a._ordinal || 0);
    const idxB = b.step_index !== undefined ? b.step_index : (b._ordinal || 0);
    return idxA - idxB;
  });

  const matchedCount = effectiveLastTurns > 0
    ? mergedItems.length
    : compactMatchedCount + totalHydratedMatches;

  if (mergedItems.length === 0) {
    const msg = `No matching steps found in transcript for \`${convId}\` (query: "${query || "*"}", roles: [${Array.from(roleSet).join(", ")}]).`;
    return {
      convId,
      filePath,
      mode,
      query: query || null,
      roles: Array.from(roleSet),
      matchedCount: 0,
      displayedCount: 0,
      clamped: false,
      items: [],
      text: msg
    };
  }

  const finalItems = mergedItems.length > effectiveMaxResults
    ? mergedItems.slice(-effectiveMaxResults)
    : mergedItems;
  const maxResultsTruncated = mergedItems.length > finalItems.length;

  // Auto-dereferencing for full rendering mode (or when fullArgs / field requires untruncated tool calls)
  if (mode === "auto" && (!summaryOnly || effectiveFullArgs || normalizedField) && fullSiblingPath && filePath !== fullSiblingPath) {
    const hydrateIndices = new Set();
    for (const it of finalItems) {
      if (it.step_index === undefined) continue;
      const hasTruncated = Array.isArray(it.truncated_fields) && it.truncated_fields.length > 0;
      const needsFullTools = (effectiveFullArgs || normalizedField) && Array.isArray(it.tool_calls) && it.tool_calls.length > 0;
      if (hasTruncated || needsFullTools || normalizedField) {
        hydrateIndices.add(it.step_index);
      }
    }
    if (hydrateIndices.size > 0 && fs.existsSync(fullSiblingPath)) {
      const fullMap = await batchFindFullSteps(fullSiblingPath, hydrateIndices);
      for (let i = 0; i < finalItems.length; i++) {
        const it = finalItems[i];
        if (it && fullMap.has(it.step_index)) {
          finalItems[i] = fullMap.get(it.step_index);
        }
      }
    }
  }

  if (summaryOnly) {
    const summaryLines = [];
    const displayedItems = [];
    const buildSummaryHeader = (shownCount) => [
      `## Transcript Query Summary: \`${convId}\``,
      `- Filter: query=${query ? `"${query}"` : "NONE"}, roles=[${Array.from(roleSet).join(", ")}], mode=${mode}`,
      `- Matched Steps: ${matchedCount} (showing ${shownCount} in compact summary mode)`,
      "",
      "---",
      ""
    ].join("\n");

    let currentLength = buildSummaryHeader(finalItems.length).length + 8;
    let clamped = false;

    for (const it of finalItems) {
      const step = it.step_index ?? "?";
      const role = normalizeRoleLabel(it);
      const time = it.created_at ? ` (${it.created_at.replace(/\.\d+Z$/, "Z")})` : "";
      const errorBadge = isStructuredErrorItem(it) ? " [ERROR]" : "";

      const parts = [];
      if (it.content) {
        const preview = cleanMessageContent(it.content, 120, { truncationStyle: "ellipsis" }).replace(/\s+/g, " ").trim();
        if (preview) parts.push(preview);
      }
      if (includeThinking && it.thinking) {
        const thinkPreview = cleanMessageContent(it.thinking, 80, { truncationStyle: "ellipsis" }).replace(/\s+/g, " ").trim();
        if (thinkPreview) parts.push(`[thinking: ${thinkPreview}]`);
      }
      const hasTools = Array.isArray(it.tool_calls) && it.tool_calls.length > 0;
      if (hasTools && (effectiveIncludeTools || roleSet.has("tool") || !it.content)) {
        parts.push(`[tools: ${formatCompactToolList(it.tool_calls, { fullArgs: effectiveFullArgs })}]`);
      }

      const line = `- **[Step ${step} | ${role}]**${errorBadge}${time}: ${parts.join(" ") || "(empty)"}`;
      if (currentLength + line.length + 1 > MAX_OUTPUT_CHARS && summaryLines.length > 0) {
        clamped = true;
        break;
      }
      summaryLines.push(line);
      displayedItems.push(it);
      currentLength += line.length + 1;
    }

    let output = buildSummaryHeader(summaryLines.length) + summaryLines.join("\n");
    const isTruncated = clamped || maxResultsTruncated || matchedCount > summaryLines.length;
    if (clamped) {
      output += "\n\n... [Query results clamped at 24 KB safety ceiling] ...";
    } else if (isTruncated) {
      output += `\n\n... [Truncated: showing last ${summaryLines.length} of ${matchedCount} matching steps; pass --limit <N> or --start/--end to inspect earlier steps] ...`;
    }

    return {
      convId,
      filePath,
      mode,
      query: query || null,
      roles: Array.from(roleSet),
      matchedCount,
      displayedCount: summaryLines.length,
      clamped: isTruncated,
      items: displayedItems,
      text: output
    };
  }

  const buildResultsHeader = (shownCount) => [
    `## Transcript Query Results: \`${convId}\``,
    `- Filter: query=${query ? `"${query}"` : "NONE"}, roles=[${Array.from(roleSet).join(", ")}], mode=${mode}`,
    `- Matched Steps: ${matchedCount} (showing ${shownCount})`,
    "",
    "---",
    ""
  ].join("\n");

  const blocks = [];
  const displayedItems = [];
  let currentLength = buildResultsHeader(finalItems.length).length + 8;
  let clamped = false;

  for (let i = finalItems.length - 1; i >= 0; i--) {
    const block = formatTranscriptItem(finalItems[i], {
      includeThinking,
      includeToolCalls: effectiveIncludeTools || roleSet.has("tool"),
      fullArgs: effectiveFullArgs,
      field: normalizedField
    });
    if (currentLength + block.length + 6 > MAX_OUTPUT_CHARS && blocks.length > 0) {
      clamped = true;
      break;
    }
    blocks.unshift(block);
    displayedItems.unshift(finalItems[i]);
    currentLength += block.length + 6;
  }

  let output = buildResultsHeader(blocks.length) + blocks.join("\n\n---\n\n");
  const isTruncated = clamped || maxResultsTruncated || matchedCount > blocks.length;
  if (clamped) {
    output += "\n\n... [Query results clamped at 24 KB safety ceiling] ...";
  } else if (isTruncated) {
    output += `\n\n... [Truncated: showing last ${blocks.length} of ${matchedCount} matching steps; pass --limit <N> or --start/--end to inspect earlier steps] ...`;
  }

  return {
    convId,
    filePath,
    mode,
    query: query || null,
    roles: Array.from(roleSet),
    matchedCount,
    displayedCount: blocks.length,
    clamped: isTruncated,
    items: displayedItems,
    text: output
  };
}

/**
 * Exact parity with scripts/execution-guard-hook.mjs `getRequiredBackoffSeconds`.
 */
export function getRequiredBackoffSeconds(pollCount) {
  if (pollCount <= 0) return 0;
  return Math.min(600, Math.round(30 * Math.pow(2.5, Math.max(0, pollCount - 1))));
}

/**
 * Exact parity with scripts/execution-guard-hook.mjs `isTaskPollSchedule`.
 */
export function isTaskPollSchedule(args = {}) {
  const prompt = String(args.Prompt || args.prompt || "").replace(/^["']|["']$/g, "").trim().toLowerCase();
  const cond = String(args.TimerCondition || args.timerCondition || "").replace(/^["']|["']$/g, "").trim().toLowerCase();
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

export function isSwarmPollSchedule(args = {}) {
  const isDaemon = args.IsDaemon === true || args.isDaemon === true;
  const cron = String(args.CronExpression || args.cronExpression || "").trim();
  if (isDaemon && cron) return false;

  const prompt = String(args.Prompt || args.prompt || "").replace(/^["']|["']$/g, "").trim().toLowerCase();
  const cond = String(args.TimerCondition || args.timerCondition || "").replace(/^["']|["']$/g, "").trim().toLowerCase();
  return (
    /\b(?:swarm|subagent|subagents|squad|board)\b/i.test(prompt) ||
    (cond === "any" && /\b(?:check|status|poll|monitor|wait|worker|lead|auditor)\b/i.test(prompt))
  );
}

/**
 * Unified Context Health & Proportional Backoff Evaluator (ACS-MCP-01, ACS-HOOK-12).
 */
export async function checkContextHealth({
  conversationId,
  transcriptPath,
  filePath: explicitFile,
  allowExternalPaths = false
} = {}) {
  const resolved = explicitFile
    ? resolveTranscriptPath(null, "compact", { explicitFile, allowExternalPaths, subcommand: "health" })
    : resolveTranscriptPath(transcriptPath || conversationId || "current", "compact", {
        allowExternalPaths: allowExternalPaths || Boolean(transcriptPath),
        subcommand: "health"
      });

  if (resolved.error) {
    return { isError: true, text: resolved.error, error: resolved.error, candidates: resolved.candidates };
  }

  const { filePath, convId } = resolved;
  const fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let totalSteps = 0;
  let userTurns = 0;
  let modelTurns = 0;
  let toolCalls = 0;
  let pollingViolations = 0;
  let legalChecks = 0;
  let totalBytes = 0;
  let corruptLines = 0;

  // Simulated hook backoff ledger state across transcript timestamps
  let pollCount = 0;
  let lastPollMs = null;

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      totalSteps++;
      totalBytes += line.length;

      if (totalSteps > MAX_HEALTH_LINES) {
        break;
      }

      const hasToolCalls = line.includes('"tool_calls"');
      const head = line.slice(0, 300);
      const isUserInput = head.includes('"type":"USER_INPUT"');
      const isPlannerResp = head.includes('"type":"PLANNER_RESPONSE"');

      if (!hasToolCalls && (isUserInput || isPlannerResp)) {
        if (isUserInput) userTurns++;
        else modelTurns++;
        continue;
      }

      try {
        const item = JSON.parse(line);
        if (item.type === "USER_INPUT") userTurns++;
        if (item.type === "PLANNER_RESPONSE") modelTurns++;

        const stepTsMs = item.created_at ? Date.parse(item.created_at) : NaN;
        const hasValidTs = Number.isFinite(stepTsMs);

        if (Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
          toolCalls += item.tool_calls.length;
          for (const tc of item.tool_calls) {
            const name = tc.tool_name || tc.name;
            const tcArgs = tc.args || tc.arguments || {};

            if (name === "manage_task") {
              const action = String(tcArgs.Action || tcArgs.action || "").replace(/^["']|["']$/g, "").trim().toLowerCase();
              if (action === "status") {
                if (!hasValidTs) {
                  // Un-timestamped manage_task(status) cannot prove backoff compliance
                  pollingViolations++;
                } else {
                  const requiredBackoffSec = Math.max(30, getRequiredBackoffSeconds(pollCount));
                  const elapsedSec = lastPollMs !== null ? (stepTsMs - lastPollMs) / 1000 : Infinity;
                  if (elapsedSec < requiredBackoffSec) {
                    pollingViolations++;
                  } else {
                    legalChecks++;
                    pollCount++;
                    lastPollMs = stepTsMs;
                  }
                }
              }
            } else if (name === "schedule" && isSwarmPollSchedule(tcArgs)) {
              pollingViolations++;
            } else if (name === "schedule" && isTaskPollSchedule(tcArgs)) {
              const duration = Number(tcArgs.DurationSeconds || tcArgs.durationSeconds || tcArgs.duration || 0);
              const requiredBackoffSec = Math.max(30, getRequiredBackoffSeconds(pollCount));
              if (!Number.isFinite(duration) || duration < requiredBackoffSec) {
                pollingViolations++;
              } else {
                legalChecks++;
                pollCount = Math.max(1, pollCount) + 1;
                if (hasValidTs) lastPollMs = stepTsMs;
              }
            }
          }
        }
      } catch {
        corruptLines++;
      }
    }
  } catch (err) {
    const msg = `Failed to inspect transcript: ${err.message}`;
    return { isError: true, text: msg, error: msg };
  } finally {
    rl.close();
    fileStream.destroy();
  }

  const kb = (totalBytes / 1024).toFixed(1);
  let healthStatus = "HEALTHY";
  if (pollingViolations > 3) {
    healthStatus = "CRITICAL (Active Polling Loops Detected)";
  } else if (pollingViolations > 0 && userTurns > 40) {
    healthStatus = "WARNING (High Turn Budget & Polling Violations Detected)";
  } else if (pollingViolations > 0) {
    healthStatus = "WARNING (Polling Violations Detected)";
  } else if (userTurns > 40) {
    healthStatus = "WARNING (High Turn Budget)";
  }

  const rtkInfo = findExistingRtk();
  const reportLines = [
    `### Context Health Report: ${healthStatus}`,
    "",
    "#### [Active Session Metrics]",
    `- Total Steps: ${totalSteps}`,
    `- User Turns: ${userTurns}`,
    `- Assistant Responses: ${modelTurns}`,
    `- Tool Calls: ${toolCalls}`,
    `- Detected Busy-Polling Events: ${pollingViolations}`,
    `- Legal Backoff-Compliant Checks/Watchdogs: ${legalChecks}`,
    `- Approximate Raw Transcript Size: ${kb} KB`
  ];

  if (corruptLines > 0) {
    reportLines.push(`- Corrupted/Unparsed Lines: ${corruptLines}`);
  }

  reportLines.push("");
  reportLines.push("#### [Local RTK Environment]");
  reportLines.push(`- RTK Command Optimizer: ${rtkInfo ? `Active (${rtkInfo.version})` : "Missing (run agy-context setup)"}`);
  reportLines.push(`- Note: Lifetime token gains from 'rtk gain' represent cumulative machine-wide host savings, not single-session metrics.`);
  reportLines.push("");

  if (pollingViolations > 0) {
    reportLines.push("⚠️ Recommendation: Background polling violations detected! Cease premature manage_task(status) or short schedule polling calls and yield execution to native Reactive Wakeup.");
  }
  if (userTurns >= 35) {
    reportLines.push("💡 Recommendation: Turn budget approaching threshold. Summarize progress and continue in a fresh conversation to preserve context.");
  }
  if (pollingViolations === 0 && userTurns < 35 && healthStatus === "HEALTHY") {
    reportLines.push("✓ Context footprint is well-managed.");
  }

  return {
    convId,
    filePath,
    status: healthStatus,
    metrics: {
      totalSteps,
      userTurns,
      modelTurns,
      toolCalls,
      pollingViolations,
      legalChecks,
      totalBytes,
      kb: Number(kb),
      corruptLines
    },
    rtkInfo: rtkInfo || null,
    reportText: reportLines.join("\n"),
    text: reportLines.join("\n")
  };
}

function redactSensitiveSecrets(raw) {
  if (!raw || typeof raw !== "string") return "";
  return raw
    .replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=_-]+/gi, "[Embedded Media/Binary Omitted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED]");
}

const EXPORT_OMITTED_ARG_KEYS = new Set([
  ...LARGE_BODY_ARG_KEYS,
  "ReplacementChunks",
  "replacementChunks"
]);

function sanitizeToolCallsForExport(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];
  return toolCalls.map((tc) => {
    if (!tc || typeof tc !== "object") return tc;
    const rawArgs = tc.args || tc.arguments;
    if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return tc;
    const safeArgs = {};
    for (const [k, v] of Object.entries(rawArgs)) {
      if (EXPORT_OMITTED_ARG_KEYS.has(k)) {
        safeArgs[k] = "[omitted]";
      } else if (typeof v === "string") {
        safeArgs[k] = redactSensitiveSecrets(v);
      } else {
        safeArgs[k] = v;
      }
    }
    return {
      ...tc,
      ...(tc.args ? { args: safeArgs } : { arguments: safeArgs })
    };
  });
}

function sanitizeTableCellText(raw, maxLen = 120) {
  if (!raw || typeof raw !== "string") return "";
  let cleaned = cleanMessageContent(raw, Math.max(maxLen * 4, 600), { truncationStyle: "ellipsis" });
  cleaned = redactSensitiveSecrets(cleaned)
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length > maxLen) {
    return cleaned.slice(0, Math.max(0, maxLen - 3)).trimEnd() + "...";
  }
  return cleaned;
}

function sanitizeExportContentPreview(item) {
  const raw = typeof item?.content === "string"
    ? item.content
    : item?.content !== undefined && item?.content !== null
      ? JSON.stringify(item.content)
      : "";
  if (!raw.trim()) return "";
  // Collapse wrapper tags/message headers for concise index readability
  const stripped = raw
    .replace(/<\/?(?:SYSTEM_MESSAGE|USER_REQUEST)>/gi, " ")
    .replace(/\[Message\]\s*timestamp=\S+\s*sender=\S+\s*priority=\S+\s*content=/gi, "");
  return sanitizeTableCellText(stripped, 120);
}

async function summarizeTranscriptForSanitizedExport({
  convId,
  filePath,
  startStep,
  endStep,
  maxStepsPerSession = 200
}) {
  const lineage = inspectTranscriptLineageFromFile(filePath);
  const verifiedParentDir = path.dirname(realOrNull(filePath) || filePath);
  const rawFullSiblingPath = filePath.endsWith("transcript_full.jsonl")
    ? filePath
    : filePath.replace(/transcript\.jsonl$/, "transcript_full.jsonl");
  let fullSiblingPath = null;
  if (rawFullSiblingPath === filePath) {
    fullSiblingPath = filePath;
  } else if (fs.existsSync(rawFullSiblingPath)) {
    const realSibling = realOrNull(rawFullSiblingPath);
    try {
      if (realSibling && fs.statSync(realSibling).isFile() && isContainedInDir(realSibling, verifiedParentDir)) {
        fullSiblingPath = realSibling;
      }
    } catch {}
  }

  const ring = new CircularRingBuffer(maxStepsPerSession);
  let totalSteps = 0;
  let matchingSteps = 0;
  let userTurns = 0;
  let assistantTurns = 0;
  let toolCallCount = 0;
  let errorCount = 0;
  let lineOrdinal = 0;
  let fileStream;
  let rl;

  try {
    fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
    rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      lineOrdinal++;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      totalSteps++;
      const stepIdx = item.step_index !== undefined ? item.step_index : lineOrdinal;
      if (item.step_index === undefined) item._ordinal = lineOrdinal;
      if (item.type === "USER_INPUT") userTurns++;
      if (item.type === "PLANNER_RESPONSE") assistantTurns++;
      if (Array.isArray(item.tool_calls)) toolCallCount += item.tool_calls.length;
      if (isStructuredErrorItem(item)) errorCount++;

      if (startStep !== undefined && stepIdx < Number(startStep)) continue;
      if (endStep !== undefined && stepIdx > Number(endStep)) continue;
      matchingSteps++;
      ring.push(item);
    }
  } finally {
    if (rl) rl.close();
    if (fileStream) fileStream.destroy();
  }

  const selectedItems = ring.toArray();
  // Hydrate truncated tool_calls from transcript_full.jsonl when needed (never exporting raw thinking/content bodies)
  if (fullSiblingPath && fullSiblingPath !== filePath && fs.existsSync(fullSiblingPath)) {
    const needToolHydration = new Set();
    for (const it of selectedItems) {
      if (
        it.step_index !== undefined &&
        Array.isArray(it.truncated_fields) &&
        it.truncated_fields.includes("tool_calls")
      ) {
        needToolHydration.add(it.step_index);
      }
    }
    if (needToolHydration.size > 0) {
      const fullMap = await batchFindFullSteps(fullSiblingPath, needToolHydration);
      for (const it of selectedItems) {
        if (it.step_index !== undefined && fullMap.has(it.step_index)) {
          const full = fullMap.get(it.step_index);
          if (Array.isArray(full?.tool_calls)) {
            it.tool_calls = full.tool_calls;
          }
        }
      }
    }
  }

  const rows = selectedItems.map((it) => {
    const step = it.step_index !== undefined ? it.step_index : it._ordinal || "?";
    const role = normalizeRoleLabel(it);
    const isErr = isStructuredErrorItem(it);
    const status = isErr ? "ERROR" : "OK";
    const safeTools = sanitizeToolCallsForExport(it.tool_calls);
    const toolsCompact = safeTools.length > 0
      ? sanitizeTableCellText(formatCompactToolList(safeTools, { fullArgs: false }), 140)
      : "—";
    const note = sanitizeExportContentPreview(it) || "—";
    return {
      step,
      role,
      status,
      timestamp: it.created_at ? String(it.created_at).replace(/\.\d+Z$/, "Z") : null,
      tools: toolsCompact,
      summary: note
    };
  });

  return {
    convId,
    sessionKind: lineage.sessionKind,
    parentConvId: lineage.parentConvId,
    rosterName: lineage.rosterName,
    totalSteps,
    matchingSteps,
    displayedSteps: rows.length,
    truncatedSteps: matchingSteps > rows.length,
    userTurns,
    assistantTurns,
    toolCallCount,
    errorCount,
    rows
  };
}

/**
 * Generates an L6-safe sanitized transcript summary index (for scratch/ artifacts or audit handoffs).
 * Never emits raw `.system_generated/` JSONL lines, `thinking` blocks, or full file payloads.
 */
export async function exportSanitizedTranscript({
  conversationIds = [],
  parentId = null,
  filePath: explicitFile = null,
  sanitized = false,
  startStep,
  endStep,
  limit,
  maxOutputChars = MAX_OUTPUT_CHARS,
  allowExternalPaths = false
} = {}) {
  if (sanitized !== true) {
    consumeTranscriptAccessGrant();
    const msg = "Flag '--sanitized' is required for 'transcript export' to enforce L6 transcript isolation (raw transcript export is prohibited).";
    return { isError: true, text: msg, error: msg };
  }

  const normalizedIds = Array.from(
    new Set(
      (Array.isArray(conversationIds) ? conversationIds : [conversationIds])
        .flatMap((id) => String(id || "").split(","))
        .map((id) => id.trim())
        .filter(Boolean)
    )
  );
  const trimmedParent =
    parentId !== null && parentId !== undefined
      ? String(parentId).trim()
      : null;
  if (parentId !== null && parentId !== undefined && trimmedParent === "") {
    consumeTranscriptAccessGrant();
    const msg = "Flag '--parent' must be a non-empty conversation ID or 'current'.";
    return { isError: true, text: msg, error: msg };
  }
  const hasExplicitFile = explicitFile !== null && explicitFile !== undefined && String(explicitFile).trim() !== "";

  if (startStep !== undefined && startStep !== null) {
    const s = Number(startStep);
    if (!Number.isInteger(s) || s < 0) {
      consumeTranscriptAccessGrant();
      const msg = `Invalid '--start' step '${startStep}': expected a non-negative integer.`;
      return { isError: true, text: msg, error: msg };
    }
  }
  if (endStep !== undefined && endStep !== null) {
    const e = Number(endStep);
    if (!Number.isInteger(e) || e < 0) {
      consumeTranscriptAccessGrant();
      const msg = `Invalid '--end' step '${endStep}': expected a non-negative integer.`;
      return { isError: true, text: msg, error: msg };
    }
  }
  if (startStep !== undefined && startStep !== null && endStep !== undefined && endStep !== null && Number(endStep) < Number(startStep)) {
    consumeTranscriptAccessGrant();
    const msg = `Invalid step range '--start ${startStep} --end ${endStep}': '--end' must be >= '--start'.`;
    return { isError: true, text: msg, error: msg };
  }

  if (hasExplicitFile && (trimmedParent || normalizedIds.length > 0)) {
    consumeTranscriptAccessGrant();
    const msg = "Conflicting selectors for 'transcript export': pass only one of '--id', '--parent', or '--file'.";
    return { isError: true, text: msg, error: msg };
  }
  if (trimmedParent && normalizedIds.length > 0) {
    consumeTranscriptAccessGrant();
    const msg = "Conflicting selectors for 'transcript export': pass either '--parent' or '--id', not both.";
    return { isError: true, text: msg, error: msg };
  }

  const parsedLimit = limit !== undefined && limit !== null ? Number(limit) : 150;
  const maxStepsPerSession = Math.min(500, Math.max(1, Math.floor(Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 150)));
  let displayParentFilter = trimmedParent;
  const targets = [];

  if (trimmedParent) {
    let resolvedParentId = trimmedParent;
    if (trimmedParent.toLowerCase() === "current") {
      const envId = process.env.GEMINI_CONVERSATION_ID && process.env.GEMINI_CONVERSATION_ID.trim();
      if (!envId) {
        consumeTranscriptAccessGrant();
        const msg = "Cannot resolve '--parent current': GEMINI_CONVERSATION_ID is not set. Pass an explicit parent UUID.";
        return { isError: true, text: msg, error: msg };
      }
      resolvedParentId = envId;
    }
    displayParentFilter = resolvedParentId;

    const access = verifyTranscriptCoreAccess({
      targetConvId: `parent:${resolvedParentId}`,
      subcommand: "export",
      consumeGrant: true,
      isImplicitCurrent: false
    });
    if (!access.allowed) {
      return { isError: true, text: access.error, error: access.error };
    }

    const listed = listTranscriptConversationsInternal({ limit: 500, parentId: resolvedParentId, includeLineage: true });
    if (listed.conversations.length === 0) {
      const msg = `No child conversations found for parent '${resolvedParentId}'.`;
      return { isError: true, text: msg, error: msg };
    }

    const brainDirs = getBrainDirs();
    for (const item of listed.conversations) {
      const candidatePath = resolveTargetFileInBrainDirs(brainDirs, item.conversationId);
      if (candidatePath.error) {
        return { isError: true, text: candidatePath.error, error: candidatePath.error };
      }
      targets.push({ convId: item.conversationId, filePath: candidatePath.filePath });
    }
  } else if (normalizedIds.length > 1) {
    if (normalizedIds.some((id) => id.toLowerCase() === "current")) {
      consumeTranscriptAccessGrant();
      const msg = "Placeholder 'current' cannot be combined with multiple '--id' values in 'transcript export'.";
      return { isError: true, text: msg, error: msg };
    }
    const grantKey = `multi:${[...normalizedIds].sort().join(",")}`;
    const access = verifyTranscriptCoreAccess({
      targetConvId: grantKey,
      subcommand: "export",
      consumeGrant: true,
      isImplicitCurrent: false
    });
    if (!access.allowed) {
      return { isError: true, text: access.error, error: access.error };
    }

    const brainDirs = getBrainDirs();
    for (const id of normalizedIds) {
      const candidatePath = resolveTargetFileInBrainDirs(brainDirs, id);
      if (candidatePath.error) {
        return { isError: true, text: candidatePath.error, error: candidatePath.error };
      }
      targets.push({ convId: id, filePath: candidatePath.filePath });
    }
  } else {
    const resolved = resolveTranscriptPath(normalizedIds[0], "compact", {
      explicitFile,
      allowExternalPaths,
      subcommand: "export"
    });
    if (resolved.error) {
      return { isError: true, text: resolved.error, error: resolved.error, candidates: resolved.candidates };
    }
    targets.push({ convId: resolved.convId, filePath: resolved.filePath });
  }

  const sessions = [];
  for (const target of targets) {
    const summary = await summarizeTranscriptForSanitizedExport({
      convId: target.convId,
      filePath: target.filePath,
      startStep,
      endStep,
      maxStepsPerSession
    });
    sessions.push(summary);
  }

  const generatedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const lines = [
    "# Sanitized Transcript Index",
    "",
    `- Generated At: ${generatedAt}`,
    ...(displayParentFilter ? [`- Parent Session Filter: \`${displayParentFilter}\``] : []),
    `- Exported Sessions: ${sessions.length}`,
    "- L6 Isolation: Sanitized summary index only — raw `.system_generated/` JSONL lines, `thinking` blocks, and full file payloads omitted.",
    "",
    "| Conversation ID | Kind | Roster | Parent | Steps | Tool Calls | Errors |",
    "| --- | --- | --- | --- | ---: | ---: | ---: |"
  ];

  for (const sess of sessions) {
    const rosterCell = sess.rosterName ? `@${sess.rosterName}` : "—";
    const parentCell = sess.parentConvId ? `\`${sess.parentConvId}\`` : "—";
    lines.push(
      `| \`${sess.convId}\` | ${sess.sessionKind} | ${rosterCell} | ${parentCell} | ${sess.totalSteps} | ${sess.toolCallCount} | ${sess.errorCount} |`
    );
  }

  const buildMarkdownFromSessions = (sessionList, wasClamped) => {
    const outLines = [
      "# Sanitized Transcript Index",
      "",
      `- Generated At: ${generatedAt}`,
      ...(displayParentFilter ? [`- Parent Session Filter: \`${displayParentFilter}\``] : []),
      `- Exported Sessions: ${sessionList.length}${sessionList.length < sessions.length ? ` (of ${sessions.length})` : ""}`,
      "- L6 Isolation: Sanitized summary index only — raw `.system_generated/` JSONL lines, `thinking` blocks, and full file payloads omitted.",
      "",
      "| Conversation ID | Kind | Roster | Parent | Steps | Tool Calls | Errors |",
      "| --- | --- | --- | --- | ---: | ---: | ---: |"
    ];
    for (const sess of sessionList) {
      const rosterCell = sess.rosterName ? `@${sess.rosterName}` : "—";
      const parentCell = sess.parentConvId ? `\`${sess.parentConvId}\`` : "—";
      outLines.push(
        `| \`${sess.convId}\` | ${sess.sessionKind} | ${rosterCell} | ${parentCell} | ${sess.totalSteps} | ${sess.toolCallCount} | ${sess.errorCount} |`
      );
    }
    for (const sess of sessionList) {
      outLines.push(
        "",
        `## Session \`${sess.convId}\`${sess.rosterName ? ` (@${sess.rosterName})` : ""}`,
        `- Kind: ${sess.sessionKind} | Parent: ${sess.parentConvId || "none"} | Steps Shown: ${sess.displayedSteps} of ${sess.matchingSteps}${sess.truncatedSteps ? " (truncated)" : ""} | Errors: ${sess.errorCount}`,
        "",
        "| Step | Role | Status | Tool Calls | Sanitized Summary |",
        "| ---: | --- | --- | --- | --- |"
      );
      if (sess.rows.length === 0) {
        outLines.push("| — | — | — | — | (no matching steps) |");
      } else {
        for (const row of sess.rows) {
          outLines.push(`| ${row.step} | ${row.role} | ${row.status} | ${row.tools} | ${row.summary} |`);
        }
      }
    }
    let rendered = outLines.join("\n");
    if (wasClamped) {
      rendered += "\n\n... [Sanitized transcript export clamped at safety ceiling; pass --start/--end or smaller --limit] ...";
    }
    return rendered;
  };

  let clamped = false;
  const effectiveCeiling = Math.max(4000, Number(maxOutputChars) || MAX_OUTPUT_CHARS);
  let currentLength = lines.join("\n").length;
  const retainedSessions = [];

  for (const sess of sessions) {
    const baseHeaderLine = `## Session \`${sess.convId}\`${sess.rosterName ? ` (@${sess.rosterName})` : ""}`;
    const tableHeaderLines = [
      "",
      baseHeaderLine,
      `- Kind: ${sess.sessionKind} | Parent: ${sess.parentConvId || "none"} | Steps Shown: ${sess.matchingSteps} of ${sess.matchingSteps} (truncated) | Errors: ${sess.errorCount}`,
      "",
      "| Step | Role | Status | Tool Calls | Sanitized Summary |",
      "| ---: | --- | --- | --- | --- |"
    ];
    const estimatedHeaderLength = tableHeaderLines.join("\n").length;
    if (currentLength + estimatedHeaderLength + 1 > effectiveCeiling) {
      clamped = true;
      break;
    }

    const retainedRows = [];
    const mdRowLines = [];
    let bodyLength = currentLength + estimatedHeaderLength + 1;

    if (sess.rows.length === 0) {
      const emptyRow = "| — | — | — | — | (no matching steps) |";
      mdRowLines.push(emptyRow);
      currentLength = bodyLength + emptyRow.length + 1;
      const actualHeader = [
        "",
        baseHeaderLine,
        `- Kind: ${sess.sessionKind} | Parent: ${sess.parentConvId || "none"} | Steps Shown: 0 of ${sess.matchingSteps}${sess.truncatedSteps ? " (truncated)" : ""} | Errors: ${sess.errorCount}`,
        "",
        "| Step | Role | Status | Tool Calls | Sanitized Summary |",
        "| ---: | --- | --- | --- | --- |"
      ].join("\n");
      lines.push(actualHeader, emptyRow);
      retainedSessions.push({ ...sess, rows: retainedRows, displayedSteps: 0 });
      continue;
    }

    for (const row of sess.rows) {
      const rowLine = `| ${row.step} | ${row.role} | ${row.status} | ${row.tools} | ${row.summary} |`;
      if (bodyLength + rowLine.length + 1 > effectiveCeiling) {
        clamped = true;
        break;
      }
      mdRowLines.push(rowLine);
      bodyLength += rowLine.length + 1;
      retainedRows.push(row);
    }

    const isSessTruncated = sess.truncatedSteps || retainedRows.length < sess.rows.length;
    const actualHeader = [
      "",
      baseHeaderLine,
      `- Kind: ${sess.sessionKind} | Parent: ${sess.parentConvId || "none"} | Steps Shown: ${retainedRows.length} of ${sess.matchingSteps}${isSessTruncated ? " (truncated)" : ""} | Errors: ${sess.errorCount}`,
      "",
      "| Step | Role | Status | Tool Calls | Sanitized Summary |",
      "| ---: | --- | --- | --- | --- |"
    ].join("\n");
    lines.push(actualHeader, ...mdRowLines);
    currentLength = bodyLength;
    retainedSessions.push({
      ...sess,
      rows: retainedRows,
      displayedSteps: retainedRows.length,
      truncatedSteps: isSessTruncated
    });
    if (clamped) break;
  }

  let text = lines.join("\n");
  if (clamped) {
    text += "\n\n... [Sanitized transcript export clamped at safety ceiling; pass --start/--end or smaller --limit] ...";
  }

  const buildPayload = () => ({
    sanitized: true,
    l6Safe: true,
    generatedAt,
    parentFilter: displayParentFilter,
    exportedCount: retainedSessions.length,
    totalSessions: sessions.length,
    clamped,
    sessions: retainedSessions
  });

  // Symmetrically bound JSON payload against effectiveCeiling and keep text/clamped synchronized
  let jsonTrimmed = false;
  while (JSON.stringify(buildPayload(), null, 2).length > effectiveCeiling && retainedSessions.length > 0) {
    const lastSess = retainedSessions[retainedSessions.length - 1];
    if (lastSess.rows.length > 0) {
      lastSess.rows.pop();
      lastSess.displayedSteps = lastSess.rows.length;
      lastSess.truncatedSteps = true;
      clamped = true;
      jsonTrimmed = true;
    } else if (retainedSessions.length > 1) {
      retainedSessions.pop();
      clamped = true;
      jsonTrimmed = true;
    } else {
      break;
    }
  }
  if (jsonTrimmed) {
    text = buildMarkdownFromSessions(retainedSessions, clamped);
  }

  return {
    ...buildPayload(),
    text
  };
}

function resolveTargetFileInBrainDirs(brainDirs, convId) {
  if (!convId || typeof convId !== "string" || /[\\/]|\.\./.test(convId)) {
    return { error: `Invalid conversation ID '${convId}'.` };
  }
  const searched = [];
  let newest = null;
  for (const brainDir of brainDirs) {
    const realBrain = realOrNull(brainDir) || path.resolve(brainDir);
    const expectedSessionDir = path.join(realBrain, convId);
    if (!fs.existsSync(expectedSessionDir)) {
      searched.push(expectedSessionDir);
      continue;
    }
    const compactPath = path.join(expectedSessionDir, ".system_generated", "logs", "transcript.jsonl");
    const fullPath = path.join(expectedSessionDir, ".system_generated", "logs", "transcript_full.jsonl");
    const targetPath = fs.existsSync(compactPath) ? compactPath : fs.existsSync(fullPath) ? fullPath : null;
    if (!targetPath) {
      searched.push(compactPath);
      continue;
    }
    const realCandidate = realOrNull(targetPath);
    if (!realCandidate || !isContainedInDir(realCandidate, expectedSessionDir) || !isContainedInAnyBrainDir(realCandidate, brainDirs)) {
      return {
        error: `Security containment error: resolved path '${realCandidate || targetPath}' escapes conversation directory '${expectedSessionDir}'.`
      };
    }
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(realCandidate).mtimeMs; } catch {}
    if (!newest || mtimeMs > newest.mtimeMs) {
      newest = { filePath: realCandidate, convId, mtimeMs };
    }
  }
  if (newest) {
    return { filePath: newest.filePath, convId };
  }
  return { error: `Transcript not found for conversation '${convId}'. Searched: ${searched.join(", ")}` };
}
