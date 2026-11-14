#!/usr/bin/env node

/**
 * Agy-Context-Saver CLI (v2.0.0)
 *
 * Local-first CLI for streaming transcript inspection, forensic querying,
 * context health diagnostics, and lifecycle management.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readTranscript,
  queryTranscript,
  getStepDetail,
  checkContextHealth
} from "../lib/transcript-core.mjs";
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
    return pkg.version || "2.0.0";
  } catch {
    return "2.0.0";
  }
}

function printHelp() {
  const version = getVersion();
  console.log(`Agy-Context-Saver CLI (v${version})

Usage:
  agy-context <command> [options]

Transcript Commands:
  agy-context transcript read   [--id <conv>] [--mode compact|full] [--last-turns N] [--offset N] [--limit N] [--include-thinking] [--json] [--file <path>]
  agy-context transcript query  [--id <conv>] [--query <regex>] [--roles csv] [--mode auto|compact|full] [--start N] [--end N] [--last-turns N] [--limit N] [--summary] [--include-tools] [--include-thinking] [--json] [--file <path>]
  agy-context transcript step   [--id <conv>] --step <N> [--field content|thinking|tool_calls|tool_args|tool_args:<Key>|all] [--json] [--file <path>]
  agy-context transcript health [--id <conv>] [--json] [--file <path>]

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

function emitError(message, asJson = false, extra = {}) {
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
    printHelp();
    process.exit(0);
  }

  const rest = argv.slice(1);

  if (sub === "read") {
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["include-thinking", "json"]),
      values: new Set(["id", "mode", "last-turns", "offset", "limit", "file"])
    });
    if (opts.help) {
      printHelp();
      process.exit(0);
    }
    if (positional.length > 0) {
      throw new Error(`Unexpected positional arguments for 'transcript read': ${positional.join(" ")}`);
    }
    const mode = opts.mode || "compact";
    if (mode !== "compact" && mode !== "full") {
      throw new Error(`Invalid --mode '${mode}' for 'transcript read' (expected 'compact' or 'full').`);
    }
    const explicitFile = validateExplicitFileFlag(opts.file);
    const lastTurns = parseOptionalInt(opts["last-turns"], "last-turns");
    const offset = parseOptionalInt(opts.offset, "offset");
    const limit = parseOptionalInt(opts.limit, "limit");

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

  if (sub === "query") {
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["summary", "include-tools", "include-thinking", "json"]),
      values: new Set(["id", "query", "roles", "mode", "start", "end", "last-turns", "limit", "file"])
    });
    if (opts.help) {
      printHelp();
      process.exit(0);
    }
    if (positional.length > 0) {
      throw new Error(`Unexpected positional arguments for 'transcript query': ${positional.join(" ")}`);
    }
    const mode = opts.mode || "auto";
    if (mode !== "auto" && mode !== "compact" && mode !== "full") {
      throw new Error(`Invalid --mode '${mode}' for 'transcript query' (expected 'auto', 'compact', or 'full').`);
    }
    const explicitFile = validateExplicitFileFlag(opts.file);
    const startStep = parseOptionalInt(opts.start, "start");
    const endStep = parseOptionalInt(opts.end, "end");
    const lastTurns = parseOptionalInt(opts["last-turns"], "last-turns");
    const maxResults = parseOptionalInt(opts.limit, "limit");
    const roles = opts.roles
      ? opts.roles.split(",").map((r) => r.trim()).filter(Boolean)
      : ["user", "assistant"];

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
      summaryOnly: Boolean(opts.summary),
      includeToolCalls: Boolean(opts["include-tools"]),
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

  if (sub === "step") {
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["json"]),
      values: new Set(["id", "step", "field", "file"])
    });
    if (opts.help) {
      printHelp();
      process.exit(0);
    }
    if (positional.length > 0) {
      throw new Error(`Unexpected positional arguments for 'transcript step': ${positional.join(" ")}`);
    }
    if (opts.step === undefined) {
      throw new Error(`Missing required flag '--step <N>' for 'transcript step'.`);
    }
    const stepIndex = parseOptionalInt(opts.step, "step");
    const explicitFile = validateExplicitFileFlag(opts.file);

    const res = await getStepDetail({
      conversationId: opts.id,
      filePath: explicitFile,
      stepIndex,
      field: opts.field || "all",
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

  if (sub === "health") {
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["json"]),
      values: new Set(["id", "file"])
    });
    if (opts.help) {
      printHelp();
      process.exit(0);
    }
    if (positional.length > 0) {
      throw new Error(`Unexpected positional arguments for 'transcript health': ${positional.join(" ")}`);
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

  throw new Error(`Unknown transcript subcommand '${sub}'. Expected read, query, step, or health.`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    printHelp();
    process.exit(0);
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
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
    return;
  }

  if (cmd === "setup" || cmd === "install" || cmd === "--install") {
    const { opts, positional } = parseFlags(rest, {
      booleans: new Set(["check", "allow-degraded"]),
      values: new Set()
    });
    if (opts.help) {
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
    await runRestoreBackups();
    return;
  }

  throw new Error(`Unknown command '${cmd}'. Run 'agy-context --help' for usage.`);
}

main().catch((err) => {
  const wantsJson = process.argv.includes("--json");
  emitError(err?.message || String(err), wantsJson);
});
