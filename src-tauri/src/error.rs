//! One error type for the whole backend, serialized to the UI as `{ kind, message }`.
use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    NotConfigured(String),
    #[error("Couldn't find `{0}`. Install it or set the full path in Settings.")]
    CommandNotFound(String),
    #[error("Couldn't start the MCP server: {0}")]
    SpawnFailed(String),
    #[error("{0}")]
    AuthRequired(String),
    #[error("{0}")]
    Timeout(String),
    #[error("Blocked a call to `{0}`: JiraPowder only uses read-only tools.")]
    ToolNotAllowed(String),
    #[error("The server does not offer `{0}`. Check the tool names in Settings.")]
    ToolMissing(String),
    #[error("Unexpected response from the server: {0}")]
    BadResponse(String),
    #[error("{0}")]
    Io(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn kind(&self) -> &'static str {
        match self {
            Error::NotConfigured(_) => "NotConfigured",
            Error::CommandNotFound(_) => "CommandNotFound",
            Error::SpawnFailed(_) => "SpawnFailed",
            Error::AuthRequired(_) => "AuthRequired",
            Error::Timeout(_) => "Timeout",
            Error::ToolNotAllowed(_) => "ToolNotAllowed",
            Error::ToolMissing(_) => "ToolMissing",
            Error::BadResponse(_) => "BadResponse",
            Error::Io(_) => "Io",
        }
    }

    /// BadResponse with at most the first 300 characters of the offending payload.
    pub fn bad_response(what: &str, payload: &str) -> Self {
        let head: String = payload.chars().take(300).collect();
        Error::BadResponse(if head.is_empty() {
            what.to_string()
        } else {
            format!("{what}: {head}")
        })
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Io(e.to_string())
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("Error", 2)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_kind_and_message() {
        let v = serde_json::to_value(Error::ToolNotAllowed("jira_create_issue".into())).unwrap();
        assert_eq!(v["kind"], "ToolNotAllowed");
        assert!(v["message"].as_str().unwrap().contains("jira_create_issue"));
    }

    #[test]
    fn bad_response_truncates() {
        let e = Error::bad_response("parse", &"x".repeat(1000));
        assert!(e.to_string().len() < 400);
    }
}
