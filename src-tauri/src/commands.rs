//! Tauri commands: thin wrappers around `Backend`.
use tauri::State;
use tauri_plugin_opener::OpenerExt;

use crate::backend::{Backend, ConnectionReport, DetectedFields, Diagnostics};
use crate::error::{Error, Result};
use crate::jira::Snapshot;
use crate::store::{Config, Scope};

#[tauri::command]
pub fn get_config(b: State<'_, Backend>) -> Result<Option<Config>> {
    b.get_config()
}

#[tauri::command]
pub async fn save_config(b: State<'_, Backend>, cfg: Config) -> Result<()> {
    b.save_config(cfg).await
}

#[tauri::command]
pub fn set_secret(b: State<'_, Backend>, name: String, value: String) -> Result<()> {
    b.set_secret(&name, &value)
}

#[tauri::command]
pub async fn test_connection(b: State<'_, Backend>) -> Result<ConnectionReport> {
    b.test_connection().await
}

#[tauri::command]
pub async fn fetch_snapshot(b: State<'_, Backend>, scope: Option<Scope>) -> Result<Snapshot> {
    b.fetch_snapshot(scope).await
}

#[tauri::command]
pub fn load_cached_snapshot(b: State<'_, Backend>) -> Result<Option<Snapshot>> {
    b.load_cached_snapshot()
}

#[tauri::command]
pub async fn get_diagnostics(b: State<'_, Backend>) -> Result<Diagnostics> {
    Ok(b.get_diagnostics().await)
}

#[tauri::command]
pub async fn detect_fields(b: State<'_, Backend>) -> Result<DetectedFields> {
    b.detect_fields().await
}

/// Opens `https://<site>/browse/<KEY>` in the default browser. Nothing else can be opened:
/// the frontend has no opener permission, and the URL is built and checked here.
#[tauri::command]
pub fn open_in_jira(app: tauri::AppHandle, b: State<'_, Backend>, key: String) -> Result<()> {
    let url = b.jira_url(&key)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| Error::Io(e.to_string()))
}
