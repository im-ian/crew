use std::path::Path;
use std::process::Command;
use tauri_build::{AppManifest, Attributes};

fn main() {
    build_frontend();
    tauri_build::try_build(
        Attributes::new().app_manifest(AppManifest::new().commands(&[
            "list_agents",
            "list_channels",
            "send_message",
            "stop_agent",
            "approve_agent",
            "tell_message",
            "add_channel",
            "set_channel",
            "leave_channel",
            "remove_channel",
            "channel_send",
            "get_snapshot",
            "get_messages",
            "get_channel_messages",
            "daemon_ping",
            "reset_agent",
            "set_agent",
            "add_agent",
            "clone_agent",
            "remove_agent",
            "set_avatar",
            "clear_avatar",
            "add_routine",
            "remove_routine",
            "set_routine_enabled",
            "run_routine",
            "edit_routine",
            "list_routine_runs",
            "get_memory",
            "set_memory",
            "list_groups",
            "set_groups",
            "list_models",
            "search_crew",
            "list_skills",
            "lookup_skill",
            "save_skill",
            "save_upload",
            "peek_pending_focus",
            "take_pending_focus",
            "open_path",
        ])),
    )
    .expect("failed to run tauri build");
}

fn build_frontend() {
    let ui = Path::new("ui");
    let debug = std::env::var("PROFILE").ok().as_deref() == Some("debug");
    println!("cargo:rerun-if-changed=ui/package.json");
    println!("cargo:rerun-if-changed=ui/package-lock.json");
    println!("cargo:rerun-if-changed=ui/vite.config.ts");
    println!("cargo:rerun-if-changed=ui/tsconfig.json");
    if debug {
        // UI edits are served by Vite HMR; do not rebuild dist on every src change.
        println!("cargo:rerun-if-changed=ui/dist/index.html");
    } else {
        println!("cargo:rerun-if-changed=ui/src");
        println!("cargo:rerun-if-changed=ui/index.html");
    }

    if std::env::var_os("SKIP_UI_BUILD").is_some() {
        let dist = ui.join("dist/index.html");
        if !dist.exists() {
            panic!("SKIP_UI_BUILD set but {} is missing", dist.display());
        }
        return;
    }

    if debug && ui.join("dist/index.html").exists() {
        return;
    }

    if !ui.join("package.json").exists() {
        panic!("React UI package.json missing at {}", ui.display());
    }

    npm(ui, &["install"]);
    npm(ui, &["run", "build"]);

    let dist = ui.join("dist/index.html");
    if !dist.exists() {
        panic!("Vite build did not produce {}", dist.display());
    }
}

fn npm(dir: &Path, args: &[&str]) {
    let mut cmd = Command::new("npm");
    cmd.args(args).current_dir(dir).env("CI", "true");
    let status = cmd
        .status()
        .unwrap_or_else(|err| panic!("failed to run npm {}: {err}", args.join(" ")));
    if !status.success() {
        panic!("npm {} failed with {status}", args.join(" "));
    }
}
