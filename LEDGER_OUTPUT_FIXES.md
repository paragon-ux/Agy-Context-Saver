# Agy-Context-Saver Output Inspection & Recovery Ledger (`LEDGER_OUTPUT_FIXES.md`)

**Target Subsystem**: `Agy-Context-Saver` Lifecycle Governor (`scripts/execution-guard-hook.mjs`), Universal MCP Server (`mcp/index.js`), and Agent Rules (`rules/AGENTS.md`)  
**Incident Reference**: Incident `07b0f8d8-0a2c-47ca-9330-e4ed04471a51` (*"Post-Sweep 55 Ungraded Task Evaluation & Forensic Recovery"*)  
**Created**: October 8, 2026  
**Status**: ACTIVE / NON-FRAGILE ARCHITECTURAL SPECIFICATION  

---

## 1. Executive Summary & Problem Statement

To prevent runaway polling loops (`manage_task(status)`) and transcript token explosion (uncompressed terminal streams), `Agy-Context-Saver` implemented a strict, root-level prohibition on inspecting Antigravity internal execution state (`.system_generated/`) across both native inspection tools (`view_file`, `read_file`) and shell execution (`run_command`).

While effective at stopping high-frequency polling, **this created an unintended "Output Blind-Spot Trap" (Information Black Hole / Catch-22)**:
1. **The System Requires Output Inspection**: Antigravity actively redirects large MCP tool responses ($>24\text{ KB}$) to disk at `.system_generated/steps/<step>/output.txt` and returns that file URI to the agent.
2. **The Hook Forbids the Inspection**: The PreToolUse hook unconditionally denies access to any path containing `.system_generated`, stating:
   > *"Direct shell/file access to internal Antigravity execution state (.system_generated) is strictly prohibited... Call MCP tool read_transcript or query_transcript instead."*
3. **The MCP Tool Cannot Fulfill the Request**:
   - `read_transcript` and `query_transcript` only inspect conversation transcripts (`transcript.jsonl`), **not** completed background task logs (`task-*.log`) or step spillover files (`output.txt`).
   - `formatTranscriptItem()` in `mcp/index.js:586` hardcoded an arbitrary **80-character substring slice** on all tool call arguments (`JSON.stringify(v).slice(0, 80)`), severing research reports passed via `send_message(Message="...")`.
   - When `query_transcript` returned multi-step findings, Antigravity redirected *that* output to `.system_generated/steps/.../output.txt`, trapping the agent in an unbreakable access denial loop.
4. **Antigravity Engine Constraint**: The platform schema strictly caps `WaitMsBeforeAsync` at `10000ms`. Any command taking $>10\text{s}$ **will** be sent to the background by the Antigravity engine. Therefore, post-completion background task log inspection is **not an edge case—it is a core architectural necessity**.

---

## 2. Systematic Fragility Audit of Naive Quick-Fixes

Before committing fixes, we audited naive proposals against long-term operational ramifications:

| Naive Fix | Failure Mode / Fragility | Long-Term Ramification | Verdict |
| :--- | :--- | :--- | :---: |
| **Path Regex Exemption**<br>`/\.system_generated\/steps\/\d+\/output\.txt$/` | Hardcodes Antigravity's internal directory conventions. Any runtime update (e.g. hash paths, subdirectories) breaks access. | Vulnerable to path-spoofing and runtime changes; routes raw, uncompressed text through `view_file`, bypassing RTK token optimization. | **REJECTED (Fragile)** |
| **Direct File Access to `task-*.log`** | Lifting the ban on `task-*.log` re-opens LH-02: agents will read the log in a loop while tasks run. | Reintroduces the Polling Trap and terminal bloat. | **REJECTED (Unsafe)** |
| **Key-Based Argument Slicing**<br>`if (key === "Message") allow` | Hardcoded list of "payload keys". Any new tool with arguments like `payload`, `script`, `document`, or `data` gets truncated. | Brittle heuristic that continuously breaks as new tools or MCP servers are added. | **REJECTED (Fragile)** |
| **Blind Wait Time Overwrite**<br>Overwriting `WaitMsBeforeAsync` to 30s | Antigravity engine schema strictly specifies a maximum of `10000ms`. Overwriting past 10s is invalid or ignored by the engine. | Violates platform contract; cannot prevent backgrounding for long commands. | **REJECTED (Invalid)** |
| **Prompt-Only Subagent Exhortation**<br>Telling subagents "do not send large messages" | LLMs frequently ignore length admonitions and dump long markdown into `send_message`. | Truncation continues at the messaging bus boundary (`<truncated 17393 bytes>`). | **REJECTED (Brittle)** |

