//! Raw tool output → Ticket[]. Accepts mcp-atlassian's simplified issue dicts and raw Jira
//! REST issues (see NOTES.md → Phase 2). Never panics on missing fields.
use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use super::{Assignee, IssueType, Priority, Sprint, SprintState, StatusCat, Ticket};
use crate::error::{Error, Result};

pub struct FieldConfig {
    pub story_points: String,
    pub sprint: String,
    /// `https://<site>`; when empty, the server's `browse_url` is used.
    pub site: String,
}

#[derive(Debug, Default)]
pub struct Normalized {
    pub tickets: Vec<Ticket>,
    pub warnings: Vec<String>,
}

/// MCP `CallToolResult` (as JSON) → the tool's JSON payload.
/// Order: structuredContent → first text block parsed as JSON → BadResponse.
pub fn unwrap_result(res: &Value) -> Result<Value> {
    let text = res
        .get("content")
        .and_then(Value::as_array)
        .and_then(|c| c.iter().find(|b| b.get("type").and_then(Value::as_str) == Some("text")))
        .and_then(|b| b.get("text"))
        .and_then(Value::as_str);
    if res.get("isError").and_then(Value::as_bool) == Some(true) {
        let msg = text.unwrap_or("the tool reported an error").trim();
        return Err(classify_tool_error(msg));
    }
    if let Some(sc) = res.get("structuredContent").filter(|v| !v.is_null()) {
        // FastMCP wraps `-> str` results as {"result": "<json>"}.
        if let Some(s) = sc
            .get("result")
            .and_then(Value::as_str)
            .filter(|_| sc.as_object().is_some_and(|o| o.len() == 1))
        {
            if let Ok(v) = serde_json::from_str(s) {
                return Ok(v);
            }
        } else if sc.is_object() || sc.is_array() {
            return Ok(sc.clone());
        }
    }
    match text {
        Some(t) => serde_json::from_str(t).map_err(|_| {
            Error::bad_response(
                "the tool returned text that is not JSON (Markdown output is not supported)",
                t,
            )
        }),
        None => Err(Error::bad_response(
            "the tool returned no text content",
            &res.to_string(),
        )),
    }
}

fn classify_tool_error(msg: &str) -> Error {
    let m = msg.to_ascii_lowercase();
    if m.contains("401") || m.contains("unauthorized") || m.contains("authentication") {
        Error::AuthRequired(format!(
            "Jira rejected the credentials. Check the token in Settings. ({})",
            short(msg)
        ))
    } else if m.contains("jql") || m.contains("400") {
        Error::BadResponse(format!("Jira could not run the query: {}", short(msg)))
    } else {
        Error::bad_response("the tool reported an error", msg)
    }
}

fn short(s: &str) -> String {
    s.chars().take(200).collect()
}

/// Issues inside a payload: a search result `{issues: [...]}`, a list, or a single issue.
pub fn issues_of(payload: &Value) -> Vec<&Value> {
    if let Some(a) = payload.get("issues").and_then(Value::as_array) {
        a.iter().collect()
    } else if let Some(a) = payload.as_array() {
        a.iter().collect()
    } else if payload.get("key").is_some() {
        vec![payload]
    } else {
        vec![]
    }
}

pub fn normalize(payloads: &[Value], cfg: &FieldConfig, mine: &HashSet<String>, in_scope: bool) -> Normalized {
    let mut out = Normalized::default();
    let mut seen = HashSet::new();
    for issue in payloads.iter().flat_map(issues_of) {
        match ticket(issue, cfg, mine, in_scope) {
            Some(t) => {
                if seen.insert(t.key.clone()) {
                    out.tickets.push(t);
                }
            }
            None => {
                let key = s(issue.get("key")).unwrap_or("an issue");
                out.warnings.push(format!("Skipped {key}: it has no key or summary."));
            }
        }
    }
    out
}

fn s(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).map(str::trim).filter(|x| !x.is_empty())
}

/// A field from the simplified dict (top level) or raw REST (`fields.*`), first match wins.
fn field<'a>(issue: &'a Value, names: &[&str]) -> Option<&'a Value> {
    let f = issue.get("fields").filter(|f| f.is_object());
    names.iter().find_map(|n| {
        issue
            .get(*n)
            .filter(|v| !v.is_null())
            .or_else(|| f.and_then(|f| f.get(*n)).filter(|v| !v.is_null()))
    })
}

