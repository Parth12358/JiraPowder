//! Jira data: the Ticket/Snapshot shapes shared with the UI, JQL building, normalizing.
pub mod jql;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StatusCat {
    Todo,
    Prog,
    Review,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueType {
    Story,
    Task,
    Bug,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Highest,
    High,
    Med,
    Low,
    Lowest,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SprintState {
    Active,
    Future,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sprint {
    pub id: i64,
    pub name: String,
    pub state: SprintState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Assignee {
    pub name: String,
    pub initials: String,
}

/// Mirror of `Ticket` in src/types.ts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ticket {
    pub key: String,
    pub summary: String,
    pub status: StatusCat,
    pub status_name: String,
    #[serde(rename = "type")]
    pub issue_type: IssueType,
    pub type_name: String,
    pub priority: Priority,
    pub assignee: Option<Assignee>,
    pub is_mine: bool,
    pub sprint: Option<Sprint>,
    pub points: Option<f64>,
    pub epic: Option<String>,
    pub blocked_by: Vec<String>,
    pub blocks: Vec<String>,
    pub url: String,
    pub in_scope: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub fetched_at: String,
    pub scope_label: String,
    pub tickets: Vec<Ticket>,
    pub warnings: Vec<String>,
}