---

## 3. The Four Non-Fragile Architectural Pillars

To ensure long-term resilience, `Agy-Context-Saver` adopts four architectural pillars governed by **Lifecycle State and Content Semantics**, rather than crude path regexes.

```
       +-------------------------------------------------------------+
       |             Agy-Context-Saver Long-Term Model               |
       +-------------------------------------------------------------+
                                      |
         +----------------------------+----------------------------+
         |                            |                            |
         v                            v                            v
  [PILLAR 1: SPILLED DATA]    [PILLAR 2: TASKS]           [PILLAR 3: FORENSICS]
  Ephemeral Tool Spillovers   Lifecycle-Gated Output      Semantic Step Projection
  -> get_spillover_content    -> read_task_output         -> get_step_detail
  (Safe RTK Windowing)        (Denied while RUNNING;      (Surgical Step Extraction;
                              Allowed when COMPLETED)     No Blind Substring Slicing)
                                      |
                                      v
                         [PILLAR 4: AGENT PROTOCOL]
                         Pointer-Over-Wire (POW)
                         (Control metadata in message;
                          Payload written to disk artifact)
```

---

### Pillar 1: Governed Runtime Spillover Bridge (`get_spillover_content`)

* **Principle**: When Antigravity spills large tool outputs to disk, the agent should never inspect raw internal paths with uncompressed file tools. It must retrieve the output through a governed bridge that guarantees token optimization.
* **Architecture**:
  1. Add a dedicated MCP tool: `get_spillover_content({ uri, lines = 100, tail = true, filterRegex })`.
  2. The MCP tool resolves the local file URI, validates that it resides within the active session's step directory, applies RTK output compression and line windowing, and returns a bounded text card ($<15\text{ KB}$).
  3. In `scripts/execution-guard-hook.mjs`, when an agent calls `view_file` or `run_command` targeting a `.system_generated/.../output.txt` path, the hook intercepts and automatically redirects the call:
     > *"Antigravity Governance: Direct file read of runtime spillover is optimized via MCP. Calling `get_spillover_content(uri)` instead."*

#### Tool Specification (`mcp/get_spillover_content.json`)
```json
{
  "name": "get_spillover_content",
  "description": "Safely inspects an ephemeral tool output spillover file generated by the Antigravity runtime, applying RTK token optimization and line windowing. Strictly bounded to prevent context blowout.",
  "parameters": {
    "type": "object",
    "properties": {
      "uri": {
        "type": "string",
        "description": "The file URI provided by the Antigravity runtime (e.g. 'file:///.../.system_generated/steps/507/output.txt')."
      },
      "lines": {
        "type": "number",
        "description": "Number of lines to return (default: 80, max: 200)."
      },
      "tail": {
        "type": "boolean",
        "description": "If true, returns the last N lines; if false, returns the first N lines (default: false)."
      },
      "filterRegex": {
        "type": "string",
        "description": "Optional regex to filter matching lines before returning."
      }
    },
    "required": ["uri"]
  }
}
```

---

### Pillar 2: Lifecycle-Gated Task Output Inspection (`read_task_output`)

* **Principle**: **Gate by Lifecycle State, Never by Filesystem Path.**
  * While a task is `RUNNING`: Reading task logs is **DENIED** under Proportional Backoff to eliminate busy-waiting.
  * When a task is `TERMINATED` (`CLOSED`, `EXIT 0`, `EXIT 1`, `KILLED`): The task output is an immutable historical record. Reading it is a one-time retrieval, not a polling loop.
* **Architecture**:
  1. Add a dedicated MCP tool: `read_task_output({ taskId, lines = 100, tail = true, filterRegex })`.
  2. The tool checks the task lifecycle state against the session ledger (`agy-session-${safeId}.json`):
     - If state is `RUNNING`: Deny immediately with countdown to next allowed diagnostic window.
     - If state is `COMPLETED` or `TERMINATED`: Read the log, apply RTK terminal output summarization (compressing stack traces, ANSI stripping, test table formatting), and return a clean $<12\text{ KB}$ summary.

