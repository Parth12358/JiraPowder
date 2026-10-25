//! config.json + snapshot cache on disk (atomic writes), Keychain placeholders, and the
//! final server spec (env with forced read-only values and resolved secrets).
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::jira::Snapshot;
use crate::mcp::profile::{self, Tools};
use crate::mcp::ServerSpec;

pub const KEYCHAIN_PREFIX: &str = "keychain:";
/// What the UI sees instead of a secret value; sending it back means "unchanged".
pub const MASK: &str = "•••";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    #[default]
    OpenSprints,
    FutureSprints,
    Jql,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldIds {
    pub story_points: String,
    pub sprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub version: u32,
    pub server: ServerConfig,
    pub profile: String,
    pub tools: Tools,
    pub fields: FieldIds,
    pub site: String,
    pub project_key: String,
    pub default_scope: Scope,
    pub custom_jql: String,
    pub refresh_minutes: u32,
    /// Use tools/fake-mcp instead of `server` (demos, tests).
    pub use_fake_server: bool,
}

impl Default for Config {
    fn default() -> Self {
        let p = &profile::MCP_ATLASSIAN;
        Config {
            version: 1,
            server: ServerConfig {
                command: "uvx".into(),
                args: vec!["mcp-atlassian".into()],
                env: BTreeMap::from([("READ_ONLY_MODE".into(), "true".into())]),
            },
            profile: p.id.into(),
            tools: Tools {
                search: (p.search)(),
                fields: p.fields_tool.map(String::from),
            },
            fields: FieldIds {
                story_points: "customfield_10016".into(),
                sprint: "customfield_10020".into(),
            },
            site: String::new(),
            project_key: String::new(),
            default_scope: Scope::OpenSprints,
            custom_jql: String::new(),
            refresh_minutes: 0,
            use_fake_server: false,
        }
    }
}

impl Config {
    /// For a known profile, tool settings always come from the profile (only "custom" is editable).
    pub fn normalized(mut self) -> Self {
        if let Some(p) = profile::by_id(&self.profile) {
            self.tools = Tools {
                search: (p.search)(),
                fields: p.fields_tool.map(String::from),
            };
        }
        self.site = self.site.trim().trim_end_matches('/').to_string();
        self.project_key = self.project_key.trim().to_uppercase();
        self
    }

    pub fn validate(&self) -> Result<()> {
        if !self.use_fake_server && self.server.command.trim().is_empty() {
            return Err(Error::NotConfigured(
                "Enter the command that starts your MCP server.".into(),
            ));
        }
        if !self.site.is_empty() && !is_site_url(&self.site) {
            return Err(Error::NotConfigured(
                "Site URL must look like https://yourcompany.atlassian.net.".into(),
            ));
        }
        match self.default_scope {
            Scope::Jql if self.custom_jql.trim().is_empty() => {
                Err(Error::NotConfigured("Enter a JQL query, or pick another scope.".into()))
            }
            Scope::OpenSprints | Scope::FutureSprints if !crate::jira::jql::is_project_key(&self.project_key) => Err(
                Error::NotConfigured("Enter a project key such as PAY in Settings.".into()),
            ),
            _ => Ok(()),
        }
    }
}

pub fn is_site_url(s: &str) -> bool {
    s.strip_prefix("https://")
        .is_some_and(|h| !h.is_empty() && !h.contains(['/', ' ', '?', '#', '@']))
}

fn looks_secret(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    ["token", "secret", "password", "api_key", "apikey"]
        .iter()
        .any(|s| k.contains(s))
}

/// Copy for the UI: plain-text values of secret-looking env vars become "•••".
/// Keychain placeholders are left as they are (they hold no secret).
pub fn masked(cfg: &Config) -> Config {
    let mut c = cfg.clone();
    for (k, v) in c.server.env.iter_mut() {
        if looks_secret(k) && !v.starts_with(KEYCHAIN_PREFIX) && !v.is_empty() {
            *v = MASK.into();
        }
    }
    c
}

