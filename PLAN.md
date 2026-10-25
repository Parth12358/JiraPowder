# Blockmap — Build Plan (Tauri + MCP, macOS)

A native macOS app that reads Jira tickets through an MCP server and shows which tickets block which, as a Flow (columns) or Graph (force) map. **Read-only.** Runs locally on a MacBook. Released through GitHub Actions.

This file is written for Claude Code to execute phase by phase. Each phase has a goal, exact tasks, and a **Done when** checklist with commands to run. Do not start a phase until the previous one passes its checklist.

---

## 0. Rules for Claude while executing this plan

1. Work one phase at a time. At the end of each phase, run every command in its **Done when** list and fix failures before moving on. Commit once per phase with message `phase N: <summary>`.
2. **Never call, expose, or allow any MCP tool that writes to Jira.** All tool calls go through the read-only guard (Phase 3). No exceptions, including during debugging.
3. The UI must match `reference/blockmap-mockup.html` (Modern Dark style, Jira-style cards, collapsible details panel). Port it; do not redesign it.
4. Never commit secrets, real Jira responses, or `~/Library/Application Support/...` files. Fixtures from real Jira must be redacted (Phase 2.4) before commit.
5. When a library API differs from what this plan shows (versions move), follow the library's current docs and leave a short comment noting the difference. Do not downgrade to match the plan.
6. Pin dependency versions in `Cargo.toml` and `package.json` (exact or `~`), and commit `Cargo.lock` and `package-lock.json`.
7. If something in this plan is impossible or wrong, stop and write the problem into `NOTES.md` with options, instead of improvising around it.

---

## 1. Architecture

```
┌──────────────────────── Blockmap.app ─────────────────────────┐
│  Frontend (WebView, Vite + TypeScript, no framework)          │
│   ui/  map render (SVG), list, details panel, settings        │
│        └─ invoke('fetch_snapshot' …)                          │
│  ─────────────────────── Tauri IPC ────────────────────────── │
│  Rust backend (src-tauri)                                     │
│   commands.rs   → typed commands for the UI                   │
│   mcp/client.rs → rmcp client, one long-lived session         │
│   mcp/guard.rs  → read-only allowlist (refuses everything else)│
│   jira/normalize.rs → raw tool output → Ticket[]              │
│   store.rs      → config.json + snapshot cache on disk        │
│   env_path.rs   → recovers the user's shell PATH              │
└───────────────────────────┬───────────────────────────────────┘
                            │ stdio (child process)
                 ┌──────────▼───────────┐
                 │  MCP server process   │  e.g. `uvx mcp-atlassian`
                 │  (same command you    │  or `npx mcp-remote <url>`
                 │   use in Claude today)│  for Atlassian's hosted server
                 └──────────┬───────────┘
                            │ HTTPS
                         Jira Cloud
```

### Key decisions (and why)

| Decision | Choice | Reason |
|---|---|---|
| Where the MCP client runs | Rust backend, `rmcp` crate (official Rust MCP SDK) | Single binary. No bundled Node runtime. Webviews cannot spawn processes. |
| Transport | **stdio child process only** | Covers both setups: a local server (`mcp-atlassian`) and Atlassian's hosted server via the `mcp-remote` bridge, which also handles OAuth in the browser. Same config shape as Claude Desktop's `mcpServers`. |
| LLM | None | Fetching tickets is deterministic. No cost, no variance. |
| Read-only | Enforced in app (allowlist + denylist) **and** in server where possible (`READ_ONLY_MODE=true` for mcp-atlassian) | Two independent layers. |
| Tool names / output format | Configurable "tool profile" + fixture-tested normalizer | MCP servers differ. Discover once (Phase 2), then lock with tests. |
| Frontend | Vite + vanilla TypeScript, ported from the mockup | Mockup is already vanilla JS; no framework needed. |
| Fonts | Geist + Geist Mono bundled locally (OFL) | App must work offline; CSP blocks remote fonts. |
| Signing | Ad-hoc (`signingIdentity: "-"`) | Personal use, no Apple Developer account needed. Apple Silicon requires some signature on downloaded apps. |

### Data model (shared shape, Rust ↔ TS)

