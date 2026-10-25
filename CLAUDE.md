# Blockmap — rules for Claude

Full plan: `PLAN.md`. Open questions and decisions: `NOTES.md`.

1. Work one phase at a time. At the end of each phase, run every command in its **Done when** list and fix failures before moving on. Commit once per phase with message `phase N: <summary>`.
2. **Never call, expose, or allow any MCP tool that writes to Jira.** All tool calls go through the read-only guard (`src-tauri/src/mcp/guard.rs`). No exceptions, including during debugging.
3. The UI must match `reference/blockmap-mockup.html` (Modern Dark style, Jira-style cards, collapsible details panel). Port it; do not redesign it.
4. Never commit secrets, real Jira responses, or `~/Library/Application Support/...` files. Fixtures from real Jira must be redacted (`tools/redact.mjs`) before commit.
5. When a library API differs from what the plan shows, follow the library's current docs and leave a short comment noting the difference. Do not downgrade to match the plan.
6. Pin dependency versions in `Cargo.toml` and `package.json` (exact or `~`), and commit `Cargo.lock` and `package-lock.json`.
7. If something in the plan is impossible or wrong, stop and write the problem into `NOTES.md` with options, instead of improvising around it.

## Commands
- Frontend: `npm run typecheck`, `npm test`, `npm run build`, `npm run dev` (browser, Demo mode only)
- App: `npm run tauri dev`
- Rust (in `src-tauri/`): `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`
- Rust without a system webview (Linux without webkit2gtk): add `--no-default-features`
- Dev-only: open the browser build with `?demo=cycle` to see a blocking cycle
