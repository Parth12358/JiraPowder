# Notes

Open questions and decisions found while building. Newest first.

---

## Big maps and the colour scheme (after v0.1.4)

Measured in headless Chromium (software rendering) with `?demo=big`. "Before" is the first draft of
this work (zoom levels, culling with `display:none`); v0.1.4 itself had no culling at all.

| | 200 tickets | 500 tickets |
|---|---|---|
| Rebuild after a filter change | 225 ms → 64 ms | 547 ms → 137 ms |
| Zoom/pan frame | 126 ms → 33 ms | 248 ms → 33–66 ms |

Graph layout alone (Node, same machine): 200 tickets 264 → 118 ms, 400 tickets 1078 → 225 ms,
500 tickets 298 ms; it now runs in a worker, so the window never waits for it. 33 ms is two
frames, the floor of the measurement.

What made the difference:

- **Culling by detaching.** Off-screen nodes and edges are removed from the DOM, not hidden.
  With `display:none` Chromium still walked all hidden SVG on every pan/zoom transform. For the
  same reason a node holds only the current mode's shapes (cards *or* circles), and the map is
  rebuilt on a mode switch.
- **No forced layout after building.** Nodes are built detached and the stage size is cached
  (`ResizeObserver`); `getBoundingClientRect` right after inserting 500 cards cost ~400 ms.
- **Detail by zoom.** Below 42% cards show only a big key on a state-tinted block; below 75%, or
  with 120+ tickets, no drop shadows or transitions. **Fit** now zooms out as far as needed (to
  8%); automatic fits still stop at a readable zoom and centre on the selection, as in the
  mockup.
- **Graph layout:** Barnes-Hut (typed-array quadtree, θ 0.9, 300 steps) above 150 tickets,
  in a web worker with a synchronous fallback if the worker fails or takes over 5 s. At 150 or
  fewer it is the mockup's exact version, unchanged.
- **Flow layout:** after the mockup's forward pass, up to 8 alternating barycenter sweeps keep
  the order with the fewest crossings (tested never worse than the forward pass). A column
  taller than max(12, 1.6·√n) rows is split into sub-columns, filled row by row. The sample
  sprint is unaffected.

**Colours** (departure from the mockup, asked for): owner → card outline and circle stroke;
state (done > blocked > in progress > ready) → left stripe and circle fill. The old teal
selection bar became the state stripe; selection is still the white outline. Colours are stored
in `localStorage`, not `config.json`: they then work in Demo mode and before Jira is set up, and
changing them doesn't reconnect the MCP server. The **Mono** preset (default) stays within the
mockup's grey + teal palette.

Not verified in WebKit yet (no WebKit here). Workers from the `tauri://` origin should work
under the CSP (`script-src 'self'`); if not, the fallback runs the layout on the UI thread.

---

## Logo geometry differs from the mockup (v0.1.4)

In the mockup's logo the two lines don't point at the circle centres, so the V looks bent.
The header, setup page and app icon now draw them centre to centre (`M3.5 4L8 12L12.5 4`,
under the circles). The icon source is `src-tauri/icons/icon.svg`.

---

## Renamed Blockmap → JiraPowder (v0.1.2)

PLAN.md and `reference/blockmap-mockup.html` keep the old name; everything else uses
JiraPowder. The bundle id changed to `dev.parth.jirapowder`, so the config now lives in
`~/Library/Application Support/dev.parth.jirapowder/` and the Keychain service is `jirapowder`.
Anything set up with v0.1.1 (Blockmap.app, its config folder, `blockmap` Keychain items) is not
picked up; delete Blockmap.app and set up again.


---

## Atlassian's hosted MCP server (Rovo) is not supported

The plan assumed the `custom` profile would cover Atlassian's hosted server through
`mcp-remote`. It most likely doesn't (untested here): that server's JQL search tool takes a `cloudId` argument, and the
search-tool config has no way to pass extra fixed arguments. Options: (a) add an
`extraArgs` map to `SearchTool` and look up the cloud id once with the server's resources tool
(needs that tool on the allowlist); (b) a dedicated `atlassian-remote` profile that handles both.
Either one needs the real tool schemas from a probe run against the hosted server first.

---

## Phases 6–7 — CI and release (not run yet)

The workflows are written but have never run: there is no GitHub remote yet. Differences from
the plan:

- Both workflows run `node scripts/check-versions.mjs` (plan §7.1 asks for a CI check).
- `release.yml` runs `npm ci` in `tools/fake-mcp` and `npm run build` before `cargo test`.
  `cargo test` includes the fake-server integration tests (they need node modules), and
  Tauri's build script needs `dist/`.
- `setup-node` caches both lockfiles.
- The action majors in the plan (`checkout@v7`, `setup-node@v6`, `tauri-action@v1`,
  `rust-cache@v2`) all resolve. `setup-node@v7` also exists; I kept `v6` to match the plan.

---

## Phase 5 decisions

- **Opener capability.** The plan lists the opener permission scoped to the Jira site in
  `capabilities/default.json`. The frontend never calls the opener plugin: `open_in_jira`
  builds `https://<site>/browse/<KEY>` in Rust (key validated, site from config) and opens it
  there. Rust-side plugin calls don't go through capabilities, so the capability file grants
  only `core:default`. That is stricter than the plan.
- **Command logic lives in `backend.rs`**, which has no Tauri dependency, so it is tested
  headless (`cargo test --no-default-features`), including against the fake server.
  `commands.rs` only forwards to it.
- **Type-checking the app without webkit.** With stub `.pc` files for
  `webkit2gtk-4.1` / `javascriptcoregtk-4.1` on `PKG_CONFIG_PATH`,
  `cargo check --all-targets` and `cargo clippy --all-targets -- -D warnings` pass with the
  `app` feature. Nothing was linked or run.
- **In-app UI states** were checked in headless Chromium with a mocked
  `__TAURI_INTERNALS__` bridge serving a snapshot from the real Rust pipeline + fake server:
  loaded, refreshing, error (Retry / Diagnostics), Open in Jira, and 170+ tickets.
  Graph (force) layout for 175 tickets takes ~330 ms once; Flow ~50 ms.
- **Fake server in Settings** needs `node` and the source tree (dev builds). Release builds
  report "only available in development builds".

---

## Build machine is Linux, not macOS (Phases 1–7)

This repo was built on Arch Linux without `webkit2gtk-4.1`, so the Tauri app crate could not be
compiled or launched here. To keep everything else testable:

- `tauri`, `tauri-plugin-opener` and `keyring` sit behind the default cargo feature `app`.
- The MCP client, guard, PATH fix, JQL, normalizer, store and the fetch pipeline build and test
  without it: `cargo test --no-default-features` (in `src-tauri/`).
- CI (`macos-latest`) and your Mac build the full app with default features.

**Still to do on the Mac:** `npm run tauri dev`, then run the manual test script (PLAN.md §8).
Every place the plan asks for a check in the real app window is unverified until then.

---

## Phase 2 — MCP discovery (mcp-atlassian 0.23.1)

### What was verified, and how

No real Jira was available on the build machine. What I did instead:

1. Ran `mcp_probe` against a real local `uvx mcp-atlassian` (0.23.1) with fake credentials.
   That confirms the handshake, tool listing, and that `READ_ONLY_MODE=true` +
   `ENABLED_TOOLS=jira_search,jira_get_issue,jira_search_fields` leave exactly those three
   tools (server name: `Atlassian MCP`).
2. Listed every tool (`TOOLSETS=all`, listing only, no calls) to build the guard's write-tool
   test list (63 Jira tools, 25 of them write).
3. Read the server source (`mcp_atlassian/servers/jira.py`, `models/jira/*.py`) for argument
   names and the exact output format.

**Not verified:** a search against a real site, and item 5 below (the known blocks pair). Run
the probe on your Mac with your real config before trusting the normalizer:

```sh
cd src-tauri
cat > ~/jirapowder-probe.json <<'JSON'
{ "command": "uvx", "args": ["mcp-atlassian"],
  "env": { "JIRA_URL": "https://yourcompany.atlassian.net", "JIRA_USERNAME": "you@company.com", "JIRA_API_TOKEN": "…" },
  "projectKey": "PAY", "issueKey": "PAY-103" }
JSON
cargo run --no-default-features --example mcp_probe -- ~/jirapowder-probe.json
node ../tools/redact.mjs probe-out tests/fixtures   # writes tests/fixtures/real_*.json
```

The committed fixtures (`src-tauri/tests/fixtures/*.json`) are **synthetic**, generated by
`tools/make-fixtures.mjs` in the exact shape the server source produces. Replace or extend them
with redacted real output after the probe run.