```ts
type StatusCat = 'todo' | 'prog' | 'review' | 'done';
type IssueType = 'story' | 'task' | 'bug' | 'other';
type Priority = 'highest' | 'high' | 'med' | 'low' | 'lowest' | 'none';

interface Ticket {
  key: string;            // "PAY-103"
  summary: string;
  status: StatusCat;
  statusName: string;     // raw Jira status, e.g. "In QA"
  type: IssueType;
  typeName: string;       // raw Jira type name
  priority: Priority;
  assignee: { name: string; initials: string } | null;
  isMine: boolean;
  sprint: { id: number; name: string; state: 'active' | 'future' | 'closed' } | null;
  points: number | null;
  epic: string | null;    // parent/epic summary
  blockedBy: string[];    // keys of tickets that block this one
  blocks: string[];       // keys of tickets this one blocks
  url: string;            // https://<site>/browse/KEY
  inScope: boolean;       // false = pulled in only because it is linked ("ghost")
}

interface Snapshot {
  fetchedAt: string;      // ISO timestamp
  scopeLabel: string;     // "PAY · Sprint 43 (active)"
  tickets: Ticket[];
  warnings: string[];     // e.g. "12 linked tickets not fetched (limit)"
}
```

Field names in Rust use `#[serde(rename_all = "camelCase")]` so they serialize to exactly this shape.

---

## 2. Repository layout (target)

```
blockmap/
├─ PLAN.md                     ← this file
├─ CLAUDE.md                   ← short rules (copy of section 0)
├─ NOTES.md                    ← open questions/decisions found while building
├─ reference/
│  └─ blockmap-mockup.html     ← the approved design
├─ package.json  vite.config.ts  tsconfig.json  index.html
├─ src/                        ← frontend
│  ├─ main.ts                  ← boot, state, wiring
│  ├─ api.ts                   ← typed wrappers around invoke()
│  ├─ types.ts                 ← Ticket, Snapshot, Config (mirror of Rust)
│  ├─ graph/model.ts           ← ancestors/descendants/readiness/waves
│  ├─ graph/layout.ts          ← flow + force layouts (pure functions)
│  ├─ ui/map.ts                ← SVG build/draw/pan/zoom/drag
│  ├─ ui/list.ts  ui/order.ts  ui/inspector.ts  ui/settings.ts  ui/status.ts
│  ├─ sample.ts                ← the 16 sample tickets (Demo mode)
│  ├─ styles.css               ← ported from mockup
│  └─ assets/fonts/            ← Geist, Geist Mono woff2 + LICENSE
├─ tests/                      ← vitest (frontend logic)
├─ tools/fake-mcp/             ← fake MCP server for tests & demo (Node)
├─ src-tauri/
│  ├─ Cargo.toml  build.rs  tauri.conf.json
│  ├─ capabilities/default.json
│  ├─ icons/
│  ├─ src/main.rs  lib.rs  commands.rs  error.rs  store.rs  env_path.rs
│  ├─ src/mcp/{mod.rs, client.rs, guard.rs, profile.rs}
│  ├─ src/jira/{mod.rs, normalize.rs, jql.rs}
│  ├─ src/bin/mcp_probe.rs     ← CLI used in Phase 2
│  └─ tests/fixtures/*.json    ← redacted tool outputs
└─ .github/workflows/{ci.yml, release.yml}
```

---

## Phase 0 — Prerequisites (do on the Mac, once)

- Xcode Command Line Tools: `xcode-select --install`
- Rust stable via rustup, plus both Mac targets:
  `rustup target add aarch64-apple-darwin x86_64-apple-darwin`
- Node LTS (via `nvm` or Homebrew) and npm.
- Whatever your MCP server needs. Check your current Claude Desktop / Claude Code MCP config and copy the **exact** `command`, `args`, and `env` for the Jira server into a scratch file. Examples:
  - mcp-atlassian (local): `command: "uvx"`, `args: ["mcp-atlassian"]`, `env: { JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN }` → needs `uv` installed.
  - Atlassian hosted (Rovo) server: `command: "npx"`, `args: ["-y", "mcp-remote", "<the URL from your current config>"]` → needs Node.
- GitHub repo created (private is fine). In **Settings → Actions → General → Workflow permissions**, select **Read and write permissions** (the release job creates releases).

**Done when:** `rustc --version`, `cargo --version`, `node --version`, `npm --version` all print, and your server command runs in Terminal without errors (Ctrl-C to stop).

