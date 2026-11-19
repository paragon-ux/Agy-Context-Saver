import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const binDir = path.join(repoRoot, "bin");

export const RTK_VERSION = "v1.1.0";
export const MIN_RTK_VERSION = "1.1.0";
export const MIN_COMPATIBLE_RTK_VERSION = MIN_RTK_VERSION;
export const MANAGED_SHIM_MARKER = "agy-context-saver-managed";

export function quotePowerShellSingle(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function formatWindowsExpandArchiveCommand(archivePath, destDir) {
  return `Expand-Archive -LiteralPath ${quotePowerShellSingle(archivePath)} -DestinationPath ${quotePowerShellSingle(destDir)} -Force`;
}

// Pinned SHA-256 checksums per release asset from https://github.com/rtk-ai/rtk/releases/download/v1.1.0/checksums.txt;
// ensureRtkInstalled verifies the downloaded archive before extraction and fails closed on any mismatch.
export const RTK_CHECKSUMS = {
  "rtk-x86_64-pc-windows-msvc.zip": "c9a8f7a8bad471e64a343314168f38d2399a06fa327cdf5772fb0e645d99ea6f",
  "rtk-aarch64-apple-darwin.tar.gz": "8da773b0954cf90b115ec95c4e4eb420f04c39de233c5db102246a6caf073ba7",
  "rtk-x86_64-apple-darwin.tar.gz": "1e23e8b9542b58428e6409c49b1c3fb92c4c0d5125da72e80f002a46086a6c20",
  "rtk-x86_64-unknown-linux-musl.tar.gz": "9454ad1b9489daa57ab0a9f4ebe2faaf4dc82b8a0f26c9e5135151abd7c9378d",
  "rtk-aarch64-unknown-linux-gnu.tar.gz": "a5c00c3ab0129884bcb757d348afc1a650efa0f4f0769da97c341f28f89719ed"
};

export function isCompatibleRtkVersion(versionStr) {
  if (!versionStr || typeof versionStr !== "string") return false;
  const match = versionStr.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  return major > 1 || (major === 1 && minor >= 1);
}

export function getRtkPlatformAsset({ platform = os.platform(), arch = os.arch() } = {}) {
  if (platform === "win32" && arch === "x64") {
    return { asset: "rtk-x86_64-pc-windows-msvc.zip", exeName: "rtk.exe", isZip: true };
  }
  if (platform === "darwin" && arch === "arm64") {
    return { asset: "rtk-aarch64-apple-darwin.tar.gz", exeName: "rtk", isZip: false };
  }
  if (platform === "darwin" && arch === "x64") {
    return { asset: "rtk-x86_64-apple-darwin.tar.gz", exeName: "rtk", isZip: false };
  }
  if (platform === "linux" && arch === "x64") {
    return { asset: "rtk-x86_64-unknown-linux-musl.tar.gz", exeName: "rtk", isZip: false };
  }
  if (platform === "linux" && arch === "arm64") {
    return { asset: "rtk-aarch64-unknown-linux-gnu.tar.gz", exeName: "rtk", isZip: false };
  }
  return null;
}

export function formatManualRtkInstallInstructions() {
  return (
    `Please install RTK >= ${MIN_RTK_VERSION} manually and ensure 'rtk' is on your PATH:\n` +
    `  - macOS (Homebrew): brew install rtk\n` +
    `  - Cargo:            cargo install --locked rtk\n` +
    `  - Official script:  curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh\n` +
    `  - GitHub Releases:  https://github.com/rtk-ai/rtk/releases/tag/${RTK_VERSION}`
  );
}

export function isDirectoryWritable(dirPath) {
  try {
    let probeDir = dirPath;
    while (probeDir && !fs.existsSync(probeDir)) {
      const parent = path.dirname(probeDir);
      if (parent === probeDir) break;
      probeDir = parent;
    }
    if (!probeDir || !fs.existsSync(probeDir)) return false;
    fs.accessSync(probeDir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function runCmdShimSync(bin, args, platformExec = execFileSync) {
  if (/["\r\n]/.test(String(bin))) {
    throw new Error(`Unsafe command path: ${bin}`);
  }
  const comspec =
    process.env.ComSpec ||
    process.env.COMSPEC ||
    path.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "cmd.exe");
  const quotedBin = /[\\/\s&|<>^()%!]/.test(bin) ? `"${bin}"` : bin;
  const quotedArgs = args
    .map((a) => (/\s|["&|<>^()%!]/.test(String(a)) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a)))
    .join(" ");
  const cmdLine = quotedArgs ? `"${quotedBin} ${quotedArgs}"` : `"${quotedBin}"`;
  return platformExec(comspec, ["/d", "/s", "/c", cmdLine], {
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    windowsVerbatimArguments: true
  });
}

function runRtkVersionSync(bin, { platform = os.platform(), execFileSyncFn = execFileSync } = {}) {
  const execOpts = {
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true
  };
  if (platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    return runCmdShimSync(bin, ["--version"], execFileSyncFn).trim();
  }
  try {
    return execFileSyncFn(bin, ["--version"], execOpts).trim();
  } catch (err) {
    if (platform === "win32" && bin === "rtk" && (err?.code === "ENOENT" || err?.code === "EINVAL")) {
      return runCmdShimSync("rtk", ["--version"], execFileSyncFn).trim();
    }
    throw err;
  }
}

export function verifyLocalRtkBinary(binPath, options = {}) {
  if (!binPath || !fs.existsSync(binPath)) return null;
  const platform = options.platform || os.platform();
  const execFileSyncFn = options.execFileSync || execFileSync;
  try {
    const out = runRtkVersionSync(binPath, { platform, execFileSyncFn });
    return isCompatibleRtkVersion(out) ? out : null;
  } catch {
    return null;
  }
}

function isManagedRtkShimFile(filePath) {
  try {
    const st = fs.lstatSync(filePath);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 4096) return false;
    return fs.readFileSync(filePath, "utf-8").includes(MANAGED_SHIM_MARKER);
  } catch {
    return false;
  }
}

function normalizePathDir(dirPath, platform) {
  if (!dirPath || typeof dirPath !== "string") return "";
  let trimmed = dirPath.trim().replace(/^"(.*)"$/, "$1");
  if (!trimmed) return "";
  if (trimmed === "~") {
    trimmed = os.homedir();
  } else if (/^~[\\/]/.test(trimmed)) {
    trimmed = path.join(os.homedir(), trimmed.slice(2));
  }
  const resolved = path.resolve(trimmed);
  const root = path.parse(resolved).root;
  let normalized = resolved === root ? resolved : resolved.replace(/[\\/]+$/, "");
  if (platform === "win32" || platform === "darwin") {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

function isSameDir(dirA, dirB, platform) {
  const normA = normalizePathDir(dirA, platform);
  const normB = normalizePathDir(dirB, platform);
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  try {
    const realA = normalizePathDir(fs.realpathSync(dirA), platform);
    const realB = normalizePathDir(fs.realpathSync(dirB), platform);
    return Boolean(realA && realB && realA === realB);
  } catch {
    return false;
  }
}

function scanPathForRtk({ platform, pathEnv, antigravityBinDir }) {
  const delim = platform === "win32" ? ";" : ":";
  const exts = platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  let firstHit = null;
  let firstExternalHit = null;

  for (const rawEntry of String(pathEnv || "").split(delim)) {
    let dir = rawEntry.trim().replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    if (dir === "~") {
      dir = os.homedir();
    } else if (/^~[\\/]/.test(dir)) {
      dir = path.join(os.homedir(), dir.slice(2));
    }
    const isManagedDir = isSameDir(dir, antigravityBinDir, platform);
    for (const ext of exts) {
      const candidate = path.join(dir, `rtk${ext}`);
      try {
        const st = fs.statSync(candidate);
        if (!st.isFile()) continue;
        if (platform !== "win32") {
          fs.accessSync(candidate, fs.constants.X_OK);
        }
        const isManaged = isManagedDir && isManagedRtkShimFile(candidate);
        if (!firstHit) {
          firstHit = { path: candidate, isManaged };
        }
        if (!isManaged && !firstExternalHit) {
          firstExternalHit = candidate;
        }
        break;
      } catch {}
    }
    if (firstHit && firstExternalHit) break;
  }

  return { firstHit, firstExternalHit };
}

export function findExistingRtk(options = {}) {
  const platform = options.platform || os.platform();
  const execFileSyncFn = options.execFileSync || execFileSync;
  const pathEnv = options.pathEnv ?? (process.env.PATH || process.env.Path || "");
  const names = platform === "win32" ? ["rtk.exe", "rtk.cmd"] : ["rtk"];
  const profileHome = process.env.AGY_TEST_PROFILE_DIR || os.homedir();
  const pluginBinDir = path.join(profileHome, ".gemini", "config", "plugins", "agy-context-saver", "bin");
  const antigravityBinDir = path.join(profileHome, ".gemini", "antigravity", "bin");
  const candidateDirs = process.env.AGY_TEST_PROFILE_DIR ? [pluginBinDir] : [binDir, pluginBinDir];
  if (options.targetBinDir && !candidateDirs.includes(options.targetBinDir)) {
    candidateDirs.unshift(options.targetBinDir);
  }

  const findLocalRtk = () => {
    for (const dir of candidateDirs) {
      for (const exeName of names) {
        const localExe = path.join(dir, exeName);
        if (fs.existsSync(localExe)) {
          try {
            const out = runRtkVersionSync(localExe, { platform, execFileSyncFn });
            if (isCompatibleRtkVersion(out)) {
              return { path: localExe, version: out, isLocal: true };
            }
          } catch {}
        }
      }
    }
    return null;
  };

  // Detect whether the first `rtk` on PATH is our own managed shim in ~/.gemini/antigravity/bin.
  // Prefer any compatible external system rtk on PATH (even behind our managed shim) so installing
  // system rtk later supersedes the bundled binary; otherwise fall back to plugin-local rtk
  // (`isLocal: true`) so copy-mode npx upgrades preserve pluginDest/bin/rtk.
  const { firstHit, firstExternalHit } = scanPathForRtk({ platform, pathEnv, antigravityBinDir });
  if (firstHit?.isManaged) {
    if (firstExternalHit) {
      try {
        const out = runRtkVersionSync(firstExternalHit, { platform, execFileSyncFn });
        if (isCompatibleRtkVersion(out)) {
          return { path: firstExternalHit, version: out, isLocal: false };
        }
        if (!options.silent) {
          console.warn(`[WARN] System RTK version '${out}' is below minimum supported version >=${MIN_RTK_VERSION}. Local or manual ${RTK_VERSION} installation is required.`);
        }
      } catch {}
    }
    const localHit = findLocalRtk();
    if (localHit) {
      return localHit;
    }
    return null;
  }

  // Check PATH first so a system rtk >= 1.1.0 is preferred over bundled binaries
  try {
    const out = runRtkVersionSync("rtk", { platform, execFileSyncFn });
    if (isCompatibleRtkVersion(out)) {
      return { path: "rtk", version: out, isLocal: false };
    }
    if (!options.silent) {
      console.warn(`[WARN] System RTK version '${out}' is below minimum supported version >=${MIN_RTK_VERSION}. Local or manual ${RTK_VERSION} installation is required.`);
    }
  } catch {}

  return findLocalRtk();
}

function resolveDefaultTargetBinDir() {
  const profileHome = process.env.AGY_TEST_PROFILE_DIR || os.homedir();
  const pluginBinDir = path.join(profileHome, ".gemini", "config", "plugins", "agy-context-saver", "bin");
  if (process.env.AGY_TEST_PROFILE_DIR) {
    return pluginBinDir;
  }
  const isGitRepo = fs.existsSync(path.join(repoRoot, ".git"));
  const isPackageStore =
    !isGitRepo || repoRoot.includes("_npx") || repoRoot.includes("npm-cache") || repoRoot.includes("node_modules");
  if (!isPackageStore && isDirectoryWritable(binDir)) {
    return binDir;
  }
  return pluginBinDir;
}

export async function ensureRtkInstalled(options = {}) {
  const log = options.silent ? () => {} : console.log;
  const existing = options.existingRtk || findExistingRtk(options);
  if (existing) {
    ensureRtkConfigured(options);
    log(`✓ RTK is already installed and verified: ${existing.version} (${existing.path})`);
    return existing;
  }

  const platform = options.platform || os.platform();
  const arch = options.arch || os.arch();
  const assetInfo = options.platformAsset !== undefined ? options.platformAsset : getRtkPlatformAsset({ platform, arch });
  if (!assetInfo) {
    throw new Error(
      `Unsupported platform/architecture for prebuilt RTK: ${platform} ${arch}.\n` +
      formatManualRtkInstallInstructions()
    );
  }

  // Fail closed when the target release asset checksum is unpinned/missing instead of trusting stale hashes
  const checksums = options.checksums || RTK_CHECKSUMS;
  const expectedHash = checksums[assetInfo.asset];
  if (!expectedHash) {
    throw new Error(
      `Integrity error: No pinned SHA-256 checksum configured for RTK ${RTK_VERSION} asset '${assetInfo.asset}'.\n` +
      `Automated download aborted (fail-closed). ${formatManualRtkInstallInstructions()}`
    );
  }

  const resolvedTargetBinDir = options.targetBinDir || resolveDefaultTargetBinDir();
  const targetExe = path.join(resolvedTargetBinDir, assetInfo.exeName);
  const downloadUrl = `https://github.com/rtk-ai/rtk/releases/download/${RTK_VERSION}/${assetInfo.asset}`;
  const fetchFn = options.fetch || fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30000;
  log(`⚡ Downloading RTK ${RTK_VERSION} from ${downloadUrl}...`);

  let buffer;
  try {
    const response = await fetchFn(downloadUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response || !response.ok) {
      throw new Error(
        `Failed to download RTK release (${response?.status ?? "unknown"} ${response?.statusText ?? ""}): ${downloadUrl}.\n` +
        formatManualRtkInstallInstructions()
      );
    }
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    if (err?.message && err.message.includes("Failed to download RTK release")) {
      throw err;
    }
    throw new Error(
      `Failed to download RTK release from ${downloadUrl}: ${err?.message || String(err)}.\n` +
      formatManualRtkInstallInstructions()
    );
  }

  // Fail-closed SHA-256 verification before writing archive to disk or extracting
  const actualHash = crypto.createHash("sha256").update(buffer).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(
      `SHA-256 checksum verification failed for ${assetInfo.asset}!\n` +
      `  Expected: ${expectedHash}\n` +
      `  Actual:   ${actualHash}\n` +
      `Archive extraction aborted to protect system integrity.`
    );
  }
  log(`✓ Verified SHA-256 checksum: ${actualHash}`);

  // Stage archive download and extraction in os.tmpdir() so read-only package installs never fail with EACCES
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-rtk-stage-"));
  const archivePath = path.join(stageDir, assetInfo.asset);
  try {
    fs.writeFileSync(archivePath, buffer);
    log(`✓ Downloaded ${Math.round(buffer.length / 1024)} KB. Extracting archive...`);
    try {
      // Windows 10/11, macOS, and Linux all provide native tar
      execFileSync("tar", ["-xf", archivePath, "-C", stageDir], { stdio: "pipe" });
    } catch (err) {
      // Fallback on Windows if tar fails
      if (platform === "win32") {
        execFileSync(
          "powershell",
          ["-NoProfile", "-Command", formatWindowsExpandArchiveCommand(archivePath, stageDir)],
          { stdio: "pipe", windowsHide: true }
        );
      } else {
        throw err;
      }
    }

    let extractedExe = path.join(stageDir, assetInfo.exeName);
    if (!fs.existsSync(extractedExe)) {
      for (const entry of fs.readdirSync(stageDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const nested = path.join(stageDir, entry.name, assetInfo.exeName);
          if (fs.existsSync(nested)) {
            extractedExe = nested;
            break;
          }
        }
      }
    }
    if (!fs.existsSync(extractedExe)) {
      throw new Error(`Extracted RTK archive did not contain expected binary '${assetInfo.exeName}'.`);
    }

    fs.mkdirSync(resolvedTargetBinDir, { recursive: true });
    const tmpTargetExe = `${targetExe}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.copyFileSync(extractedExe, tmpTargetExe);
    if (platform !== "win32") {
      try { fs.chmodSync(tmpTargetExe, 0o755); } catch {}
    }
    try {
      fs.renameSync(tmpTargetExe, targetExe);
    } catch {
      fs.copyFileSync(tmpTargetExe, targetExe);
      try { fs.unlinkSync(tmpTargetExe); } catch {}
    }
    if (platform !== "win32") {
      try { fs.chmodSync(targetExe, 0o755); } catch {}
    }
  } finally {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}
  }

  const verifiedVersion = verifyLocalRtkBinary(targetExe, options);
  if (!verifiedVersion) {
    try { fs.unlinkSync(targetExe); } catch {}
    throw new Error(`RTK installation verification failed: could not run ${targetExe}`);
  }
  const verified = { path: targetExe, version: verifiedVersion, isLocal: true };

  ensureRtkConfigured(options);

  log(`✓ Successfully installed and verified RTK: ${verified.version} at ${verified.path}`);
  return verified;
}

export function getRtkConfigPath(options = {}) {
  const platform = options.platform || os.platform();
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const profileHome = options.profileHome !== undefined ? options.profileHome : env.AGY_TEST_PROFILE_DIR;

  if (profileHome) {
    if (platform === "win32") {
      return path.join(profileHome, "AppData", "Roaming", "rtk", "config.toml");
    }
    if (platform === "darwin") {
      return path.join(profileHome, "Library", "Application Support", "rtk", "config.toml");
    }
    return path.join(profileHome, ".config", "rtk", "config.toml");
  }
  if (platform === "win32") {
    const appData = env.APPDATA || path.join(homeDir, "AppData", "Roaming");
    return path.join(appData, "rtk", "config.toml");
  }
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "rtk", "config.toml");
  }
  const configHome = env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
  return path.join(configHome, "rtk", "config.toml");
}

export function updateRtkConfigToml(content) {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  let inHooks = false;
  let seenAnySection = false;
  let hooksHeaderIndex = -1;
  let updated = false;
  let alreadyEnabled = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (/^\[\[.+?\]\](?:\s*#.*)?$/.test(trimmed)) {
      seenAnySection = true;
      inHooks = false;
      continue;
    }

    const sectionMatch = trimmed.match(/^\[\s*([^\]]+?)\s*\](?:\s*#.*)?$/);
    if (sectionMatch) {
      seenAnySection = true;
      const sectionName = sectionMatch[1].trim().toLowerCase();
      inHooks = sectionName === "hooks";
      if (inHooks && hooksHeaderIndex === -1) {
        hooksHeaderIndex = i;
      }
      continue;
    }

    if (!seenAnySection) {
      const dottedMatch = line.match(/^(\s*)hooks\s*\.\s*suppress_hook_warning\s*=\s*(true|false)(?=\s*(?:#|$))(.*)$/i);
      if (dottedMatch) {
        if (dottedMatch[2].toLowerCase() === "true") {
          alreadyEnabled = true;
        } else {
          lines[i] = `${dottedMatch[1]}hooks.suppress_hook_warning = true${dottedMatch[3]}`;
          updated = true;
        }
        break;
      }
    }

    if (inHooks) {
      const keyMatch = line.match(/^(\s*)suppress_hook_warning\s*=\s*(true|false)(?=\s*(?:#|$))(.*)$/i);
      if (keyMatch) {
        if (keyMatch[2].toLowerCase() === "true") {
          alreadyEnabled = true;
        } else {
          lines[i] = `${keyMatch[1]}suppress_hook_warning = true${keyMatch[3]}`;
          updated = true;
        }
        break;
      }
    }
  }

  if (alreadyEnabled) {
    return { changed: false, content };
  }
  if (updated) {
    return { changed: true, content: lines.join(eol) };
  }
  if (hooksHeaderIndex !== -1) {
    lines.splice(hooksHeaderIndex + 1, 0, "suppress_hook_warning = true");
    return { changed: true, content: lines.join(eol) };
  }

  const trimmedEnd = content.trimEnd();
  const nextContent = trimmedEnd
    ? `${trimmedEnd}${eol}${eol}[hooks]${eol}suppress_hook_warning = true${eol}`
    : `[hooks]${eol}suppress_hook_warning = true${eol}`;
  return { changed: true, content: nextContent };
}

export function ensureRtkConfigured(options = {}) {
  const log = options.silent ? () => {} : console.log;
  const configPath = getRtkConfigPath(options);
  const configDir = path.dirname(configPath);

  try {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    if (!fs.existsSync(configPath)) {
      const defaultContent = `[hooks]\nsuppress_hook_warning = true\n`;
      fs.writeFileSync(configPath, defaultContent, "utf-8");
      log(`✓ Initialized RTK configuration with suppress_hook_warning = true at ${configPath}`);
    } else {
      const content = fs.readFileSync(configPath, "utf-8");
      const result = updateRtkConfigToml(content);
      if (result.changed) {
        fs.writeFileSync(configPath, result.content, "utf-8");
        log(`✓ Configured suppress_hook_warning = true in ${configPath}`);
      }
    }
  } catch (err) {
    if (!options.silent) {
      console.warn(`[WARN] Could not standardize RTK config: ${err.message}`);
    }
  }
}

// Auto-run if executed directly
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureRtkInstalled().catch((err) => {
    console.error("Error provisioning RTK:", err);
    process.exit(1);
  });
}
