//! Beyond Compare (`bcompare`) & FreeCompare (`fcompare` / `fc`) CLI argument parser.
//!
//! Strictly handles optional vs. required positional paths (0..=4) and flags:
//! - Prefix styles: `-flag`, `--flag`, and `/flag` (when not an existing filesystem path on Unix)
//! - Assignment styles: `-key=val`, `-key:val`, and `-key val`
//! - Optional-value flags: `-qc` / `-quickcompare[=<mode>]`
//! - Standard BC 3/4-way path ordering: `<left> <right> <center/base> [<output>]`

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuickCompareMode {
    RulesBased,
    Binary,
    Crc,
    Size,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForcedViewerKind {
    TextCompare,
    TextMerge,
    FolderCompare,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FavorSide {
    Left,
    Right,
}

/// Standard Beyond Compare exit codes for `-qc` (Quick Compare) and `git mergetool`.
pub mod exit_codes {
    pub const SAME: i32 = 0;
    pub const BINARY_SAME: i32 = 1;
    pub const RULES_SAME: i32 = 2;
    pub const BINARY_DIFF: i32 = 11;
    pub const IMPORTANT_DIFF: i32 = 12;
    pub const UNIMPORTANT_DIFF: i32 = 13;
    pub const FOLDER_MIXED_OR_DIFF: i32 = 14;
    pub const MERGE_CONFLICT_OR_ABORTED: i32 = 1;
    pub const ERROR_OR_MISSING_ARGS: i32 = 105;
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CliInvocation {
    /// Positional paths (0 to 4 paths, all optional unless `-qc` is active).
    /// - 1 path: `[left]`
    /// - 2 paths: `[left, right]`
    /// - 3 paths (BC convention): `[left, right, center_base]`
    /// - 4 paths (BC & git mergetool convention): `[left, right, center_base, merged_output]`
    pub paths: Vec<PathBuf>,

    /// Custom titles (`-title1`..`-title4`, `-lefttitle`, `-righttitle`, `-centertitle`, `-outputtitle`).
    /// Index 0 = Left(1), 1 = Right(2), 2 = Center/Base(3), 3 = Output(4).
    pub titles: [Option<String>; 4],

    /// Read-only locks (`-ro`, `-ro1`/`-leftreadonly`, `-ro2`/`-rightreadonly`, `-ro3`/`-centerreadonly`).
    pub readonly: [bool; 3],

    /// `-automerge`: Automatically merge files without user interaction if no conflicts exist.
    pub automerge: bool,
    /// `-force`: Write conflict markers to output when automerge encounters conflicts.
    pub force: bool,
    /// `-reviewconflicts`: Open UI if `-automerge` encounters unresolved conflicts.
    pub review_conflicts: bool,
    /// `-favorleft` / `-favorright`: Auto-resolve conflicts in favor of Left or Right.
    pub favor: Option<FavorSide>,
    /// `-mergeoutput=<path>`: Explicit output path (overrides or supplements 4th positional path).
    pub merge_output: Option<PathBuf>,

    /// `-qc` / `-quickcompare[=<mode>]`: Run headless quick comparison and return BC exit code.
    pub quick_compare: Option<QuickCompareMode>,
    /// `-silent`: Suppress UI and terminal output, returning only exit code.
    pub silent: bool,
    /// `-cli` / `--summary`: Print human-readable CLI diff summary without launching UI.
    pub cli_summary: bool,

    /// `-wait` / `-solo` vs `-nowait`: Wait for UI window closure before exiting process.
    pub wait_for_ui: bool,
    pub no_wait: bool,

    /// `-expandall`: Expand all subfolders initially in Folder Compare.
    pub expand_all: bool,
    /// `-filters=<globs>`: Semicolon-separated include/exclude filters (e.g. `-*.tmp;-target/`).
    pub filters: Vec<String>,
    /// `-fv` / `-fileviewer=<type>`: Force a specific view type even with 0 or 1 path.
    pub forced_viewer: Option<ForcedViewerKind>,

    /// Help or Git integration installer flags.
    pub show_help: bool,
    pub print_git_config: bool,
    pub install_git_config: bool,

    /// Internal server flags (`--port`, `--no-open`).
    pub port_override: Option<u16>,
    pub no_open_window: bool,
}

impl CliInvocation {
    pub fn parse<I, S>(raw_args: I) -> Result<Self, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let args: Vec<String> = raw_args.into_iter().map(|s| s.as_ref().to_string()).collect();
        let mut inv = CliInvocation {
            wait_for_ui: true,
            ..Default::default()
        };

        let mut i = 0;
        let mut stop_flags = false;

        while i < args.len() {
            let arg = &args[i];

            if stop_flags {
                inv.paths.push(PathBuf::from(arg));
                i += 1;
                continue;
            }

            if arg == "--" {
                stop_flags = true;
                i += 1;
                continue;
            }

            if let Some((raw_key, inline_val)) = parse_flag_token(arg) {
                let key = raw_key.to_lowercase();
                match key.as_str() {
                    "h" | "help" | "?" => {
                        inv.show_help = true;
                    }
                    "git-config" => {
                        inv.print_git_config = true;
                    }
                    "install-git" => {
                        inv.install_git_config = true;
                    }
                    "cli" | "summary" => {
                        inv.cli_summary = true;
                    }
                    "no-open" | "headless" => {
                        inv.no_open_window = true;
                    }
                    "port" => {
                        let val_str = require_flag_value(&key, inline_val, &args, &mut i)?;
                        let p = val_str
                            .parse::<u16>()
                            .map_err(|_| format!("Invalid port number for -{key}: {val_str}"))?;
                        inv.port_override = Some(p);
                    }
                    // Read-only switches (no value required)
                    "ro" | "readonly" => {
                        inv.readonly = [true, true, true];
                    }
                    "ro1" | "leftreadonly" | "lro" => {
                        inv.readonly[0] = true;
                    }
                    "ro2" | "rightreadonly" | "rro" => {
                        inv.readonly[1] = true;
                    }
                    "ro3" | "centerreadonly" | "cro" => {
                        inv.readonly[2] = true;
                    }
                    // Titles (value required)
                    "title1" | "lefttitle" | "vcsleft" => {
                        let val = require_flag_value(&key, inline_val, &args, &mut i)?;
                        inv.titles[0] = Some(val);
                    }
                    "title2" | "righttitle" | "vcsright" => {
                        let val = require_flag_value(&key, inline_val, &args, &mut i)?;
                        inv.titles[1] = Some(val);
                    }
                    "title3" | "centertitle" | "vcscenter" => {
                        let val = require_flag_value(&key, inline_val, &args, &mut i)?;
                        inv.titles[2] = Some(val);
                    }
                    "title4" | "outputtitle" | "vcsoutput" => {
                        let val = require_flag_value(&key, inline_val, &args, &mut i)?;
                        inv.titles[3] = Some(val);
                    }
                    // Merge switches
                    "automerge" => {
                        inv.automerge = true;
                    }
                    "force" => {
                        inv.force = true;
                    }
                    "reviewconflicts" => {
                        inv.review_conflicts = true;
                    }
                    "favorleft" => {
                        inv.favor = Some(FavorSide::Left);
                    }
                    "favorright" => {
                        inv.favor = Some(FavorSide::Right);
                    }
                    "mergeoutput" => {
                        let val = require_flag_value(&key, inline_val, &args, &mut i)?;
                        inv.merge_output = Some(PathBuf::from(val));
                    }
                    // Quick compare (value is OPTIONAL!)
                    "qc" | "quickcompare" => {
                        let mode = match inline_val.map(|s| s.to_lowercase()).as_deref() {
                            None | Some("") | Some("rules-based") | Some("rules") => {
                                QuickCompareMode::RulesBased
                            }
                            Some("binary") | Some("bin") => QuickCompareMode::Binary,
                            Some("crc") | Some("hash") => QuickCompareMode::Crc,
                            Some("size") | Some("meta") => QuickCompareMode::Size,
                            Some(other) => {
                                return Err(format!("Unknown quickcompare mode: {other}"))
                            }
                        };
                        inv.quick_compare = Some(mode);
                    }
                    "silent" => {
                        inv.silent = true;
                    }
                    "solo" | "wait" => {
                        inv.wait_for_ui = true;
                    }
                    "nowait" => {
                        inv.no_wait = true;
                        inv.wait_for_ui = false;
                    }
                    "expandall" => {
                        inv.expand_all = true;
                    }
                    "filters" | "filter" => {
                        let val = require_flag_value(&key, inline_val, &args, &mut i)?;
                        inv.filters = val
                            .split(';')
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty())
                            .collect();
                    }
                    "fv" | "fileviewer" => {
                        let val = require_flag_value(&key, inline_val, &args, &mut i)?.to_lowercase();
                        if val.contains("merge") {
                            inv.forced_viewer = Some(ForcedViewerKind::TextMerge);
                        } else if val.contains("folder") || val.contains("dir") {
                            inv.forced_viewer = Some(ForcedViewerKind::FolderCompare);
                        } else {
                            inv.forced_viewer = Some(ForcedViewerKind::TextCompare);
                        }
                    }
                    _ => {
                        // Ignore unknown BC-specific cosmetic flags (e.g. -nobackups, -ignorerename)
                        // so 3rd-party tools never break when invoking fcompare!
                    }
                }
                i += 1;
                continue;
            }

            inv.paths.push(PathBuf::from(arg));
            i += 1;
        }

        // Validation: `-qc` requires at least 2 paths
        if inv.quick_compare.is_some() && inv.paths.len() < 2 {
            return Err("`-qc` / `-quickcompare` requires at least 2 file paths".to_string());
        }

        Ok(inv)
    }

    pub fn left_path(&self) -> Option<&Path> {
        self.paths.first().map(|p| p.as_path())
    }

    pub fn right_path(&self) -> Option<&Path> {
        self.paths.get(1).map(|p| p.as_path())
    }

    /// In 3-way or 4-way invocation (`<left> <right> <center> [<output>]`), index 2 is Center/Base.
    pub fn center_base_path(&self) -> Option<&Path> {
        self.paths.get(2).map(|p| p.as_path())
    }

    /// Output path for 3-way merge: explicit `-mergeoutput` takes precedence, then 4th path, then 3rd path.
    pub fn resolved_merge_output_path(&self) -> Option<PathBuf> {
        if let Some(ref explicit) = self.merge_output {
            return Some(explicit.clone());
        }
        if let Some(fourth) = self.paths.get(3) {
            return Some(fourth.clone());
        }
        self.paths.get(2).cloned()
    }
}

/// Parses `-key=val`, `--key:val`, or Windows-style `/key=val` (only if not an existing Unix path).
fn parse_flag_token(arg: &str) -> Option<(String, Option<String>)> {
    if let Some(rest) = arg.strip_prefix("--") {
        if rest.is_empty() {
            return None;
        }
        return Some(split_key_val(rest));
    }
    if let Some(rest) = arg.strip_prefix('-') {
        if rest.is_empty() {
            return None;
        }
        return Some(split_key_val(rest));
    }
    if let Some(rest) = arg.strip_prefix('/') {
        // On Unix/macOS, `/home/...` or `/tmp/...` is an absolute file path!
        // Only treat `/flag` as a switch if it matches known BC switch prefixes and is not an existing path.
        if !rest.is_empty() && !Path::new(arg).exists() && is_known_slash_flag(rest) {
            return Some(split_key_val(rest));
        }
    }
    None
}

fn split_key_val(rest: &str) -> (String, Option<String>) {
    let eq_pos = rest.find('=');
    let colon_pos = rest.find(':');
    let split_idx = match (eq_pos, colon_pos) {
        (Some(e), Some(c)) => Some(e.min(c)),
        (Some(e), None) => Some(e),
        (None, Some(c)) => Some(c),
        (None, None) => None,
    };

    if let Some(idx) = split_idx {
        let key = rest[..idx].to_string();
        let val = unquote(rest[idx + 1..].trim());
        (key, Some(val))
    } else {
        (rest.to_string(), None)
    }
}

fn require_flag_value(
    key: &str,
    inline_val: Option<String>,
    args: &[String],
    idx: &mut usize,
) -> Result<String, String> {
    if let Some(v) = inline_val {
        return Ok(v);
    }
    if *idx + 1 < args.len() {
        *idx += 1;
        return Ok(unquote(&args[*idx]));
    }
    Err(format!("Flag `-{key}` requires a value"))
}

fn unquote(s: &str) -> String {
    if (s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
        || (s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2)
    {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

fn is_known_slash_flag(rest: &str) -> bool {
    let lower = rest.to_lowercase();
    let key = lower
        .split(['=', ':'])
        .next()
        .unwrap_or(&lower);
    matches!(
        key,
        "h"
            | "help"
            | "?"
            | "ro"
            | "ro1"
            | "ro2"
            | "ro3"
            | "leftreadonly"
            | "rightreadonly"
            | "centerreadonly"
            | "title1"
            | "title2"
            | "title3"
            | "title4"
            | "lefttitle"
            | "righttitle"
            | "centertitle"
            | "outputtitle"
            | "vcsleft"
            | "vcsright"
            | "vcscenter"
            | "vcsoutput"
            | "automerge"
            | "force"
            | "reviewconflicts"
            | "favorleft"
            | "favorright"
            | "mergeoutput"
            | "qc"
            | "quickcompare"
            | "silent"
            | "solo"
            | "wait"
            | "nowait"
            | "expandall"
            | "filters"
            | "filter"
            | "fv"
            | "fileviewer"
    )
}
