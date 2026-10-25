pub mod backend;
pub mod env_path;
pub mod error;
pub mod jira;
pub mod mcp;
pub mod store;

#[cfg(feature = "app")]
mod commands;

#[cfg(feature = "app")]
pub fn run() {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    use tauri::{Emitter, Manager, RunEvent};

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let paths = app.path();
            let backend = backend::Backend::new(
                paths.app_config_dir()?,
                paths.app_data_dir()?,
                Box::new(store::Keychain),
            );
            app.manage(backend);
            // Resolve the login-shell PATH in the background so the first fetch doesn't wait for it.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                handle.state::<backend::Backend>().path().await;
            });

            let refresh = MenuItemBuilder::with_id("refresh", "Refresh")
                .accelerator("CmdOrCtrl+R")
                .build(app)?;
            let settings = MenuItemBuilder::with_id("settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let app_menu = SubmenuBuilder::new(app, "Blockmap")
                .about(None)
                .separator()
                .item(&settings)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            // Standard Edit items so copy/paste work in text fields.
            let edit = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let view = SubmenuBuilder::new(app, "View")
                .item(&refresh)
                .separator()
                .fullscreen()
                .build()?;
            let window = SubmenuBuilder::new(app, "Window").minimize().close_window().build()?;
            let menu = MenuBuilder::new(app)
                .items(&[&app_menu, &edit, &view, &window])
                .build()?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let action = match event.id().as_ref() {
                "refresh" => "refresh",
                "settings" => "settings",
                _ => return,
            };
            let _ = app.emit("menu", action);
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::save_config,
            commands::set_secret,
            commands::test_connection,
            commands::fetch_snapshot,
            commands::load_cached_snapshot,
            commands::get_diagnostics,
            commands::detect_fields,
            commands::open_in_jira,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Blockmap");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // Kill the MCP server (and its process group) so nothing is left running.
            if let Some(b) = handle.try_state::<backend::Backend>() {
                tauri::async_runtime::block_on(b.shutdown());
            }
        }
    });
}
