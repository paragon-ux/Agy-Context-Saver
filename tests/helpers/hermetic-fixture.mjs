import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const HERMETIC_CONV_ID = "fcda194f-62d6-46aa-b545-b2de8fa5774e";

/**
 * Prepends a directory to PATH (handling Windows case-insensitive Path/PATH keys).
 */
export function prependToPath(dir, env = process.env) {
  const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === "path");
  const primaryKey = pathKeys[0] || "PATH";
  const current = env[primaryKey] || env.PATH || "";
  const updated = `${dir}${path.delimiter}${current}`;
  for (const k of pathKeys) {
    env[k] = updated;
  }
  env.PATH = updated;
}

/**
 * Returns a shallow-cloned env object with PATH (and Windows Path) replaced cleanly.
 */
export function withEnvPath(newPath, baseEnv = process.env) {
  const out = { ...baseEnv };
  for (const k of Object.keys(out)) {
    if (k.toLowerCase() === "path") {
      delete out[k];
    }
  }
  out.PATH = newPath;
  if (process.platform === "win32") {
    out.Path = newPath;
  }
  return out;
}

/**
 * Creates a deterministic cross-platform RTK (>= 1.1.0) executable shim in `targetDir`.
 * Supports `--version`, `hook antigravity`, `rewrite`, `read`, `grep`, and `git`.
 */
export function createRtkShim(targetDir, version = "1.1.0") {
  fs.mkdirSync(targetDir, { recursive: true });
  const shimJsPath = path.join(targetDir, "rtk-shim-runner.mjs");
  const shimCode = `#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const sub = args[0] || "";

function rewriteSingleSegment(seg) {
  const t = seg.trim();
  if (!t) return t;
  const envMatch = t.match(/^((?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\\s]+)\\s+)|(?:env(?:\\s+-[A-Za-z]+)*(?:\\s+[A-Za-z_][A-Za-z0-9_]*=[^\\s]+)*\\s+))+)/i);
  const envPrefix = envMatch ? envMatch[1] : "";
  const body = envPrefix ? t.slice(envPrefix.length).trim() : t;
  if (!body) return t;
  if (/^(?:["']?[^\\s"']*[/\\\\])?rtk(?:\\.exe|\\.cmd|\\.bat)?["']?\\s+/i.test(body)) return t;
  let m = body.match(/^cat\\s+(?=-n(?:\\s|$)|[^-])([\\s\\S]+)$/i);
  if (m) return envPrefix + "rtk read " + m[1].trim();
  m = body.match(/^head\\s+(?:(?:-n\\s+(\\d+)|-(\\d+)|--lines=(\\d+))\\s+)?((?![-])[^\\s"'\\\\]+)$/i);
  if (m) return envPrefix + "rtk read " + m[4] + " --head-lines " + (m[1] || m[2] || m[3] || "10");
  m = body.match(/^tail\\s+(?:-n\\s+(\\d+)|-(\\d+)|--lines=(\\d+))\\s+((?![-])[^\\s"'\\\\]+)$/i);
  if (m) return envPrefix + "rtk read " + m[4] + " --tail-lines " + (m[1] || m[2] || m[3]);
  m = body.match(/^(?:rg|grep|select-string)\\s+([\\s\\S]+)$/i);
  if (m) return envPrefix + (/^rg\\b/i.test(body) ? "rtk rg " : "rtk grep ") + m[1].trim();
  if (/^(?:git|pytest|cargo|vitest|jest|tsc|eslint|ruff|find|ls|wc|diff|ps)\\b/i.test(body) || /^npm\\s+(?:test|run\\s+test)\\b/i.test(body)) {
    return envPrefix + "rtk " + body;
  }
  return t;
}

function rewriteCompound(cmd) {
  const wrapMatch = cmd.trim().match(/^(bash\\s+-c\\s+)(["'])([\\s\\S]*)\\2$/i);
  if (wrapMatch) {
    const inner = rewriteCompound(wrapMatch[3]);
    return inner === wrapMatch[3] ? cmd : wrapMatch[1] + wrapMatch[2] + inner + wrapMatch[2];
  }
  const parts = cmd.split(/(\\s*(?:&&|\\|\\||;)\\s*)/);
  let changed = false;
  const out = parts.map((p, idx) => {
    if (idx % 2 === 1) return p;
    const rw = rewriteSingleSegment(p);
    if (rw !== p.trim()) changed = true;
    return rw;
  }).join("");
  return changed ? out : cmd;
}

if (sub === "--version" || sub === "-V" || sub === "version") {
  process.stdout.write("rtk ${version}\\n");
  process.exit(0);
}

if (sub === "hook" && args[1] === "antigravity") {
  let raw = "";
  try { raw = fs.readFileSync(0, "utf-8"); } catch {}
  let payload = {};
  try { payload = JSON.parse(raw || "{}"); } catch {}
  const toolCall = payload.toolCall || {};
  const name = String(toolCall.name || "").toLowerCase();
  const cmd = String(toolCall.args?.CommandLine || toolCall.args?.command || "");
  if (name === "run_command" && cmd.trim()) {
    const rewritten = rewriteCompound(cmd);
    if (rewritten !== cmd) {
      process.stdout.write(JSON.stringify({
        decision: "allow",
        overwrite: { CommandLine: rewritten }
      }) + "\\n");
      process.exit(0);
    }
  }
  process.stdout.write('{"decision":"allow"}\\n');
  process.exit(0);
}

if (sub === "rewrite") {
  const cmd = args.slice(1).join(" ").trim();
  if (!cmd) process.exit(1);
  const rewritten = rewriteCompound(cmd);
  if (rewritten === cmd) process.exit(1);
  process.stdout.write(rewritten + "\\n");
  process.exit(0);
}

if (sub === "read") {
  const rest = args.slice(1);
  const isAggressive = rest.includes("aggressive") || rest.includes("--aggressive");
  const target = rest.find((a, idx) => !a.startsWith("-") && rest[idx - 1] !== "--level" && rest[idx - 1] !== "-l" && rest[idx - 1] !== "--head-lines" && rest[idx - 1] !== "--tail-lines");
  if (!target || !fs.existsSync(target)) {
    process.stderr.write(\`File not found: \${target}\\n\`);
    process.exit(1);
  }
  let content = fs.readFileSync(target, "utf-8");
  if (isAggressive) {
    content = content.replace(/\\/\\*[\\s\\S]*?\\*\\//g, "").replace(/^\\s*\\/\\/.*$/gm, "").replace(/\\n{3,}/g, "\\n\\n");
  }
  process.stdout.write(content);
  process.exit(0);
}

if (sub === "git") {
  const gitRes = spawnSync("git", args.slice(1), { encoding: "utf-8" });
  if (gitRes.status === 0 && gitRes.stdout) {
    process.stdout.write(\`* \${gitRes.stdout.trim()}\\n\`);
  } else {
    process.stdout.write("* main (clean)\\n");
  }
  process.exit(0);
}

process.stdout.write(\`rtk ${version} (\${args.join(" ")})\\n\`);
process.exit(0);
`;
  fs.writeFileSync(shimJsPath, shimCode, "utf-8");

  if (process.platform === "win32") {
    const cmdPath = path.join(targetDir, "rtk.cmd");
    fs.writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${shimJsPath}" %*\r\n`, "utf-8");
    return cmdPath;
  } else {
    const binPath = path.join(targetDir, "rtk");
    fs.writeFileSync(binPath, `#!/bin/sh\nexec "${process.execPath}" "${shimJsPath}" "$@"\n`, "utf-8");
    fs.chmodSync(binPath, 0o755);
    return binPath;
  }
}

