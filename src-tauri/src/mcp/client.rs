//! Spawns the server as a child process (in its own process group, so `npx` and its node
//! child die together), performs the handshake, keeps stderr in a ring buffer, and
//! reconnects once on transport errors.
use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use process_wrap::tokio::{CommandWrap, ProcessGroup};
use rmcp::service::ServiceError;
use rmcp::transport::TokioChildProcess;
use rmcp::ServiceExt;
use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::{guard, McpSession};
use crate::env_path;
use crate::error::{Error, Result};

pub const CALL_TIMEOUT: Duration = Duration::from_secs(20);
/// First call may wait on a browser OAuth login (`mcp-remote`).
pub const FIRST_CALL_TIMEOUT: Duration = Duration::from_secs(120);
const STDERR_LINES: usize = 200;

/// Everything needed to start the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerSpec {
    pub command: String,
    pub args: Vec<String>,
    /// Final env (placeholders already resolved). Values are secrets for masking purposes.
    pub env: Vec<(String, String)>,
    pub path: String,
}

/// Last 200 stderr lines of the server, with secrets masked on read.
#[derive(Default)]
pub struct StderrLog {
    lines: Mutex<VecDeque<String>>,
    secrets: Mutex<Vec<String>>,
}

impl StderrLog {
    pub fn push(&self, line: String) {
        let mut l = self.lines.lock().unwrap();
        if l.len() == STDERR_LINES {
            l.pop_front();
        }
        l.push_back(line);
    }

    pub fn set_secrets(&self, env: &[(String, String)]) {
        // Mask every env value of 6+ chars; short ones ("1", "true") would garble the log.
        *self.secrets.lock().unwrap() = env.iter().map(|(_, v)| v.clone()).filter(|v| v.len() >= 6).collect();
    }

    pub fn lines(&self) -> Vec<String> {
        let secrets = self.secrets.lock().unwrap().clone();
        self.lines.lock().unwrap().iter().map(|l| mask(l, &secrets)).collect()
    }

    fn mentions_authorize(&self) -> bool {
        self.lines.lock().unwrap().iter().any(|l| {
            let l = l.to_ascii_lowercase();
            l.contains("authorize") || l.contains("oauth") || l.contains("browser")
        })
    }

    fn tail(&self, n: usize) -> String {
        let all = self.lines();
        all[all.len().saturating_sub(n)..].join(" | ")
    }
}

pub fn mask(line: &str, secrets: &[String]) -> String {
    let mut out = line.to_string();
    for s in secrets {
        if !s.is_empty() {
            out = out.replace(s.as_str(), "•••");
        }
    }
    out
}

pub(crate) fn map_service_error(e: ServiceError) -> Error {
    match e {
        ServiceError::McpError(m) => Error::BadResponse(m.message.to_string()),
        ServiceError::Timeout { timeout } => Error::Timeout(format!("No answer within {}s.", timeout.as_secs())),
        other => Error::Io(format!("Lost the connection to the MCP server ({other})")),
    }
}

/// Transport-level failures that are worth one reconnect.
fn is_transport(e: &Error) -> bool {
    matches!(e, Error::Io(m) if m.starts_with("Lost the connection"))
}

async fn connect(spec: &ServerSpec, log: &Arc<StderrLog>) -> Result<McpSession> {
    let exe = env_path::resolve_command(&spec.command, &spec.path)
        .ok_or_else(|| Error::CommandNotFound(spec.command.clone()))?;
    log.set_secrets(&spec.env);

    let mut cmd = tokio::process::Command::new(exe);
    cmd.args(&spec.args).env("PATH", &spec.path).kill_on_drop(true);
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    let mut wrap = CommandWrap::from(cmd);
    wrap.wrap(ProcessGroup::leader());

    let (proc, stderr) = TokioChildProcess::builder(wrap)
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::SpawnFailed(e.to_string()))?;
    if let Some(stderr) = stderr {
        let log = log.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log.push(line);
            }
        });
    }

    let service = ().serve(proc).await.map_err(|e| {
        let tail = log.tail(3);
        Error::SpawnFailed(if tail.is_empty() {
            e.to_string()
        } else {
            format!("{e}. Server said: {tail}")
        })
    })?;
    let server_name = service
        .peer_info()
        .and_then(|i| serde_json::to_value(&*i).ok())
        .and_then(|v| v.pointer("/serverInfo/name").and_then(Value::as_str).map(String::from))
        .unwrap_or_else(|| spec.command.clone());
    let defs = service.list_all_tools().await.map_err(map_service_error)?;
    let tools = defs.iter().map(|t| t.name.to_string()).collect();
    let tool_defs = defs.iter().filter_map(|t| serde_json::to_value(t).ok()).collect();
    Ok(McpSession {
        service,
        server_name,
        tools,
        tool_defs,
    })
}

