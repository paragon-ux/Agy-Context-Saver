# MCP Tool, Prompt & CLI Reference

`Agy-Context-Saver` implements standard Model Context Protocol (MCP) capabilities purpose-built for Antigravity:
- **6 Agent-Facing Tools**: Invoked autonomously by the AI during coding sessions to govern lifecycles, stream transcripts, and audit installations.
- **1 User-Facing Prompt (`context_shield`)**: Appears as a slash command (`/mcp:agy-context-saver:context_shield`) in the chat autocomplete menu to inject 3-layer governance rules with a single click.
- **RTK (Rust Token Killer)**: Transparent CLI proxy that reduces terminal and inspection token consumption by 60–99%.

---

## Canonical Codebase Inspection via RTK

Native file and search tools (`view_file`, `grep_search`, `find_by_name`, `list_dir`) bypass token compression and are hard-routed by Agy's PreToolUse hook to RTK shell commands:

| Command | Usage | Description |
| :--- | :--- | :--- |
| `rtk read <file>` | `rtk read src/main.rs` | Reads file with intelligent token filtering and line numbers. |
| `rtk grep "<pattern>"` | `rtk grep "TODO" src/` | Compact ripgrep search grouped by file. |
| `rtk find <path>` | `rtk find .` | Compact directory search tree. |
| `rtk ls` | `rtk ls` | Token-optimized directory listing. |
| `rtk err <cmd>` | `rtk err cargo test` | Runs command and shows only errors and warnings. |
| `rtk summary <cmd>` | `rtk summary git diff` | Runs command and produces a 2-line technical summary. |

---

## 1. `check_context_health`

Streams the active conversation transcript using bounded chunk streams to audit turn count, raw payload size, RTK status, and repetitive polling loops.

### Parameters

| Name | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `transcriptPath` | `string` | **Yes** | — | Absolute path to `transcript.jsonl`. |

### Return Value
Returns a structured diagnostic assessment:
- `CRITICAL`: Active busy-wait polling or dangerous bloat detected.
- `WARNING`: High turn budget approaching threshold.
- `HEALTHY`: Context footprint is well-managed.

---

## 2. `read_transcript`

Reads recent conversation turns from Antigravity transcripts in clean, formatted Markdown without raw JSON syntax.

### Parameters

| Name | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `conversationId` | `string` | **Yes** | — | Conversation UUID or path to transcript. |
| `mode` | `string` | No | `"compact"` | Output format: `"compact"` (`transcript.jsonl`) or `"full"` (`transcript_full.jsonl`). |
| `lastTurns` | `number` | No | `3` | Number of recent turns to return (0 for all). |
| `includeThinking` | `boolean` | No | `false` | Whether to include model internal reasoning blocks. |

---

## 3. `query_transcript`

Forensic query and search engine across Antigravity conversation trajectories.

### Parameters

| Name | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `conversationId` | `string` | **Yes** | — | Conversation UUID or path to transcript. |
| `query` | `string` | No | `""` | Keyword or regex pattern to search for in steps. |
| `roles` | `array` | No | `["user", "assistant"]` | Filter by role: `"user"`, `"assistant"`, `"tool"`, `"error"`, `"all"`. |
| `maxResults` | `number` | No | `5` | Maximum number of matching steps to return. |
| `summaryOnly` | `boolean` | No | `false` | If `true`, formats results as 1-line bullet summaries per matched step. |

---

## 4. `subagent_brief`

Generates scope-isolated prompts for delegated subagents (`invoke_subagent`), offloading research or heavy inspections into isolated sub-transcripts.

### Parameters

| Name | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `objective` | `string` | **Yes** | — | Core research or investigative objective. |
| `scopeFiles` | `array` | No | `[]` | Specific file targets within bounds. |
| `expectedDeliverable` | `string` | No | `"Synthesized factual findings"` | Expected concise format expected back by parent agent. |

---

## 5. `get_installation_status`

Inspects the 4-layer integration status of the system directly from inside an Antigravity agent or chat session.

### Parameters
*(None)*

### Returns
Diagnostic report detailing status of Plugin Link, Governor Lifecycle Hook, MCP Server in `mcp_config.json`, 6 Antigravity Tool Schemas, and RTK binary/version.

---

## 6. `sync_installation`

Programmatically reconciles and repairs all installation layers and tool schemas in ~25ms.

### Parameters

| Name | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `checkOnly` | `boolean` | No | `false` | If `true`, performs dry-run audit without writing changes. |

---

## MCP Prompts (`/mcp:...`): User Slash Commands

The Model Context Protocol supports **Prompts**, which Antigravity exposes directly in the user chat interface as slash commands prefixed with `/mcp:<server>:<prompt>`.

Unlike tools (which the model invokes during reasoning), prompts are user-triggered directives that populate the chat with pre-configured governance instructions.

### `/mcp:agy-context-saver:context_shield`

* **Prompt Identifier**: `context_shield`
* **Trigger**: Type `/mcp:agy-context-saver:context_shield` in the Antigravity chat input box or select it from the slash command autocomplete popup.
* **Purpose**: Instantly injects the complete 3-Layer Context Governance and RTK Optimization rulebook into the conversation context.

#### When to Use
- **Start of a New Session**: Establishes strict zero-polling and RTK inspection habits from turn 1.
- **Before Complex Refactors or Test Runs**: Ensures the model will not enter busy-waiting loops if test tasks or builds detach into background jobs.
- **Session Recovery**: Re-engages governance boundaries if an agent starts reverting to uncompressed commands or polling patterns.

#### Injected Governance Rules
When triggered, `context_shield` delivers three operational layers to the session:
1. **Layer 1 (Background Tasks & Reactive Wakeup)**: Forbids `manage_task(Action='status')` polling loops and polling timers; enforces native Reactive Wakeup via `<SYSTEM_MESSAGE>`. Escalates to a `force_ask` circuit breaker after 5 repeated polling attempts.
2. **Layer 2 (Transparent Shell & RTK Inspection)**: Hard-routes workspace file reads (`rtk read`), directory searches (`rtk find`), and regex scans (`rtk rg "<pattern>" .`) to RTK's canonical CLI; protects internal state (`.system_generated/`).
3. **Layer 3 (Synchronous Execution & Subagent Delegation)**: Expands the synchronous execution window to 10 seconds to avoid unnecessary background detachment, bounds test sweeps, and isolates deep exploration to subagents via `subagent_brief`.
