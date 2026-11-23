/**
 * Shared transcript access policy store, atomic 10s capability grants,
 * transcript lineage inspector, and 5-tier caller-access evaluator.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "../scripts/state-dir.mjs";
import { getBrainDirs, isContainedInDir, realOrNull } from "./path-guards.mjs";

export const ACTIVE_SWARM_WINDOW_MS = 5 * 60 * 1000;
export const TRANSCRIPT_ACCESS_DEFAULT_TTL_MS = 3600000;
export const STATE_TTL_MS = 3600000;
export const HOOK_GRANT_TTL_MS = 10000;

const STANDALONE_DIRECTIVE_LINE_RE = /^(?:@[a-zA-Z0-9_-]+\s+)?\[agy-transcript-access:\s*(deny|self-only|allow)\]\s*$/i;

let processVerifiedGrant = null;
let processClaimedGrantMeta = null;

export function getTranscriptAccessPolicyPath() {
  return path.join(getStateDir(), "transcript-access.json");
}

export function getGrantsDir() {
  return path.join(getStateDir(), "grants");
}

function normalizePatternList(rawList) {
  if (!rawList) return [];
  const arr = Array.isArray(rawList)
    ? rawList
    : String(rawList).split(",").map((s) => s.trim()).filter(Boolean);
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

    const freshGrant = (g) =>
      g && typeof g === "object" && typeof g.ts === "number" && (now - g.ts) < HOOK_GRANT_TTL_MS ? g : null;

    return {
      version: 1,
      activeOwnerId,
      policies,
      lastHookGrant: freshGrant(parsed.lastHookGrant),
      lastAccessMutationGrant: freshGrant(parsed.lastAccessMutationGrant)
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

function listFreshGrantRecords(prefix = "grant-") {
  const dir = getGrantsDir();
  if (!fs.existsSync(dir)) return [];
  const now = Date.now();
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
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
  try { fs.renameSync(filePath, claimedPath); } catch { return null; }
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

  listFreshGrantRecords("grant-");
  listFreshGrantRecords("mut-");

  try {
    fs.mkdirSync(grantsDir, { recursive: true });
    for (let attempt = 0; attempt < 4; attempt++) {
      const filePath = path.join(grantsDir, `${prefix}${now}-${process.pid}-${crypto.randomUUID()}.json`);
      try {
        const fd = fs.openSync(filePath, "wx", 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(payloadObj), "utf-8"); } finally { fs.closeSync(fd); }
        if (!isMutation) {
          processVerifiedGrant = payloadObj;
          processClaimedGrantMeta = { filePath, grant: payloadObj };
        }
        return;
      } catch {}
    }
  } catch {}
}

function hasActiveLaunchRestrictedSession({ targetConvId = null, isMutation = false } = {}) {
  const envConvId = process.env.GEMINI_CONVERSATION_ID && process.env.GEMINI_CONVERSATION_ID.trim();
  const stateDir = getStateDir();
  const now = Date.now();
  if (envConvId) {
    const safeId = String(envConvId).replace(/[^a-zA-Z0-9_-]/g, "_");
    const sessionFile = path.join(stateDir, `agy-session-${safeId}.json`);
    try {
      if (!fs.existsSync(sessionFile)) return false;
      const st = fs.statSync(sessionFile);
      if ((now - st.mtimeMs) > ACTIVE_SWARM_WINDOW_MS) return false;
      const parsed = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
      const dirVal = parsed?.lineage?.launchDirective;
      return dirVal === "deny" || dirVal === "self-only";
    } catch {
      return false;
    }
  }
  // IND-SEC-004-BOUNDARY: When GEMINI_CONVERSATION_ID is unset (normal host shells), enforce Tier 4
  // launch-restricted children scoped to the requested target (parentConvId or deny/multi-locked child) or policy mutations.
  if (!isMutation && !targetConvId) return false;
  try {
    if (!fs.existsSync(stateDir)) return false;
    const entries = fs.readdirSync(stateDir);
    let checked = 0;
    for (const name of entries) {
      if (!name.startsWith("agy-session-") || !name.endsWith(".json")) continue;
      if (name === "agy-session-governance-state.json") continue;
      if (++checked > 64) break;
      const fullPath = path.join(stateDir, name);
      try {
        const st = fs.lstatSync(fullPath);
        if (st.isSymbolicLink() || !st.isFile() || (now - st.mtimeMs) > ACTIVE_SWARM_WINDOW_MS) continue;
        const parsed = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
        const lineage = parsed?.lineage;
        const dirVal = lineage?.launchDirective;
        if (dirVal !== "deny" && dirVal !== "self-only") continue;
        if (isMutation) return true;
        if (targetConvId) {
          const rawTarget = String(targetConvId);
          const targets = rawTarget.startsWith("parent:")
            ? [rawTarget.slice("parent:".length)]
            : rawTarget.startsWith("multi:")
              ? rawTarget.slice("multi:".length).split(",").filter(Boolean)
              : [rawTarget];
          for (const t of targets) {
            if (lineage?.parentConvId && lineage.parentConvId === t) return true;
            const safeT = t.replace(/[^a-zA-Z0-9_-]/g, "_");
            if ((dirVal === "deny" || rawTarget.startsWith("multi:")) && safeT && name === `agy-session-${safeT}.json`) return true;
          }
        }
      } catch {}
    }
  } catch {}
  return false;
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

export function consumeTranscriptAccessGrant({ subcommand = null, targetConvId = null } = {}) {
  const reqCanon = subcommand ? canonicalizeTranscriptSubcommand(subcommand) : null;
  if (processClaimedGrantMeta?.filePath) {
    const cachedCanon = canonicalizeTranscriptSubcommand(processClaimedGrantMeta.grant?.subcommand);
    if (!reqCanon || !cachedCanon || cachedCanon === reqCanon) {
      try { fs.unlinkSync(processClaimedGrantMeta.filePath); } catch {}
      clearProcessTranscriptGrant();
    }
  } else {
    clearProcessTranscriptGrant();
  }
  const envConvId = process.env.GEMINI_CONVERSATION_ID && process.env.GEMINI_CONVERSATION_ID.trim();
  const records = listFreshGrantRecords("grant-");
  for (const rec of records) {
    if (envConvId) {
      if (rec.grant.callerConvId === envConvId) {
        claimGrantFileAtomically(rec.filePath);
        break;
      }
      continue;
    }
    if (reqCanon) {
      if (canonicalizeTranscriptSubcommand(rec.grant.subcommand) === reqCanon) {
        const targetMatch =
          !targetConvId ||
          !rec.grant.targetConvId ||
          rec.grant.targetConvId === targetConvId ||
          (String(rec.grant.targetConvId).toLowerCase() === "current" && targetConvId === rec.grant.callerConvId);
        if (targetMatch) {
          claimGrantFileAtomically(rec.filePath);
          break;
        }
      }
      continue;
    }
    if (records.length === 1) {
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
    if (reqCanon === "list") return { matches: false, reason: "self-only-list" };
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
  const hasRestriction = activePolicies.length > 0 || hasActiveLaunchRestrictedSession({ targetConvId });
  if (!hasRestriction) {
    if (consumeGrant) clearProcessTranscriptGrant();
    return { allowed: true, mode: "open", hasRestriction: false };
  }

  const reqCanon = canonicalizeTranscriptSubcommand(subcommand);
  const envConvId = process.env.GEMINI_CONVERSATION_ID && process.env.GEMINI_CONVERSATION_ID.trim();
  const freshRecords = listFreshGrantRecords("grant-");

  let grant = null;
  let claimedMeta = null;

  for (const rec of freshRecords) {
    if (grantMatchesRequest(rec.grant, reqCanon, targetConvId, isImplicitCurrent, envConvId).matches) {
      if (consumeGrant) {
        const claimed = claimGrantFileAtomically(rec.filePath);
        if (claimed) { grant = claimed; break; }
      } else {
        grant = rec.grant;
        claimedMeta = rec;
        break;
      }
    }
  }

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
    if (!processClaimedGrantMeta?.filePath) {
      grant = processVerifiedGrant;
    }
  }

  const denyGrant = (error) => {
    if (claimedMeta?.filePath) claimGrantFileAtomically(claimedMeta.filePath);
    clearProcessTranscriptGrant();
    return { allowed: false, hasRestriction: true, error };
  };

  if (!grant) {
    return denyGrant(
      "Antigravity Execution Governance: Transcript access is currently restricted by parent governance policy; direct or unverified transcript-core invocation outside an authorized PreToolUse CLI call is blocked."
    );
  }

  const grantCanon = canonicalizeTranscriptSubcommand(grant.subcommand);
  if (!reqCanon || !grantCanon || reqCanon !== grantCanon) {
    return denyGrant(
      `Antigravity Execution Governance: Capability grant subcommand mismatch (grant authorized '${grant.subcommand}', but '${subcommand}' was requested).`
    );
  }

  if (grant.mode === "self-only") {
    if (reqCanon === "list") {
      return denyGrant(
        `Antigravity Execution Governance: 'agy-context transcript ${subcommand}' is disabled in self-only mode (caller: ${grant.callerConvId}).`
      );
    }
    if (targetConvId !== null && (!grant.callerConvId || grant.callerConvId === "global" || targetConvId !== grant.callerConvId)) {
      return denyGrant(
        `Antigravity Execution Governance: Cross-session transcript inspection of '${targetConvId}' is disabled in self-only mode (caller: ${grant.callerConvId}).`
      );
    }
  }

  if (targetConvId !== null && grant.targetConvId) {
    const isGrantCurrent = String(grant.targetConvId).toLowerCase() === "current";
    if (isGrantCurrent ? !isImplicitCurrent : targetConvId !== grant.targetConvId) {
      return denyGrant(
        `Antigravity Execution Governance: Capability grant target mismatch (grant authorized '${grant.targetConvId}', but '${targetConvId}' was requested).`
      );
    }
  }

  if (consumeGrant) {
    clearProcessTranscriptGrant();
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

export function scanRecentLaunchRestrictions({
  ownerId = null,
  windowMs = ACTIVE_SWARM_WINDOW_MS
} = {}) {
  const realStateDir = realOrNull(getStateDir());
  const empty = {
    scope: "recent-child-sessions",
    windowMs,
    restrictedCount: 0,
    denyCount: 0,
    selfOnlyCount: 0,
    sessions: []
  };
  if (!realStateDir) return empty;

  let entries = [];
  try { entries = fs.readdirSync(realStateDir, { withFileTypes: true }); } catch { return empty; }

  const now = Date.now();
  const recordsById = new Map();
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    const isStaleLock = /^agy-session-[a-zA-Z0-9_-]+\.lock$/.test(entry.name);
    const nameMatch = isStaleLock ? null : /^agy-session-([a-zA-Z0-9_-]+)\.json$/.exec(entry.name);
    if (!isStaleLock && (!nameMatch || entry.name === "agy-session-governance-state.json")) continue;

    const fullPath = path.join(realStateDir, entry.name);
    let st;
    try { st = fs.lstatSync(fullPath); } catch { continue; }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    const realFile = realOrNull(fullPath);
    if (!realFile || !isContainedInDir(realFile, realStateDir)) continue;

    // PT-RUN-004: Opportunistically unlink expired per-conversation session and lock files past STATE_TTL_MS
    if ((now - st.mtimeMs) > STATE_TTL_MS) {
      try { fs.unlinkSync(realFile); } catch {}
      continue;
    }
    if (isStaleLock) continue;
    if ((now - st.mtimeMs) > windowMs) continue;

    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(realFile, "utf-8")); } catch { continue; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;

    const activityTime = Math.max(Number(parsed.lastPollTime || 0), Number(parsed.lastSeenTime || 0));
    if (Number.isFinite(activityTime) && activityTime > 0 && (now - activityTime) > windowMs) continue;

    const lin = parsed.lineage;
    if (!lin || typeof lin !== "object" || Array.isArray(lin)) continue;
    if (lin.isTopLevelUserSession && !lin.isChildSession) continue;

    const parentConvId = typeof lin.parentConvId === "string" && lin.parentConvId.trim()
      ? lin.parentConvId.trim()
      : null;
    if (!lin.isChildSession && !lin.isSwarmChild && !parentConvId) continue;

    const convId = typeof parsed.conversationId === "string" && parsed.conversationId.trim()
      ? parsed.conversationId.trim()
      : nameMatch[1];
    const dirVal = typeof lin.launchDirective === "string" ? lin.launchDirective.trim().toLowerCase() : null;
    const rosterName = typeof lin.rosterName === "string" && lin.rosterName.trim()
      ? lin.rosterName.trim().replace(/^@/, "")
      : null;

    recordsById.set(convId, {
      conversationId: convId,
      parentConvId,
      rosterName,
      launchDirective: dirVal,
      lastActivityMs: Number.isFinite(activityTime) && activityTime > 0 ? activityTime : st.mtimeMs
    });
  }

  const normalizedOwner =
    ownerId && ownerId !== "local-operator" && ownerId !== "global" ? String(ownerId).trim() : null;

  const belongsToOwner = (rec) => {
    if (!normalizedOwner) return true;
    if (rec.conversationId === normalizedOwner) return false;
    let curParent = rec.parentConvId;
    const visited = new Set([rec.conversationId]);
    for (let hop = 0; curParent && !visited.has(curParent) && hop < 8; hop++) {
      if (curParent === normalizedOwner) return true;
      visited.add(curParent);
      curParent = recordsById.get(curParent)?.parentConvId || null;
    }
    return false;
  };

  const restricted = [];
  let denyCount = 0;
  let selfOnlyCount = 0;
  for (const rec of recordsById.values()) {
    if (rec.launchDirective !== "deny" && rec.launchDirective !== "self-only") continue;
    if (!belongsToOwner(rec)) continue;
    if (rec.launchDirective === "deny") denyCount++;
    else selfOnlyCount++;
    restricted.push(rec);
  }

  restricted.sort((a, b) => (b.lastActivityMs - a.lastActivityMs) || a.conversationId.localeCompare(b.conversationId));
  return {
    scope: "recent-child-sessions",
    windowMs,
    restrictedCount: denyCount + selfOnlyCount,
    denyCount,
    selfOnlyCount,
    sessions: restricted.slice(0, 50).map((rec) => ({
      conversationId: rec.conversationId,
      parentConvId: rec.parentConvId,
      rosterName: rec.rosterName,
      mode: rec.launchDirective,
      source: "launch-directive"
    }))
  };
}

export function formatTranscriptAccessStatus(store = null, { ownerId: explicitOwnerId = null } = {}) {
  const current = store || readTranscriptAccessStore();
  const policies = Object.values(current.policies || {}).sort((a, b) => b.updatedAt - a.updatedAt);
  const activePolicy = (current.activeOwnerId && current.policies?.[current.activeOwnerId]) || policies[0] || null;
  const hasRestrictivePolicy = Boolean(
    activePolicy && (activePolicy.mode !== "open" || activePolicy.allow.length > 0 || activePolicy.deny.length > 0)
  );

  let ownerScope = hasRestrictivePolicy ? activePolicy.ownerId : (explicitOwnerId || activePolicy?.ownerId || null);
  if (!ownerScope || ownerScope === "local-operator" || ownerScope === "global") {
    const envConvId = process.env.GEMINI_CONVERSATION_ID && process.env.GEMINI_CONVERSATION_ID.trim();
    if (envConvId && envConvId !== "global") {
      const safeEnvId = String(envConvId).replace(/[^a-zA-Z0-9_-]/g, "_");
      const envStatePath = path.join(getStateDir(), `agy-session-${safeEnvId}.json`);
      let resolvedEnvScope = envConvId;
      try {
        if (fs.existsSync(envStatePath) && !fs.lstatSync(envStatePath).isSymbolicLink()) {
          const envState = JSON.parse(fs.readFileSync(envStatePath, "utf-8"));
          if (envState?.lineage?.isChildSession && !envState?.lineage?.isTopLevelUserSession && envState?.lineage?.parentConvId) {
            resolvedEnvScope = envState.lineage.parentConvId;
          }
        }
      } catch {}
      ownerScope = resolvedEnvScope;
    } else {
      ownerScope = null;
    }
  }

  const launchRestrictions = scanRecentLaunchRestrictions({ ownerId: ownerScope });
  const formatRestrictedSummaryLines = () => {
    const preview = launchRestrictions.sessions
      .slice(0, 8)
      .map((s) => `${s.rosterName ? `@${s.rosterName} (${s.conversationId})` : s.conversationId}: ${s.mode}`)
      .join(", ");
    const moreSuffix = launchRestrictions.sessions.length > 8 ? `, +${launchRestrictions.sessions.length - 8} more` : "";
    return [
      `- Recently active launch-restricted children: ${launchRestrictions.restrictedCount}`,
      `- Launch directives: ${launchRestrictions.denyCount} deny, ${launchRestrictions.selfOnlyCount} self-only`,
      `- Restricted sessions: ${preview}${moreSuffix}`
    ];
  };

  if (!hasRestrictivePolicy) {
    const text = launchRestrictions.restrictedCount > 0
      ? [
          "Transcript Access Policy: OPEN (parent CLI policy)",
          ...formatRestrictedSummaryLines(),
          "- Reset clears parent policy overrides; launch directives remain in effect."
        ].join("\n")
      : "Transcript Access Policy: OPEN (default — all sessions permitted)";
    return {
      active: false,
      mode: "open",
      ownerId: explicitOwnerId ? null : (activePolicy ? activePolicy.ownerId : null),
      allow: [],
      deny: [],
      policiesCount: policies.length,
      launchRestrictions,
      text
    };
  }

  const expiresSec = Math.max(0, Math.round(((activePolicy.updatedAt + activePolicy.ttlMs) - Date.now()) / 1000));
  const textLines = [
    `Transcript Access Policy: ${activePolicy.mode.toUpperCase()}`,
    `- Owner Session: ${activePolicy.ownerId}`,
    `- Mode: ${activePolicy.mode}`,
    `- Allow List: ${activePolicy.allow.length > 0 ? activePolicy.allow.join(", ") : "(none)"}`,
    `- Deny List: ${activePolicy.deny.length > 0 ? activePolicy.deny.join(", ") : "(none)"}`,
    `- Expires In: ${expiresSec}s`,
    ...(launchRestrictions.restrictedCount > 0 ? formatRestrictedSummaryLines() : [])
  ];

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
    launchRestrictions,
    text: textLines.join("\n")
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
  if (isStatusOnly) return formatTranscriptAccessStatus(store);

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
    } else if (activePolicies.length > 0 || hasActiveLaunchRestrictedSession({ isMutation: true })) {
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

  store.lastAccessMutationGrant = null;
  store.lastHookGrant = null;
  clearProcessTranscriptGrant();

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

  if ((options.on || options.reset || options.mode === "open") && options.allow === undefined && options.deny === undefined) {
    delete store.policies[ownerId];
    if (store.activeOwnerId === ownerId) {
      const remaining = Object.values(store.policies).sort((a, b) => b.updatedAt - a.updatedAt);
      store.activeOwnerId = remaining.length > 0 ? remaining[0].ownerId : null;
    }
    writeTranscriptAccessStore(store);
    return formatTranscriptAccessStatus(store, { ownerId });
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
  if (options.off || options.denyChildren) nextMode = "deny";
  else if (options.selfOnly) nextMode = "self-only";
  else if (options.on || options.reset) nextMode = "open";
  else if (options.mode !== undefined) {
    const m = String(options.mode).trim().toLowerCase();
    if (!["open", "allowlist", "self-only", "deny"].includes(m)) {
      throw new Error(`Invalid --mode '${options.mode}'. Expected 'open', 'allowlist', 'self-only', or 'deny'.`);
    }
    nextMode = m;
  } else if (options.allow !== undefined && existing.mode === "open") {
    nextMode = "allowlist";
  }

  store.policies[ownerId] = {
    ownerId,
    mode: nextMode,
    allow: options.allow !== undefined ? normalizePatternList(options.allow) : existing.allow,
    deny: options.deny !== undefined ? normalizePatternList(options.deny) : existing.deny,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    ttlMs
  };
  store.activeOwnerId = ownerId;
  writeTranscriptAccessStore(store);
  return formatTranscriptAccessStatus(store);
}

export function extractFirstLineDirective(bodyText) {
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
 * Inspects initial transcript JSONL steps (up to 48 header lines / 512 KiB) to classify
 * session kind (`swarm`, `subagent`, `top-level`, `unknown`) and extract `parentConvId`,
 * `rosterName`, and any first-line `[agy-transcript-access: ...]` directive.
 */
