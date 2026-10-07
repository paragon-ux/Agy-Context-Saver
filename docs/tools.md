# MCP Tool Reference

`Agy-Context-Saver` provides 7 specialized Model Context Protocol (MCP) tools directly registered into Antigravity's tool invocation ecosystem.

---

## 1. `safe_command`

Runs shell commands with intelligent log compression, dynamic working directory auto-resolution, streaming buffer concatenation, and escalating timeout protection.

### Parameters

| Name | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `command` | `string` | **Yes** | — | The exact shell command line to execute. |
| `cwd` | `string` | No | Auto | Working directory. If omitted, dynamically queries the active Antigravity workspace. |
| `maxOutputLines` | `number` | No | `30` | Maximum lines to return before compressing repetitive output blocks. |
| `timeoutSeconds` | `number` | No | `30` | Maximum execution duration before escalating SIGKILL termination. |
| `terse` | `boolean` | No | `false` | If `true` and command exits 0, returns a compact 1-line execution summary. |

### Example

=== "Standard Output"
    ```json
    {
      "command": "npm test",
      "maxOutputLines": 25
    }
    ```
    Returns:
    ```text
    [STATUS: PASSED (exit 0) in 1.45s]
    ✓ Test suite 1 passed (12 tests)
    ✓ Test suite 2 passed (8 tests)
    ... [agy-context-saver: compressed 45 repetitive output lines] ...
    ✓ Test suite 5 passed (14 tests)
    All 34 tests passed cleanly.
    ```

=== "Terse Output (UI Optimization)"
    ```json
    {
      "command": "git status",
      "terse": true
    }
    ```
    Returns:
    ```text
    [STATUS: PASSED (exit 0) in 0.16s]
    ```

---

## 2. `check_context_health`

Streams the active conversation transcript using bounded chunk streams to audit turn count, raw payload size, and repetitive polling loops.

### Parameters

| Name | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `conversationId` | `string` | No | Current | The conversation ID to audit. Defaults to current conversation. |

### Return Value
Returns a structured diagnostic assessment:
- `CRITICAL`: Active busy-wait polling or dangerous bloat detected.
- `MODERATE`: Elevated step count or large payloads.
- `HEALTHY`: Context attention within optimal token parameters.

---

## 3. `read_transcript`

Reads recent conversation turns from Antigravity transcripts in clean, formatted Markdown without raw JSON syntax.

### Parameters

| Name | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `conversationId` | `string` | No | Current | Conversation ID to read. Defaults to current session. |
| `lastTurns` | `number` | No | `3` | Number of recent turns to return (default: 3). |
| `mode` | `string` | No | `"compact"` | Output format: `"compact"` (summarized steps) or `"full"` (verbatim messages). |

---

## 4. `query_transcript`

Forensic query and search engine across Antigravity conversation trajectories.

### Parameters

| Name | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `query` | `string` | No | `""` | Keyword or regex pattern to search for in steps. |
| `role` | `string` | No | `"all"` | Filter by role: `"user"`, `"assistant"`, `"tool"`, `"error"`, `"all"`. |
| `maxResults` | `number` | No | `5` | Maximum number of matching steps to return. |
| `summaryOnly` | `boolean` | No | `false` | If `true`, formats results as 1-line bullet summaries per matched step. |
| `conversationId` | `string` | No | Current | Conversation ID to query. |

---

## 5. `subagent_brief`

Generates scope-isolated prompts for delegated subagents (`invoke_subagent`), offloading research or heavy inspections into isolated sub-transcripts.

### Parameters

| Name | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `role` | `string` | **Yes** | — | Specific role title for the subagent (e.g. `"Test Investigator"`). |
| `task` | `string` | **Yes** | — | Concrete objective for the subagent to achieve. |
| `scope` | `string` | **Yes** | — | Exact directories, files, or symbols within bounds. |
| `deliverableFormat` | `string` | No | `"1-paragraph summary"` | Expected return structure from the subagent. |

---

## 6. `get_installation_status`

Inspects the 4-layer integration status of the system directly from inside an Antigravity agent or chat session.

### Parameters
*(None)*

### Returns
JSON object detailing the status of Plugin Symlink, Lifecycle Hook, MCP Configuration, and Antigravity Tool Schemas.

---

## 7. `sync_installation`

Programmatically reconciles and repairs all 4 installation layers in ~25ms.

### Parameters

| Name | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `dryRun` | `boolean` | No | `false` | If `true`, returns planned changes without modifying disk. |
