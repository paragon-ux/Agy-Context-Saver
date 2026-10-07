# MCP Tool & CLI Reference

`Agy-Context-Saver` provides 6 specialized Model Context Protocol (MCP) tools for Antigravity lifecycle and context governance, paired with **RTK (Rust Token Killer)** for transparent CLI output reduction.

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