fn ticket(issue: &Value, cfg: &FieldConfig, mine: &HashSet<String>, in_scope: bool) -> Option<Ticket> {
    let key = s(issue.get("key"))?.to_string();
    let summary = s(field(issue, &["summary"]))?.to_string();

    let (status, status_name) = status(field(issue, &["status"]));
    let type_name = s(field(issue, &["issue_type", "issuetype"]).and_then(|t| t.get("name")))
        .unwrap_or("")
        .to_string();
    let (blocked_by, blocks) = links(field(issue, &["issuelinks"]));
    let url = if cfg.site.is_empty() {
        s(issue.get("browse_url")).map(String::from).unwrap_or_default()
    } else {
        format!("{}/browse/{key}", cfg.site.trim_end_matches('/'))
    };

    Some(Ticket {
        is_mine: mine.contains(&key),
        summary,
        status,
        status_name,
        issue_type: issue_type(&type_name),
        type_name,
        priority: priority(s(field(issue, &["priority"]).and_then(|p| p.get("name")))),
        assignee: assignee(field(issue, &["assignee"])),
        sprint: sprint(unwrap_custom(field(issue, &[cfg.sprint.as_str()]))),
        points: unwrap_custom(field(issue, &[cfg.story_points.as_str()])).and_then(Value::as_f64),
        epic: s(field(issue, &["parent"]).and_then(|p| p.pointer("/fields/summary"))).map(String::from),
        blocked_by,
        blocks,
        url,
        in_scope,
        key,
    })
}

/// mcp-atlassian wraps custom fields as {"value": …, "name": "…"}.
fn unwrap_custom(v: Option<&Value>) -> Option<&Value> {
    match v {
        Some(o) if o.is_object() && o.get("value").is_some() && o.get("id").is_none() => o.get("value"),
        other => other,
    }
    .filter(|v| !v.is_null())
}

static REVIEW: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)review|qa|verify").unwrap());

fn status(v: Option<&Value>) -> (StatusCat, String) {
    let Some(v) = v else {
        return (StatusCat::Todo, String::new());
    };
    let name = s(v.get("name")).unwrap_or("").to_string();
    // Raw REST: statusCategory.key. Simplified: category (a name) or color.
    let key = s(v.pointer("/statusCategory/key")).map(str::to_ascii_lowercase);
    let cat = s(v.get("category"))
        .or(s(v.pointer("/statusCategory/name")))
        .map(str::to_ascii_lowercase);
    let color = s(v.get("color")).map(str::to_ascii_lowercase);
    let base = match (key.as_deref(), cat.as_deref(), color.as_deref()) {
        (Some("done"), _, _) | (_, Some("done"), _) | (None, None, Some("green")) => StatusCat::Done,
        (Some("indeterminate"), _, _) | (_, Some("in progress"), _) | (None, None, Some("yellow")) => StatusCat::Prog,
        _ => StatusCat::Todo,
    };
    let cat = if base == StatusCat::Prog && REVIEW.is_match(&name) {
        StatusCat::Review
    } else {
        base
    };
    (cat, name)
}

fn issue_type(name: &str) -> IssueType {
    match name.to_ascii_lowercase().as_str() {
        "story" => IssueType::Story,
        "task" | "sub-task" | "subtask" => IssueType::Task,
        "bug" => IssueType::Bug,
        _ => IssueType::Other,
    }
}

fn priority(name: Option<&str>) -> Priority {
    match name.map(str::to_ascii_lowercase).as_deref() {
        Some("highest") | Some("blocker") => Priority::Highest,
        Some("high") | Some("critical") | Some("major") => Priority::High,
        Some("medium") | Some("med") => Priority::Med,
        Some("low") | Some("minor") => Priority::Low,
        Some("lowest") | Some("trivial") => Priority::Lowest,
        _ => Priority::None,
    }
}

fn assignee(v: Option<&Value>) -> Option<Assignee> {
    let v = v?;
    let name = s(v.get("display_name")).or(s(v.get("displayName")))?;
    let has_id = ["account_id", "accountId", "email", "emailAddress", "key"]
        .iter()
        .any(|k| s(v.get(*k)).is_some());
    // mcp-atlassian prints an unassigned issue as {"display_name": "Unassigned"}.
    if name == "Unassigned" && !has_id {
        return None;
    }
    let initials = name
        .split_whitespace()
        .take(2)
        .filter_map(|w| w.chars().next())
        .flat_map(char::to_uppercase)
        .collect();
    Some(Assignee {
        name: name.to_string(),
        initials,
    })
}

static SERVER_SPRINT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[(.*)\]\s*$").unwrap());

fn parse_sprint(v: &Value) -> Option<Sprint> {
    let (id, name, state) = if let Some(text) = v.as_str() {
        // Server/DC: com.atlassian.greenhopper.service.sprint.Sprint@abc[id=1,state=ACTIVE,name=…,…]
        let inner = SERVER_SPRINT.captures(text)?.get(1)?.as_str();
        let get = |k: &str| {
            inner
                .split(',')
                .find_map(|kv| kv.split_once('=').filter(|(a, _)| *a == k).map(|(_, b)| b.to_string()))
        };
        (get("id")?.parse().ok()?, get("name")?, get("state")?)
    } else {
        let id = v
            .get("id")
            .and_then(|i| i.as_i64().or_else(|| i.as_str().and_then(|s| s.parse().ok())))?;
        (id, s(v.get("name"))?.to_string(), s(v.get("state"))?.to_string())
    };
    let state = match state.to_ascii_lowercase().as_str() {
        "active" => SprintState::Active,
        "future" => SprintState::Future,
        "closed" => SprintState::Closed,
        _ => return None,
    };
    Some(Sprint { id, name, state })
}

