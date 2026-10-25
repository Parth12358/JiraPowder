fn main() {
    // tauri-build only matters for the app binary; skip it for headless builds/tests.
    if std::env::var_os("CARGO_FEATURE_APP").is_some() {
        tauri_build::build()
    }
}