/**
 * Seeds the canonical synthetic conversation fixture used across transcript and E2E tests.
 */
export function seedHermeticConversationFixture(profileDir, convId = HERMETIC_CONV_ID) {
  const logsDir = path.join(profileDir, ".gemini", "antigravity", "brain", convId, ".system_generated", "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  const steps = [
    {
      step_index: 1,
      type: "USER_INPUT",
      content: "Step 1 Content: Please run verification and anti-overfitting checks across the governance test suite.",
      created_at: "2026-10-12T12:00:00Z"
    },
    {
      step_index: 2,
      type: "PLANNER_RESPONSE",
      thinking: "Analyzing verification and anti-overfitting requirements for the execution guard hook.",
      content: "Step 2 Content: Running verification and anti-overfitting probes across all integration layers.",
      tool_calls: [{ name: "run_command", args: { CommandLine: "rtk git status" } }],
      created_at: "2026-10-12T12:00:05Z"
    },
    {
      step_index: 3,
      type: "USER_INPUT",
      content: "Step 3 Content: Confirm that agy-context transcript health and query handle streaming JSONL cleanly.",
      created_at: "2026-10-12T12:01:00Z"
    },
    {
      step_index: 4,
      type: "PLANNER_RESPONSE",
      thinking: "Verifying streaming readline reader and surgical step extraction.",
      content: "Step 4 Content: Verified streaming JSONL reader and anti-overfitting safeguards with zero regressions.",
      tool_calls: [{ name: "read_file", args: { Path: "scripts/execution-guard-hook.mjs", StartLine: 1, EndLine: 50 } }],
      created_at: "2026-10-12T12:01:05Z"
    },
    {
      step_index: 5,
      type: "USER_INPUT",
      content: "Step 5 Content: Summarize the final verification status.",
      created_at: "2026-10-12T12:02:00Z"
    },
    {
      step_index: 6,
      type: "PLANNER_RESPONSE",
      thinking: "Preparing concise verification summary.",
      content: "Step 6 Content: All verification and anti-overfitting checks passed 100%.",
      tool_calls: [],
      created_at: "2026-10-12T12:02:05Z"
    }
  ];

  const jsonl = steps.map((s) => JSON.stringify(s)).join("\n") + "\n";
  fs.writeFileSync(path.join(logsDir, "transcript.jsonl"), jsonl, "utf-8");
  fs.writeFileSync(path.join(logsDir, "transcript_full.jsonl"), jsonl, "utf-8");
  return logsDir;
}

