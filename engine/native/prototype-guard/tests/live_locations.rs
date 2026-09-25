//! The live-location list is DATA shared with the Python door hook. These
//! tests pin what the file says and that the Rust guard derives exactly it.

use orgtree_prototype_guard::{live_locations, protected_locations, unconditional_locations, Env};
use std::path::PathBuf;

#[test]
fn the_file_parses_and_lists_exactly_these_locations() {
    let spec = live_locations();
    let got: Vec<(&str, bool)> = spec.locations.iter().map(|l| (l.label.as_str(), l.unconditional)).collect();
    assert_eq!(
        got,
        vec![
            ("ORGTREE_AGENT_PARENT_DATA", true),
            ("ORGTREE_AGENT_LEGACY_DATA", true),
            ("%APPDATA%\\Orgtree v2", true),
            ("%USERPROFILE%\\AppData\\Roaming\\Orgtree v2", true),
            ("~/orgtree", true),
            ("%ProgramFiles%\\Orgtree", true),
            ("%LOCALAPPDATA%\\Programs\\Orgtree", true),
            ("ORGTREE_DATA", false),
        ]
    );
}

#[test]
fn locations_resolve_from_the_environment_as_the_file_says() {
    let mut env = Env::new();
    for (k, v) in [
        ("ORGTREE_AGENT_PARENT_DATA", "C:\\p"),
        ("ORGTREE_AGENT_LEGACY_DATA", "C:\\l"),
        ("APPDATA", "C:\\u\\AppData\\Roaming"),
        ("USERPROFILE", "C:\\u"),
        ("HOME", "C:\\ignored-because-userprofile-wins"),
        ("ProgramFiles", "C:\\pf"),
        ("LOCALAPPDATA", "C:\\u\\AppData\\Local"),
    ] {
        env.insert(k.into(), v.into());
    }
    let got: Vec<PathBuf> = unconditional_locations(&env).into_iter().map(|(_, p)| p).collect();
    let want: Vec<PathBuf> = [
        "C:\\p",
        "C:\\l",
        "C:\\u\\AppData\\Roaming\\Orgtree v2",
        "C:\\u\\AppData\\Roaming\\Orgtree v2",
        "C:\\u\\orgtree",
        "C:\\pf\\Orgtree",
        "C:\\u\\AppData\\Local\\Programs\\Orgtree",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    assert_eq!(got, want);
    // HOME is the fallback when USERPROFILE is unset; unset bases are skipped.
    let mut env2 = Env::new();
    env2.insert("HOME".into(), "C:\\h".into());
    let got2: Vec<PathBuf> = unconditional_locations(&env2).into_iter().map(|(_, p)| p).collect();
    assert_eq!(got2, vec![PathBuf::from("C:\\h\\AppData\\Roaming\\Orgtree v2"), PathBuf::from("C:\\h\\orgtree")]);
    // ORGTREE_DATA (unmarked, nonexistent) is protected.
    env2.insert("ORGTREE_DATA".into(), "C:\\nonexistent-p03-test\\d".into());
    assert!(protected_locations(&env2).iter().any(|(l, _)| l == "ORGTREE_DATA"));
}
