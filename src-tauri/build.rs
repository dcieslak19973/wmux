use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    let text = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (out.status.success() && !text.is_empty()).then_some(text)
}

fn main() {
    // Short commit shown next to the version (title bar, sidebar, settings,
    // /info) so a running build can be told apart from a release of the
    // same version.
    let commit = git(&["rev-parse", "--short=9", "HEAD"]).unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=WMUX_GIT_COMMIT={commit}");
    // Re-run when HEAD moves (worktree-aware paths); tauri_build already
    // emits its own rerun-if-changed directives.
    for path in [
        git(&["rev-parse", "--git-path", "HEAD"]),
        git(&["symbolic-ref", "-q", "HEAD"]).and_then(|r| git(&["rev-parse", "--git-path", &r])),
    ]
    .into_iter()
    .flatten()
    {
        println!("cargo:rerun-if-changed={path}");
    }
    tauri_build::build()
}
