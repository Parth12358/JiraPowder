//! Apps opened from Finder/Dock don't inherit the shell PATH, so `npx`/`uvx` aren't found.
//! Recover it from a login shell and merge with the usual install locations.
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

const EXTRA: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "~/.local/bin", "~/.cargo/bin"];

fn expand_home(p: &str, home: Option<&Path>) -> String {
    match (p.strip_prefix("~/"), home) {
        (Some(rest), Some(h)) => h.join(rest).to_string_lossy().into_owned(),
        _ => p.to_string(),
    }
}

/// Shell PATH first, then the extra locations, then the current PATH; de-duplicated, order kept.
pub fn merge_path(shell: Option<&str>, current: Option<&str>, home: Option<&Path>) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut push = |s: String| {
        if !s.is_empty() && !out.contains(&s) {
            out.push(s);
        }
    };
    for part in shell.unwrap_or("").split(':') {
        push(part.to_string());
    }
    for e in EXTRA {
        push(expand_home(e, home));
    }
    for part in current.unwrap_or("").split(':') {
        push(part.to_string());
    }
    out.join(":")
}

/// `$SHELL -ilc 'printf "%s" "$PATH"'` with a 3 s timeout. None on failure.
pub fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".into());
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let out = Command::new(shell)
            .args(["-ilc", r#"printf "%s" "$PATH""#])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output();
        let _ = tx.send(out);
    });
    match rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(o)) if o.status.success() => {
            // Login shells may print banners; PATH is the last line.
            let s = String::from_utf8_lossy(&o.stdout);
            s.lines()
                .last()
                .map(|l| l.trim().to_string())
                .filter(|l| l.contains('/'))
        }
        _ => None,
    }
}

/// The PATH to give the MCP server process.
pub fn resolved_path() -> String {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    merge_path(
        login_shell_path().as_deref(),
        std::env::var("PATH").ok().as_deref(),
        home.as_deref(),
    )
}

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.is_file()
            && p.metadata()
                .map(|m| m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

/// Absolute commands are used as-is (if executable); bare names are looked up on `path`.
pub fn resolve_command(cmd: &str, path: &str) -> Option<PathBuf> {
    let p = Path::new(cmd);
    if p.is_absolute() || cmd.contains('/') {
        return is_executable(p).then(|| p.to_path_buf());
    }
    path.split(':')
        .filter(|d| !d.is_empty())
        .map(|d| Path::new(d).join(cmd))
        .find(|c| is_executable(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_in_order_without_duplicates() {
        let home = Path::new("/Users/me");
        let p = merge_path(Some("/a:/opt/homebrew/bin:/b"), Some("/b:/usr/bin"), Some(home));
        assert_eq!(
            p,
            "/a:/opt/homebrew/bin:/b:/usr/local/bin:/Users/me/.local/bin:/Users/me/.cargo/bin:/usr/bin"
        );
    }

    #[test]
    fn works_without_shell_path() {
        let p = merge_path(None, None, None);
        assert!(p.starts_with("/opt/homebrew/bin:/usr/local/bin"));
    }

    #[test]
    fn resolves_on_path() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("uvx");
        std::fs::write(&exe, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path = format!("/nonexistent:{}", dir.path().display());
        assert_eq!(resolve_command("uvx", &path), Some(exe.clone()));
        assert_eq!(resolve_command(exe.to_str().unwrap(), ""), Some(exe));
        assert_eq!(resolve_command("definitely-not-here", &path), None);
    }
}
