# JiraPowder

A Mac app that shows which of your Jira tickets block which. It draws your sprint as a
**Flow** map (columns by dependency depth) or a **Graph** (force layout), lists what you can
start now, and tells you what each ticket is waiting on.

- **Read-only.** JiraPowder only calls allowlisted read tools (`jira_search`, `jira_get_issue`,
  `jira_search_fields`). Anything that could change Jira is refused in the app, and
  `mcp-atlassian` always runs with `READ_ONLY_MODE=true`.
- **Local.** It starts the same `mcp-atlassian` server you already use with Claude, as a child
  process. No LLM and no JiraPowder servers are involved.
- **Works offline** with the last snapshot it fetched.

**Setup page:** https://parth12358.github.io/JiraPowder/

> Early release. It has been tested against a fake Jira server, not a real one yet. If the
> arrows or story points look wrong for your site, please
> [open an issue](https://github.com/Parth12358/JiraPowder/issues) with Settings → Diagnostics.

## Install

[Download the latest `.dmg`](https://github.com/Parth12358/JiraPowder/releases/latest). It is
a universal build for Apple Silicon and Intel, macOS 12 or later.

### With Claude Code

Copy the prompt from the [setup page](https://parth12358.github.io/JiraPowder/) and paste it
into Claude Code in Terminal on your Mac. Claude Code then:

- installs the app
- finds your `mcp-atlassian` settings in your Claude config, or asks you for them
- stores the API token in the Keychain
- writes the JiraPowder config and opens the app

It asks before each command and doesn't touch your Claude config or Jira.

### Yourself

1. Open the `.dmg` and drag JiraPowder to Applications. The app isn't notarized, so the first
   time, right-click it and choose **Open**. If macOS says it is damaged, run:

   ```sh
   xattr -dr com.apple.quarantine /Applications/JiraPowder.app
   ```

2. Install `uv` if `uvx --version` doesn't work: `brew install uv`.
3. Get a Jira API token from
   [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens),
   or reuse the one in your Claude MCP config.
4. Open JiraPowder. Settings opens on the first launch (later: ⌘,). Fill it in:

   | Field | Value |
   |---|---|
   | Profile | `mcp-atlassian` |
   | Command | `uvx` |
   | Arguments | `mcp-atlassian` |
   | `JIRA_URL` | `https://yourcompany.atlassian.net` |
   | `JIRA_USERNAME` | your Atlassian email |
   | `JIRA_API_TOKEN` | your token, with **Keychain** ticked |
   | Site URL | `https://yourcompany.atlassian.net` |
   | Project key | e.g. `PAY` |

   Press **Save**. JiraPowder tests the connection and loads your open sprint.

Atlassian's hosted (Rovo) MCP server is not supported yet. It is untested, and its tools expect
a site `cloudId` argument that JiraPowder doesn't send. See `NOTES.md`.

### Upgrading

Download the new `.dmg` and drag JiraPowder to Applications, replacing the old copy. Your
settings, Keychain token, cached tickets and colours are kept. If the Dock still shows the old
icon, run `killall Dock`.

If you still have **Blockmap.app** (the app's name before v0.1.2), delete it. JiraPowder doesn't
read its settings, so set JiraPowder up once as above.

## Using it

| Shortcut | Does |
|---|---|
| ⌘R | Refresh from Jira |
| ⌘F | Filter the ticket list |
| ⌘1 / ⌘2 | Flow / Graph |
| ⌘I | Show or hide ticket details |
| ⌘, | Settings |

Select a ticket to see its blockers (solid white), the tickets it blocks (dashed), and the
path to start. Tickets outside the sprint that are linked to it appear as dotted ghosts.
**Work order** groups open tickets into waves you can start in sequence.

Each card's outline shows whose ticket it is (mine, others, unassigned) and the stripe on its
left shows its state (blocked, ready, in progress, done); in Graph the circle's fill is the state.
Change the colours in Settings → **Colours**, or pick the **Mono** or **Vivid** preset.

Big sprints (hundreds of tickets): **Fit** zooms out until everything is on screen. Zoomed out,
cards turn into coloured blocks showing just the key; zoom in for the full card.

If something goes wrong:
- **Couldn't find `uvx`**: install uv, or put the full path from `which uvx` in Command.
- **No story points**: Settings → **Detect** finds your site's field.
- **Anything else**: Settings → **Diagnostics** shows the server log, with secrets masked.

Settings live in `~/Library/Application Support/dev.parth.jirapowder/`, and the token is in the
Keychain under the service `jirapowder`.

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
only). It serves sample tickets through a real MCP connection.

In `npm run dev`, `?demo=big&n=400` loads a generated sprint of that many tickets (for checking
the map at scale) and `?demo=cycle` shows a blocking cycle.

| Path | What |
|---|---|
| `src/` | UI (Vite + TypeScript, no framework). `graph/` is the pure logic, `ui/` the views |
| `src-tauri/src/mcp/` | MCP client (`rmcp`), read-only guard, tool profiles |
| `src-tauri/src/jira/` | JQL builders, normalizer, fetch pipeline |
| `src-tauri/src/backend.rs` | All command logic, testable without Tauri |
| `src-tauri/examples/mcp_probe.rs` | Discovery CLI: lists a server's tools and saves raw read results |
| `tools/fake-mcp/` | Fake Jira MCP server for tests and demos |
| `tools/make-fixtures.mjs`, `tools/redact.mjs` | Test fixtures: synthetic, or redacted real output |
| `site/` | The setup page (GitHub Pages) |

`PLAN.md` is the original build plan, written when the app was called Blockmap. `NOTES.md` has
the decisions and open questions.

## Releasing

```sh
node scripts/bump.mjs 0.2.0 && (cd src-tauri && cargo update -p jirapowder)
git commit -am "release 0.2.0" && git tag -a v0.2.0 -m "JiraPowder v0.2.0" && git push --follow-tags
```

The `release` workflow builds a universal, ad-hoc signed `.dmg` and creates a **draft** GitHub
release. Test it with the manual script in `PLAN.md` §8, then publish it:

```sh
gh release edit v0.2.0 --draft=false --latest
```

## License

MIT. Geist and Geist Mono fonts: SIL Open Font License (`src/assets/fonts/LICENSE-OFL.txt`).
Not affiliated with Atlassian.
