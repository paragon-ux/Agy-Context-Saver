import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const binDir = path.join(repoRoot, "bin");

export const RTK_VERSION = "v0.51.0";
export const MIN_COMPATIBLE_RTK_VERSION = "0.50.0";
export const MAX_COMPATIBLE_RTK_VERSION = "0.52.0";

export const RTK_CHECKSUMS = {
  "rtk-x86_64-pc-windows-msvc.zip": "1623e9b45d28b15122d69e7314776e1123a804224885ce07e7182fb40080f05c",
  "rtk-aarch64-apple-darwin.tar.gz": "8817d8b71afc02ac8bf06eb24bcc41c306592ab735b68e8fee9db1ba0de7cb59",
  "rtk-x86_64-apple-darwin.tar.gz": "bd39c8153f4147358360c7dc51665a8131cc9ee16f81f69a9402ffa500be3cc2",
  "rtk-x86_64-unknown-linux-musl.tar.gz": "5028d3b19a8f0990d30fec9fbb07e32782bc5698e618fb1861aad8a9ccba4eb5",
  "rtk-aarch64-unknown-linux-gnu.tar.gz": "8d6d1aad9e69b42481eda7039507d1f7ee93698f87713cecd873d287c1931632"
};

export function isCompatibleRtkVersion(versionStr) {
  if (!versionStr || typeof versionStr !== "string") return false;
  const match = versionStr.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  // Compatible if 0.50.x or 0.51.x (>= 0.50.0 and < 0.52.0)
  return major === 0 && (minor === 50 || minor === 51);
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

  // Check PATH
  try {
    const out = execSync("rtk --version", { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (isCompatibleRtkVersion(out)) {
      return { path: "rtk", version: out, isLocal: false };
    } else {
      if (!options.silent) {
        console.warn(`[WARN] System RTK version '${out}' is outside supported range [>=${MIN_COMPATIBLE_RTK_VERSION} <${MAX_COMPATIBLE_RTK_VERSION}]. Local pinned ${RTK_VERSION} will be required.`);
      }
    }
  } catch {}

  return null;
}

export async function ensureRtkInstalled(options = {}) {
  const log = options.silent ? () => {} : console.log;
  const existing = options.existingRtk || findExistingRtk(options);
  if (existing) {
    log(`✓ RTK is already installed and verified: ${existing.version} (${existing.path})`);
    return existing;
  }

  const assetInfo = getRtkPlatformAsset();
  if (!assetInfo) {
    throw new Error(`Unsupported platform/architecture for prebuilt RTK: ${os.platform()} ${os.arch()}`);
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
  const expectedHash = RTK_CHECKSUMS[assetInfo.asset];
  if (!expectedHash) {
    throw new Error(`Integrity error: No pinned SHA-256 checksum found for asset '${assetInfo.asset}'`);
  }
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

  log(`✓ Successfully installed and verified RTK: ${verified.version} at ${verified.path}`);
  return verified;
}

// Auto-run if executed directly
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureRtkInstalled().catch((err) => {
    console.error("Error provisioning RTK:", err);
    process.exit(1);
  });
}