---

## Phase 1 — Scaffold and port the mockup (Demo mode, no Jira yet)

**Goal:** the app opens, looks exactly like the mockup, and runs on sample data.

1. Scaffold: `npm create tauri-app@latest blockmap -- --template vanilla-ts --manager npm` (Tauri v2). Move into the repo root if it creates a subfolder.
2. Copy `reference/blockmap-mockup.html` into the repo. Split it:
   - `<style>` → `src/styles.css`. Replace the Google Fonts `<link>` with local `@font-face` rules pointing at `src/assets/fonts/` (download Geist and Geist Mono woff2 from Vercel's official `geist-font` repo; include the OFL license file). Keep the `--dp-*` tokens unchanged.
   - Markup → `index.html` body.
   - Script → split into the modules listed in section 2. Keep behaviour identical: sprint picker, My tickets, Flow/Graph, list/work-order tabs, search filter, select/highlight, drag, pan, wheel zoom, zoom buttons, readable minimum zoom, collapsible details panel, keyboard Enter/Space selection.
   - Sample data → `src/sample.ts`, converted to the `Ticket` shape in section 1 (`blockedBy` from `by`, compute `blocks` as the reverse).
3. Make all frontend logic read `Ticket[]` from one in-memory `state.snapshot`. Nothing reads `sample.ts` directly except the Demo-mode loader.
4. Sprint picker: options come from the snapshot (distinct `sprint` values of `inScope` tickets) plus "All". Do not hardcode sprint names.
5. Pure logic goes in `graph/model.ts` and `graph/layout.ts`, with no DOM access, so it can be unit tested.
6. Window config in `tauri.conf.json`: title `Blockmap`, size 1440×900, `minWidth` 900, `minHeight` 600. Set `app.security.csp` to:
   `default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; script-src 'self'`
7. Add vitest (`npm i -D vitest`) and tests in `tests/`:
   - `ancestors`/`descendants` on the sample graph (e.g. PAY-103's ancestors = {PAY-102, PAY-111, PAY-101, PAY-110}).
   - `isReady` (PAY-102 ready, PAY-103 blocked by 2).
   - Work-order waves contain every open ticket exactly once, and no ticket appears before its open blockers.
   - Flow layout: every edge goes from a lower column to a higher column.
   - Cycle safety: a graph with A→B→A does not hang or overflow the stack (add visited-set guards; depth computation must treat back-edges as depth 0 and add a warning).
8. Add npm scripts: `"test": "vitest run"`, `"typecheck": "tsc --noEmit"`.

**Done when:**
- `npm run typecheck` and `npm test` pass.
- `npm run tauri dev` opens a window that matches the mockup in Flow and Graph, with all interactions working.
- A cyclic test graph renders without freezing.

---

## Phase 2 — MCP discovery spike (find out what your server really returns)

**Goal:** know the exact tool names, argument schemas, and output format before writing the normalizer. This is the phase that prevents breakage later.

1. Add `rmcp` to `src-tauri/Cargo.toml` with features `client` and `transport-child-process`, plus `tokio` (features `macros`, `rt-multi-thread`, `process`, `time`, `sync`), `serde`, `serde_json`, `anyhow` (bin only), `thiserror`.
   Client usage per the rmcp README (verify against the version you install):
   ```rust
   use rmcp::{ServiceExt, transport::{TokioChildProcess, ConfigureCommandExt}};
   use tokio::process::Command;
   let client = ().serve(TokioChildProcess::new(Command::new(cmd).configure(|c| {
       c.args(&args).envs(&env);
   }))?).await?;
   let tools = client.list_all_tools().await?;
   // call: client.call_tool(CallToolRequestParams { name, arguments: Some(map), .. }) – check current struct/builder
   ```
2. Create `src-tauri/src/bin/mcp_probe.rs`, a CLI that:
   - reads a JSON file path from argv: `{ "command": "...", "args": [...], "env": {...} }`
   - connects, prints server info and **every tool name + input schema** to `probe-out/tools.json`
   - runs **only these read calls** (hardcode the names after reading `tools.json`; mcp-atlassian names shown):
     - search: `jira_search` with JQL `project = <KEY> AND sprint in openSprints() ORDER BY rank` and the fields `summary,status,issuetype,priority,assignee,issuelinks,parent,customfield_*` (request `*all` if the tool supports it, to see field IDs once)
     - search: same JQL plus `AND assignee = currentUser()` (to confirm "mine" works)
     - get one issue that you know has a "blocks" link: `jira_get_issue`
     - optional: `jira_search_fields` to find the Story Points and Sprint custom field IDs
   - writes each raw result to `probe-out/<name>.json`
   - refuses to call any tool not in a hardcoded read list (reuse this list in Phase 3)
3. Run it on the Mac: `cargo run --bin mcp_probe -- ~/blockmap-probe.json`.
   If you use `mcp-remote`, the first run opens a browser for Atlassian login. That is expected.
4. Redact and commit fixtures: write a small script `tools/redact.mjs` that replaces names, emails, account IDs, site URLs, and summaries with stable fake values (keep keys, statuses, link structure, field IDs). Save the output to `src-tauri/tests/fixtures/`. **Never commit `probe-out/`** (add it to `.gitignore`).
5. Write in `NOTES.md`:
   - exact tool names and their argument names (e.g. `jql`, `fields`, `limit`, `start_at`/`startAt`)
   - whether results are JSON text, structured content, or Markdown text
   - the custom field IDs for Story Points and Sprint, and the parent/epic field
   - max page size and how pagination works
   - one known pair `A blocks B`, and which direction it appears in on each issue's `issuelinks` (`inwardIssue` vs `outwardIssue`).

**Done when:** `NOTES.md` has all five items filled in, fixtures are committed and contain no real names/emails/URLs (`grep -ri "@" src-tauri/tests/fixtures` only matches fake values).

> If the tool returns Markdown/plain text instead of JSON, stop and record it in `NOTES.md`. Prefer a search tool or argument that returns JSON; for mcp-atlassian, JSON output is the norm. Do not write a Markdown scraper unless there is no alternative.

---

## Phase 3 — Rust MCP client, read-only guard, PATH fix

**Goal:** a robust long-lived MCP session that can only read.

### 3.1 Config (`store.rs`)
Stored at `app_config_dir()/config.json` (Tauri path API; resolves under `~/Library/Application Support/<identifier>/`). Write atomically (write temp file, then rename).

```jsonc
{
  "version": 1,
  "server": { "command": "uvx", "args": ["mcp-atlassian"], "env": { "READ_ONLY_MODE": "true" } },
  "profile": "mcp-atlassian",             // or "custom"
  "tools": {                               // filled from the profile; editable for "custom"
    "search": { "name": "jira_search", "jqlArg": "jql", "fieldsArg": "fields", "limitArg": "limit", "startArg": "start_at", "pageSize": 50 }
  },
  "fields": { "storyPoints": "customfield_10016", "sprint": "customfield_10020" },
  "site": "https://yourcompany.atlassian.net",
  "projectKey": "PAY",
  "defaultScope": "openSprints",           // openSprints | futureSprints | jql
  "customJql": "",
  "refreshMinutes": 0                      // 0 = manual only
}
```

- `env` values may hold tokens. Store tokens in the **macOS Keychain** instead when the user enters them in Settings (use the `keyring` crate, service `blockmap`), and put a placeholder like `"JIRA_API_TOKEN": "keychain:jira"` in the file. Resolve placeholders only when spawning the server. Never log env values.
- Profiles live in `mcp/profile.rs` as constants. The `mcp-atlassian` profile values come from Phase 2's `NOTES.md`. For the `mcp-atlassian` profile always force `READ_ONLY_MODE=true` and `ENABLED_TOOLS=<the read allowlist>` in the spawned env, even if the user's config omits them.

### 3.2 PATH fix (`env_path.rs`)
Apps opened from Finder/Dock do not inherit your shell `PATH`, so `npx`/`uvx` are not found. On startup:
1. Run `$SHELL -ilc 'printf "%s" "$PATH"'` with a 3-second timeout (fall back to `/bin/zsh` if `$SHELL` is unset).
2. Merge with `/opt/homebrew/bin:/usr/local/bin:~/.local/bin:~/.cargo/bin` and the current PATH, de-duplicated.
3. Use this PATH for the child process. If `command` is not absolute, resolve it against this PATH and report "Couldn't find `uvx`. Install it or set the full path in Settings." when missing.

### 3.3 Client (`mcp/client.rs`)
- One session held in `tauri::State<Mutex<Option<McpSession>>>` (use `tokio::sync::Mutex`).
- `connect()` spawns the server with the resolved PATH + env, performs the MCP handshake, and calls `list_all_tools()` to cache tool names.
- Every call has a timeout: 20 s for normal calls, 120 s for the first call when OAuth may be in progress (`mcp-remote` opens the browser). On timeout, drop the session (which kills the child) and return `Error::Timeout`.
- On any transport error, drop the session and reconnect once, then fail with the error.
- Capture the child's stderr into a 200-line ring buffer. Show it in Settings → Diagnostics (with secrets masked: anything matching the env values is replaced by `•••`).
- Kill the child on app exit (`RunEvent::ExitRequested` / `Exit`). Verify no orphan process remains (`pgrep -fl mcp`).

### 3.4 Read-only guard (`mcp/guard.rs`)
- `call_read_tool(name, args)` is the **only** function that calls `call_tool`. Make the raw `call_tool` inaccessible outside this module.
- Allow a call only if the name is in the active profile's read allowlist **and** does not match the denylist regex:
  `(?i)(create|update|delete|remove|add|transition|link_to|batch_create|edit|assign|move|set|post|put|upload|worklog_add)`
- Return `Error::ToolNotAllowed(name)` otherwise.
- Unit tests: every write tool name from the Phase 2 `tools.json` (and the mcp-atlassian write list: `jira_create_issue`, `jira_update_issue`, `jira_delete_issue`, `jira_transition_issue`, `jira_add_comment`, `jira_create_issue_link`, `jira_remove_issue_link`, `jira_create_sprint`, `jira_update_sprint`, `jira_batch_create_issues`, `jira_link_to_epic`, `jira_add_worklog`) is refused. Allowlisted read names pass.

### 3.5 Errors (`error.rs`)
One `thiserror` enum serialized to the UI as `{ kind, message }`. Kinds: `NotConfigured`, `CommandNotFound`, `SpawnFailed`, `AuthRequired`, `Timeout`, `ToolNotAllowed`, `ToolMissing` (configured tool not offered by server), `BadResponse` (parse failure, include the first 300 chars), `Io`.

**Done when:**
- `cargo test` passes (guard tests included).
- `cargo clippy -- -D warnings` and `cargo fmt --check` pass.
- From `npm run tauri dev`, a temporary debug button connects and lists tools from the real server; quitting the app leaves no child process running.

---

## Phase 4 — Fetch and normalize Jira data

**Goal:** turn one or more search results into a correct `Snapshot`.

### 4.1 JQL builder (`jira/jql.rs`)
- Scope → JQL:
  - `openSprints` → `project = "<KEY>" AND sprint in openSprints() ORDER BY rank`
  - `futureSprints` → `project = "<KEY>" AND sprint in futureSprints() ORDER BY rank`
  - `jql` → the user's JQL verbatim (Settings shows a warning if it is empty).
- Linked-ticket fetch: `key in (A, B, C)`, chunked to 50 keys per query.
- Validate every key with `^[A-Z][A-Z0-9_]+-\d+$` before putting it into JQL. Quote the project key. Reject anything else (no JQL injection from data).
- Unit tests for each builder, including chunking (120 keys → 3 queries).

### 4.2 Fetch pipeline (`commands.rs::fetch_snapshot`)
1. Search scope JQL with the needed fields only: `summary,status,issuetype,priority,assignee,issuelinks,parent,<storyPoints>,<sprint>`. Paginate until all results are fetched or a hard cap of 500 issues (add a warning if capped).
2. Search the same JQL plus `AND assignee = currentUser()` with fields `summary` only → set of "mine" keys.
3. Collect every linked key (from `issuelinks` of type "Blocks", both directions) not already fetched. Fetch them with `key in (...)` (same fields). Mark these `inScope = false`. Do **one** level only (no recursive crawl). Cap at 200 extra; add a warning if capped.
4. Normalize (4.3), then make links symmetric: if A lists B in `blocks`, ensure B lists A in `blockedBy` (when B is present), and vice versa. Drop links to keys that were not fetched, and count them in a warning.
5. Save the snapshot to `app_data_dir()/snapshot.json` (atomic write) and return it.

### 4.3 Normalizer (`jira/normalize.rs`)
Pure function: `normalize(raw_results: &[serde_json::Value], cfg: &FieldConfig, mine: &HashSet<String>, in_scope: bool) -> Result<Vec<Ticket>>`.
- **Links:** for each `issuelinks[]` whose `type.name` is `"Blocks"` (case-insensitive; also accept the type whose `inward` text is "is blocked by"):
  - `outwardIssue` present → this issue **blocks** that key.
  - `inwardIssue` present → this issue **is blocked by** that key.
  Confirm this direction against the known pair recorded in `NOTES.md` (Phase 2) and write a test named `blocks_direction_matches_known_pair`.
- **Status:** map `status.statusCategory.key`: `new` → `todo`, `indeterminate` → `prog`, `done` → `done`. Then, if the category is `indeterminate` and the status name matches `(?i)review|qa|verify`, use `review`. Keep `statusName` raw.
- **Type:** `issuetype.name` → `story|task|bug` (case-insensitive; "Sub-task" → task), else `other`.
- **Priority:** `priority.name` → highest/high/med(ium)/low/lowest, missing → `none`.
- **Assignee:** `displayName`; initials = first letter of the first two words, uppercase; `null` when unassigned.
- **Sprint:** the sprint field is an array; pick the entry with state `active`, else the `future` one with the lowest id, else the last `closed`.
- **Points:** number or null; accept integer or float.
- **Epic:** `parent.fields.summary` if present, else null.
- **url:** `<site>/browse/<key>`.
- Never panic on missing fields; missing optional data becomes null/defaults. A missing `key` or `summary` skips the issue and adds a warning.
- The MCP result may wrap JSON in a text content block. Parse in this order: structured content → first text block parsed as JSON → error `BadResponse`. The exact unwrap path for your server comes from `NOTES.md`.

### 4.4 Tests
- Fixture tests for each file in `tests/fixtures/` (expected outputs as `*.expected.json`, compared with `assert_eq!` on the deserialized value).
- Hand-written edge-case fixtures: unassigned, no sprint, no points, link to an issue outside the result, a Blocks cycle, a non-Blocks link type ("relates to") that must be ignored, empty result.
- An integration test against `tools/fake-mcp` (Phase 4.5) that runs the whole `fetch_snapshot` pipeline.

### 4.5 Fake MCP server (`tools/fake-mcp/`)
A tiny Node MCP server (`@modelcontextprotocol/sdk`, stdio) that exposes `jira_search`, `jira_get_issue`, and also `jira_create_issue` (to prove the guard refuses it). It answers from the redacted fixtures and evaluates only the JQL patterns the app produces (`openSprints`, `currentUser()`, `key in (...)`). Used by: Rust integration tests, CI, and a "Use fake server" option in Settings for demos.

**Done when:** `cargo test` passes, including fixture, edge-case, direction, and fake-server integration tests; the fake server's `jira_create_issue` is never called (assert via a counter the fake server writes to a temp file).

---

## Phase 5 — Commands, UI wiring, settings, states

### 5.1 Tauri commands (`commands.rs`)
| Command | Returns | Notes |
|---|---|---|
| `get_config()` | `Config` (secrets masked) | |
| `save_config(cfg)` | `()` | Validates; drops the MCP session so the next call reconnects |
| `set_secret(name, value)` | `()` | Keychain |
| `test_connection()` | `{ serverName, tools: string[], missing: string[] }` | `missing` = configured tools the server does not offer |
| `fetch_snapshot(scope)` | `Snapshot` | Section 4.2 |
| `load_cached_snapshot()` | `Snapshot \| null` | |
| `get_diagnostics()` | `{ stderr: string[], path: string, lastError?: … }` | Masked |
| `open_in_jira(key)` | `()` | Opens `url` in the default browser (use `tauri-plugin-opener`; allow only `https://<site>/browse/*`) |

Commands are async and never block the main thread. Only one `fetch_snapshot` runs at a time; a second call while one is running returns the in-flight result.

### 5.2 Capabilities
`src-tauri/capabilities/default.json`: `core:default`, plus the opener permission scoped to the Jira site URL. Nothing else (no fs, no shell plugin in the frontend).

### 5.3 App states (UI)
1. **First launch / not configured:** show the map with sample data and a banner "Demo data. Connect Jira in Settings." Settings opens automatically once.
2. **Loading:** keep showing the last snapshot; a small spinner and "Refreshing…" in the header.
3. **Loaded:** header shows `Updated 10:42` (mono). If older than 1 hour, show "Updated 2h ago".
4. **Error:** keep the last snapshot visible; show a one-line error bar with the message and buttons **Retry** and **Diagnostics**. `AuthRequired` says "Sign in to Atlassian in the browser window that opened, then Retry."
5. **Empty scope:** "No tickets in this sprint." with a link to change the scope.
6. Replace the mockup's "Sample data · live build reads Jira through MCP" pill with the real source label (`Demo data` or `PAY · Sprint 43 (active)`).

### 5.4 Settings screen (`ui/settings.ts`)
A modal sheet with sections: **Server** (command, args, env table with "store in Keychain" per row, profile select), **Jira** (site URL, project key, scope, custom JQL, field IDs with a "Detect" button that calls the read-only fields tool if the profile has one), **Refresh** (manual / every 5, 15, 30 min), **Diagnostics** (PATH, server stderr, Test connection). Saving runs `test_connection()` and shows missing tools inline.

### 5.5 Menu and shortcuts
- App menu item **Refresh** (⌘R) → `fetch_snapshot`.
- **Settings…** (⌘,).
- ⌘F focuses the ticket filter. ⌘1 / ⌘2 switch Flow / Graph. ⌘I toggles the details panel.
- Details panel gets an **Open in Jira** button (calls `open_in_jira`).

### 5.6 Refresh behaviour
- On launch: render cached snapshot immediately, then fetch.
- Timer refresh only while the window is visible; pause when hidden.
- Keep the user's selection, zoom, and manually dragged positions across refreshes when the ticket still exists. Only re-run layout for tickets that are new.

**Done when:**
- Manual test script (section 8) passes against the real server and the fake server.
- `npm run typecheck`, `npm test`, `cargo test`, `cargo clippy -- -D warnings` pass.

---

## Phase 6 — CI (`.github/workflows/ci.yml`)

Runs on pull requests and pushes to `main`. Two jobs:

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]

jobs:
  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v6
        with: { node-version: lts/*, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build

  rust:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v6
        with: { node-version: lts/*, cache: npm }
      - uses: dtolnay/rust-toolchain@stable
        with: { components: 'clippy, rustfmt' }
      - uses: swatinem/rust-cache@v2
        with: { workspaces: './src-tauri -> target' }
      - run: npm ci
      - run: npm ci
        working-directory: tools/fake-mcp
      - run: npm run build            # frontend dist must exist for tauri's build script
      - run: cargo fmt --check
        working-directory: src-tauri
      - run: cargo clippy --all-targets -- -D warnings
        working-directory: src-tauri
      - run: cargo test
        working-directory: src-tauri
```

Notes:
- Action major versions above match Tauri's current GitHub pipeline guide. If an action version does not resolve, use the latest major listed on that action's GitHub page.
- Tests must not need Jira, a network connection, or secrets. Only the fake server.

**Done when:** both jobs are green on a PR.

---

## Phase 7 — Release (`.github/workflows/release.yml`)

### 7.1 Versioning
- Single source of truth: `version` in `src-tauri/tauri.conf.json`. Keep `package.json` and `Cargo.toml` equal; add `scripts/bump.mjs <x.y.z>` that updates all three and a CI step that fails if they differ.
- Release by pushing a tag `vX.Y.Z` that matches that version.

### 7.2 Signing
In `tauri.conf.json`:
```json
"bundle": {
  "active": true,
  "targets": ["app", "dmg"],
  "identifier": "dev.parth.blockmap",
  "icon": ["icons/32x32.png","icons/128x128.png","icons/128x128@2x.png","icons/icon.icns"],
  "macOS": { "signingIdentity": "-", "minimumSystemVersion": "12.0" }
}
```
`"-"` is ad-hoc signing. Generate icons once with `npm run tauri icon path/to/icon.png`.

### 7.3 Workflow
```yaml
name: release
on:
  push:
    tags: ['v*']
  workflow_dispatch:

jobs:
  check-version:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - name: tag matches app version
        if: startsWith(github.ref, 'refs/tags/v')
        run: |
          APP=$(node -p "require('./src-tauri/tauri.conf.json').version")
          [ "v$APP" = "${GITHUB_REF_NAME}" ] || { echo "Tag ${GITHUB_REF_NAME} != v$APP"; exit 1; }

  build:
    needs: check-version
    permissions:
      contents: write
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v6
        with: { node-version: lts/*, cache: npm }
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: 'aarch64-apple-darwin,x86_64-apple-darwin' }
      - uses: swatinem/rust-cache@v2
        with: { workspaces: './src-tauri -> target' }
      - run: npm ci
      - run: npm test
      - run: cargo test
        working-directory: src-tauri
      - uses: tauri-apps/tauri-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tagName: v__VERSION__
          releaseName: 'Blockmap v__VERSION__'
          releaseBody: 'Unsigned (ad-hoc) macOS build. See README → Installing.'
          releaseDraft: true
          prerelease: false
          args: '--target universal-apple-darwin'
```
- One universal build runs on both Apple Silicon and Intel Macs.
- The release is created as a **draft**. Publish it by hand after testing.

### 7.4 Installing a release on your Mac (put this in README)
1. Download the `.dmg` from the release, drag Blockmap to Applications.
2. First open: right-click → **Open**, or System Settings → Privacy & Security → **Open Anyway**.
3. If macOS says the app "is damaged and can't be opened", it's the quarantine flag on an unsigned download. Run:
   `xattr -dr com.apple.quarantine /Applications/Blockmap.app`

**Done when:** pushing tag `v0.1.0` produces a draft release with a `.dmg`; it installs and opens on your Mac and passes the manual test script.

---

## 8. Manual test script (run before publishing any release)

Run against **both** the fake server and the real server.

1. Fresh install (delete `~/Library/Application Support/dev.parth.blockmap/`): app opens in Demo mode, Settings opens once.
2. Configure the server, Test connection lists tools, no missing tools.
3. Refresh: tickets load; the count matches the same JQL in Jira's issue search.
4. Pick 3 tickets with known "blocks" links in Jira; the map shows the same directions (blocking = solid white into the ticket; blocked-by = dashed out of it).
5. A ticket linked to one outside the sprint shows as a dotted "ghost" with the other sprint's name.
6. My tickets filter shows exactly your assigned tickets.
7. Work order: no ticket appears in a wave before any of its open blockers.
8. Quit and reopen offline (Wi-Fi off): the cached map shows with "Updated …" and a clear error on refresh; no crash.
9. Break the config (wrong command): a readable error, Diagnostics shows the stderr, the app stays usable.
10. Force a write: temporarily add `jira_create_issue` to the allowlist in a debug build → guard still refuses (denylist). Remove the change.
11. Quit: `pgrep -fl "mcp"` shows no leftover server process.
12. Flow and Graph render 150+ tickets without lag (use the fake server with a generated large fixture).

---

## 9. Known pitfalls (and where they're handled)

| Pitfall | Handled in |
|---|---|
| `npx`/`uvx` not found when launched from Finder | 3.2 PATH fix |
| OAuth browser login on first `mcp-remote` run makes the first call slow | 3.3 long first-call timeout, 5.3 AuthRequired message |
| Tool names/output differ between MCP servers | Phase 2 discovery, 3.1 profiles, 4.3 fixtures |
| `inwardIssue`/`outwardIssue` direction confusion | 4.3 known-pair test |
| Story points / sprint field IDs differ per Jira site | 3.1 config, 5.4 Detect button |
| JQL injection from data | 4.1 key validation |
| Orphan MCP processes after quit | 3.3 kill on exit, test 11 |
| Cycles in links freezing layout | Phase 1 tests, visited-set guards |
| Remote fonts blocked offline / by CSP | Phase 1 local fonts |
| "App is damaged" on downloaded build | 7.2 ad-hoc signing, 7.4 xattr |
| Tag and app version out of sync | 7.3 check-version job |
| Secrets in logs or the repo | 3.1 Keychain, 3.3 masking, rule 4 |

---

## 10. Out of scope for v1 (do not build yet)

- Writing anything to Jira (comments, transitions, links).
- Multiple projects at once, boards view, Confluence.
- Auto-update (Tauri updater needs signing keys), Apple notarization.
- LLM features (`claude -p` summaries, risk analysis). Possible later as a separate, optional panel.
