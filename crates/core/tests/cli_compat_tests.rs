use freecompare_core::cli_args::{
    exit_codes, CliInvocation, FavorSide, ForcedViewerKind, QuickCompareMode,
};
use std::path::PathBuf;

#[test]
fn test_cli_optional_and_required_positional_paths() {
    // 0 paths -> completely optional, valid
    let inv0 = CliInvocation::parse(Vec::<&str>::new()).unwrap();
    assert_eq!(inv0.paths.len(), 0);
    assert!(inv0.wait_for_ui);

    // 1 path -> left pre-populated, right optional
    let inv1 = CliInvocation::parse(["left_only.rs"]).unwrap();
    assert_eq!(inv1.paths.len(), 1);
    assert_eq!(inv1.left_path().unwrap().to_str(), Some("left_only.rs"));
    assert!(inv1.right_path().is_none());

    // 2 paths -> left and right
    let inv2 = CliInvocation::parse(["left.rs", "right.rs"]).unwrap();
    assert_eq!(inv2.paths.len(), 2);

    // 3 paths -> BC convention: [0]=Left, [1]=Right, [2]=Center/Base, output defaults to [2]
    let inv3 = CliInvocation::parse(["local.rs", "remote.rs", "base.rs"]).unwrap();
    assert_eq!(inv3.left_path().unwrap().to_str(), Some("local.rs"));
    assert_eq!(inv3.right_path().unwrap().to_str(), Some("remote.rs"));
    assert_eq!(inv3.center_base_path().unwrap().to_str(), Some("base.rs"));
    assert_eq!(
        inv3.resolved_merge_output_path(),
        Some(PathBuf::from("base.rs"))
    );

    // 4 paths -> Git mergetool convention: [0]=Left, [1]=Right, [2]=Center/Base, [3]=Merged Output
    let inv4 = CliInvocation::parse(["local.rs", "remote.rs", "base.rs", "merged.rs"]).unwrap();
    assert_eq!(
        inv4.resolved_merge_output_path(),
        Some(PathBuf::from("merged.rs"))
    );
}

#[test]
fn test_cli_bc_flags_dash_slash_colon_equals_and_optional_values() {
    // Git mergetool style with BC flags (`-solo`, `-automerge`, `-reviewconflicts`, `-title1=...`, `/ro1`)
    let args = [
        "-solo",
        "-automerge",
        "-reviewconflicts",
        "-favorleft",
        "/ro1",
        "-title1=LOCAL (HEAD)",
        "/title2:REMOTE (feature/login)",
        "-centertitle",
        "BASE (ancestor)",
        "-outputtitle=MERGED",
        "-mergeoutput=out/final.rs",
        "a.rs",
        "b.rs",
        "base.rs",
    ];

    let inv = CliInvocation::parse(args).unwrap();
    assert!(inv.automerge);
    assert!(inv.review_conflicts);
    assert_eq!(inv.favor, Some(FavorSide::Left));
    assert_eq!(inv.readonly, [true, false, false]);
    assert_eq!(inv.titles[0].as_deref(), Some("LOCAL (HEAD)"));
    assert_eq!(inv.titles[1].as_deref(), Some("REMOTE (feature/login)"));
    assert_eq!(inv.titles[2].as_deref(), Some("BASE (ancestor)"));
    assert_eq!(inv.titles[3].as_deref(), Some("MERGED"));
    assert_eq!(
        inv.resolved_merge_output_path(),
        Some(PathBuf::from("out/final.rs"))
    );
    assert_eq!(inv.paths.len(), 3);
}

#[test]
fn test_cli_quickcompare_optional_value_and_required_paths_validation() {
    // `-qc` without value is valid (defaults to RulesBased) when >= 2 paths are supplied
    let inv_default = CliInvocation::parse(["-qc", "f1.txt", "f2.txt"]).unwrap();
    assert_eq!(inv_default.quick_compare, Some(QuickCompareMode::RulesBased));

    // `-qc=binary` and `/quickcompare:crc` with explicit values
    let inv_bin = CliInvocation::parse(["-qc=binary", "f1.txt", "f2.txt"]).unwrap();
    assert_eq!(inv_bin.quick_compare, Some(QuickCompareMode::Binary));

    let inv_crc = CliInvocation::parse(["/quickcompare:crc", "-silent", "f1.txt", "f2.txt"]).unwrap();
    assert_eq!(inv_crc.quick_compare, Some(QuickCompareMode::Crc));
    assert!(inv_crc.silent);

    // `-qc` with fewer than 2 paths MUST fail validation!
    assert!(CliInvocation::parse(["-qc", "only_one_file.txt"]).is_err());

    // Required-value flag missing its value MUST fail validation!
    assert!(CliInvocation::parse(["-title1"]).is_err());

    // `-fv="Text Merge"` forced viewer
    let inv_fv = CliInvocation::parse(["-fv=Text Merge"]).unwrap();
    assert_eq!(inv_fv.forced_viewer, Some(ForcedViewerKind::TextMerge));
    assert_eq!(exit_codes::IMPORTANT_DIFF, 12);
}