/// Active sprint, else the future one with the lowest id, else the last closed.
fn sprint(v: Option<&Value>) -> Option<Sprint> {
    let list: Vec<Sprint> = match v? {
        Value::Array(a) => a.iter().filter_map(parse_sprint).collect(),
        one => parse_sprint(one).into_iter().collect(),
    };
    list.iter()
        .find(|s| s.state == SprintState::Active)
        .or_else(|| {
            list.iter()
                .filter(|s| s.state == SprintState::Future)
                .min_by_key(|s| s.id)
        })
        .or_else(|| list.iter().rev().find(|s| s.state == SprintState::Closed))
        .cloned()
}

fn is_blocks_type(t: Option<&Value>) -> bool {
    let Some(t) = t else { return false };
    s(t.get("name")).is_some_and(|n| n.eq_ignore_ascii_case("blocks"))
        || s(t.get("inward")).is_some_and(|n| n.eq_ignore_ascii_case("is blocked by"))
}

/// (blocked_by, blocks). outward issue → this issue blocks it; inward issue → it blocks this one.
fn links(v: Option<&Value>) -> (Vec<String>, Vec<String>) {
    let mut by = Vec::new();
    let mut blocks = Vec::new();
    for l in v.and_then(Value::as_array).into_iter().flatten() {
        if !is_blocks_type(l.get("type")) {
            continue;
        }
        let key = |names: [&str; 2]| {
            names
                .iter()
                .find_map(|n| s(l.get(*n).and_then(|i| i.get("key"))))
                .map(String::from)
        };
        if let Some(k) = key(["outward_issue", "outwardIssue"]) {
            if !blocks.contains(&k) {
                blocks.push(k);
            }
        }
        if let Some(k) = key(["inward_issue", "inwardIssue"]) {
            if !by.contains(&k) {
                by.push(k);
            }
        }
    }
    (by, blocks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cfg() -> FieldConfig {
        FieldConfig {
            story_points: "customfield_10016".into(),
            sprint: "customfield_10020".into(),
            site: "https://example.atlassian.net".into(),
        }
    }

    #[test]
    fn unwraps_text_and_structured() {
        let payload = json!({"issues": []});
        let text = json!({"content": [{"type": "text", "text": payload.to_string()}]});
        assert_eq!(unwrap_result(&text).unwrap(), payload);
        let sc = json!({"content": [], "structuredContent": {"result": payload.to_string()}});
        assert_eq!(unwrap_result(&sc).unwrap(), payload);
        let sc_obj = json!({"content": [], "structuredContent": payload});
        assert_eq!(unwrap_result(&sc_obj).unwrap(), payload);
    }

    #[test]
    fn markdown_is_a_bad_response() {
        let md = json!({"content": [{"type": "text", "text": "# PAY-1\n**Status**: Done"}]});
        assert_eq!(unwrap_result(&md).unwrap_err().kind(), "BadResponse");
    }

    #[test]
    fn tool_errors_are_classified() {
        let e = json!({"isError": true, "content": [{"type": "text", "text": "Error: 401 Unauthorized"}]});
        assert_eq!(unwrap_result(&e).unwrap_err().kind(), "AuthRequired");
    }

    #[test]
    fn status_mapping() {
        let st = |v: Value| status(Some(&v)).0;
        assert_eq!(
            st(json!({"name": "In QA", "category": "In Progress", "color": "yellow"})),
            StatusCat::Review
        );
        assert_eq!(
            st(json!({"name": "Doing", "statusCategory": {"key": "indeterminate"}})),
            StatusCat::Prog
        );
        assert_eq!(st(json!({"name": "Closed", "category": "Done"})), StatusCat::Done);
        assert_eq!(
            st(json!({"name": "Ready to verify", "color": "yellow"})),
            StatusCat::Review
        );
        assert_eq!(
            st(json!({"name": "Backlog", "statusCategory": {"key": "new"}})),
            StatusCat::Todo
        );
        // "Review" in a To Do status stays To Do: only in-progress statuses become review.
        assert_eq!(
            st(json!({"name": "Needs review", "category": "To Do"})),
            StatusCat::Todo
        );
    }

    #[test]
    fn sprint_pick() {
        let v = json!([
            {"id": 3, "name": "C", "state": "closed"},
            {"id": 9, "name": "F9", "state": "future"},
            {"id": 7, "name": "F7", "state": "future"}
        ]);
        assert_eq!(sprint(Some(&v)).unwrap().name, "F7");
        let v = json!([{"id": 1, "name": "A", "state": "closed"}, {"id": 2, "name": "B", "state": "closed"}]);
        assert_eq!(sprint(Some(&v)).unwrap().name, "B");
        assert_eq!(sprint(Some(&json!([]))), None);
    }

    #[test]
    fn missing_everything_but_key_and_summary() {
        let n = normalize(&[json!({"key": "X-1", "summary": "s"})], &cfg(), &HashSet::new(), true);
        let t = &n.tickets[0];
        assert_eq!(
            (t.status, t.issue_type, t.priority),
            (StatusCat::Todo, IssueType::Other, Priority::None)
        );
        assert!(t.assignee.is_none() && t.sprint.is_none() && t.points.is_none() && t.epic.is_none());
    }
}
