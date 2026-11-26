/** Single-use identity grants written by the hook in protected plugin state. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getStateDir } from "../scripts/state-dir.mjs";

const PREFIX = "transcript-hook-grant-";
const TTL = 15000;
const grantPath = (nonce) => path.join(getStateDir(), `${PREFIX}${nonce}.json`);

function pruneGrants() {
  for (const name of fs.readdirSync(getStateDir())) {
    if (!/^transcript-hook-grant-[a-f0-9]{32}\.json$/.test(name)) continue;
    const file = path.join(getStateDir(), name);
    try { if (Date.now() - fs.lstatSync(file).mtimeMs > TTL) fs.unlinkSync(file); }
    catch (err) { if (err.code !== "ENOENT") throw err; }
  }
}

export function mintHookIdentity(ctx, command) {
  if (!/^[a-zA-Z0-9_-]{4,}$/.test(ctx.convId || "") || ctx.convId === "global") return null;
  fs.mkdirSync(getStateDir(), { recursive: true });
  pruneGrants();
  const nonce = crypto.randomBytes(16).toString("hex");
  const issuedAt = Date.now();
  fs.writeFileSync(grantPath(nonce), JSON.stringify({ nonce, convId: ctx.convId, transcriptPath: ctx.transcriptPath || "", command, issuedAt, expiresAt: issuedAt + TTL }), { flag: "wx", mode: 0o600 });
  return nonce;
}

export function resolveCallerIdentity(nonce, command) {
  if (nonce === undefined) return { callerConvId: (process.env.GEMINI_CONVERSATION_ID || "").trim(), activeTranscriptPath: "" };
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new Error("Invalid hook identity grant.");
  const file = grantPath(nonce);
  let fd;
  let grant;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 8192) throw new Error("Invalid hook identity grant.");
    grant = JSON.parse(fs.readFileSync(fd, "utf-8"));
    // Only the process that removes the grant may use it.
    fs.unlinkSync(file);
  } catch { throw new Error("Invalid or consumed hook identity grant."); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  if (grant.nonce !== nonce || grant.command !== command || !/^[a-zA-Z0-9_-]{4,}$/.test(grant.convId || "") ||
      !Number.isFinite(grant.issuedAt) || grant.issuedAt > Date.now() || grant.expiresAt <= Date.now() || grant.expiresAt - grant.issuedAt !== TTL) {
    throw new Error("Invalid or expired hook identity grant.");
  }
  pruneGrants();
  return { callerConvId: grant.convId, activeTranscriptPath: grant.transcriptPath };
}
