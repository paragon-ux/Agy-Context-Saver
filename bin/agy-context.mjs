#!/usr/bin/env node

/**
 * Agy-Context-Saver CLI (v2.0.2)
 *
 * Local-first CLI for streaming transcript inspection, forensic querying,
 * context health diagnostics, and lifecycle management.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readTranscript,
  queryTranscript,
  getStepDetail,
  checkContextHealth,
  getBrainDir,
  getBrainDirs,
  getProfileHomeDir,
  listTranscriptConversations,
  exportSanitizedTranscript,
  manageTranscriptAccessPolicy,
  consumeTranscriptAccessGrant
} from "../lib/transcript-core.mjs";
import { getStateDir } from "../scripts/state-dir.mjs";
import {
  runInstall,
  runUninstall,
  runStatus,
  runRestoreBackups
} from "../scripts/install-register.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgPath = path.resolve(__dirname, "../package.json");

function getVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return pkg.version || "2.0.2";
  } catch {
    return "2.0.2";
  }
}

function printHelp() {
  const version = getVersion();
  console.log(`Agy-Context-Saver CLI (v${version})

Usage:
  agy-context <command> [options]

Transcript Commands:
  agy-context transcript read   [--id <conv>] [--mode compact|full] [--last-turns N] [--offset N] [--limit N] [--outline] [--include-thinking] [--json] [--file <path>]
  agy-context transcript query  [--id <conv>] [--query <regex>] [--roles csv] [--mode auto|compact|full] [--start N] [--end N] [--last-turns N] [--limit N] [--summary] [--include-tools] [--full-args] [--field content|thinking|tool_calls|tool_args|tool_args:<Key>|all] [--include-thinking] [--json] [--file <path>]
  agy-context transcript step   [--id <conv>] (--step <N|N,M|N-M|N..M> | --start N --end M) [--field content|thinking|tool_calls|tool_args|tool_args:<Key>|all] [--head N] [--tail N] [--full] [--json] [--file <path>]
  agy-context transcript health [--id <conv>] [--json] [--file <path>]
  agy-context transcript list   [--limit N] [--parent <id>] [--lineage] [--json]
  agy-context transcript export [<id>] [--id <conv[,conv...]>] [--parent <id>] --sanitized [--start N] [--end N] [--limit N] [--out|--output <path>] [--file <path>] [--json]
  agy-context transcript access [--status | --off | --on | --reset | --self-only | --mode <open|allowlist|self-only|deny> | --allow <id,@roster*...> | --deny <id,@roster*...> | --ttl <sec>] [--json]
  Aliases: grep/search/find -> query | stats/info -> health | tools -> query --roles assistant --field tool_args | outline/summary -> query --summary --include-tools | ls -> list | dump -> export | policy -> access

Lifecycle Commands:
  agy-context status            [--json]
  agy-context setup             [--check] [--allow-degraded]
  agy-context uninstall         [--restore-backups]
  agy-context restore-backups
  agy-context --help | -h | --version | -v
`);
}

function parseFlags(argv, spec) {
  const opts = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("-") || token === "-") {
      positional.push(token);
      continue;
    }

    if (token === "-h") {
      opts.help = true;
      continue;
    }
    if (token === "-v") {
      opts.version = true;
      continue;
    }
    if (token === "-c") {
      if (!spec.booleans.has("check")) {
        throw new Error(`Unknown flag '-c' for this command.`);
      }
      opts.check = true;
      continue;
    }

    if (!token.startsWith("--")) {
      throw new Error(`Unknown option '${token}'.`);
    }

    const eqIdx = token.indexOf("=");
    const key = eqIdx === -1 ? token.slice(2) : token.slice(2, eqIdx);
    const inlineVal = eqIdx === -1 ? null : token.slice(eqIdx + 1);

    if (key === "help") {
      opts.help = true;
      continue;
    }
    if (key === "version") {
      opts.version = true;
      continue;
    }

    if (spec.booleans.has(key)) {
      if (inlineVal !== null) {
        if (inlineVal !== "true" && inlineVal !== "false") {
          throw new Error(`Boolean flag '--${key}' does not accept value '${inlineVal}'.`);
        }
        opts[key] = inlineVal === "true";
      } else {
        opts[key] = true;
      }
      continue;
    }

    if (spec.multiValues && spec.multiValues.has(key)) {
      let val = inlineVal;
      if (val === null) {
        if (i + 1 >= argv.length) {
          throw new Error(`Missing value for flag '--${key}'.`);
        }
        val = argv[++i];
      }
      if (!Array.isArray(opts[key])) opts[key] = [];
      opts[key].push(val);
      continue;
    }

    if (spec.values.has(key)) {
      let val = inlineVal;
      if (val === null) {
        if (i + 1 >= argv.length) {
          throw new Error(`Missing value for flag '--${key}'.`);
        }
        val = argv[++i];
      }
      opts[key] = val;
      continue;
    }

    throw new Error(`Unknown flag '--${key}'.`);
  }

  return { opts, positional };
}

function assertCleanHelp(opts, positional) {
  const extraKeys = Object.keys(opts).filter((k) => k !== "help");
  if (extraKeys.length > 0 || positional.length > 0) {
    throw new Error("Conflicting flags: '--help' cannot be combined with operational flags or arguments.");
  }
}

function parseOptionalInt(val, flagName) {
  if (val === undefined) return undefined;
  const num = Number(val);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new Error(`Flag '--${flagName}' must be an integer (received: '${val}').`);
  }
  return num;
}

function validateExplicitFileFlag(fileArg) {
  if (fileArg === undefined) return undefined;
  const trimmed = String(fileArg).trim();
  if (!trimmed || !trimmed.toLowerCase().endsWith(".jsonl")) {
    throw new Error(`Invalid --file '${fileArg}': must be an existing .jsonl transcript file.`);
  }
  const resolved = path.resolve(trimmed);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Transcript file not found at --file '${resolved}'.`);
  }
  const real = fs.realpathSync(resolved);
  if (!fs.statSync(real).isFile()) {
    throw new Error(`Invalid --file '${resolved}': target is not a regular file.`);
  }
  return real;
}

function isInsideDirCaseAware(targetPath, baseDir) {
  const norm = (p) => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p);
  const rel = path.relative(norm(baseDir), norm(targetPath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isProtectedBenchmarkOutPath(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return false;
  const normalized = targetPath.replace(/\\/g, "/");
  return (
    /(?:^|\/)(?:benchmarks?|evaluators?|evaluation|scoring|ground_truth|prompt_templates)(?:\/|$)/i.test(normalized) ||
    /(?:^|\/)(?:eval_[^/]+\.(?:py|json|toml)|bench_[^/]+\.(?:py|json|toml))$/i.test(normalized)
  );
}

function isProtectedInternalOutPath(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return false;
  const normalized = targetPath.replace(/\\/g, "/");
  return (
    /(?:^|\/)\.system_generated(?:\/|$)/i.test(normalized) ||
    /(?:^|\/)\.git(?:\/|$)/i.test(normalized) ||
    isProtectedBenchmarkOutPath(normalized)
  );
}

function resolveWithExistingAncestor(targetPath) {
  const absTarget = path.resolve(targetPath);
  if (fs.existsSync(absTarget)) {
    try { return fs.realpathSync(absTarget); } catch { return absTarget; }
  }
  const missingTail = [];
  let probe = absTarget;
  while (probe && !fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    missingTail.unshift(path.basename(probe));
    probe = parent;
  }
  let baseReal = probe;
  if (fs.existsSync(probe)) {
    try { baseReal = fs.realpathSync(probe); } catch {}
  }
  return missingTail.length > 0 ? path.join(baseReal, ...missingTail) : baseReal;
}

function validateSafeExportOutPath(outArg) {
  if (outArg === undefined) return undefined;
  const trimmed = String(outArg).trim();
  if (!trimmed || trimmed.includes("\0")) {
    throw new Error(`Invalid --out path '${outArg}'.`);
  }
  const segments = trimmed.split(/[\\/]/);
  if (segments.includes("..")) {
    throw new Error(`Invalid --out path '${outArg}': '..' traversal is prohibited.`);
  }
  if (!/\.(?:md|json|txt)$/i.test(trimmed)) {
    throw new Error(`Invalid --out path '${outArg}': must end with .md, .json, or .txt.`);
  }
  const abs = path.resolve(trimmed);
  if (isProtectedInternalOutPath(abs)) {
    throw new Error(`Refusing '--out' inside protected internal or benchmark directory: '${abs}'.`);
  }

  const profileHome = getProfileHomeDir();
  const protectedRoots = [
    getStateDir(),
    path.join(profileHome, ".gemini", "config"),
    path.join(profileHome, ".gemini", "antigravity", "bin"),
    path.join(profileHome, ".gemini", "antigravity", "mcp")
  ].map((p) => resolveWithExistingAncestor(p));

  let absLst = null;
  try {
    absLst = fs.lstatSync(abs);
  } catch {}

  if (absLst) {
    if (absLst.isSymbolicLink() || !absLst.isFile()) {
      throw new Error(`Invalid --out path '${abs}': refusing symlink or non-regular file.`);
    }
    const realTarget = fs.realpathSync(abs);
    if (isProtectedInternalOutPath(realTarget)) {
      throw new Error(`Refusing '--out' inside protected internal or benchmark directory: '${realTarget}'.`);
    }
    for (const pr of protectedRoots) {
      if (isInsideDirCaseAware(realTarget, pr)) {
        throw new Error(`Refusing '--out' inside protected governance/state directory: '${realTarget}'.`);
      }
    }
  } else {
    const resolvedTarget = resolveWithExistingAncestor(abs);
    if (isProtectedInternalOutPath(resolvedTarget)) {
      throw new Error(`Refusing '--out' inside protected internal or benchmark directory: '${resolvedTarget}'.`);
    }
    for (const pr of protectedRoots) {
      if (isInsideDirCaseAware(resolvedTarget, pr)) {
        throw new Error(`Refusing '--out' inside protected governance/state directory: '${resolvedTarget}'.`);
      }
    }
  }
  return abs;
}

function emitError(message, asJson = false, extra = {}) {
  consumeTranscriptAccessGrant();
  if (asJson) {
    console.error(JSON.stringify({ isError: true, error: message, ...extra }, null, 2));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(1);
}

async function handleTranscriptCommand(argv) {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    if (argv.length > 1) {
      throw new Error("Conflicting flags: '--help' cannot be combined with operational flags or arguments.");
    }
    printHelp();
    process.exit(0);
  }

  const rest = argv.slice(1);

  if (sub === "read" || sub === "outline" || sub === "summary") {
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["include-thinking", "outline", "summary", "include-tools", "full-args", "json"]),
      values: new Set(["id", "mode", "last-turns", "last", "tail", "offset", "limit", "start", "end", "file"])
    });
    if (opts.help) {
      assertCleanHelp(opts, positional);
      printHelp();
      process.exit(0);
    }
    if (opts.id === undefined && positional.length === 1) {
      opts.id = positional.shift();
    }
    if (positional.length > 0) {
      throw new Error(`Unexpected positional arguments for 'transcript ${sub}': ${positional.join(" ")}`);
    }
    const explicitFile = validateExplicitFileFlag(opts.file);
    const limit = parseOptionalInt(opts.limit, "limit");

    if (sub === "outline" || sub === "summary" || opts.outline || opts.summary) {
      const startStep = parseOptionalInt(opts.start, "start");
      const endStep = parseOptionalInt(opts.end, "end");
      const res = await queryTranscript({
        conversationId: opts.id,
        filePath: explicitFile,
        startStep: startStep !== undefined ? startStep : 0,
        endStep: endStep !== undefined ? endStep : 999999,
        maxResults: limit !== undefined ? limit : 500,
        summaryOnly: true,
        includeToolCalls: true,
        fullArgs: Boolean(opts["full-args"]),
        includeThinking: Boolean(opts["include-thinking"]),
        allowExternalPaths: false,
        subcommand: sub
      });
      if (res.isError) {
        emitError(res.text, Boolean(opts.json), res.candidates ? { candidates: res.candidates } : {});
      }
      if (opts.json) {
        const { text, ...payload } = res;
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(res.text);
      }
      return;
    }

    const mode = opts.mode || "compact";
    if (mode !== "compact" && mode !== "full") {
      throw new Error(`Invalid --mode '${mode}' for 'transcript read' (expected 'compact' or 'full').`);
    }
    const rawLastTurns = opts["last-turns"] !== undefined ? opts["last-turns"] : (opts.last !== undefined ? opts.last : opts.tail);
    const lastTurns = parseOptionalInt(rawLastTurns, "last-turns");
    const offset = parseOptionalInt(opts.offset, "offset");

    const res = await readTranscript({
      conversationId: opts.id,
      filePath: explicitFile,
      mode,
      lastTurns: lastTurns !== undefined ? lastTurns : 3,
      offset,
      limit,
      includeThinking: Boolean(opts["include-thinking"]),
      allowExternalPaths: false
    });

    if (res.isError) {
      emitError(res.text, Boolean(opts.json), res.candidates ? { candidates: res.candidates } : {});
    }
    if (opts.json) {
      const { text, ...payload } = res;
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(res.text);
    }
    return;
  }

  if (sub === "query" || sub === "grep" || sub === "search" || sub === "find" || sub === "tools") {
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["summary", "outline", "include-tools", "full-args", "include-thinking", "json"]),
      values: new Set(["id", "query", "roles", "mode", "start", "end", "last-turns", "last", "tail", "limit", "field", "file"])
    });
    if (opts.help) {
      assertCleanHelp(opts, positional);
      printHelp();
      process.exit(0);
    }
    if (sub === "grep" || sub === "search" || sub === "find") {
      opts["include-tools"] = true;
    }
    if (sub === "tools") {
      if (!opts.roles) opts.roles = "assistant";
      if (!opts.field) opts.field = "tool_args";
      opts["include-tools"] = true;
      if (opts.limit === undefined) opts.limit = "500";
      if (opts.start === undefined && opts.last === undefined && opts["last-turns"] === undefined && opts.tail === undefined) {
        opts.start = "0";
        if (opts.end === undefined) opts.end = "999999";
      }
    }
    if (opts.query === undefined && positional.length >= 1) {
      opts.query = positional.shift();
    }
    if (opts.id === undefined && positional.length >= 1) {
      opts.id = positional.shift();
    }
    if (positional.length > 0) {
      throw new Error(`Unexpected positional arguments for 'transcript ${sub}': ${positional.join(" ")}`);
    }
    const mode = opts.mode || "auto";
    if (mode !== "auto" && mode !== "compact" && mode !== "full") {
      throw new Error(`Invalid --mode '${mode}' for 'transcript query' (expected 'auto', 'compact', or 'full').`);
    }
    const explicitFile = validateExplicitFileFlag(opts.file);
    const startStep = parseOptionalInt(opts.start, "start");
    const endStep = parseOptionalInt(opts.end, "end");
    const rawLastTurns = opts["last-turns"] !== undefined ? opts["last-turns"] : (opts.last !== undefined ? opts.last : opts.tail);
    const lastTurns = parseOptionalInt(rawLastTurns, "last-turns");
    const maxResults = parseOptionalInt(opts.limit, "limit");
    const roles = opts.roles
      ? opts.roles.split(",").map((r) => r.trim()).filter(Boolean)
      : ["all"];

    const res = await queryTranscript({
      conversationId: opts.id,
      filePath: explicitFile,
      query: opts.query,
      roles,
      mode,
      startStep,
      endStep,
      lastTurns,
      maxResults,
      summaryOnly: Boolean(opts.summary || opts.outline),
      includeToolCalls: Boolean(opts["include-tools"]),
      fullArgs: Boolean(opts["full-args"]),
      field: opts.field,
      includeThinking: Boolean(opts["include-thinking"]),
      allowExternalPaths: false,
      subcommand: sub
    });

    if (res.isError) {
      emitError(res.text, Boolean(opts.json), res.candidates ? { candidates: res.candidates } : {});
    }
    if (opts.json) {
      const { text, ...payload } = res;
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(res.text);
    }
    return;
  }

  if (sub === "step") {
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["json", "full"]),
      values: new Set(["id", "step", "start", "end", "field", "mode", "tail", "tail-lines", "head", "head-lines", "file"])
    });
    if (opts.help) {
      assertCleanHelp(opts, positional);
      printHelp();
      process.exit(0);
    }
    if (opts.step === undefined && positional.length >= 1) {
      opts.step = positional.shift();
    }
    if (opts.id === undefined && positional.length >= 1) {
      opts.id = positional.shift();
    }
    if (positional.length > 0) {
      throw new Error(`Unexpected positional arguments for 'transcript step': ${positional.join(" ")}`);
    }
    const startStep = parseOptionalInt(opts.start, "start");
    const endStep = parseOptionalInt(opts.end, "end");
    const tailLines = parseOptionalInt(opts["tail-lines"] !== undefined ? opts["tail-lines"] : opts.tail, "tail");
    const headLines = parseOptionalInt(opts["head-lines"] !== undefined ? opts["head-lines"] : opts.head, "head");
    if (opts.step === undefined && startStep === undefined && endStep === undefined) {
      throw new Error(`Missing required flag '--step <N|N,M|N-M>' (or '--start N --end M') for 'transcript step'.`);
    }
    const explicitFile = validateExplicitFileFlag(opts.file);

    const res = await getStepDetail({
      conversationId: opts.id,
      filePath: explicitFile,
      stepIndex: opts.step,
      startStep,
      endStep,
      field: opts.field || "all",
      headLines,
      tailLines,
      allowExternalPaths: false
    });

    if (res.isError) {
      emitError(res.text, Boolean(opts.json), res.candidates ? { candidates: res.candidates } : {});
    }
    if (opts.json) {
      const { text, ...payload } = res;
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(res.text);
    }
    return;
  }

  if (sub === "health" || sub === "stats" || sub === "info") {
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["json"]),
      values: new Set(["id", "file"])
    });
    if (opts.help) {
      assertCleanHelp(opts, positional);
      printHelp();
      process.exit(0);
    }
    if (opts.id === undefined && positional.length === 1) {
      opts.id = positional.shift();
    }
    if (positional.length > 0) {
      throw new Error(`Unexpected positional arguments for 'transcript ${sub}': ${positional.join(" ")}`);
    }
    const explicitFile = validateExplicitFileFlag(opts.file);

    const res = await checkContextHealth({
      conversationId: opts.id,
      filePath: explicitFile,
      allowExternalPaths: false
    });

    if (res.isError) {
      emitError(res.text, Boolean(opts.json), res.candidates ? { candidates: res.candidates } : {});
    }
    if (opts.json) {
      const { text, reportText, ...payload } = res;
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(res.reportText);
    }
    return;
  }

  if (sub === "list" || sub === "ls") {
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["json", "lineage"]),
      values: new Set(["limit", "parent"])
    });
    if (opts.help) {
      assertCleanHelp(opts, positional);
      printHelp();
      process.exit(0);
    }
    if (positional.length > 0) {
      throw new Error(`Unexpected positional arguments for 'transcript ${sub}': ${positional.join(" ")}`);
    }
    if (opts.parent !== undefined && !String(opts.parent).trim()) {
      throw new Error("Flag '--parent' must be a non-empty conversation ID or 'current'.");
    }
    const parsedLimit = parseOptionalInt(opts.limit, "limit");
    if (parsedLimit !== undefined && parsedLimit <= 0) {
      throw new Error(`Flag '--limit' must be a positive integer (received: '${opts.limit}').`);
    }
    const limit = parsedLimit ?? (opts.parent !== undefined ? 50 : 10);
    const listed = listTranscriptConversations({
      limit,
      parentId: opts.parent,
      includeLineage: Boolean(opts.lineage)
    });
    if (listed.isError) {
      emitError(listed.text || listed.error, Boolean(opts.json));
    }
    const dirLabel = listed.brainDirs.length === 1 ? listed.brainDirs[0] : listed.brainDirs.join(", ");
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            total: listed.total,
            ...(listed.parentFilter ? { parentFilter: listed.parentFilter } : {}),
            ...(listed.includeLineage ? { includeLineage: true } : {}),
            conversations: listed.conversations
          },
          null,
          2
        )
      );
    } else {
      const parentLabel = listed.parentFilter ? ` [parent: ${listed.parentFilter}]` : "";
      const lines = [`Recent Conversations (${listed.conversations.length} of ${listed.total} in ${dirLabel})${parentLabel}:`];
      for (const item of listed.conversations) {
        if (listed.includeLineage) {
          const rosterStr = item.rosterName ? `@${item.rosterName}` : "none";
          const parentStr = item.parentConvId || "none";
          lines.push(
            `- ${item.conversationId} | kind: ${item.sessionKind} | steps: ${item.stepCount} | parent: ${parentStr} | roster: ${rosterStr} | updated: ${item.updatedAt} | ${(item.bytes / 1024).toFixed(1)} KB`
          );
        } else {
          lines.push(`- ${item.conversationId} | updated: ${item.updatedAt} | ${(item.bytes / 1024).toFixed(1)} KB`);
        }
      }
      console.log(lines.join("\n"));
    }
    return;
  }

  if (sub === "export" || sub === "dump") {
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["sanitized", "json"]),
      values: new Set(["parent", "start", "end", "limit", "out", "output", "file"]),
      multiValues: new Set(["id"])
    });
    if (opts.help) {
      assertCleanHelp(opts, positional);
      printHelp();
      process.exit(0);
    }
    if ((!opts.id || opts.id.length === 0) && !opts.parent && !opts.file && positional.length >= 1) {
      opts.id = [positional.shift()];
    }
    if (positional.length > 0) {
      throw new Error(`Unexpected positional arguments for 'transcript ${sub}': ${positional.join(" ")}`);
    }
    if (opts.parent !== undefined && !String(opts.parent).trim()) {
      throw new Error("Flag '--parent' must be a non-empty conversation ID or 'current'.");
    }
    if (opts.out !== undefined && opts.output !== undefined && opts.out !== opts.output) {
      throw new Error("Conflicting '--out' and '--output' values provided.");
    }
    const rawOut = opts.out !== undefined ? opts.out : opts.output;
    const safeOutPath = validateSafeExportOutPath(rawOut);
    const explicitFile = validateExplicitFileFlag(opts.file);
    const startStep = parseOptionalInt(opts.start, "start");
    const endStep = parseOptionalInt(opts.end, "end");
    if (startStep !== undefined && startStep < 0) {
      throw new Error(`Flag '--start' must be a non-negative integer (received: '${opts.start}').`);
    }
    if (endStep !== undefined && endStep < 0) {
      throw new Error(`Flag '--end' must be a non-negative integer (received: '${opts.end}').`);
    }
    if (startStep !== undefined && endStep !== undefined && endStep < startStep) {
      throw new Error(`Invalid step range '--start ${startStep} --end ${endStep}': '--end' must be >= '--start'.`);
    }
    const limit = parseOptionalInt(opts.limit, "limit");
    if (limit !== undefined && limit <= 0) {
      throw new Error(`Flag '--limit' must be a positive integer (received: '${opts.limit}').`);
    }

    const res = await exportSanitizedTranscript({
      conversationIds: opts.id || [],
      parentId: opts.parent,
      filePath: explicitFile,
      sanitized: Boolean(opts.sanitized),
      startStep,
      endStep,
      limit,
      maxOutputChars: safeOutPath ? 64000 : undefined,
      allowExternalPaths: false
    });

    if (res.isError) {
      emitError(res.text, Boolean(opts.json), res.candidates ? { candidates: res.candidates } : {});
    }

    if (safeOutPath) {
      validateSafeExportOutPath(rawOut);
      fs.mkdirSync(path.dirname(safeOutPath), { recursive: true });
      validateSafeExportOutPath(rawOut);
      const { text, ...payload } = res;
      const fileContent = opts.json ? JSON.stringify(payload, null, 2) + "\n" : text + "\n";
      const tmpOut = `${safeOutPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(tmpOut, fileContent, { encoding: "utf8", flag: "wx" });
        fs.renameSync(tmpOut, safeOutPath);
      } catch (err) {
        try { fs.unlinkSync(tmpOut); } catch {}
        throw err;
      }
      if (opts.json) {
        console.log(JSON.stringify({ ...payload, outputPath: safeOutPath }, null, 2));
      } else {
        console.log(`[OK] Exported sanitized L6 transcript index (${res.exportedCount} session(s)) to: ${safeOutPath}`);
      }
      return;
    }

    if (opts.json) {
      const { text, ...payload } = res;
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(res.text);
    }
    return;
  }

  if (sub === "access" || sub === "policy") {
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["status", "off", "deny-children", "on", "reset", "self-only", "json"]),
      values: new Set(["mode", "allow", "deny", "ttl"])
    });
    if (opts.help) {
      assertCleanHelp(opts, positional);
      printHelp();
      process.exit(0);
    }
    if (positional.length === 1 && !opts.status && !opts.off && !opts["deny-children"] && !opts.on && !opts.reset && !opts["self-only"] && opts.mode === undefined) {
      const p0 = positional[0].toLowerCase();
      if (p0 === "status") opts.status = true;
      else if (p0 === "off" || p0 === "deny" || p0 === "lock") opts.off = true;
      else if (p0 === "on" || p0 === "open" || p0 === "reset" || p0 === "unlock") opts.on = true;
      else if (p0 === "self-only") opts["self-only"] = true;
      else throw new Error(`Unexpected positional argument '${positional[0]}' for 'transcript ${sub}'.`);
      positional.shift();
    }
    if (positional.length > 0) {
      throw new Error(`Unexpected positional arguments for 'transcript ${sub}': ${positional.join(" ")}`);
    }

    const hasMutationFlag =
      Boolean(opts.off) ||
      Boolean(opts["deny-children"]) ||
      Boolean(opts.on) ||
      Boolean(opts.reset) ||
      Boolean(opts["self-only"]) ||
      opts.mode !== undefined ||
      opts.allow !== undefined ||
      opts.deny !== undefined ||
      opts.ttl !== undefined;

    const res = manageTranscriptAccessPolicy({
      status: Boolean(opts.status) || !hasMutationFlag,
      off: Boolean(opts.off),
      denyChildren: Boolean(opts["deny-children"]),
      on: Boolean(opts.on),
      reset: Boolean(opts.reset),
      selfOnly: Boolean(opts["self-only"]),
      mode: opts.mode,
      allow: opts.allow,
      deny: opts.deny,
      ttl: opts.ttl
    });

    if (opts.json) {
      const { text, ...payload } = res;
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(res.text);
    }
    return;
  }

  throw new Error(`Unknown transcript subcommand '${sub}'. Expected read, query, step, health, list, export, or access.`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    if (argv.length > 1) {
      throw new Error("Conflicting flags: '--help' cannot be combined with operational flags or arguments.");
    }
    printHelp();
    process.exit(0);
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    if (argv.length > 1) {
      throw new Error("Conflicting flags: '--version' cannot be combined with operational flags or arguments.");
    }
    console.log(getVersion());
    process.exit(0);
  }

  const cmd = argv[0];
  const rest = argv.slice(1);

  if (cmd === "transcript") {
    await handleTranscriptCommand(rest);
    return;
  }

  if (cmd === "status" || cmd === "--status") {
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["json"]),
      values: new Set()
    });
    if (opts.help) {
      assertCleanHelp(opts, positional);
      printHelp();
      process.exit(0);
    }
    if (positional.length > 0) {
      throw new Error(`Unexpected arguments for 'status': ${positional.join(" ")}`);
    }
    const status = runStatus({ silent: Boolean(opts.json) });
    if (opts.json) {
      console.log(JSON.stringify(status, null, 2));
    }
    if (!status.isComplete) {
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === "setup" || cmd === "install" || cmd === "--install") {
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["check", "allow-degraded"]),
      values: new Set()
    });
    if (opts.help) {
      assertCleanHelp(opts, positional);
      printHelp();
      process.exit(0);
    }
    if (positional.length > 0) {
      throw new Error(`Unexpected arguments for 'setup': ${positional.join(" ")}`);
    }
    await runInstall({
      checkOnly: Boolean(opts.check),
      allowDegraded: Boolean(opts["allow-degraded"])
    });
    return;
  }

  if (cmd === "uninstall" || cmd === "--uninstall") {
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["restore-backups"]),
      values: new Set()
    });
    if (opts.help) {
      assertCleanHelp(opts, positional);
      printHelp();
      process.exit(0);
    }
    if (positional.length > 0) {
      throw new Error(`Unexpected arguments for 'uninstall': ${positional.join(" ")}`);
    }
    await runUninstall({
      restoreBackups: Boolean(opts["restore-backups"])
    });
    return;
  }

  if (cmd === "restore-backups" || cmd === "--restore-backups") {
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(),
      values: new Set()
    });
    if (opts.help) {
      assertCleanHelp(opts, positional);
      printHelp();
      process.exit(0);
    }
    if (positional.length > 0) {
      throw new Error(`Unexpected arguments for 'restore-backups': ${positional.join(" ")}`);
    }
    await runRestoreBackups();
    return;
  }

  throw new Error(`Unknown command '${cmd}'. Run 'agy-context --help' for usage.`);
}

main().catch((err) => {
  const wantsJson = process.argv.includes("--json");
  emitError(err?.message || String(err), wantsJson);
});
