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
 * Creates a deterministic cross-platform RTK executable shim in `targetDir` reporting `version`.
 */
export function createRtkShim(targetDir, version = "0.51.0") {
  fs.mkdirSync(targetDir, { recursive: true });
  const shimJsPath = path.join(targetDir, "rtk-shim-runner.mjs");
  const shimCode = `#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const sub = args[0] || "";

if (sub === "--version" || sub === "-V" || sub === "version") {
  process.stdout.write("rtk ${version}\\n");
  process.exit(0);
}

if (sub === "rewrite") {
  const cmd = args.slice(1).join(" ").trim();
  if (!cmd) process.exit(1);
  const catMatch = cmd.match(/^(?:cat|head|tail|type|get-content)\\s+(.+)$/i);
  if (catMatch) {
    process.stdout.write(\`rtk read \${catMatch[1].trim()}\\n\`);
    process.exit(0);
  }
  const grepMatch = cmd.match(/^(?:grep|rg|select-string)\\s+(.+)$/i);
  if (grepMatch) {
    process.stdout.write(\`rtk rg \${grepMatch[1].trim()}\\n\`);
    process.exit(0);
  }
  if (/^(?:git|pytest|cargo|vitest|jest|tsc|eslint|ruff|find|ls)\\b/i.test(cmd) || /^npm\\s+(?:test|run\\s+test)\\b/i.test(cmd)) {
    process.stdout.write(\`rtk \${cmd}\\n\`);
    process.exit(0);
  }
  process.exit(1);
}

if (sub === "read") {
  const rest = args.slice(1);
  const isAggressive = rest.includes("aggressive") || rest.includes("--aggressive");
  const target = rest.find((a, idx) => !a.startsWith("-") && rest[idx - 1] !== "--level" && rest[idx - 1] !== "-l");
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
    fs.writeFileSync(binPath, shimCode, "utf-8");
    fs.chmodSync(binPath, 0o755);
    return binPath;
  }
}

/**
 * Seeds the canonical synthetic conversation fixture used across MCP and E2E tests.
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
      content: "Step 3 Content: Confirm that check_context_health and query_transcript handle streaming JSONL cleanly.",
      created_at: "2026-10-12T12:01:00Z"
    },
    {
      step_index: 4,
      type: "PLANNER_RESPONSE",
      thinking: "Verifying streaming readline reader and surgical stepIndex extraction.",
      content: "Step 4 Content: Verified streaming JSONL reader and anti-overfitting safeguards with zero regressions.",
      tool_calls: [{ name: "check_context_health", args: {} }],
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
export function runRtkCli(args, options = {}) {
  const res = spawnSync("rtk", args, { encoding: "utf-8", ...options });
  if (process.platform === "win32" && res.error && (res.error.code === "ENOENT" || res.error.code === "EINVAL")) {
    const quotedArgs = args.map((a) => (/\s|["&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
    return spawnSync("cmd.exe", ["/d", "/s", "/c", `rtk ${quotedArgs}`], { encoding: "utf-8", ...options });
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

  // Seed synthetic historical conversation fixture
  seedHermeticConversationFixture(profileDir);

  // Ensure a compatible RTK binary or deterministic shim is on PATH
  const { findExistingRtk } = await import("../../scripts/provision-rtk.mjs");
  let rtkInfo = findExistingRtk({ silent: true });
  if (!rtkInfo) {
    const shimDir = path.join(profileDir, "rtk-shim-bin");
    createRtkShim(shimDir, "0.51.0");
    prependToPath(shimDir);
    rtkInfo = findExistingRtk({ silent: true });
  } else if (rtkInfo.isLocal && rtkInfo.path) {
    prependToPath(path.dirname(rtkInfo.path));
  }

  // Clear rewrite cache so hook picks up current PATH & profileDir
  const rewriteCacheFile = path.join(os.tmpdir(), "agy-rtk-rewrite-cache.json");
  try {
    if (fs.existsSync(rewriteCacheFile)) fs.unlinkSync(rewriteCacheFile);
  } catch {}

  if (options.installProfile !== false) {
    const configDir = path.join(profileDir, ".gemini", "config");
    fs.mkdirSync(configDir, { recursive: true });
    // Seed baseline foreign entries so .bak backup creation and foreign preservation are exercised
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
