use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct GitContextResult {
    pub repo_root: String,
    pub repo_name: String,
    pub branch: Option<String>,
    pub worktree_name: Option<String>,
    pub is_worktree: bool,
}

#[tauri::command]
pub async fn get_git_branch(cwd: String) -> Result<Option<String>, String> {
    git_stdout(&cwd, &["branch", "--show-current"])
}

#[tauri::command]
pub async fn get_git_context(cwd: String) -> Result<Option<GitContextResult>, String> {
    let repo_root = match git_stdout(&cwd, &["rev-parse", "--show-toplevel"])? {
        Some(value) => value,
        None => return Ok(None),
    };

    let branch = git_stdout(&cwd, &["branch", "--show-current"])?;
    let git_dir_raw = match git_stdout(&cwd, &["rev-parse", "--git-dir"])? {
        Some(value) => value,
        None => return Ok(None),
    };
    let common_dir_raw = match git_stdout(&cwd, &["rev-parse", "--git-common-dir"])? {
        Some(value) => value,
        None => return Ok(None),
    };

    let cwd_path = Path::new(&cwd);
    let repo_root_path = PathBuf::from(&repo_root);
    let git_dir = resolve_git_path(cwd_path, &git_dir_raw);
    let common_dir = resolve_git_path(cwd_path, &common_dir_raw);
    let is_worktree = git_dir != common_dir;

    let repo_name = common_dir
        .parent()
        .and_then(|path| path.file_name())
        .or_else(|| repo_root_path.file_name())
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".to_string());

    let worktree_name = if is_worktree {
        repo_root_path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .or_else(|| {
                git_dir
                    .parent()
                    .and_then(|path| path.file_name())
                    .map(|value| value.to_string_lossy().into_owned())
            })
    } else {
        None
    };

    Ok(Some(GitContextResult {
        repo_root,
        repo_name,
        branch,
        worktree_name,
        is_worktree,
    }))
}

fn git_stdout(cwd: &str, args: &[&str]) -> Result<Option<String>, String> {
    #[cfg(windows)]
    use std::os::windows::process::CommandExt as _;

    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);

    let output = cmd.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Ok(None);
    }

    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(if value.is_empty() { None } else { Some(value) })
}

fn resolve_git_path(cwd: &Path, raw: &str) -> PathBuf {
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    }
}