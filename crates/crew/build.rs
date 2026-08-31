use std::path::Path;
use std::process::Command;

fn main() {
    build_frontend();
    tauri_build::build();
}

fn build_frontend() {
    let ui = Path::new("ui");
    println!("cargo:rerun-if-changed=ui/src");
    println!("cargo:rerun-if-changed=ui/index.html");
    println!("cargo:rerun-if-changed=ui/package.json");
    println!("cargo:rerun-if-changed=ui/package-lock.json");
    println!("cargo:rerun-if-changed=ui/vite.config.ts");
    println!("cargo:rerun-if-changed=ui/tsconfig.json");

    if std::env::var_os("SKIP_UI_BUILD").is_some() {
        let dist = ui.join("dist/index.html");
        if !dist.exists() {
            panic!("SKIP_UI_BUILD set but {} is missing", dist.display());
        }
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