### 1. Tool names and arguments

| Tool | Arguments used | Notes |
|---|---|---|
| `jira_search` | `jql`, `fields` (comma string or `*all`), `limit` (1–50, default 10), `start_at` (0-based), `page_token` | Also `projects_filter`, `expand`, `use_display_names` (unused) |
| `jira_get_issue` | `issue_key`, `fields` | Also `expand`, `comment_limit`, `properties`, `update_history`, `include` |
| `jira_search_fields` | `keyword`, `limit`, `refresh` | Used by Settings → Detect |

Write tools (all refused by the guard, tested in `mcp/guard.rs`): `jira_add_watcher`,
`jira_remove_watcher`, `jira_create_issue`, `jira_batch_create_issues`, `jira_update_issue`,
`jira_assign_issue`, `jira_delete_issue`, `jira_move_issue`, `jira_add_comment`,
`jira_edit_comment`, `jira_add_worklog`, `jira_link_to_epic`, `jira_create_issue_link`,
`jira_create_remote_issue_link`, `jira_remove_issue_link`, `jira_transition_issue`,
`jira_create_sprint`, `jira_update_sprint`, `jira_add_issues_to_sprint`,
`jira_move_issues_to_backlog`, `jira_create_customer_request`, `jira_create_version`,
`jira_batch_create_versions`, `jira_update_version`, `jira_update_proforma_form_answers`.

### 2. Result format

JSON text. Tools return `json.dumps(...)` strings, so the MCP result is a text content block
holding JSON. Newer FastMCP versions may also send `structuredContent: {"result": "<same JSON
string>"}`. The normalizer unwraps in this order: `structuredContent` (object, or `{result:
string}` → parse) → first text block parsed as JSON → `BadResponse`. `isError: true` becomes an
error carrying the text.

The issue shape is mcp-atlassian's **simplified** dict, not raw Jira REST:

- `status`: `{ name, category, color }`, where `category` is the category *name* ("To Do",
  "In Progress", "Done") and `color` is "blue-gray" / "yellow" / "green". There is no
  `statusCategory.key`. The normalizer maps the category name (or colour) and also accepts the
  raw REST `statusCategory.key`.
- `issue_type: {name}`, `priority: {name}`.
- `assignee: { account_id, display_name, name, email, avatar_url }`. **Unassigned is
  `{"display_name": "Unassigned"}`** with no account id, which the normalizer treats as `null`.
- `parent`: the raw REST parent object (`{ key, fields: { summary, … } }`).
- `issuelinks[]`: `{ id, type: {id, name, inward, outward}, inward_issue?, outward_issue? }`
  (snake_case; raw REST uses `inwardIssue` / `outwardIssue`, which are accepted too).
- Custom fields: `"customfield_10020": { "value": <processed value>, "name": "Sprint" }`.
  Sprint objects have no `self` key, so they pass through whole (`{id, name, state, boardId,
  …}`). Old Server/DC sites send `com.atlassian.greenhopper…Sprint@…[id=..,state=..,name=..]`
  strings, which are parsed too.
- `browse_url` is present when the server knows its base URL.

### 3. Field IDs

`customfield_10016` (Story point estimate) and `customfield_10020` (Sprint) are the Jira Cloud
defaults for team-managed and most company-managed projects. **Unverified for your site.** Run
the probe (it calls `jira_search_fields` for "story points" and "sprint") or use Settings →
Detect. The epic is taken from `parent.fields.summary`.

### 4. Page size and pagination

`limit` is capped at 50 by the tool. Search returns `{ total, start_at, max_results, issues,
next_page_token? }`. On Jira Cloud the server uses the new `/search/jql` API: pagination is by
`next_page_token` → `page_token`, and `total` may be `-1`. On Server/DC it is `start_at` +
`total`. The pipeline uses the token when present, otherwise `start_at`, and stops on an empty
page or a missing token with nothing left (hard cap 500 issues).

### 5. Known `A blocks B` pair and link direction — UNVERIFIED

From the server source and the Jira REST convention: on issue A (A blocks B), the link has
`outward_issue = B` (type.outward "blocks"); on B it has `inward_issue = A` (type.inward "is
blocked by"). The normalizer follows that, and `blocks_direction_matches_known_pair` tests it
against the synthetic fixtures. **Confirm with a real pair from the probe** (`get_issue.json`
for an issue you know blocks another) and update the test with the real keys.
