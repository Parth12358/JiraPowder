//! Integration tests against tools/fake-mcp (needs `node` and `npm ci` in tools/fake-mcp).
use std::path::PathBuf;

use blockmap_lib::env_path;
use blockmap_lib::jira::fetch::{fetch_snapshot, McpSource};
use blockmap_lib::mcp::profile::MCP_ATLASSIAN_READ_TOOLS;
use blockmap_lib::mcp::{Mcp, ServerSpec};
use blockmap_lib::store::Config;
use serde_json::{json, Map};

struct Fake {
    spec: ServerSpec,
    counter: PathBuf,
    tag: String,
    _dir: tempfile::TempDir,
}

fn fake(extra_env: &[(&str, &str)]) -> Fake {
    let dir = tempfile::tempdir().unwrap();
    let counter = dir.path().join("writes");
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tools/fake-mcp/server.mjs");
    // A unique argv marker so the test can look for leftover processes.
    let tag = format!(
        "--blockmap-test-{}-{}",
        std::process::id(),
        dir.path().file_name().unwrap().to_string_lossy()
    );
    let mut env = vec![("FAKE_MCP_COUNTER".to_string(), counter.to_string_lossy().into_owned())];
    env.extend(extra_env.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    Fake {
        spec: ServerSpec {
            command: "node".into(),
            args: vec![script.to_string_lossy().into_owned(), tag.clone()],
            env,
            path: env_path::resolved_path(),
        },
        counter,
        tag,
        _dir: dir,
    }
}

fn config() -> Config {
    Config {
        project_key: "PAY".into(),
        site: "https://example.atlassian.net".into(),
        ..Config::default()
    }
}

fn writes(f: &Fake) -> u32 {
    std::fs::read_to_string(&f.counter)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

fn running(tag: &str) -> bool {
    std::process::Command::new("pgrep")
        .args(["-f", "--", tag])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

async fn check_snapshot(cfg: &Config, f: &Fake) {
    let mcp = Mcp::default();
    let snap = fetch_snapshot(&McpSource::new(&mcp, &f.spec, cfg), cfg, None)
        .await
        .unwrap();
    mcp.disconnect().await;

    let keys = |pred: &dyn Fn(&blockmap_lib::jira::Ticket) -> bool| {
        let mut k: Vec<&str> = snap
            .tickets
            .iter()
            .filter(|t| pred(t))
            .map(|t| t.key.as_str())
            .collect();
        k.sort();
        k
    };
    assert_eq!(keys(&|t| t.in_scope).len(), 10, "sprint 43 has 10 tickets");
    assert_eq!(
        keys(&|t| !t.in_scope),
        vec!["PAY-101", "PAY-108", "PAY-110", "PAY-112", "PAY-116"]
    );
    assert_eq!(keys(&|t| t.is_mine), vec!["PAY-102", "PAY-103", "PAY-107", "PAY-115"]);
    assert!(
        snap.tickets.iter().all(|t| t.key != "PAY-114"),
        "only one level of linked tickets"
    );
    assert_eq!(snap.scope_label, "PAY · Sprint 43 (active)");
    assert!(
        snap.warnings.iter().any(|w| w.starts_with("2 blocking links")),
        "{:?}",
        snap.warnings
    );

    // Links are symmetric and only point at fetched tickets.
    let get = |k: &str| snap.tickets.iter().find(|t| t.key == k).unwrap();
    for t in &snap.tickets {
        for b in &t.blocks {
            assert!(
                get(b).blocked_by.contains(&t.key),
                "{} blocks {b} but not the reverse",
                t.key
            );
        }
        for b in &t.blocked_by {
            assert!(get(b).blocks.contains(&t.key));
        }
    }
    assert_eq!(get("PAY-112").blocked_by, vec!["PAY-104", "PAY-109"]);
    assert!(get("PAY-112").blocks.is_empty());
    assert_eq!(writes(f), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn pipeline_with_token_paging() {
    let f = fake(&[]);
    check_snapshot(&config(), &f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn pipeline_with_offset_paging_and_small_pages() {
    let f = fake(&[("FAKE_MCP_PAGING", "offset")]);
    let mut cfg = config();
    cfg.profile = "custom".into();
    cfg.tools.search.page_size = 3;
    cfg.tools.search.page_token_arg = None;
    check_snapshot(&cfg, &f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn guard_refuses_the_fake_write_tool() {
    let f = fake(&[]);
    let mcp = Mcp::default();
    let (_, tools, _) = mcp.ensure(&f.spec).await.unwrap();
    assert!(
        tools.contains(&"jira_create_issue".to_string()),
        "fake server offers the write tool"
    );

    let read: Vec<String> = MCP_ATLASSIAN_READ_TOOLS.iter().map(|s| s.to_string()).collect();
    let mut with_write = read.clone();
    with_write.push("jira_create_issue".into()); // even a broken allowlist must not let it through
    for allow in [&read, &with_write] {
        let args: Map<_, _> = json!({ "summary": "nope" }).as_object().unwrap().clone();
        let e = mcp
            .call_read(&f.spec, allow, "jira_create_issue", args)
            .await
            .unwrap_err();
        assert_eq!(e.kind(), "ToolNotAllowed");
    }
    mcp.disconnect().await;
    assert_eq!(writes(&f), 0, "jira_create_issue must never be called");
}

#[tokio::test(flavor = "multi_thread")]
async fn disconnect_leaves_no_child_process() {
    let f = fake(&[]);
    let mcp = Mcp::default();
    mcp.ensure(&f.spec).await.unwrap();
    assert!(running(&f.tag), "server should be running");
    mcp.disconnect().await;
    for _ in 0..50 {
        if !running(&f.tag) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("MCP server process still running after disconnect");
}

#[tokio::test(flavor = "multi_thread")]
async fn missing_command_is_reported() {
    let mcp = Mcp::default();
    let spec = ServerSpec {
        command: "definitely-not-a-command".into(),
        args: vec![],
        env: vec![],
        path: "/usr/bin".into(),
    };
    assert_eq!(mcp.ensure(&spec).await.unwrap_err().kind(), "CommandNotFound");
}
