/**
 * Per-user state location for Agy-Context-Saver (governance ledger, RTK rewrite cache).
 *
 * State lives in a folder owned by this user, never in the shared os.tmpdir():
 *   Windows: %LOCALAPPDATA%\agy-context-saver
 *   POSIX:   $XDG_STATE_HOME/agy-context-saver (default ~/.local/state/agy-context-saver)
 * Under AGY_TEST_PROFILE_DIR the same layout is rooted in the test profile.
 *
 * The hook is mirrored into ~/.gemini/config/scripts as a standalone file, so it keeps an
 * identical inline copy of getStateDir(). tests/test-hook.mjs checks that the two agree.
 * No side effects on import.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function getStateDir() {
  const profileHome = process.env.AGY_TEST_PROFILE_DIR;
  if (os.platform() === "win32") {
    const localAppData = profileHome
      ? path.join(profileHome, "AppData", "Local")
      : (process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"));
    return path.join(localAppData, "agy-context-saver");
  }
  const stateHome = profileHome
    ? path.join(profileHome, ".local", "state")
    : (process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"));
  return path.join(stateHome, "agy-context-saver");
}

// Files that versions up to 1.7.0 left in the shared temp folder, plus their atomic-write temps.
const LEGACY_TMP_STATE = /^(agy-session-.+\.json|agy-rtk-rewrite-cache\.json)(\..+\.tmp)?$/;

/** Removes state files that older versions wrote to os.tmpdir(). Returns the paths removed. */
export function removeLegacyTmpState() {
  const removed = [];
  const tmp = os.tmpdir();
  let names = [];
  try { names = fs.readdirSync(tmp); } catch { return removed; }
  for (const name of names) {
    if (!LEGACY_TMP_STATE.test(name)) continue;
    const p = path.join(tmp, name);
    try {
      if (fs.lstatSync(p).isFile()) {
        fs.unlinkSync(p);
        removed.push(p);
      }
    } catch {}
  }
  return removed;
}
