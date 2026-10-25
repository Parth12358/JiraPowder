//! Tool profiles: which tools a server offers for reading Jira, and how to call them.
//! Values for `mcp-atlassian` come from NOTES.md (Phase 2).
use serde::{Deserialize, Serialize};

/// How to call the server's JQL search tool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchTool {
    pub name: String,
    pub jql_arg: String,
    pub fields_arg: String,
    pub limit_arg: String,
    pub start_arg: String,
    /// Cursor argument for servers that paginate with a token (Jira Cloud's /search/jql).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_token_arg: Option<String>,
    pub page_size: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tools {
    pub search: SearchTool,
    /// Read-only tool that lists Jira fields (used by Settings → Detect). Optional.
    #[serde(default)]
    pub fields: Option<String>,
}

pub struct Profile {
    pub id: &'static str,
    /// Every tool this profile may call. Anything else is refused by the guard.
    pub read_tools: &'static [&'static str],
    /// Env forced on the spawned server, overriding the user's config.
    pub forced_env: &'static [(&'static str, &'static str)],
    pub search: fn() -> SearchTool,
    pub fields_tool: Option<&'static str>,
}

pub const MCP_ATLASSIAN_READ_TOOLS: &[&str] = &["jira_search", "jira_get_issue", "jira_search_fields"];

pub const MCP_ATLASSIAN: Profile = Profile {
    id: "mcp-atlassian",
    read_tools: MCP_ATLASSIAN_READ_TOOLS,
    forced_env: &[
        ("READ_ONLY_MODE", "true"),
        ("ENABLED_TOOLS", "jira_search,jira_get_issue,jira_search_fields"),
    ],
    search: || SearchTool {
        name: "jira_search".into(),
        jql_arg: "jql".into(),
        fields_arg: "fields".into(),
        limit_arg: "limit".into(),
        start_arg: "start_at".into(),
        page_token_arg: Some("page_token".into()),
        page_size: 50,
    },
    fields_tool: Some("jira_search_fields"),
};

pub fn by_id(id: &str) -> Option<&'static Profile> {
    match id {
        "mcp-atlassian" => Some(&MCP_ATLASSIAN),
        _ => None,
    }
}

/// The read allowlist for a config: the profile's list, or for "custom" exactly the configured tools.
pub fn allowlist(profile: &str, tools: &Tools) -> Vec<String> {
    match by_id(profile) {
        Some(p) => p.read_tools.iter().map(|s| s.to_string()).collect(),
        None => std::iter::once(tools.search.name.clone())
            .chain(tools.fields.clone())
            .collect(),
    }
}
