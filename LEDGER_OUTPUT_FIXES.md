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

## 3. The Four Non-Fragile Architectural Pillars (Simplified 0-New-Tools Architecture)

To ensure long-term resilience without tool proliferation or agent cognitive tax, `Agy-Context-Saver` adopts four architectural pillars governed by **Lifecycle State and Canonical Tools**, rather than inventing redundant MCP wrappers.

```
       +-------------------------------------------------------------+
       |             Agy-Context-Saver Streamlined Model             |
       +-------------------------------------------------------------+
                                      |
         +----------------------------+----------------------------+
         |                            |                            |
         v                            v                            v
  [PILLAR 1: SPILLED DATA]    [PILLAR 2: TASKS]           [PILLAR 3: FORENSICS]
  Ephemeral Step Spillovers   Lifecycle-Gated Output      Folded Step Dereferencing
  -> Safe-Harbor `rtk read`   -> `rtk read tasks/*.log`   -> query_transcript(stepIndex)
  (Native Line Clamping)      (Denied while RUNNING;      (Surgical Step Extraction;
                              Allowed when COMPLETED)     No Blind Substring Slicing)
                                      |
                                      v
                         [PILLAR 4: AGENT PROTOCOL]
                         Pointer-Over-Wire (POW)
                         (Control metadata in message;
                          Payload written to disk artifact)
```

---

### Pillar 1: Safe-Harbor `rtk read` for Runtime Step Spillovers (0 New Tools)

* **Principle**: When Antigravity spills large tool outputs to disk (`.system_generated/steps/<step>/output.txt`), the agent naturally reaches for standard file reading (`rtk read`). `rtk read` *already* has built-in line clamping, head/tail windowing, and token truncation.
* **Architecture**:
  1. The PreToolUse hook (`scripts/execution-guard-hook.mjs`) provides a **Safe Harbor** allowing `rtk read` on `/\.system_generated\/steps\/\d+\/output\.txt$/`.
  2. Direct inspection calls via native tools (`view_file`, `read_file`, `cat`) are automatically routed to `rtk read <path>`.
  3. Zero new MCP tools. Zero guessing for the agent.

---

### Pillar 2: Lifecycle-Gated Task Output Inspection via `rtk read` (0 New Tools)

* **Principle**: **Gate by Lifecycle State, Never by Filesystem Path.**
  * While a task is `RUNNING`: Reading task logs (`tasks/<taskId>.log`) is strictly **DENIED** under Proportional Backoff to eliminate busy-waiting polling loops.
  * When a task is `TERMINATED` (`CLOSED`, `EXIT 0`, `EXIT 1`, `KILLED`): The task output is an immutable historical record. Reading it via `rtk read tasks/<taskId>.log` is **ALLOWED** under lifecycle governance.
* **Architecture**:
  1. When an agent runs `rtk read tasks/<taskId>.log`:
     - If the task is `RUNNING`: Denied with Proportional Backoff countdown and increment session denials.
     - If the task is `COMPLETED` / `TERMINATED`: Allowed immediately with RTK output summarization (compressing stack traces, ANSI stripping, test table formatting).
  2. If the agent calls `view_file` on a completed task log, the hook routes it to `rtk read <path>`.
  3. Zero new MCP tools. Polling is blocked cold; post-mortem inspection is guaranteed.

---

### Pillar 3: Folded Surgical Step Dereferencing & Argument Projection (0 New Tools)

* **Principle**: Never add redundant MCP tools when an existing tool already owns the domain. `query_transcript` already owns forensic trajectory queries; fold single-step extraction directly into it.
* **Architecture**:
  1. **Enhanced `query_transcript`**:
     - Added optional `stepIndex` (number) and `field` (string) parameters to `query_transcript`.
     - Calling `query_transcript(stepIndex=974)` surgically extracts the un-truncated full payload of that single step from `transcript_full.jsonl`.
     - Calling `query_transcript(stepIndex=974, field="content")` projects only the requested field.
  2. **Typed Argument Descriptors (NFF-04)**:
     - Replaced the destructive `.slice(0, 80)` in `formatTranscriptItem()` with typed argument descriptors (`[14.2 KB String]`, `[Array(5)]`, `{Object(3 keys)}`).
     - Transcript overviews remain ultra-compact while preserving valid data shapes.

---

### Pillar 4: Pointer-Over-Wire (POW) Subagent Contract

* **Principle**: **Control Plane passes references; Data Plane stores payloads.**
  * In distributed systems, high-bandwidth payloads are never transmitted across in-band messaging buses.
  * In Antigravity, `send_message` and `<SYSTEM_MESSAGE>` have fixed transport payload boundaries (~16–20 KB). Transmitting multi-file research reports in `send_message` is an architectural misuse of the message bus.
* **Architecture**:
  1. **Subagent Brief Injection (`mcp/index.js:subagent_brief`)**:
     `subagent_brief` automatically injects the Pointer-Over-Wire contract into every formulated prompt:
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

## 4. Master Non-Fragile Fix Ledger (Streamlined Model)

| Fix ID | Pillar | Component | Exact Technical Implementation | Long-Term Robustness Rationale |
| :--- | :---: | :--- | :--- | :--- |
| **NFF-01** | **1** | `scripts/execution-guard-hook.mjs` | Safe-harbor `rtk read` for `steps/*/output.txt` runtime spillover files. | Zero new tools; leverages existing `rtk read` line clamping and token windowing. |
| **NFF-02** | **1** | `scripts/execution-guard-hook.mjs` | Hard-routes native `view_file` calls on spillover files to `rtk read <path>`. | Transparent to agent; eliminates hard access denials for legitimate system spillovers. |
| **NFF-03** | **2** | `scripts/execution-guard-hook.mjs` | Lifecycle gating on `tasks/${taskId}.log`: denied when `RUNNING`, allowed via `rtk read` when `COMPLETED`. | Solves the Catch-22: strictly blocks active polling while guaranteeing post-mortem retrieval. |
| **NFF-04** | **3** | `mcp/index.js` (`formatTranscriptItem`) | Replaced `JSON.stringify(v).slice(0, 80)` with typed argument descriptors (`[14.2 KB String]`). | Eliminates data destruction in transcript summaries; preserves valid JSON structure. |
| **NFF-05** | **3** | `mcp/index.js` (`query_transcript`) | Folded surgical step extraction (`stepIndex`, `field`) into existing `query_transcript`. | Zero new tools; single unified transcript query tool handles overview search and surgical dereferencing. |
| **NFF-06** | **4** | `mcp/index.js` (`subagent_brief`) | Programmatic injection of the Pointer-Over-Wire (POW) delivery contract into all subagent prompts. | Eliminates in-band message truncations at the root by decoupling control references from data payloads. |

---

## 5. Architectural Comparison: 3-Bespoke-Tool Proposal vs 0-New-Tool Consolidation

| Metric / Attribute | Research Proposal (3 New Tools) | Streamlined Refactoring (0 New Tools) |
| :--- | :---: | :---: |
| **Registered MCP Tools** | 9 tools (`+3` bespoke tools) | **6 canonical tools (`+0` new tools)** |
| **Prompt Token Cost per Turn** | ~1,200 tokens added permanently | **0 tokens added** (0 schema bloat) |
| **Agent Tool-Selection Ambiguity** | High (agent guesses between 9 overlapping tools) | **Zero** (agent uses canonical `rtk read` & `query_transcript`) |
| **Principle of Least Surprise** | Violated (requires learning bespoke MCP wrappers) | **Honored** (agent reads spillover file using standard `rtk read`) |
| **Polling Loop Governance** | Enforced in MCP | **Enforced in PreToolUse Hook** |
| **Test Suite Coverage** | Custom bespoke tests | **100% Passing Across All 7 Suites** |

---

## 6. Implementation Checklist & Verification Matrix

- [x] **Phase 1: MCP Server Consolidation**
  - Folded `stepIndex` and `field` dereferencing directly into `query_transcript`.
  - Reverted tool registry to strictly 6 canonical tools (removed `get_spillover_content`, `read_task_output`, `get_step_detail`).
  - Removed arbitrary 80-char slicing in `formatTranscriptItem()` in favor of typed descriptors.
- [x] **Phase 2: Hook Execution Governance & Safe Harbor**
  - Updated `scripts/execution-guard-hook.mjs` to safe-harbor `rtk read` on `steps/*/output.txt`.
  - Lifecycle-gated `tasks/*.log`: Proportional Backoff on `RUNNING`, allowed `rtk read` on `COMPLETED`.
  - Preserved root protection for internal database and transcript files.
- [x] **Phase 3: Protocol Hardening & Verification**
  - Preserved Pointer-Over-Wire rules in `subagent_brief`.
  - Rewrote and passed `tests/test-output-governance.mjs`.
  - All 7 test suites passing 100% (`npm test`).
