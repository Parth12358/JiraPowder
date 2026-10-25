//! Everything the Tauri commands do, without Tauri, so it builds and tests headless.
//! `commands.rs` is a thin wrapper around this.
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::sync::OnceCell;

use crate::env_path;
use crate::error::{Error, Result};
use crate::jira::fetch::{self, McpSource};
use crate::jira::{jql, Snapshot};
use crate::mcp::{profile, Mcp, ServerSpec};
use crate::store::{self, Config, Scope, Secrets};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionReport {
    pub server_name: String,
    /// Allowlisted read tools the server offers.
    pub tools: Vec<String>,
    /// Configured tools the server does not offer.
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub stderr: Vec<String>,
    pub path: String,
    pub last_error: Option<Error>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedFields {
    pub story_points: Option<String>,
    pub sprint: Option<String>,
}

type Inflight = Arc<OnceCell<Result<Snapshot>>>;

pub struct Backend {
    pub mcp: Mcp,
    config_dir: PathBuf,
    data_dir: PathBuf,
    secrets: Box<dyn Secrets>,
    path: OnceCell<String>,
    last_error: Mutex<Option<Error>>,
    inflight: tokio::sync::Mutex<Option<Inflight>>,
}

impl Backend {
    pub fn new(config_dir: PathBuf, data_dir: PathBuf, secrets: Box<dyn Secrets>) -> Self {
        Backend {
            mcp: Mcp::default(),
            config_dir,
            data_dir,
            secrets,
            path: OnceCell::new(),
            last_error: Mutex::new(None),
            inflight: tokio::sync::Mutex::new(None),
        }
    }

    /// The login-shell PATH, resolved once (it can take up to 3 s).
    pub async fn path(&self) -> String {
        self.path
            .get_or_init(|| async {
                tokio::task::spawn_blocking(env_path::resolved_path)
                    .await
                    .unwrap_or_default()
            })
            .await
            .clone()
    }

    fn config(&self) -> Result<Config> {
        store::load_config(&self.config_dir)?
            .ok_or_else(|| Error::NotConfigured("Connect Jira in Settings to load your tickets.".into()))
    }

    async fn spec(&self, cfg: &Config) -> Result<ServerSpec> {
        let path = self.path().await;
        store::server_spec(cfg, self.secrets.as_ref(), &path)
    }

    fn record<T>(&self, r: Result<T>) -> Result<T> {
        if let Err(e) = &r {
            *self.last_error.lock().unwrap() = Some(e.clone());
        }
        r
    }

    /// Config for the UI, secrets masked. None on first launch.
    pub fn get_config(&self) -> Result<Option<Config>> {
        Ok(store::load_config(&self.config_dir)?.map(|c| store::masked(&c)))
    }

    pub async fn save_config(&self, cfg: Config) -> Result<()> {
        let old = store::load_config(&self.config_dir)?.unwrap_or_default();
        let cfg = store::unmask(cfg, &old).normalized();
        cfg.validate()?;
        store::save_config(&self.config_dir, &cfg)?;
        // Next call reconnects with the new settings.
        self.mcp.disconnect().await;
        Ok(())
    }

    pub fn set_secret(&self, name: &str, value: &str) -> Result<()> {
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Err(Error::Io(
                "Secret names may only contain letters, digits, _ and -.".into(),
            ));
        }
        self.secrets.set(name, value)
    }

    pub async fn test_connection(&self) -> Result<ConnectionReport> {
        let r = async {
            let cfg = self.config()?;
            let spec = self.spec(&cfg).await?;
            let (server_name, offered, _) = self.mcp.ensure(&spec).await?;
            let allow = profile::allowlist(&cfg.profile, &cfg.tools);
            let configured: Vec<String> = std::iter::once(cfg.tools.search.name.clone())
                .chain(cfg.tools.fields.clone())
                .collect();
            Ok(ConnectionReport {
                server_name,
                tools: offered.iter().filter(|t| allow.contains(t)).cloned().collect(),
                missing: configured.into_iter().filter(|t| !offered.contains(t)).collect(),
            })
        }
        .await;
        self.record(r)
    }

    /// Fetches a fresh snapshot. A second call while one is running gets the same result.
    pub async fn fetch_snapshot(&self, scope: Option<Scope>) -> Result<Snapshot> {
        let cell = {
            let mut g = self.inflight.lock().await;
            g.get_or_insert_with(|| Arc::new(OnceCell::new())).clone()
        };
        let res = cell.get_or_init(|| self.do_fetch(scope)).await.clone();
        {
            let mut g = self.inflight.lock().await;
            if g.as_ref().is_some_and(|c| Arc::ptr_eq(c, &cell)) {
                *g = None;
            }
        }
        res
    }

    async fn do_fetch(&self, scope: Option<Scope>) -> Result<Snapshot> {
        let r = async {
            let cfg = self.config()?;
            cfg.validate()?;
            let spec = self.spec(&cfg).await?;
            let snap = fetch::fetch_snapshot(&McpSource::new(&self.mcp, &spec, &cfg), &cfg, scope).await?;
            store::save_snapshot(&self.data_dir, &snap)?;
            Ok(snap)
        }
        .await;
        if r.is_ok() {
            *self.last_error.lock().unwrap() = None;
        }
        self.record(r)
    }

    pub fn load_cached_snapshot(&self) -> Result<Option<Snapshot>> {
        store::load_snapshot(&self.data_dir)
    }

    pub async fn get_diagnostics(&self) -> Diagnostics {
        Diagnostics {
            stderr: self.mcp.stderr.lines(),
            path: self.path().await,
            last_error: self.last_error.lock().unwrap().clone(),
        }
    }

    pub async fn detect_fields(&self) -> Result<DetectedFields> {
        let r = async {
            let cfg = self.config()?;
            let spec = self.spec(&cfg).await?;
            let (story_points, sprint) = fetch::detect_fields(&McpSource::new(&self.mcp, &spec, &cfg), &cfg).await?;
            Ok(DetectedFields { story_points, sprint })
        }
        .await;
        self.record(r)
    }

    /// The URL to open for a ticket: only `https://<configured site>/browse/<valid key>`.
    pub fn jira_url(&self, key: &str) -> Result<String> {
        let cfg = self.config()?;
        if !store::is_site_url(&cfg.site) {
            return Err(Error::NotConfigured(
                "Set your Jira site URL in Settings to open tickets.".into(),
            ));
        }
        if !jql::is_issue_key(key) {
            return Err(Error::Io(format!("`{key}` is not a Jira issue key.")));
        }
        Ok(format!("{}/browse/{key}", cfg.site))
    }

    pub async fn shutdown(&self) {
        self.mcp.disconnect().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::MemorySecrets;

    fn backend() -> (Backend, tempfile::TempDir) {
        let d = tempfile::tempdir().unwrap();
        let b = Backend::new(
            d.path().join("cfg"),
            d.path().join("data"),
            Box::new(MemorySecrets::default()),
        );
        (b, d)
    }

    #[tokio::test]
    async fn not_configured_until_saved() {
        let (b, _d) = backend();
        assert_eq!(b.get_config().unwrap(), None);
        assert_eq!(b.fetch_snapshot(None).await.unwrap_err().kind(), "NotConfigured");
        assert_eq!(b.get_diagnostics().await.last_error.unwrap().kind(), "NotConfigured");
    }

    #[tokio::test]
    async fn save_keeps_masked_secrets() {
        let (b, _d) = backend();
        let mut c = Config {
            project_key: "PAY".into(),
            ..Config::default()
        };
        c.server.env.insert("JIRA_API_TOKEN".into(), "real-token-value".into());
        b.save_config(c).await.unwrap();
        let shown = b.get_config().unwrap().unwrap();
        assert_eq!(shown.server.env["JIRA_API_TOKEN"], store::MASK);
        b.save_config(shown).await.unwrap(); // UI sends the mask back unchanged
        let stored = store::load_config(&b.config_dir).unwrap().unwrap();
        assert_eq!(stored.server.env["JIRA_API_TOKEN"], "real-token-value");
    }

    #[tokio::test]
    async fn rejects_invalid_config() {
        let (b, _d) = backend();
        assert_eq!(
            b.save_config(Config::default()).await.unwrap_err().kind(),
            "NotConfigured"
        );
    }

    #[tokio::test]
    async fn jira_url_is_scoped() {
        let (b, _d) = backend();
        let c = Config {
            project_key: "PAY".into(),
            site: "https://acme.atlassian.net".into(),
            ..Config::default()
        };
        b.save_config(c).await.unwrap();
        assert_eq!(b.jira_url("PAY-1").unwrap(), "https://acme.atlassian.net/browse/PAY-1");
        assert!(b.jira_url("PAY-1/../../evil").is_err());
        assert!(b.jira_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn secret_names_are_restricted() {
        let (b, _d) = backend();
        assert!(b.set_secret("jira_api_token", "x").is_ok());
        assert!(b.set_secret("../etc", "x").is_err());
    }

    /// Tauri async commands need Send futures.
    #[test]
    fn command_futures_are_send() {
        fn send<T: Send>(_: &T) {}
        let (b, _d) = backend();
        send(&b.fetch_snapshot(None));
        send(&b.test_connection());
        send(&b.save_config(Config::default()));
        send(&b.detect_fields());
        send(&b.get_diagnostics());
        send(&b.shutdown());
    }
}