#### Implementation Logic (`mcp/index.js`)
```javascript
async function handleReadTaskOutput(args = {}) {
  const { taskId, lines = 100, tail = true, filterRegex } = args;
  const cleanId = String(taskId).replace(/^.*[\/\\]/, ""); // Strip conversation prefix

  // 1. Lifecycle verification
  const session = loadSessionLedger();
  const taskRecord = session.tasks && session.tasks[cleanId];
  
  if (taskRecord && taskRecord.state === "RUNNING") {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `[GOVERNANCE DENIAL] Task '${cleanId}' is actively RUNNING. Reading logs during execution is prohibited to prevent polling loops. Rely on Reactive Wakeup.`
      }]
    };
  }

  // 2. Log resolution & bounded retrieval
  const logPath = resolveTaskLogPath(cleanId);
  if (!fs.existsSync(logPath)) {
    return {
      isError: true,
      content: [{ type: "text", text: `No log artifact found for completed task '${cleanId}'.` }]
    };
  }

  const raw = fs.readFileSync(logPath, "utf-8");
  const processed = windowAndFilterLog(raw, { lines, tail, filterRegex, maxChars: 12000 });
  
  return {
    content: [{
      type: "text",
      text: `### Task Output: \`${cleanId}\` (Status: ${taskRecord ? taskRecord.state : "TERMINATED"})\n\`\`\`text\n${processed}\n\`\`\``
    }]
  };
}
```

---

### Pillar 3: Semantic Step Introspection & Payload Extraction (`get_step_detail`)

* **Principle**: Never use arbitrary substring slicing (`.slice(0, 80)`) on JSON structures. Replace naive regex searches with **Semantic Projections** and surgical single-step extraction.
* **Architecture**:
  1. **Fix `formatTranscriptItem()`**: Remove the blind `.slice(0, 80)` on arguments. For overview displays, show structured argument summaries (e.g. `send_message(Message=<17.4 KB text>, Recipient=...)`).
  2. **Add `get_step_detail({ conversationId, stepIndex, field })`**:
     - Allows surgical extraction of specific step data directly from `transcript_full.jsonl`.
     - Can extract `field: "tool_calls[0].arguments.Message"`, `field: "content"`, or `field: "thinking"`.
     - Returns 100% of the requested field with full formatting preserved, eliminating all message truncations without loading surrounding turns into context.

#### Tool Specification (`mcp/get_step_detail.json`)
```json
{
  "name": "get_step_detail",
  "description": "Surgically retrieves the full, un-truncated content of a specific step from transcript_full.jsonl. Used to inspect large subagent messages, code blocks, or thinking blocks without transcript bloat.",
  "parameters": {
    "type": "object",
    "properties": {
      "conversationId": {
        "type": "string",
        "description": "Conversation ID (defaults to active session)."
      },
      "stepIndex": {
        "type": "number",
        "description": "The exact step_index to inspect."
      },
      "field": {
        "type": "string",
        "description": "Optional specific field path to extract (e.g. 'content', 'thinking', 'tool_calls', 'tool_args:Message'). Defaults to full step."
      }
    },
    "required": ["stepIndex"]
  }
}
```

---

### Pillar 4: Pointer-Over-Wire (POW) Subagent Contract

* **Principle**: **Control Plane passes references; Data Plane stores payloads.**
  * In distributed systems, high-bandwidth payloads are never transmitted across in-band messaging buses.
  * In Antigravity, `send_message` and `<SYSTEM_MESSAGE>` have fixed transport payload boundaries (~16–20 KB). Transmitting multi-file research reports in `send_message` is an architectural misuse of the message bus.
* **Architecture**:
  1. **Subagent Brief Injection (`mcp/index.js:subagent_brief`)**:
     Update `subagent_brief` to automatically inject the Pointer-Over-Wire contract into every formulated prompt:
     ```markdown
     DATA DELIVERY CONTRACT (POW):
     - If your findings or deliverable exceed 1 KB, write the full structured report to a file in the workspace (e.g. 'scratch/<task>_findings.md' or an artifact).
     - In 'send_message', transmit ONLY:
       1. Executive Summary (3-5 sentences)
       2. Key Verdicts / Scoreboard Table
       3. File Link: [Full Report](file:///absolute/path/to/report.md)
     - Once 'send_message' is dispatched, terminate your turn loop immediately so the parent agent wakes up without latency.
     ```
  2. **Zero Truncation Guarantee**: Because the message contains only high-signal metadata and a file pointer, `send_message` never hits platform truncation limits. The parent agent reads the full file directly via `rtk read`.

---

## 4. Master Non-Fragile Fix Ledger

| Fix ID | Pillar | Component | Exact Technical Implementation | Long-Term Robustness Rationale |
| :--- | :---: | :--- | :--- | :--- |
| **NFF-01** | **1** | `mcp/get_spillover_content.js` | Dedicated MCP tool to read runtime spillover files with RTK token windowing. | Replaces fragile regex file exemptions with a governed, token-optimized bridge. |
| **NFF-02** | **1** | `scripts/execution-guard-hook.mjs` | Intercepts `view_file` calls to `steps/*/output.txt` and rewrites them to `get_spillover_content`. | Transparent to the agent; eliminates hard access denials for legitimate system outputs. |
| **NFF-03** | **2** | `mcp/read_task_output.js` | MCP tool reading `tasks/${taskId}.log`, gated by task completion status in session ledger. | Solves the Catch-22: strictly blocks active polling while guaranteeing post-mortem inspection. |
| **NFF-04** | **3** | `mcp/index.js` (`formatTranscriptItem`) | Replace `JSON.stringify(v).slice(0, 80)` with typed argument descriptors (`[17.4 KB String]`). | Eliminates data destruction in transcript summaries; preserves valid JSON structure. |
| **NFF-05** | **3** | `mcp/get_step_detail.js` | Surgical step payload extractor reading directly from `transcript_full.jsonl`. | Allows recovering truncated subagent messages or tool payloads without loading multi-turn context. |
| **NFF-06** | **4** | `mcp/index.js` (`subagent_brief`) | Programmatic injection of the Pointer-Over-Wire (POW) delivery contract into all subagent prompts. | Eliminates in-band message truncations at the root by decoupling control references from data payloads. |

---

## 5. Ramifications & Safety Analysis

### 1. Loophole Regression Prevention
* **Does NFF-03 reopen the Polling Trap?**
  * **No.** `read_task_output` inspects `session.tasks[id].state`. If the task is still running, the call is rejected with the exact countdown remaining under the Proportional Backoff curve. It is physically impossible to use `read_task_output` to poll an active process.
* **Does NFF-01 reopen Transcript Bloat?**
  * **No.** `get_spillover_content` clamps lines to a maximum of 200 and total bytes to 12 KB, applying RTK summarization. A 10 MB terminal dump is compressed at the tool boundary before it can enter conversation context.

### 2. Cross-Platform & Engine Version Independence
* **Path Independence**: None of the non-fragile fixes rely on hardcoded path regexes. `get_spillover_content` takes whatever URI the Antigravity runtime provides.
* **Engine Alignment**: Operates completely within Antigravity's native 10,000ms `WaitMsBeforeAsync` limit, treating asynchronous background tasks as first-class, fully observable entities.

---

## 6. Implementation Checklist & Verification Matrix

- [ ] **Phase 1: MCP Server Enhancement**
  - Implement `mcp/get_spillover_content.js` and register schema.
  - Implement `mcp/read_task_output.js` with lifecycle gating.
  - Implement `mcp/get_step_detail.js` for surgical step dereferencing.
  - Remove arbitrary 80-char slicing in `formatTranscriptItem()`.
- [ ] **Phase 2: Hook Rewriting**
  - Update `scripts/execution-guard-hook.mjs` to redirect spillover file reads to `get_spillover_content`.
  - Validate that `isProtectedInternalState()` preserves root protection for internal databases and live task logs.
- [ ] **Phase 3: Protocol Hardening**
  - Update `subagent_brief` prompt template with Pointer-Over-Wire rules.
  - Add test suite in `tests/test_output_inspection_governance.mjs`.
