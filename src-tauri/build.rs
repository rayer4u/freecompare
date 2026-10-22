use std::env;
use std::process::Command;

fn main() {
    let git_hash = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| env::var("FC_GIT_HASH").unwrap_or_else(|_| "unknown".to_string()));

    let is_dirty = Command::new("git")
        .args(["status", "--porcelain"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    let short_hash = if git_hash.len() >= 7 {
        git_hash[..7].to_string()
    } else {
        git_hash.clone()
    };

    let short_display = if is_dirty && git_hash != "unknown" {
        format!("{short_hash}-dirty")
    } else {
        short_hash.clone()
    };

    let target = env::var("TARGET").unwrap_or_else(|_| "unknown".to_string());

    println!("cargo:rustc-env=FC_GIT_HASH={git_hash}");
    println!("cargo:rustc-env=FC_GIT_HASH_SHORT={short_display}");
    println!("cargo:rustc-env=FC_GIT_DIRTY={}", if is_dirty { "true" } else { "false" });
    println!("cargo:rustc-env=FC_TARGET_TRIPLE={target}");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs");
}
