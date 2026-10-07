import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const binDir = path.join(repoRoot, "bin");

export const RTK_VERSION = "v0.51.0";

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

export function findExistingRtk() {
  // Check local binDir first
  const info = getRtkPlatformAsset();
  const localExe = info ? path.join(binDir, info.exeName) : null;
  if (localExe && fs.existsSync(localExe)) {
    try {
      const out = execSync(`"${localExe}" --version`, { encoding: "utf-8", timeout: 5000 }).trim();
      return { path: localExe, version: out, isLocal: true };
    } catch {}
  }

  // Check PATH
  try {
    const out = execSync("rtk --version", { encoding: "utf-8", timeout: 5000 }).trim();
    return { path: "rtk", version: out, isLocal: false };
  } catch {}

  return null;
}

export async function ensureRtkInstalled(options = {}) {
  const log = options.silent ? () => {} : console.log;
  const existing = options.existingRtk || findExistingRtk();
  if (existing) {
    log(`✓ RTK is already installed: ${existing.version} (${existing.path})`);
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

  const verified = findExistingRtk();
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