export function inspectTranscriptLineageFromFile(filePath) {
  const empty = {
    transcriptFound: false,
    lineageFinalized: false,
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
  let lineageFinalized = false;

  const lines = headStr.split(/\r?\n/).filter((l) => l.trim()).slice(0, MAX_HEADER_LINES);
  for (let i = 0; i < lines.length; i++) {
    let item = null;
    try {
      item = JSON.parse(lines[i]);
      if (i === 0) line0Parsed = true;
    } catch {
      // Handle Step 0 lines truncated by the 512 KiB header ceiling (FRIC-SEC-001)
      if (i === 0 && headStr.length >= 500000) {
        const prefix = lines[0].slice(0, 4096);
        if (/"type"\s*:\s*"USER_INPUT"/.test(prefix) || /"source"\s*:\s*"USER_EXPLICIT"/.test(prefix)) {
          line0Parsed = true;
          isTopLevelUserSession = true;
          break;
        }
      }
      continue;
    }
    const content = typeof item?.content === "string" ? item.content : "";
    if (i === 0 && (item?.type === "USER_INPUT" || item?.source === "USER_EXPLICIT")) {
      isTopLevelUserSession = true;
      launchDirective = extractFirstLineDirective(content);
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
        const dir = extractFirstLineDirective(swarmAssignMatch[2]);
        if (dir) launchDirective = dir;
        break;
      }

      if (senderMatch && i === 0 && !isBoardNotification) {
        const msgBodyMatch = content.match(/\bpriority=MESSAGE_PRIORITY_[A-Z_]+\s+content=([\s\S]*)$/);
        if (msgBodyMatch) {
          const dir = extractFirstLineDirective(msgBodyMatch[1]);
          if (dir) launchDirective = dir;
        }
      }
    } else if (i > 0) {
      lineageFinalized = true;
      break;
    }
  }
  if (!parentConvId && boardFallbackSender) parentConvId = boardFallbackSender;

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
    lineageFinalized: Boolean(lineageFinalized || isTopLevelUserSession || isSwarmChild),
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

function inspectConvLineageFromDisk(convId, brainDirs = null) {
  if (!convId || convId === "global") return inspectTranscriptLineageFromFile(null);
  const dirs = brainDirs || getBrainDirs();
  for (const bDir of dirs) {
    const compactPath = path.join(bDir, convId, ".system_generated", "logs", "transcript.jsonl");
    if (fs.existsSync(compactPath)) return inspectTranscriptLineageFromFile(compactPath);
    const fullPath = path.join(bDir, convId, ".system_generated", "logs", "transcript_full.jsonl");
    if (fs.existsSync(fullPath)) return inspectTranscriptLineageFromFile(fullPath);
  }
  return inspectTranscriptLineageFromFile(null);
}

export function matchesAgentPattern(pattern, callerConvId, rosterName) {
  if (!pattern) return false;
  const rawPat = String(pattern).trim().toLowerCase();
  if (!rawPat) return false;
  const isRosterPat = rawPat.startsWith("@");
  const cleanPat = isRosterPat ? rawPat.slice(1) : rawPat;
  const isGlob = cleanPat.endsWith("*");
  const prefix = isGlob ? cleanPat.slice(0, -1) : cleanPat;

  if (rosterName) {
    const cleanRoster = String(rosterName).trim().toLowerCase().replace(/^@/, "");
    if (isGlob ? cleanRoster.startsWith(prefix) : cleanRoster === cleanPat) return true;
  }
  if (!isRosterPat && callerConvId) {
    const cleanId = String(callerConvId).trim().toLowerCase();
    if (isGlob ? cleanId.startsWith(prefix) : cleanId === cleanPat) return true;
  }
  return false;
}

export function matchesAgentList(list, callerConvId, rosterName) {
  return Array.isArray(list) && list.length > 0 && list.some((pat) => matchesAgentPattern(pat, callerConvId, rosterName));
}

export function findGoverningPolicyForCaller(store, convId, lineage, { getLineage = null, brainDirs = null } = {}) {
  const policies = store?.policies || {};
  const policyList = Object.values(policies).sort((a, b) => b.updatedAt - a.updatedAt);
  if (policyList.length === 0) return null;

  const lin = lineage || inspectTranscriptLineageFromFile(null);
  if (convId && policies[convId]) return policies[convId];
  if (lin.isTopLevelUserSession && !lin.isChildSession) return null;

  const lookupLineage = typeof getLineage === "function"
    ? getLineage
    : (id) => inspectConvLineageFromDisk(id, brainDirs);

  if (lin.parentConvId) {
    const ancestors = [];
    const visited = new Set(convId ? [convId] : []);
    let curParent = lin.parentConvId;
    for (let depth = 0; curParent && !visited.has(curParent) && depth < 8; depth++) {
      visited.add(curParent);
      ancestors.push(curParent);
      curParent = lookupLineage(curParent)?.parentConvId || null;
    }
    for (const anc of ancestors) {
      const pol = policies[anc];
      if (pol && (matchesAgentList(pol.deny, convId, lin.rosterName) || matchesAgentList(pol.allow, convId, lin.rosterName))) {
        return pol;
      }
    }
    for (const anc of ancestors) {
      if (policies[anc]) return policies[anc];
    }
    return policies["local-operator"] || policies["global"] || null;
  }

  if (lin.isChildSession) {
    for (const pol of policyList) {
      if (matchesAgentList(pol.deny, convId, lin.rosterName) || matchesAgentList(pol.allow, convId, lin.rosterName)) {
        return pol;
      }
    }
    return policies["local-operator"] || policies["global"] || (store.activeOwnerId && policies[store.activeOwnerId]) || null;
  }

  if (!lin.transcriptFound) {
    for (const pol of policyList) {
      if (matchesAgentList(pol.deny, convId, lin.rosterName) || matchesAgentList(pol.allow, convId, lin.rosterName)) {
        return pol;
      }
    }
    if (process.env.AGY_TEST_PROFILE_DIR) {
      return (store.activeOwnerId && policies[store.activeOwnerId]) || policyList[0] || null;
    }
    return null;
  }
  return null;
}

export function evaluateCallerTranscriptAccessFromLineage(
  convId,
  lineage = null,
  { store = null, getLineage = null, brainDirs = null } = {}
) {
  const lin = lineage || inspectConvLineageFromDisk(convId, brainDirs);
  const activeStore = store || readTranscriptAccessStore();
  const policy = findGoverningPolicyForCaller(activeStore, convId, lin, { getLineage, brainDirs });
  const result = (allowed, mode, source, isOwner, isRestrictedChild, ownerId) => ({
    allowed,
    mode,
    source,
    isOwner,
    isRestrictedChild,
    rosterName: lin.rosterName,
    ownerId
  });

  // Tier 1: Policy owner
  if (policy && convId && policy.ownerId === convId) {
    return result(true, "open", "owner", true, false, policy.ownerId);
  }
  // Tier 2: Explicit CLI --deny match
  if (policy && matchesAgentList(policy.deny, convId, lin.rosterName)) {
    return result(false, "deny", "cli-deny-list", false, true, policy.ownerId);
  }
  // Tier 3: Explicit CLI --allow match
  if (policy && matchesAgentList(policy.allow, convId, lin.rosterName)) {
    return result(true, "open", "cli-allow-list", false, false, policy.ownerId);
  }
  // Tier 4: First-line launch directive
  if (lin.launchDirective) {
    const dirOwner = policy ? policy.ownerId : lin.parentConvId;
    if (lin.launchDirective === "deny") {
      return result(false, "deny", "launch-directive", false, true, dirOwner);
    }
    const parentOverrodeMidSession =
      Boolean(policy) &&
      (policy.mode === "deny" || policy.mode === "allowlist") &&
      lin.birthTimeMs > 0 &&
      policy.updatedAt > lin.birthTimeMs + 1000;
    if (parentOverrodeMidSession) {
      return result(false, policy.mode, "cli-policy-override", false, true, policy.ownerId);
    }
    if (lin.launchDirective === "self-only") {
      return result(true, "self-only", "launch-directive", false, true, dirOwner);
    }
    if (lin.launchDirective === "allow") {
      return result(true, "open", "launch-directive", false, false, dirOwner);
    }
  }
  // Tier 5: Cohort default mode from governing parent policy
  if (policy) {
    if (policy.mode === "deny" || policy.mode === "allowlist") {
      return result(false, policy.mode, "cli-policy", false, true, policy.ownerId);
    }
    if (policy.mode === "self-only") {
      return result(true, "self-only", "cli-policy", false, true, policy.ownerId);
    }
  }
  return result(true, "open", "default", !lin.isChildSession, false, policy ? policy.ownerId : null);
}

export function isTopLevelUnrestrictedSession(convId, lineage = null, accessEval = null) {
  const lin = lineage || inspectConvLineageFromDisk(convId);
  if (!lin || typeof lin !== "object") return false;
  if (lin.isChildSession || lin.isSwarmChild) return false;
  if (lin.launchDirective === "deny" || lin.launchDirective === "self-only") return false;
  const evalResult = accessEval || evaluateCallerTranscriptAccessFromLineage(convId, lin);
  if (evalResult && (evalResult.isRestrictedChild || !evalResult.allowed || evalResult.mode === "self-only")) {
    return false;
  }
  return Boolean(lin.isTopLevelUserSession || !lin.transcriptFound);
}