/// Puts back secret values the UI sent as "•••".
pub fn unmask(mut new: Config, old: &Config) -> Config {
    for (k, v) in new.server.env.iter_mut() {
        if v == MASK {
            *v = old.server.env.get(k).cloned().unwrap_or_default();
        }
    }
    new
}

/// Where secrets live. The app uses the macOS Keychain (service `blockmap`).
pub trait Secrets: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<String>>;
    fn set(&self, name: &str, value: &str) -> Result<()>;
}

/// In-memory secrets for tests and headless tools.
#[derive(Default)]
pub struct MemorySecrets(pub std::sync::Mutex<BTreeMap<String, String>>);

impl Secrets for MemorySecrets {
    fn get(&self, name: &str) -> Result<Option<String>> {
        Ok(self.0.lock().unwrap().get(name).cloned())
    }
    fn set(&self, name: &str, value: &str) -> Result<()> {
        self.0.lock().unwrap().insert(name.into(), value.into());
        Ok(())
    }
}

#[cfg(feature = "app")]
pub struct Keychain;

#[cfg(feature = "app")]
impl Secrets for Keychain {
    fn get(&self, name: &str) -> Result<Option<String>> {
        let e = keyring::Entry::new("blockmap", name).map_err(|e| Error::Io(e.to_string()))?;
        match e.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Error::Io(format!("Keychain: {e}"))),
        }
    }
    fn set(&self, name: &str, value: &str) -> Result<()> {
        let e = keyring::Entry::new("blockmap", name).map_err(|e| Error::Io(e.to_string()))?;
        e.set_password(value).map_err(|e| Error::Io(format!("Keychain: {e}")))
    }
}

/// tools/fake-mcp/server.mjs, located via BLOCKMAP_FAKE_MCP or the source tree (dev builds).
pub fn fake_server_script() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("BLOCKMAP_FAKE_MCP") {
        return Some(PathBuf::from(p));
    }
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tools/fake-mcp/server.mjs");
    p.exists().then_some(p)
}

/// The final command + env to spawn: forced read-only env for known profiles, Keychain
/// placeholders resolved. Values are never logged.
pub fn server_spec(cfg: &Config, secrets: &dyn Secrets, path: &str) -> Result<ServerSpec> {
    if cfg.use_fake_server {
        let script = fake_server_script()
            .ok_or_else(|| Error::NotConfigured("The fake server is only available in development builds.".into()))?;
        return Ok(ServerSpec {
            command: "node".into(),
            args: vec![script.to_string_lossy().into_owned()],
            env: vec![],
            path: path.into(),
        });
    }
    let mut env: Vec<(String, String)> = Vec::new();
    for (k, v) in &cfg.server.env {
        let value = match v.strip_prefix(KEYCHAIN_PREFIX) {
            Some(name) => secrets.get(name)?.ok_or_else(|| {
                Error::NotConfigured(format!("{k} is not in the Keychain. Enter it again in Settings."))
            })?,
            None => v.clone(),
        };
        env.push((k.clone(), value));
    }
    if let Some(p) = profile::by_id(&cfg.profile) {
        for (k, v) in p.forced_env {
            env.retain(|(ek, _)| ek != k);
            env.push((k.to_string(), v.to_string()));
        }
    }
    Ok(ServerSpec {
        command: cfg.server.command.trim().into(),
        args: cfg.server.args.clone(),
        env,
        path: path.into(),
    })
}

