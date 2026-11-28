#!/usr/bin/env node

/**
 * Agy-Context-Saver PreToolUse Execution Governor Router (A2 + B1 + 3-Module C).
 * Fast-path exits immediately for non-governed tools before dynamically importing
 * only the tool-family guard needed for the active call.
 */

import fs from "node:fs";
import process from "node:process";

const INSPECTION_TOOLS = new Set(["read_file", "view_file", "read_many_files", "grep_search", "find_by_name", "list_dir"]);
const MUTATION_TOOLS = new Set(["write_file", "write_to_file", "edit_file", "replace_file_content", "multi_replace_file_content"]);
const TASK_TOOLS = new Set(["manage_task", "schedule"]);
const GOVERNED_TOOLS = new Set(["run_command", ...INSPECTION_TOOLS, ...MUTATION_TOOLS, ...TASK_TOOLS]);
const GOVERNED_NAME_RE =
  /"(?:name|tool_name)"\s*:\s*"(?:run_command|read_file|view_file|read_many_files|grep_search|find_by_name|list_dir|manage_task|schedule|replace_file_content|multi_replace_file_content|write_to_file|write_file|edit_file)"/i;

const STDIN_READ_TIMEOUT_MS = 5000;
const STDIN_WAIT_ARR = new Int32Array(new SharedArrayBuffer(4));

function exitJson(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(0);
}

function readStdinUtf8() {
  const chunks = [];
  const buf = Buffer.allocUnsafe(65536);
  const deadline = Date.now() + STDIN_READ_TIMEOUT_MS;
  while (true) {
    try {
      const bytesRead = fs.readSync(0, buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
    } catch (err) {
      const code = err?.code;
      if (code === "EOF") break;
      if ((code === "EAGAIN" || code === "EWOULDBLOCK" || code === "EINTR") && Date.now() < deadline) {
        try { Atomics.wait(STDIN_WAIT_ARR, 0, 0, 2); } catch {}
        continue;
      }
      throw err;
    }
  }
  if (chunks.length === 0) return "";
  if (chunks.length === 1) return chunks[0].toString("utf-8");
  return Buffer.concat(chunks).toString("utf-8");
}

let failClosed = true;

try {
  const inputRaw = readStdinUtf8();
  failClosed = false;
  if (!inputRaw || !inputRaw.trim()) exitJson({ decision: "allow" });

  let maybeGoverned = false;
  for (const name of GOVERNED_TOOLS) {
    if (inputRaw.includes(name)) {
      maybeGoverned = true;
      break;
    }
  }
  if (!maybeGoverned) exitJson({ decision: "allow" });

  failClosed = GOVERNED_NAME_RE.test(inputRaw);
  const payload = JSON.parse(inputRaw);
  const toolCall = payload.toolCall || payload.tool_call || {};
  const toolName = String(toolCall.name || toolCall.tool_name || "").trim().toLowerCase();
  if (!GOVERNED_TOOLS.has(toolName)) exitJson({ decision: "allow" });

  failClosed = true;
  const rawCwd = payload.cwd || payload.workspacePath || "";
  const ctx = {
    toolName,
    args: toolCall.args || toolCall.arguments || {},
    convId: payload.conversationId || "global",
    cwd: typeof rawCwd === "string" ? rawCwd.trim() : "",
    transcriptPath: typeof payload.transcriptPath === "string" ? payload.transcriptPath.trim() : ""
  };

  if (toolName === "run_command") {
    const { handleRunCommand } = await import("./hook/shell-guard.mjs");
    await handleRunCommand(ctx);
  } else if (INSPECTION_TOOLS.has(toolName)) {
    const { handleInspectionTool } = await import("./hook/file-guard.mjs");
    await handleInspectionTool(ctx);
  } else if (MUTATION_TOOLS.has(toolName)) {
    const { handleMutationTool } = await import("./hook/file-guard.mjs");
    handleMutationTool(ctx);
  } else if (TASK_TOOLS.has(toolName)) {
    const { handleTaskOrSchedule } = await import("./hook/task-guard.mjs");
    handleTaskOrSchedule(ctx);
  }

  exitJson({ decision: "allow" });
} catch (err) {
  if (failClosed) {
    exitJson({
      decision: "deny",
      reason: `Antigravity Governance: Exception encountered while evaluating governed tool call: ${err?.message || err}. Denied for session integrity.`
    });
  }
  exitJson({ decision: "allow" });
}
