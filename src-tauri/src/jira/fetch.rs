//! fetch_snapshot pipeline: scope search (paged) → "mine" search → one level of linked
//! tickets → normalize → symmetric links.
use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};

use super::jql::{keys_jql, mine_jql, scope_jql};
use super::normalize::{normalize, unwrap_result, FieldConfig};
use super::{Snapshot, SprintState, Ticket};
use crate::error::{Error, Result};
use crate::mcp::profile::{self, SearchTool};
use crate::mcp::{Mcp, ServerSpec};
use crate::store::{Config, Scope};

pub const MAX_ISSUES: usize = 500;
pub const MAX_LINKED: usize = 200;

/// Something that can run a read-only tool and return the raw CallToolResult JSON.
#[allow(async_fn_in_trait)]
pub trait ToolSource {
    async fn call(&self, name: &str, args: Map<String, Value>) -> Result<Value>;
}

/// The real thing: every call goes through the MCP guard.
pub struct McpSource<'a> {
    pub mcp: &'a Mcp,
    pub spec: &'a ServerSpec,
    pub allow: Vec<String>,
}

impl<'a> McpSource<'a> {
    pub fn new(mcp: &'a Mcp, spec: &'a ServerSpec, cfg: &Config) -> Self {
        McpSource {
            mcp,
            spec,
            allow: profile::allowlist(&cfg.profile, &cfg.tools),
        }
    }
}

impl ToolSource for McpSource<'_> {
    async fn call(&self, name: &str, args: Map<String, Value>) -> Result<Value> {
        self.mcp.call_read(self.spec, &self.allow, name, args).await
    }
}

/// All pages of a search, up to `cap` issues. Returns the payloads and whether it was capped.
async fn search_all<S: ToolSource>(
    src: &S,
    tool: &SearchTool,
    jql: &str,
    fields: &str,
    cap: usize,
) -> Result<(Vec<Value>, bool)> {
    let mut payloads = Vec::new();
    let mut count = 0usize;
    let mut start = 0u64;
    let mut token: Option<String> = None;
    // Generous bound so a misbehaving server can't loop forever.
    for _ in 0..(cap / tool.page_size.max(1) as usize + 10) {
        let mut args = Map::new();
        args.insert(tool.jql_arg.clone(), json!(jql));
        args.insert(tool.fields_arg.clone(), json!(fields));
        args.insert(
            tool.limit_arg.clone(),
            json!(tool.page_size.min((cap - count).max(1) as u32)),
        );
        args.insert(tool.start_arg.clone(), json!(start));
        if let (Some(t), Some(arg)) = (&token, &tool.page_token_arg) {
            args.insert(arg.clone(), json!(t));
        }
        let payload = unwrap_result(&src.call(&tool.name, args).await?)?;
        let n = super::normalize::issues_of(&payload).len();
        let next = payload
            .get("next_page_token")
            .or(payload.get("nextPageToken"))
            .and_then(Value::as_str)
            .map(String::from);
        let total = payload.get("total").and_then(Value::as_i64).unwrap_or(-1);
        payloads.push(payload);
        count += n;
        if count >= cap {
            return Ok((payloads, true));
        }
        if n == 0 {
            break;
        }
        if next.is_some() && tool.page_token_arg.is_some() {
            token = next;
            continue;
        }
        start += n as u64;
        if total < 0 || start >= total as u64 {
            break;
        }
    }
    Ok((payloads, false))
}

fn fields_list(cfg: &Config) -> String {
    let mut f = vec![
        "summary",
        "status",
        "issuetype",
        "priority",
        "assignee",
        "issuelinks",
        "parent",
    ];
    for id in [&cfg.fields.story_points, &cfg.fields.sprint] {
        if !id.trim().is_empty() {
            f.push(id.trim());
        }
    }
    f.join(",")
}

/// Makes links symmetric between fetched tickets and drops links to tickets not fetched.
/// Returns how many links were dropped.
pub fn symmetrize(tickets: &mut [Ticket]) -> usize {
    let idx: HashMap<String, usize> = tickets.iter().enumerate().map(|(i, t)| (t.key.clone(), i)).collect();
    let mut add_by: Vec<(usize, String)> = Vec::new();
    let mut add_blocks: Vec<(usize, String)> = Vec::new();
    let mut dropped: HashSet<(String, String)> = HashSet::new();
    for t in tickets.iter() {
        for b in &t.blocks {
            match idx.get(b) {
                Some(&j) => add_by.push((j, t.key.clone())),
                None => {
                    dropped.insert((t.key.clone(), b.clone()));
                }
            }
        }
        for b in &t.blocked_by {
            match idx.get(b) {
                Some(&j) => add_blocks.push((j, t.key.clone())),
                None => {
                    dropped.insert((b.clone(), t.key.clone()));
                }
            }
        }
    }
    for (j, k) in add_by {
        if !tickets[j].blocked_by.contains(&k) {
            tickets[j].blocked_by.push(k);
        }
    }
    for (j, k) in add_blocks {
        if !tickets[j].blocks.contains(&k) {
            tickets[j].blocks.push(k);
        }
    }
    for t in tickets.iter_mut() {
        t.blocks.retain(|k| idx.contains_key(k) && *k != t.key);
        t.blocked_by.retain(|k| idx.contains_key(k) && *k != t.key);
    }
    dropped.len()
}

