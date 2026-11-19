#!/usr/bin/env node
/**
 * Cross-shell local RTK launcher for Agy-Context-Saver.
 * Invoked as `node "<path>/scripts/rtk-run.mjs" <rtk-args...>` so Windows
 * PowerShell, cmd.exe, and Git Bash never fail on leading double-quoted
 * paths containing spaces (for example `C:\Users\Jane Doe\...`).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function resolveLocalRtkExecutable({
  platform = os.platform(),
  env = process.env,
  homeDir = os.homedir(),
  scriptDir = __dirname
} = {}) {
  const isWin = platform === "win32";
  const exeNames = isWin ? ["rtk.exe", "rtk.cmd", "rtk.bat"] : ["rtk"];

  if (env.AGY_TEST_PROFILE_DIR) {
    for (const exeName of exeNames) {
      const testPluginBin = path.join(
        env.AGY_TEST_PROFILE_DIR,
        ".gemini",
        "config",
        "plugins",
        "agy-context-saver",
        "bin",
        exeName
      );
      if (fs.existsSync(testPluginBin)) return testPluginBin;
    }
    return "rtk";
  }

  for (const exeName of exeNames) {
    const siblingBin = path.resolve(scriptDir, "..", "bin", exeName);
    if (fs.existsSync(siblingBin)) return siblingBin;
  }

  for (const exeName of exeNames) {
    const homePluginBin = path.join(homeDir, ".gemini", "config", "plugins", "agy-context-saver", "bin", exeName);
    if (fs.existsSync(homePluginBin)) return homePluginBin;
  }

  return "rtk";
}

function quoteForCmd(arg) {
  const str = String(arg);
  if (!str) return '""';
  return /[\s"&|<>^()%!]/.test(str) ? `"${str.replace(/"/g, '\\"')}"` : str;
}

export function runRtkPassthrough(args, options = {}) {
  const platform = options.platform || os.platform();
  const env = {
    ...(options.env || process.env),
    RTK_SUPPRESS_HOOK_WARNING: (options.env || process.env).RTK_SUPPRESS_HOOK_WARNING ?? "1"
  };
  const exe = options.exe || resolveLocalRtkExecutable({ platform, env });
  const stdio = options.stdio ?? "inherit";

  if (platform === "win32" && /\.(cmd|bat)$/i.test(exe)) {
    const comspec =
      env.ComSpec ||
      env.COMSPEC ||
      path.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "cmd.exe");
    const quotedBin = /[\s&|<>^()%!]/.test(exe) ? `"${exe}"` : exe;
    const quotedArgs = args.map(quoteForCmd).join(" ");
    const cmdLine = quotedArgs ? `"${quotedBin} ${quotedArgs}"` : `"${quotedBin}"`;
    return spawnSync(comspec, ["/d", "/s", "/c", cmdLine], {
      stdio,
      env,
      windowsVerbatimArguments: true
    });
  }

  return spawnSync(exe, args, { stdio, env });
}

const isEntryPoint = Boolean(
  process.argv[1] &&
  (() => {
    try {
      const a = fs.realpathSync(path.resolve(process.argv[1]));
      const b = fs.realpathSync(__filename);
      return process.platform === "win32" || process.platform === "darwin"
        ? a.toLowerCase() === b.toLowerCase()
        : a === b;
    } catch {
      return false;
    }
  })()
);

if (isEntryPoint) {
  const res = runRtkPassthrough(process.argv.slice(2));
  if (res.error) {
    console.error(`[agy-context-saver] Failed to launch local RTK: ${res.error.message}`);
    process.exit(1);
  }
  if (res.signal) {
    process.kill(process.pid, res.signal);
  }
  process.exit(typeof res.status === "number" ? res.status : 1);
}
