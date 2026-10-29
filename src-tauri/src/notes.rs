//! Personal ticket notes: a colour tag and comments per ticket, kept in `notes.json` next to
//! config.json. They live only on this Mac and are never sent to Jira.
use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::jira::jql::is_issue_key;
use crate::store::write_atomic;

pub const TAGS: [&str; 6] = ["red", "orange", "yellow", "green", "blue", "purple"];
pub const MAX_COMMENT_CHARS: usize = 4000;
pub const MAX_COMMENTS: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    /// ISO time it was written.
    pub at: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Note {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    pub comments: Vec<Comment>,
}

impl Note {
    pub fn is_empty(&self) -> bool {
        self.tag.is_none() && self.comments.is_empty()
    }

    pub fn validate(&self) -> Result<()> {
        if let Some(t) = &self.tag {
            if !TAGS.contains(&t.as_str()) {
                return Err(Error::Io(format!("Unknown tag colour `{t}`.")));
            }
        }
        if self.comments.len() > MAX_COMMENTS {
            return Err(Error::Io(format!("A ticket can have at most {MAX_COMMENTS} comments.")));
        }
        for c in &self.comments {
            if c.text.trim().is_empty() || c.text.chars().count() > MAX_COMMENT_CHARS {
                return Err(Error::Io(format!(
                    "Comments must be 1 to {MAX_COMMENT_CHARS} characters."
                )));
            }
            if c.at.len() > 40 {
                return Err(Error::Io("Bad comment time.".into()));
            }
        }
        Ok(())
    }
}

/// Ticket key → note.
pub type Notes = BTreeMap<String, Note>;

fn path(dir: &Path) -> std::path::PathBuf {
    dir.join("notes.json")
}

pub fn load(dir: &Path) -> Result<Notes> {
    match std::fs::read(path(dir)) {
        Ok(b) => Ok(serde_json::from_slice(&b)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Notes::new()),
        Err(e) => Err(e.into()),
    }
}

/// Replaces one ticket's note (an empty note removes it) and writes the file atomically.
pub fn set(dir: &Path, key: &str, note: Note) -> Result<()> {
    if !is_issue_key(key) {
        return Err(Error::Io(format!("`{key}` is not a Jira issue key.")));
    }
    note.validate()?;
    let mut all = load(dir)?;
    if note.is_empty() {
        all.remove(key);
    } else {
        all.insert(key.to_string(), note);
    }
    write_atomic(&path(dir), &serde_json::to_vec_pretty(&all)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(tag: Option<&str>, texts: &[&str]) -> Note {
        Note {
            tag: tag.map(String::from),
            comments: texts
                .iter()
                .map(|t| Comment {
                    at: "2026-10-29T10:00:00Z".into(),
                    text: (*t).into(),
                })
                .collect(),
        }
    }

    #[test]
    fn round_trips_and_removes_empty() {
        let d = tempfile::tempdir().unwrap();
        assert!(load(d.path()).unwrap().is_empty());
        set(d.path(), "PAY-1", note(Some("red"), &["check with design"])).unwrap();
        set(d.path(), "PAY-2", note(None, &["a", "b"])).unwrap();
        let all = load(d.path()).unwrap();
        assert_eq!(all["PAY-1"], note(Some("red"), &["check with design"]));
        assert_eq!(all["PAY-2"].comments.len(), 2);
        set(d.path(), "PAY-1", Note::default()).unwrap();
        assert!(!load(d.path()).unwrap().contains_key("PAY-1"));
    }

    #[test]
    fn rejects_bad_input() {
        let d = tempfile::tempdir().unwrap();
        assert!(set(d.path(), "../x", note(Some("red"), &[])).is_err());
        assert!(set(d.path(), "PAY-1", note(Some("magenta"), &[])).is_err());
        assert!(set(d.path(), "PAY-1", note(None, &["   "])).is_err());
        let long = "x".repeat(MAX_COMMENT_CHARS + 1);
        assert!(set(d.path(), "PAY-1", note(None, &[&long])).is_err());
        assert!(load(d.path()).unwrap().is_empty());
    }

    #[test]
    fn json_shape() {
        let v = serde_json::to_value(note(Some("blue"), &["hi"])).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"tag": "blue", "comments": [{"at": "2026-10-29T10:00:00Z", "text": "hi"}]})
        );
    }
}
