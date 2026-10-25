//! MCP client side: one long-lived stdio session to the user's Jira MCP server.
pub mod client;
pub mod guard;
pub mod profile;

use rmcp::service::RunningService;
use rmcp::RoleClient;

pub use client::{Mcp, ServerSpec, StderrLog};

/// A connected server. The raw service is private to `mcp`; tool calls go through `guard`.
pub struct McpSession {
    service: RunningService<RoleClient, ()>,
    pub server_name: String,
    pub tools: Vec<String>,
    /// Full tool definitions (name, description, inputSchema) as JSON, for the probe.
    pub tool_defs: Vec<serde_json::Value>,
}