impl McpSession {
    async fn shutdown(self) {
        // Closes stdin, waits up to 3 s, then kills the process group (rmcp graceful_shutdown).
        let _ = tokio::time::timeout(Duration::from_secs(5), self.service.cancel()).await;
    }
}

/// The app-wide MCP state: at most one live session.
#[derive(Default)]
pub struct Mcp {
    session: tokio::sync::Mutex<Option<(ServerSpec, McpSession)>>,
    pub stderr: Arc<StderrLog>,
    warmed_up: AtomicBool,
}

impl Mcp {
    /// Connects (or reuses the session if the spec is unchanged) and returns
    /// `(server name, tool names, tool definitions)`.
    pub async fn ensure(&self, spec: &ServerSpec) -> Result<(String, Vec<String>, Vec<Value>)> {
        let mut slot = self.session.lock().await;
        self.ensure_locked(&mut slot, spec).await?;
        let (_, s) = slot.as_ref().expect("session");
        Ok((s.server_name.clone(), s.tools.clone(), s.tool_defs.clone()))
    }

    async fn ensure_locked(&self, slot: &mut Option<(ServerSpec, McpSession)>, spec: &ServerSpec) -> Result<()> {
        if slot
            .as_ref()
            .is_some_and(|(s, sess)| s == spec && !sess.service.is_closed())
        {
            return Ok(());
        }
        if let Some((_, old)) = slot.take() {
            old.shutdown().await;
        }
        let timeout = self.timeout();
        let sess = tokio::time::timeout(timeout, connect(spec, &self.stderr))
            .await
            .map_err(|_| self.timeout_error(timeout))??;
        *slot = Some((spec.clone(), sess));
        Ok(())
    }

    fn timeout(&self) -> Duration {
        if self.warmed_up.load(Ordering::Relaxed) {
            CALL_TIMEOUT
        } else {
            FIRST_CALL_TIMEOUT
        }
    }

    fn timeout_error(&self, t: Duration) -> Error {
        if self.stderr.mentions_authorize() {
            Error::AuthRequired("Sign in to Atlassian in the browser window that opened, then Retry.".into())
        } else {
            Error::Timeout(format!("The MCP server did not answer within {}s.", t.as_secs()))
        }
    }

    /// Calls a read-only tool through the guard. Reconnects once on a transport error;
    /// drops the session on timeout (which kills the child).
    pub async fn call_read(
        &self,
        spec: &ServerSpec,
        allow: &[String],
        name: &str,
        args: Map<String, Value>,
    ) -> Result<Value> {
        guard::check(name, allow)?;
        let mut slot = self.session.lock().await;
        let mut retried = false;
        loop {
            self.ensure_locked(&mut slot, spec).await?;
            let timeout = self.timeout();
            let (_, sess) = slot.as_ref().expect("session");
            match guard::call_read_tool(sess, allow, name, args.clone(), timeout).await {
                Ok(v) => {
                    self.warmed_up.store(true, Ordering::Relaxed);
                    return Ok(v);
                }
                Err(Error::Timeout(_)) => {
                    if let Some((_, s)) = slot.take() {
                        s.shutdown().await;
                    }
                    return Err(self.timeout_error(timeout));
                }
                Err(e) if is_transport(&e) && !retried => {
                    retried = true;
                    if let Some((_, s)) = slot.take() {
                        s.shutdown().await;
                    }
                }
                Err(e) => {
                    if is_transport(&e) {
                        slot.take();
                    }
                    return Err(e);
                }
            }
        }
    }

    /// Drops the session; the next call reconnects. Kills the child process group.
    pub async fn disconnect(&self) {
        if let Some((_, s)) = self.session.lock().await.take() {
            s.shutdown().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_secrets() {
        let log = StderrLog::default();
        log.set_secrets(&[
            ("JIRA_API_TOKEN".into(), "abcd1234".into()),
            ("READ_ONLY_MODE".into(), "true".into()),
        ]);
        log.push("auth with abcd1234 failed, READ_ONLY_MODE=true".into());
        assert_eq!(
            log.lines(),
            vec!["auth with ••• failed, READ_ONLY_MODE=true".to_string()]
        );
    }

    #[test]
    fn ring_buffer_keeps_last_200() {
        let log = StderrLog::default();
        for i in 0..250 {
            log.push(format!("line {i}"));
        }
        let l = log.lines();
        assert_eq!(l.len(), 200);
        assert_eq!(l[0], "line 50");
    }
}
