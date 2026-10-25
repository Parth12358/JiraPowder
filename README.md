# Blockmap

A macOS app that reads your Jira tickets through an MCP server and shows which tickets block
which, as a **Flow** map (columns by dependency depth) or a **Graph** (force layout).

- **Read-only.** Blockmap only calls allowlisted read tools (`jira_search`, `jira_get_issue`,
  `jira_search_fields`). Anything that looks like a write is refused in the app, and
  `mcp-atlassian` is always started with `READ_ONLY_MODE=true`.
- **Local.** It starts the same MCP server you already use with Claude, as a child process.
  No LLM and no Blockmap servers are involved.
- **Works offline** with the last snapshot it fetched.

## Installing a release

1. Download the `.dmg` from the latest release and drag Blockmap to Applications.
2. First open: right-click → **Open**, or System Settings → Privacy & Security → **Open Anyway**.
3. If macOS says the app "is damaged and can't be opened", it's the quarantine flag on an
   unsigned download. Run:

   ```sh
   xattr -dr com.apple.quarantine /Applications/Blockmap.app
   ```

## Connecting Jira

Open **Settings** (⌘,) and copy the `command`, `args` and `env` of the Jira server from your
Claude Desktop or Claude Code MCP config.

| Server | Command | Arguments | Environment |
|---|---|---|---|
| mcp-atlassian (local) | `uvx` | `mcp-atlassian` | `JIRA_URL`, `JIRA_USERNAME`, `JIRA_API_TOKEN` |
| Atlassian hosted (Rovo) | `npx` | `-y`, `mcp-remote`, `<URL from your config>` | none; the first run opens a browser to sign in |

Tick **Keychain** next to a token to keep it in the macOS Keychain instead of the config file.
Then set the site URL and project key, and press **Save**. Blockmap tests the connection and
lists the tools it found.

Shortcuts: ⌘R refresh · ⌘F filter tickets · ⌘1 / ⌘2 Flow / Graph · ⌘I show or hide details.

## Development

Requirements: Node LTS, Rust stable, Xcode Command Line Tools (macOS).

```sh
npm ci && (cd tools/fake-mcp && npm ci)
npm run tauri dev          # the app
npm run dev                # the UI alone in a browser, sample data only
npm run typecheck && npm test
(cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings)
```

On a machine without a system webview (Linux without `webkit2gtk-4.1`), test everything except
the Tauri shell with `cargo test --no-default-features`.

To try the app without Jira, tick **Use the built-in fake server** in Settings (dev builds
only). It serves the sample tickets through a real MCP connection.

| Path | What |
|---|---|
| `src/` | UI (Vite + TypeScript, no framework). `graph/` is the pure logic, `ui/` the views |
| `src-tauri/src/mcp/` | MCP client (`rmcp`), read-only guard, tool profiles |
| `src-tauri/src/jira/` | JQL builders, normalizer, fetch pipeline |
| `src-tauri/src/backend.rs` | All command logic, testable without Tauri |
| `src-tauri/src/bin/mcp_probe.rs` | Discovery CLI: lists a server's tools and saves raw read results |
| `tools/fake-mcp/` | Fake Jira MCP server for tests and demos |
| `tools/make-fixtures.mjs`, `tools/redact.mjs` | Test fixtures: synthetic, or redacted real output |

`PLAN.md` is the build plan and `NOTES.md` has the decisions and open questions.

## Releasing

```sh
node scripts/bump.mjs 0.2.0 && (cd src-tauri && cargo update -p blockmap)
git commit -am "release 0.2.0" && git tag v0.2.0 && git push --follow-tags
```

The `release` workflow builds a universal (Apple Silicon + Intel), ad-hoc signed `.dmg` and
creates a **draft** GitHub release. Test it with the manual script in `PLAN.md` §8, then publish
it by hand.

## License

MIT. Geist and Geist Mono fonts: SIL Open Font License (`src/assets/fonts/LICENSE-OFL.txt`).
