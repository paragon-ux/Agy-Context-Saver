/** Transcript isolation, loaded only while a parent has an active policy. */
import path from "node:path";
import { getBrainDirs, resolveRealOrAncestorPath } from "../../lib/path-guards.mjs";
import { readPolicies, hasRestrictivePolicy, getEffectiveMode } from "../../lib/transcript-policy.mjs";
import { respond, expandAndResolvePathVariants, expandLeadingTilde } from "./common.mjs";
import { parseTranscriptInvocation, inspectShellCommandScope, collapseActiveShellGlob } from "./shell-guard.mjs";

const PATH_KEYS = [
  "Path", "path", "AbsolutePath", "absolutePath", "absolute_path", "FilePath", "filePath", "file_path",
  "TargetFile", "targetFile", "target_file", "DirectoryPath", "directoryPath", "directory_path",
  "dirPath", "dir_path", "directory", "SearchDirectory", "searchDirectory", "search_directory",
  "SearchPath", "searchPath", "search_path", "SearchRoot", "searchRoot", "search_root"
];
const outside = (rel) => rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);

function logsOwner(raw, cwd, brainDirs, globPositions = null) {
  const owners = new Set();
  const target = collapseActiveShellGlob(raw, globPositions);
  for (const variant of expandAndResolvePathVariants(target, cwd)) {
    const canonical = resolveRealOrAncestorPath(variant);
    for (const brain of brainDirs) {
      const root = resolveRealOrAncestorPath(brain);
      const ancestor = path.relative(canonical, root);
      if (!outside(ancestor)) { owners.add(""); continue; }
      const rel = path.relative(root, canonical);
      if (outside(rel)) continue;
      const parts = rel.split(path.sep);
      if (parts.length === 1 || (parts[1] === ".system_generated" && (parts.length === 2 || parts[2] === "logs"))) {
        owners.add(parts[0]);
      }
    }
    const norm = variant.replace(/\\/g, "/");
    if (/\.system_generated\/logs(?:\/|$)/i.test(norm)) owners.add(norm.match(/(?:^|\/)([^/]+)\/\.system_generated\/logs(?:\/|$)/i)?.[1] || "");
  }
  return !owners.size ? null : owners.size === 1 ? [...owners][0] : "";
}

export function handleTranscriptGuard(ctx) {
  const policies = readPolicies();
  if (!hasRestrictivePolicy(policies)) return;
  const brainDirs = getBrainDirs({ activeTranscriptPath: ctx.transcriptPath || "" });
  const { mode, restricted, unknown } = getEffectiveMode(ctx.convId, policies, brainDirs);
  if (!restricted) return;
  const deny = () => respond({ decision: "deny", reason: `Antigravity Execution Governance: Transcript access is ${mode} for this session.` });
  const targets = [];
  if (ctx.toolName === "run_command") {
    const command = String(ctx.args.CommandLine ?? ctx.args.command ?? "");
    const invocation = parseTranscriptInvocation(command);
    if (invocation) {
      if (!invocation.clean || invocation.command === "access" || mode === "deny" || unknown) deny();
      for (let i = 0; i < invocation.args.length; i++) {
        const arg = invocation.args[i];
        if (arg === "--parent" || arg.startsWith("--parent=")) deny();
        if (arg === "--id" || arg.startsWith("--id=")) {
          const value = arg === "--id" ? invocation.args[++i] : arg.slice(5);
          if (!value || value.split(",").some((id) => id !== "current" && id !== ctx.convId)) deny();
        }
      }
    }
    const scoped = inspectShellCommandScope(command, ctx.cwd || "", { protectedDirs: brainDirs });
    for (const entry of scoped) {
      if (entry.depthExceeded || entry.uncertainFailClosed) deny();
      if (entry.uncertainCwd && (entry.recursive || !path.isAbsolute(expandLeadingTilde(entry.value)))) {
        deny();
      }
      targets.push({ value: entry.value, cwd: entry.cwd, globPositions: entry.globPositions, isOperand: entry.isOperand });
    }
  } else {
    for (const key of PATH_KEYS) if (typeof ctx.args[key] === "string") targets.push({ value: ctx.args[key], cwd: ctx.cwd || "", globPositions: null, isOperand: true });
    for (const arr of [ctx.args.paths, ctx.args.Paths]) if (Array.isArray(arr)) {
      for (const value of arr) if (typeof value === "string") targets.push({ value, cwd: ctx.cwd || "", globPositions: null, isOperand: true });
    }
  }
  for (const { value, cwd, globPositions, isOperand } of targets) {
    if (!value || (!isOperand && value.startsWith("-"))) continue;
    const owner = logsOwner(value, cwd, brainDirs, globPositions);
    if (owner !== null && !(mode === "self-only" && !unknown && owner === ctx.convId)) deny();
  }
}
