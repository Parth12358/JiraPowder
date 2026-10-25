//! Read-only guard. `call_read_tool` is the ONLY place in the crate that sends `tools/call`
//! (enforced by the `only_guard_calls_tools` test below).
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use rmcp::model::CallToolRequestParams;
use serde_json::{Map, Value};

use super::McpSession;
use crate::error::{Error, Result};

static DENY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(create|update|delete|remove|add|transition|link_to|batch_create|edit|assign|move|set|post|put|upload|worklog_add)",
    )
    .expect("denylist regex")
});

/// Allowed only if the name is on the allowlist AND does not look like a write.
pub fn check(name: &str, allow: &[String]) -> Result<()> {
    if allow.iter().any(|a| a == name) && !DENY.is_match(name) {
        Ok(())
    } else {
        Err(Error::ToolNotAllowed(name.to_string()))
    }
}

/// Calls a read tool and returns the raw `CallToolResult` as JSON
/// (`{ content: [...], structuredContent?, isError? }`).
pub async fn call_read_tool(
    session: &McpSession,
    allow: &[String],
    name: &str,
    args: Map<String, Value>,
    timeout: Duration,
) -> Result<Value> {
    check(name, allow)?;
    if !session.tools.iter().any(|t| t == name) {
        return Err(Error::ToolMissing(name.to_string()));
    }
    let params = CallToolRequestParams::new(name.to_string()).with_arguments(args);
    let res = tokio::time::timeout(timeout, session.service.call_tool(params))
        .await
        .map_err(|_| Error::Timeout(format!("`{name}` did not answer within {}s.", timeout.as_secs())))?
        .map_err(super::client::map_service_error)?;
    Ok(serde_json::to_value(res)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::profile::MCP_ATLASSIAN_READ_TOOLS;

    fn allow() -> Vec<String> {
        MCP_ATLASSIAN_READ_TOOLS.iter().map(|s| s.to_string()).collect()
    }

    /// Every write tool mcp-atlassian 0.23.1 lists with TOOLSETS=all (see NOTES.md), which
    /// includes the plan's list.
    const WRITE_TOOLS: &[&str] = &[
        "jira_add_watcher",
        "jira_remove_watcher",
        "jira_create_issue",
        "jira_batch_create_issues",
        "jira_update_issue",
        "jira_assign_issue",
        "jira_delete_issue",
        "jira_move_issue",
        "jira_add_comment",
        "jira_edit_comment",
        "jira_add_worklog",
        "jira_link_to_epic",
        "jira_create_issue_link",
        "jira_create_remote_issue_link",
        "jira_remove_issue_link",
        "jira_transition_issue",
        "jira_create_sprint",
        "jira_update_sprint",
        "jira_add_issues_to_sprint",
        "jira_move_issues_to_backlog",
        "jira_create_customer_request",
        "jira_create_version",
        "jira_batch_create_versions",
        "jira_update_version",
        "jira_update_proforma_form_answers",
    ];

    #[test]
    fn write_tools_are_refused() {
        for t in WRITE_TOOLS {
            assert_eq!(check(t, &allow()), Err(Error::ToolNotAllowed(t.to_string())), "{t}");
        }
    }

    #[test]
    fn write_tools_are_refused_even_if_allowlisted() {
        let all: Vec<String> = WRITE_TOOLS.iter().map(|s| s.to_string()).collect();
        for t in WRITE_TOOLS {
            assert!(check(t, &all).is_err(), "{t} slipped through the denylist");
        }
    }

    #[test]
    fn read_tools_pass() {
        for t in MCP_ATLASSIAN_READ_TOOLS {
            assert_eq!(check(t, &allow()), Ok(()));
        }
    }

    #[test]
    fn unknown_read_looking_tools_are_refused() {
        assert!(check("jira_get_all_projects", &allow()).is_err());
        assert!(check("confluence_search", &allow()).is_err());
    }

    /// Nobody outside this file may send tools/call.
    #[test]
    fn only_guard_calls_tools() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut stack = vec![root];
        let needles = ["call_tool(", "call_tool_once(", "call_tool_with_mrtr"];
        while let Some(dir) = stack.pop() {
            for e in std::fs::read_dir(dir).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.extension().is_some_and(|x| x == "rs") && !p.ends_with("mcp/guard.rs") {
                    let src = std::fs::read_to_string(&p).unwrap();
                    for n in needles {
                        assert!(
                            !src.contains(n),
                            "{} calls {n} directly; use guard::call_read_tool",
                            p.display()
                        );
                    }
                }
            }
        }
    }
}
