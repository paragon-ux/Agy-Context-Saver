/**
 * PreToolUse guard for per-session transcript isolation.
 * Applies only when a restrictive policy exists (agy-context transcript access set <mode>),
 * so the common path is one small file read. Modes: open (default), self-only, deny.
 */

import { getBrainDirs } from "../../lib/path-guards.mjs";
import { readPolicies, hasRestrictivePolicy, getEffectiveMode } from "../../lib/transcript-policy.mjs";
import { respond, expandAndResolvePathVariants } from "./common.mjs";

const PATH_KEYS = [
  "Path", "path", "AbsolutePath", "absolutePath", "absolute_path", "FilePath", "filePath", "file_path",
  "TargetFile", "targetFile", "target_file", "DirectoryPath", "directoryPath", "directory_path",
  "dirPath", "dir_path", "directory", "SearchDirectory", "searchDirectory", "search_directory",
  "SearchPath", "searchPath", "search_path", "SearchRoot", "searchRoot", "search_root"
];
const LOGS_RE = /(?:^|\/)([^/]+)\/\.system_generated\/logs(?:\/|$)/i;
const LOGS_ANY_RE = /\.system_generated\/logs(?:\/|$)/i;
const HEALTH_RE = /\bagy-context(?:-saver)?(?:\.\w+)?\s+(?:\S+\s+)*?transcript\s+(?:health|stats|info)\b/i;

// Owner id of a logs path across raw and resolved variants; "" when unknown or mismatched, null when the path does not touch logs.
function logsOwner(rawPath, cwd) {
  const owners = new Set();
  let touches = false;
  for (const v of expandAndResolvePathVariants(rawPath, cwd)) {
    const norm = v.replace(/\\/g, "/");
    if (!LOGS_ANY_RE.test(norm)) continue;
    touches = true;
    owners.add(norm.match(LOGS_RE)?.[1] || "");
  }
  return !touches ? null : owners.size === 1 ? [...owners][0] : "";
}

function commandTokens(cmd) {
  return [...cmd.matchAll(/"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'()=;,|&<>]+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

export function handleTranscriptGuard(ctx) {
  const policies = readPolicies();
  if (!hasRestrictivePolicy(policies)) return;
  const { mode, restricted, unknown } = getEffectiveMode(ctx.convId, policies, getBrainDirs({ activeTranscriptPath: ctx.transcriptPath || "" }));
  if (!restricted) return;

  const cwd = ctx.cwd || "";
  const targets = [];
  if (ctx.toolName === "run_command") {
    const cmd = String(ctx.args.CommandLine ?? ctx.args.command ?? "");
    if (HEALTH_RE.test(cmd) && (mode === "deny" || /--(?:id|parent)\b/.test(cmd))) {
      respond({ decision: "deny", reason: `Antigravity Execution Governance: 'agy-context transcript health' for other sessions is disabled for this session (transcript access: ${mode}).` });
    }
    for (const tok of commandTokens(cmd)) targets.push(tok);
  } else {
    for (const k of PATH_KEYS) if (typeof ctx.args[k] === "string") targets.push(ctx.args[k]);
    for (const arr of [ctx.args.paths, ctx.args.Paths]) if (Array.isArray(arr)) targets.push(...arr.filter((v) => typeof v === "string"));
  }

  for (const t of targets) {
    if (!t) continue;
    const owner = logsOwner(t, cwd);
    if (owner === null) continue;
    if (mode === "self-only" && !unknown && owner && owner === ctx.convId) continue;
    const why = unknown
      ? "this session could not be identified, so transcript access fails closed"
      : mode === "deny" ? "transcript access is denied for this session by its parent" : "this session may read only its own transcript (self-only, set by its parent)";
    respond({ decision: "deny", reason: `Antigravity Execution Governance: Reading conversation transcripts under .system_generated/logs is blocked: ${why}. Use your task brief and workspace files instead.` });
  }
}
