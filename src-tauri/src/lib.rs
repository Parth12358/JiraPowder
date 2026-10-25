pub mod env_path;
pub mod error;
pub mod jira;
pub mod mcp;
pub mod store;

#[cfg(feature = "app")]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running Blockmap");
}
