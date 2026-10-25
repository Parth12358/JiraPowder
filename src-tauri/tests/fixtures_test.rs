//! Fixture tests: tests/fixtures/<name>.json → normalize → compare with <name>.expected.json.
use std::collections::HashSet;
use std::path::PathBuf;

use jirapowder_lib::jira::normalize::{issues_of, normalize, unwrap_result, FieldConfig};
use jirapowder_lib::jira::Ticket;
use serde_json::Value;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn load(name: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(dir().join(name)).unwrap()).unwrap()
}

fn payload(name: &str) -> Value {
    unwrap_result(&load(name)).unwrap()
}

fn cfg() -> FieldConfig {
    FieldConfig {
        story_points: "customfield_10016".into(),
        sprint: "customfield_10020".into(),
        site: "https://example.atlassian.net".into(),
    }
}

fn mine() -> HashSet<String> {
    issues_of(&payload("search_mine.json"))
        .iter()
        .map(|i| i["key"].as_str().unwrap().to_string())
        .collect()
}

fn expected(name: &str) -> Vec<Ticket> {
    serde_json::from_value(load(name)).unwrap()
}

#[test]
fn open_sprints_fixture() {
    let n = normalize(&[payload("search_open_sprints.json")], &cfg(), &mine(), true);
    assert!(n.warnings.is_empty(), "{:?}", n.warnings);
    assert_eq!(n.tickets, expected("search_open_sprints.expected.json"));
}

#[test]
fn linked_fixture() {
    let n = normalize(&[payload("search_linked.json")], &cfg(), &HashSet::new(), false);
    assert_eq!(n.tickets, expected("search_linked.expected.json"));
}

#[test]
fn get_issue_fixture() {
    let n = normalize(&[payload("get_issue.json")], &cfg(), &HashSet::new(), true);
    assert_eq!(n.tickets, expected("get_issue.expected.json"));
}

#[test]
fn edge_case_fixture() {
    let n = normalize(&[payload("edge_cases.json")], &cfg(), &HashSet::new(), true);
    assert_eq!(n.tickets, expected("edge_cases.expected.json"));
    assert_eq!(n.warnings.len(), 1, "missing summary must skip EDGE-4 with a warning");
    assert!(n.warnings[0].contains("EDGE-4"));
}

#[test]
fn empty_fixture() {
    let n = normalize(&[payload("empty.json")], &cfg(), &HashSet::new(), true);
    assert!(n.tickets.is_empty() && n.warnings.is_empty());
}

#[test]
fn mine_fixture_marks_my_tickets() {
    let m = mine();
    assert_eq!(m.len(), 4);
    assert!(m.contains("PAY-103") && !m.contains("PAY-104"));
}

/// Known pair (synthetic until confirmed on a real site, see NOTES.md): PAY-102 blocks PAY-103.
/// On PAY-102 Jira lists PAY-103 as the outward issue; on PAY-103, PAY-102 as the inward issue.
#[test]
fn blocks_direction_matches_known_pair() {
    let n = normalize(&[payload("search_open_sprints.json")], &cfg(), &HashSet::new(), true);
    let t = |k: &str| n.tickets.iter().find(|t| t.key == k).unwrap();
    assert!(t("PAY-102").blocks.contains(&"PAY-103".to_string()));
    assert!(t("PAY-103").blocked_by.contains(&"PAY-102".to_string()));
    assert!(!t("PAY-103").blocks.contains(&"PAY-102".to_string()));
}
