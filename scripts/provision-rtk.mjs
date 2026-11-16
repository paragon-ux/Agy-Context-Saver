import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const binDir = path.join(repoRoot, "bin");

export const RTK_VERSION = "v1.1.0";
export const MIN_RTK_VERSION = "1.1.0";
export const MIN_COMPATIBLE_RTK_VERSION = MIN_RTK_VERSION;

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

export function getRtkPlatformAsset() {
  const platform = os.platform();
  const arch = os.arch();

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

export function findExistingRtk(options = {}) {
  const names = os.platform() === "win32" ? ["rtk.exe", "rtk.cmd"] : ["rtk"];
  const profileHome = process.env.AGY_TEST_PROFILE_DIR || os.homedir();
  const pluginBinDir = path.join(profileHome, ".gemini", "config", "plugins", "agy-context-saver", "bin");
  const candidateDirs = [binDir, pluginBinDir];

  // Check PATH first so a system rtk >= 1.1.0 is preferred over bundled binaries
  try {
    const out = execSync("rtk --version", { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (isCompatibleRtkVersion(out)) {
      return { path: "rtk", version: out, isLocal: false };
    }
    if (!options.silent) {
      console.warn(`[WARN] System RTK version '${out}' is below minimum supported version >=${MIN_RTK_VERSION}. Local or manual ${RTK_VERSION} installation is required.`);
    }
  } catch {}

  for (const dir of candidateDirs) {
    for (const exeName of names) {
      const localExe = path.join(dir, exeName);
      if (fs.existsSync(localExe)) {
        try {
          const out = execSync(`"${localExe}" --version`, { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
          if (isCompatibleRtkVersion(out)) {
            return { path: localExe, version: out, isLocal: true };
          }
        } catch {}
      }
    }
  }

  return null;
}

export async function ensureRtkInstalled(options = {}) {
  const log = options.silent ? () => {} : console.log;
  const existing = options.existingRtk || findExistingRtk(options);
  if (existing) {
    ensureRtkConfigured(options);
    log(`✓ RTK is already installed and verified: ${existing.version} (${existing.path})`);
    return existing;
  }

  const assetInfo = getRtkPlatformAsset();
  if (!assetInfo) {
    throw new Error(`Unsupported platform/architecture for prebuilt RTK: ${os.platform()} ${os.arch()}`);
  }

  // Fail closed when the target release asset checksum is unpinned/missing instead of trusting stale hashes
  const expectedHash = RTK_CHECKSUMS[assetInfo.asset];
  if (!expectedHash) {
    throw new Error(
      `Integrity error: No pinned SHA-256 checksum configured for RTK ${RTK_VERSION} asset '${assetInfo.asset}'.\n` +
      `Automated download aborted (fail-closed). Please install RTK >= ${MIN_RTK_VERSION} manually and ensure 'rtk' is on your PATH:\n` +
      `  - macOS (Homebrew): brew install rtk\n` +
      `  - Cargo:            cargo install --locked rtk\n` +
      `  - Official script:  curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh\n` +
      `  - GitHub Releases:  https://github.com/rtk-ai/rtk/releases/tag/${RTK_VERSION}`
    );
  }

  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  const targetExe = path.join(binDir, assetInfo.exeName);
  const downloadUrl = `https://github.com/rtk-ai/rtk/releases/download/${RTK_VERSION}/${assetInfo.asset}`;
  log(`⚡ Downloading RTK ${RTK_VERSION} from ${downloadUrl}...`);

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download RTK release (${response.status} ${response.statusText}): ${downloadUrl}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

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

  const archivePath = path.join(binDir, assetInfo.asset);
  fs.writeFileSync(archivePath, buffer);

  log(`✓ Downloaded ${Math.round(buffer.length / 1024)} KB. Extracting archive...`);
  try {
    // Windows 10/11, macOS, and Linux all provide native tar
    execSync(`tar -xf "${archivePath}" -C "${binDir}"`, { stdio: "pipe" });
  } catch (err) {
    // Fallback on Windows if tar fails
    if (os.platform() === "win32") {
      execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${binDir}' -Force"`, { stdio: "pipe" });
    } else {
      throw err;
    }
  } finally {
    try { fs.unlinkSync(archivePath); } catch {}
  }

  // Make executable on POSIX
  if (os.platform() !== "win32") {
    try { fs.chmodSync(targetExe, 0o755); } catch {}
  }

  const verified = findExistingRtk(options);
  if (!verified) {
    throw new Error(`RTK installation verification failed: could not run ${targetExe}`);
  }

  ensureRtkConfigured(options);

  log(`✓ Successfully installed and verified RTK: ${verified.version} at ${verified.path}`);
  return verified;
}

export function getRtkConfigPath() {
  const profileHome = process.env.AGY_TEST_PROFILE_DIR;
  if (profileHome) {
    if (os.platform() === "win32") {
      return path.join(profileHome, "AppData", "Roaming", "rtk", "config.toml");
    }
    return path.join(profileHome, ".config", "rtk", "config.toml");
  }
  if (os.platform() === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "rtk", "config.toml");
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "rtk", "config.toml");
}

export function ensureRtkConfigured(options = {}) {
  const log = options.silent ? () => {} : console.log;
  const configPath = getRtkConfigPath();
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
      let content = fs.readFileSync(configPath, "utf-8");
      if (/suppress_hook_warning\s*=\s*false/i.test(content)) {
        content = content.replace(/suppress_hook_warning\s*=\s*false/i, "suppress_hook_warning = true");
        fs.writeFileSync(configPath, content, "utf-8");
        log(`✓ Updated RTK configuration to suppress_hook_warning = true in ${configPath}`);
      } else if (!/suppress_hook_warning/i.test(content)) {
        if (/\[hooks\]/i.test(content)) {
          content = content.replace(/\[hooks\]/i, "[hooks]\nsuppress_hook_warning = true");
        } else {
          content = (content.trim() + "\n\n[hooks]\nsuppress_hook_warning = true\n").trimStart();
        }
        fs.writeFileSync(configPath, content, "utf-8");
        log(`✓ Configured suppress_hook_warning = true in ${configPath}`);
      }
    }
  } catch (err) {
    if (!options.silent) {
      console.warn(`[WARN] Could not standardize RTK config: ${err.message}`);
    }
  }

  ensureGitLineEndingConfigured(options);
}

export function ensureGitLineEndingConfigured(options = {}) {
  const log = options.silent ? () => {} : console.log;
  try {
    const env = { ...process.env };
    if (process.env.AGY_TEST_PROFILE_DIR && !env.GIT_CONFIG_GLOBAL) {
      env.GIT_CONFIG_GLOBAL = path.join(process.env.AGY_TEST_PROFILE_DIR, ".gitconfig");
    }
    execSync("git config --global core.safecrlf false", { windowsHide: true, stdio: "ignore", env });
    log("✓ Standardized git core.safecrlf = false to suppress line-ending warning noise");
  } catch {}
}

// Auto-run if executed directly
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureRtkInstalled().catch((err) => {
    console.error("Error provisioning RTK:", err);
    process.exit(1);
  });
}
