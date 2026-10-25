//! Phase 2 discovery CLI. Connects to the MCP server described in a JSON file, writes every
//! tool name + input schema to probe-out/tools.json, then runs a few READ calls and saves the
//! raw results. All calls go through the read-only guard.
//!
//!   cargo run --no-default-features --bin mcp_probe -- ~/blockmap-probe.json
//!
//! Config: { "command": "uvx", "args": ["mcp-atlassian"], "env": { ... },
//!           "projectKey": "PAY", "issueKey": "PAY-103" }
//! `projectKey` and `issueKey` are optional; without them only tools.json is written.
use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{bail, Context};
use blockmap_lib::env_path;
use blockmap_lib::mcp::profile::MCP_ATLASSIAN;
use blockmap_lib::mcp::{Mcp, ServerSpec};
use serde::Deserialize;
use serde_json::{json, Map, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeConfig {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    project_key: Option<String>,
    issue_key: Option<String>,
}

const FIELDS: &str = "summary,status,issuetype,priority,assignee,issuelinks,parent";

fn args(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).context("usage: mcp_probe <config.json>")?;
    let cfg: ProbeConfig =
        serde_json::from_str(&std::fs::read_to_string(&path).with_context(|| format!("read {path}"))?)?;
    if !cfg
        .project_key
        .as_deref()
        .unwrap_or("A")
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        bail!("projectKey must be letters, digits or _");
    }

    let mut env: Vec<(String, String)> = cfg.env.into_iter().collect();
    for (k, v) in MCP_ATLASSIAN.forced_env {
        env.retain(|(ek, _)| ek != k);
        env.push((k.to_string(), v.to_string()));
    }
    let spec = ServerSpec {
        command: cfg.command,
        args: cfg.args,
        env,
        path: env_path::resolved_path(),
    };
    let allow: Vec<String> = MCP_ATLASSIAN.read_tools.iter().map(|s| s.to_string()).collect();

    let out = Path::new("probe-out");
    std::fs::create_dir_all(out)?;
    let mcp = Mcp::default();
    let res = run(
        &mcp,
        &spec,
        &allow,
        out,
        cfg.project_key.as_deref(),
        cfg.issue_key.as_deref(),
    )
    .await;
    std::fs::write(out.join("stderr.log"), mcp.stderr.lines().join("\n"))?;
    mcp.disconnect().await;
    res
}

async fn run(
    mcp: &Mcp,
    spec: &ServerSpec,
    allow: &[String],
    out: &Path,
    project: Option<&str>,
    issue: Option<&str>,
) -> anyhow::Result<()> {
    let (name, tools, defs) = mcp.ensure(spec).await.map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("connected to {name}: {} tools", tools.len());
    std::fs::write(
        out.join("tools.json"),
        serde_json::to_string_pretty(&json!({ "server": name, "tools": defs }))?,
    )?;

    let save = |file: &str, v: &Value| -> anyhow::Result<()> {
        std::fs::write(out.join(file), serde_json::to_string_pretty(v)?)?;
        println!("wrote probe-out/{file}");
        Ok(())
    };
    let call = |name: &'static str, a: Value| async move { mcp.call_read(spec, allow, name, args(a)).await };

    if let Some(p) = project {
        let jql = format!("project = \"{p}\" AND sprint in openSprints() ORDER BY rank");
        save(
            "search.json",
            &call(
                "jira_search",
                json!({ "jql": jql, "fields": format!("{FIELDS},customfield_*"), "limit": 50 }),
            )
            .await?,
        )?;
        save(
            "search_all_fields.json",
            &call("jira_search", json!({ "jql": jql, "fields": "*all", "limit": 3 })).await?,
        )?;
        let mine = format!(
            "{jql_base} AND assignee = currentUser() ORDER BY rank",
            jql_base = jql.trim_end_matches(" ORDER BY rank")
        );
        save(
            "search_mine.json",
            &call("jira_search", json!({ "jql": mine, "fields": "summary", "limit": 50 })).await?,
        )?;
        if tools.iter().any(|t| t == "jira_search_fields") {
            save(
                "fields_story_points.json",
                &call("jira_search_fields", json!({ "keyword": "story points" })).await?,
            )?;
            save(
                "fields_sprint.json",
                &call("jira_search_fields", json!({ "keyword": "sprint" })).await?,
            )?;
        }
    }
    if let Some(k) = issue {
        save(
            "get_issue.json",
            &call("jira_get_issue", json!({ "issue_key": k, "fields": FIELDS })).await?,
        )?;
    }
    Ok(())
}
