use std::env;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let ui_dist = manifest_dir.join("../../ui/dist");

    println!("cargo:rerun-if-changed={}", ui_dist.display());

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let dest_path = out_dir.join("embedded_ui.rs");
    let mut out = File::create(&dest_path).expect("Failed to create embedded_ui.rs");

    let mut files: Vec<(String, PathBuf)> = Vec::new();
    if ui_dist.is_dir() {
        collect_files(&ui_dist, &ui_dist, &mut files);
    }

    writeln!(out, "pub fn get_embedded_ui_asset(rel_path: &str) -> Option<&'static [u8]> {{").unwrap();
    writeln!(out, "    match rel_path {{").unwrap();
    for (rel, full_path) in &files {
        println!("cargo:rerun-if-changed={}", full_path.display());
        let normalized_rel = rel.replace('\\', "/");
        let escaped_full = full_path.to_string_lossy().replace('\\', "/");
        writeln!(
            out,
            "        {:?} => Some(include_bytes!({:?})),",
            normalized_rel, escaped_full
        )
        .unwrap();
    }
    writeln!(out, "        _ => None,").unwrap();
    writeln!(out, "    }}").unwrap();
    writeln!(out, "}}").unwrap();
}

fn collect_files(root: &Path, current: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(rd) = fs::read_dir(current) else {
        return;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, out);
        } else if path.is_file() {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push((rel.to_string_lossy().to_string(), path));
            }
        }
    }
}