/// "PAY · Sprint 43 (active)" from the in-scope tickets' sprints.
pub fn scope_label(scope: Scope, project: &str, tickets: &[Ticket]) -> String {
    if scope == Scope::Jql {
        return "Custom JQL".into();
    }
    let mut seen = Vec::new();
    for s in tickets.iter().filter(|t| t.in_scope).filter_map(|t| t.sprint.as_ref()) {
        if !seen.iter().any(|x: &&super::Sprint| x.id == s.id) {
            seen.push(s);
        }
    }
    seen.sort_by_key(|s| (s.state != SprintState::Active, s.id));
    let names: Vec<String> = seen
        .iter()
        .map(|s| {
            let name = s
                .name
                .strip_prefix(project)
                .map(str::trim_start)
                .filter(|n| !n.is_empty())
                .unwrap_or(&s.name);
            let st = match s.state {
                SprintState::Active => "active",
                SprintState::Future => "next",
                SprintState::Closed => "closed",
            };
            format!("{name} ({st})")
        })
        .collect();
    match names.len() {
        0 if scope == Scope::FutureSprints => format!("{project} · Future sprints"),
        0 => format!("{project} · Open sprints"),
        1..=2 => format!("{project} · {}", names.join(", ")),
        n => format!("{project} · {n} sprints"),
    }
}

pub async fn fetch_snapshot<S: ToolSource>(src: &S, cfg: &Config, scope: Option<Scope>) -> Result<Snapshot> {
    let scope = scope.unwrap_or(cfg.default_scope);
    let jql = scope_jql(scope, &cfg.project_key, &cfg.custom_jql)?;
    let tool = &cfg.tools.search;
    let fields = fields_list(cfg);
    let fc = FieldConfig {
        story_points: cfg.fields.story_points.clone(),
        sprint: cfg.fields.sprint.clone(),
        site: cfg.site.clone(),
    };
    let mut warnings = Vec::new();

    // 1. scope
    let (pages, capped) = search_all(src, tool, &jql, &fields, MAX_ISSUES).await?;
    if capped {
        warnings.push(format!("Showing the first {MAX_ISSUES} tickets of this scope."));
    }

    // 2. mine
    let (mine_pages, _) = search_all(src, tool, &mine_jql(&jql), "summary", MAX_ISSUES).await?;
    let mine: HashSet<String> = mine_pages
        .iter()
        .flat_map(super::normalize::issues_of)
        .filter_map(|i| i.get("key").and_then(Value::as_str).map(String::from))
        .collect();

    let mut n = normalize(&pages, &fc, &mine, true);
    n.tickets.truncate(MAX_ISSUES);
    warnings.append(&mut n.warnings);
    let mut tickets = n.tickets;

    // 3. one level of linked tickets outside the scope
    let have: HashSet<String> = tickets.iter().map(|t| t.key.clone()).collect();
    let mut linked: Vec<String> = Vec::new();
    for t in &tickets {
        for k in t.blocked_by.iter().chain(&t.blocks) {
            if !have.contains(k) && !linked.contains(k) {
                linked.push(k.clone());
            }
        }
    }
    // Keys come from Jira data: skip anything that isn't a plain issue key instead of failing.
    let before = linked.len();
    linked.retain(|k| super::jql::is_issue_key(k));
    if linked.len() < before {
        warnings.push(format!("Ignored {} malformed linked key(s).", before - linked.len()));
    }
    if linked.len() > MAX_LINKED {
        warnings.push(format!(
            "{} linked tickets not fetched (limit {MAX_LINKED}).",
            linked.len() - MAX_LINKED
        ));
        linked.truncate(MAX_LINKED);
    }
    for q in keys_jql(&linked)? {
        let (pages, _) = search_all(src, tool, &q, &fields, MAX_LINKED).await?;
        let mut g = normalize(&pages, &fc, &mine, false);
        warnings.append(&mut g.warnings);
        tickets.extend(g.tickets.into_iter().filter(|t| !have.contains(&t.key)));
    }

    // 4. symmetric links
    let dropped = symmetrize(&mut tickets);
    if dropped > 0 {
        warnings.push(format!(
            "{dropped} blocking link{} lead{} to tickets outside this map.",
            if dropped == 1 { "" } else { "s" },
            if dropped == 1 { "s" } else { "" }
        ));
    }

    Ok(Snapshot {
        fetched_at: now_iso(),
        scope_label: scope_label(scope, &cfg.project_key, &tickets),
        tickets,
        warnings,
    })
}

async fn find_field<S: ToolSource>(src: &S, tool: &str, kw: &str, pick: fn(&str) -> bool) -> Result<Option<String>> {
    let mut a = Map::new();
    a.insert("keyword".into(), json!(kw));
    let v = unwrap_result(&src.call(tool, a).await?)?;
    let list = v
        .as_array()
        .or_else(|| v.get("fields").and_then(Value::as_array))
        .cloned()
        .unwrap_or_default();
    Ok(list.iter().find_map(|f| {
        let id = f.get("id").and_then(Value::as_str)?;
        let name = f.get("name").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
        (id.starts_with("customfield_") && pick(&name)).then(|| id.to_string())
    }))
}

/// Detect story points / sprint field IDs with the profile's read-only fields tool.
pub async fn detect_fields<S: ToolSource>(src: &S, cfg: &Config) -> Result<(Option<String>, Option<String>)> {
    let tool = cfg
        .tools
        .fields
        .as_deref()
        .ok_or_else(|| Error::ToolMissing("fields tool".into()))?;
    let sp = find_field(src, tool, "story point", |n| n.contains("story point")).await?;
    let sprint = find_field(src, tool, "sprint", |n| n == "sprint").await?;
    Ok((sp, sprint))
}

/// Current UTC time as `YYYY-MM-DDTHH:MM:SSZ`.
pub fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    iso_from_unix(secs as i64)
}

pub fn iso_from_unix(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_dates() {
        assert_eq!(iso_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_from_unix(1_793_000_000), "2026-10-26T07:33:20Z");
        assert_eq!(iso_from_unix(951_782_400), "2000-02-29T00:00:00Z");
    }
}