/// Write to a temp file in the same directory, fsync, then rename over the target.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().ok_or_else(|| Error::Io("bad path".into()))?;
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file")
    ));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    match std::fs::read(path) {
        Ok(b) => Ok(Some(serde_json::from_slice(&b)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn load_config(dir: &Path) -> Result<Option<Config>> {
    Ok(read_json::<Config>(&dir.join("config.json"))?.map(Config::normalized))
}

pub fn save_config(dir: &Path, cfg: &Config) -> Result<()> {
    write_atomic(&dir.join("config.json"), &serde_json::to_vec_pretty(cfg)?)
}

pub fn load_snapshot(dir: &Path) -> Result<Option<Snapshot>> {
    // A corrupt cache is not worth an error; just ignore it.
    Ok(read_json(&dir.join("snapshot.json")).ok().flatten())
}

pub fn save_snapshot(dir: &Path, s: &Snapshot) -> Result<()> {
    write_atomic(&dir.join("snapshot.json"), &serde_json::to_vec(s)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_round_trips_atomically() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_config(dir.path()).unwrap(), None);
        let c = Config {
            project_key: "PAY".into(),
            ..Config::default()
        };
        save_config(dir.path(), &c).unwrap();
        assert_eq!(load_config(dir.path()).unwrap(), Some(c));
        assert!(!dir.path().join(".config.json.tmp").exists());
    }

    #[test]
    fn config_json_uses_camel_case() {
        let v = serde_json::to_value(Config::default()).unwrap();
        assert!(v.get("projectKey").is_some());
        assert_eq!(v["defaultScope"], "openSprints");
        assert_eq!(v["tools"]["search"]["jqlArg"], "jql");
    }

    #[test]
    fn forces_read_only_env_and_resolves_keychain() {
        let secrets = MemorySecrets::default();
        secrets.set("jira_api_token", "s3cret-token").unwrap();
        let mut c = Config::default();
        c.server.env = BTreeMap::from([
            ("READ_ONLY_MODE".into(), "false".into()),
            ("JIRA_API_TOKEN".into(), "keychain:jira_api_token".into()),
        ]);
        let spec = server_spec(&c, &secrets, "/usr/bin").unwrap();
        let get = |k: &str| spec.env.iter().find(|(ek, _)| ek == k).map(|(_, v)| v.as_str());
        assert_eq!(get("READ_ONLY_MODE"), Some("true"));
        assert_eq!(
            get("ENABLED_TOOLS"),
            Some("jira_search,jira_get_issue,jira_search_fields")
        );
        assert_eq!(get("JIRA_API_TOKEN"), Some("s3cret-token"));
    }

    #[test]
    fn missing_keychain_entry_is_reported() {
        let mut c = Config::default();
        c.server.env.insert("JIRA_API_TOKEN".into(), "keychain:nope".into());
        let e = server_spec(&c, &MemorySecrets::default(), "").unwrap_err();
        assert_eq!(e.kind(), "NotConfigured");
    }

    #[test]
    fn masks_and_unmasks_plain_secrets() {
        let mut c = Config::default();
        c.server.env.insert("JIRA_API_TOKEN".into(), "plain-token".into());
        c.server.env.insert("CONFLUENCE_TOKEN".into(), "keychain:c".into());
        let m = masked(&c);
        assert_eq!(m.server.env["JIRA_API_TOKEN"], MASK);
        assert_eq!(m.server.env["CONFLUENCE_TOKEN"], "keychain:c");
        assert_eq!(m.server.env["READ_ONLY_MODE"], "true");
        assert_eq!(unmask(m, &c), c);
    }

    #[test]
    fn validates() {
        let mut c = Config::default();
        assert!(c.validate().is_err()); // no project key
        c.project_key = "PAY".into();
        assert!(c.validate().is_ok());
        c.site = "http://insecure.example".into();
        assert!(c.validate().is_err());
        c.site = "https://acme.atlassian.net".into();
        c.default_scope = Scope::Jql;
        assert!(c.validate().is_err());
    }

    #[test]
    fn known_profiles_ignore_edited_tools() {
        let mut c = Config::default();
        c.tools.search.name = "jira_create_issue".into();
        assert_eq!(c.normalized().tools.search.name, "jira_search");
    }
}