/**
 * Cross-platform helper to invoke `rtk` CLI in tests (supports both native binary and .cmd shim on Windows).
 */
function quoteWinCmdArg(arg) {
  const str = String(arg);
  if (!str) return '""';
  if (!/[\s"&|<>^()%!]/.test(str)) return str;
  let out = '"';
  let pendingBackslashes = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "\\") {
      pendingBackslashes++;
    } else if (ch === '"') {
      out += "\\".repeat(pendingBackslashes * 2 + 1) + '"';
      pendingBackslashes = 0;
    } else {
      if (pendingBackslashes > 0) {
        out += "\\".repeat(pendingBackslashes);
        pendingBackslashes = 0;
      }
      out += ch;
    }
  }
  if (pendingBackslashes > 0) {
    out += "\\".repeat(pendingBackslashes * 2);
  }
  out += '"';
  return out;
}

export function runRtkCli(args, options = {}) {
  const res = spawnSync("rtk", args, { encoding: "utf-8", ...options });
  if (process.platform === "win32" && res.error && (res.error.code === "ENOENT" || res.error.code === "EINVAL")) {
    const comspec =
      process.env.ComSpec ||
      process.env.COMSPEC ||
      path.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "cmd.exe");
    const quotedArgs = args.map(quoteWinCmdArg).join(" ");
    return spawnSync(comspec, ["/d", "/s", "/c", `rtk ${quotedArgs}`], { encoding: "utf-8", ...options });
  }
  return res;
}

/**
 * Sets up a completely hermetic test environment in `os.tmpdir()` so suites never depend on
 * or mutate the host's `~/.gemini` profile or require pre-installed global binaries.
 */
export async function setupHermeticTestEnv(options = {}) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hermetic-profile-"));
  process.env.AGY_TEST_PROFILE_DIR = profileDir;
  if (!process.env.GIT_CONFIG_GLOBAL) {
    process.env.GIT_CONFIG_GLOBAL = path.join(profileDir, ".gitconfig");
  }

  // Seed synthetic historical conversation fixture
  seedHermeticConversationFixture(profileDir);

  if (options.forceShim) {
    const shimDir = path.join(profileDir, "rtk-shim-bin");
    createRtkShim(shimDir, options.shimVersion || "1.1.0");
    prependToPath(shimDir);
  } else {
    const { findExistingRtk } = await import("../../scripts/provision-rtk.mjs");
    let rtkInfo = findExistingRtk({ silent: true });
    if (!rtkInfo) {
      const shimDir = path.join(profileDir, "rtk-shim-bin");
      createRtkShim(shimDir, "1.1.0");
      prependToPath(shimDir);
      rtkInfo = findExistingRtk({ silent: true });
    } else if (rtkInfo.isLocal && rtkInfo.path) {
      prependToPath(path.dirname(rtkInfo.path));
    }
  }

  if (options.installProfile !== false) {
    const configDir = path.join(profileDir, ".gemini", "config");
    fs.mkdirSync(configDir, { recursive: true });
    // Seed baseline foreign entries so preservation is exercised
    fs.writeFileSync(
      path.join(configDir, "hooks.json"),
      JSON.stringify({ "waymark-continuity": { PreToolUse: [] } }, null, 2),
      "utf-8"
    );
    fs.writeFileSync(
      path.join(configDir, "mcp_config.json"),
      JSON.stringify({ mcpServers: { "waymark-engine": { command: "node" } } }, null, 2),
      "utf-8"
    );

    const { runInstall } = await import("../../scripts/install-register.mjs");
    await runInstall({ silent: true });
  }

  const cleanup = () => {
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {}
  };
  process.on("exit", cleanup);

  return { profileDir, cleanup };
}
