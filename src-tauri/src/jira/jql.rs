//! JQL builders. Keys from data are validated before they go into a query.
use std::sync::LazyLock;

use regex::Regex;

use crate::error::{Error, Result};
use crate::store::Scope;

static KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z][A-Z0-9_]+-\d+$").unwrap());
static PROJECT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z][A-Z0-9_]+$").unwrap());
static ORDER_BY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\s+order\s+by\s+").unwrap());

pub const KEYS_PER_QUERY: usize = 50;

pub fn is_issue_key(k: &str) -> bool {
    KEY.is_match(k)
}

pub fn is_project_key(k: &str) -> bool {
    PROJECT.is_match(k)
}

pub fn scope_jql(scope: Scope, project: &str, custom: &str) -> Result<String> {
    let sprint = |f: &str| -> Result<String> {
        if !is_project_key(project) {
            return Err(Error::NotConfigured(
                "Enter a project key such as PAY in Settings.".into(),
            ));
        }
        Ok(format!("project = \"{project}\" AND sprint in {f}() ORDER BY rank"))
    };
    match scope {
        Scope::OpenSprints => sprint("openSprints"),
        Scope::FutureSprints => sprint("futureSprints"),
        Scope::Jql => {
            let q = custom.trim();
            if q.is_empty() {
                Err(Error::NotConfigured("Enter a JQL query, or pick another scope.".into()))
            } else {
                Ok(q.to_string())
            }
        }
    }
}

/// The same query restricted to the current user, keeping any ORDER BY at the end.
pub fn mine_jql(scope_jql: &str) -> String {
    let (cond, order) = match ORDER_BY.find(scope_jql) {
        Some(m) => (&scope_jql[..m.start()], Some(&scope_jql[m.end()..])),
        None => (scope_jql, None),
    };
    let mut q = format!("({}) AND assignee = currentUser()", cond.trim());
    if let Some(o) = order {
        q.push_str(" ORDER BY ");
        q.push_str(o.trim());
    }
    q
}

/// `key in (A, B, …)` queries, 50 keys each. Any invalid key is rejected.
pub fn keys_jql(keys: &[String]) -> Result<Vec<String>> {
    if let Some(bad) = keys.iter().find(|k| !is_issue_key(k)) {
        return Err(Error::bad_response("invalid issue key in a link", bad));
    }
    Ok(keys
        .chunks(KEYS_PER_QUERY)
        .map(|c| format!("key in ({})", c.join(", ")))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes() {
        assert_eq!(
            scope_jql(Scope::OpenSprints, "PAY", "").unwrap(),
            r#"project = "PAY" AND sprint in openSprints() ORDER BY rank"#
        );
        assert_eq!(
            scope_jql(Scope::FutureSprints, "PAY", "").unwrap(),
            r#"project = "PAY" AND sprint in futureSprints() ORDER BY rank"#
        );
        assert_eq!(scope_jql(Scope::Jql, "", "  labels = x  ").unwrap(), "labels = x");
        assert!(scope_jql(Scope::Jql, "PAY", " ").is_err());
    }

    #[test]
    fn rejects_bad_project_keys() {
        assert!(scope_jql(Scope::OpenSprints, "PAY\" OR 1=1", "").is_err());
        assert!(scope_jql(Scope::OpenSprints, "pay", "").is_err());
        assert!(scope_jql(Scope::OpenSprints, "", "").is_err());
    }

    #[test]
    fn mine_keeps_order_by() {
        assert_eq!(
            mine_jql(r#"project = "PAY" AND sprint in openSprints() ORDER BY rank"#),
            r#"(project = "PAY" AND sprint in openSprints()) AND assignee = currentUser() ORDER BY rank"#
        );
        assert_eq!(
            mine_jql("labels = x OR labels = y"),
            "(labels = x OR labels = y) AND assignee = currentUser()"
        );
    }

    #[test]
    fn chunks_keys() {
        let keys: Vec<String> = (1..=120).map(|i| format!("PAY-{i}")).collect();
        let q = keys_jql(&keys).unwrap();
        assert_eq!(q.len(), 3);
        assert!(q[0].starts_with("key in (PAY-1, PAY-2,"));
        assert!(q[2].ends_with("PAY-120)"));
        assert_eq!(q[2].matches(',').count(), 19);
    }

    #[test]
    fn rejects_injected_keys() {
        for bad in ["PAY-1) OR project = SECRET", "pay-1", "PAY-", "PAY-1 ", "1-PAY"] {
            assert!(keys_jql(&[bad.to_string()]).is_err(), "{bad}");
        }
    }
}
