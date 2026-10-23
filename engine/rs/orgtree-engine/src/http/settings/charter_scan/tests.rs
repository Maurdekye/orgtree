use super::*;
use std::io::{Cursor, Write};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("charter-scan-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn dir(&self, name: &str) -> PathBuf {
        let path = self.0.join(name);
        fs::create_dir_all(&path).unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Fixtures contain only owned generated files. Remove test junctions
        // explicitly before Drop; never recurse through them in cleanup.
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn charter_scan_states_and_read_failures_are_reported() {
    let fixture = Fixture::new();
    assert_eq!(
        scan(&fixture.0.join("missing"), false).0["status"],
        "missing"
    );
    assert_eq!(
        scan(Path::new("relative"), false).0["status"],
        "invalid_path"
    );
    fs::write(fixture.0.join("file"), b"not a directory").unwrap();
    assert_eq!(
        scan(&fixture.0.join("file"), false).0["status"],
        "not_directory"
    );
    let dir = fixture.dir("plain");
    fs::write(dir.join("good.md"), b"Charter text").unwrap();
    fs::write(dir.join("upper.MD"), b"Upper-case suffix").unwrap();
    fs::write(dir.join("bad.md"), [0xff, 0xfe]).unwrap();
    fs::write(dir.join("ignored.txt"), b"not markdown").unwrap();
    fs::create_dir(dir.join("directory.md")).unwrap();
    let (names, records) = scan(&dir, false);
    assert_eq!(names["status"], "ok");
    assert_eq!(names["count"], 3);
    assert!(records.iter().all(|r| r.text.is_none()));
    assert_eq!(names["not_files"], json!(["directory.md"]));
    let (state, records) = scan(&dir, true);
    assert_eq!(state["count"], 2);
    assert_eq!(state["unreadable_files"], json!(["bad.md"]));
    assert_eq!(records[0].text.as_ref().unwrap().shown, "Charter text");
    assert_eq!(read(&dir.join("good.md")).as_deref(), Some("Charter text"));
}

#[test]
fn charter_scan_checks_byte_bound_before_read_and_preserves_display_truncation() {
    let fixture = Fixture::new();
    let exact = fixture.0.join("exact.md");
    let mut file = File::create(&exact).unwrap();
    file.write_all(&vec![b'x'; FILE_MAX as usize]).unwrap();
    drop(file);
    let oversize = fixture.0.join("oversize.md");
    File::create(&oversize)
        .unwrap()
        .set_len(FILE_MAX + 1)
        .unwrap();
    let (state, records) = scan(&fixture.0, true);
    assert_eq!(state["oversize"], json!(["oversize.md"]));
    assert_eq!(state["count"], 1);
    let text = records[0].text.as_ref().unwrap();
    assert_eq!(text.chars, FILE_MAX as usize);
    assert_eq!(text.shown.len(), super::super::PRESET_MAX);
    assert!(read(&oversize).is_none());
    // A file growing after metadata checks still cannot produce an unbounded
    // read. Only one byte beyond the limit is consumed, then it is refused.
    let mut growing = Cursor::new(vec![b'x'; FILE_MAX as usize + 100]);
    assert_eq!(bounded_text(&mut growing).unwrap_err(), Refusal::Oversize);
    assert_eq!(growing.position(), FILE_MAX + 1);
    fs::write(&exact, "\u{1f43e}".repeat(100_001)).unwrap();
    let (_, records) = scan(&fixture.0, true);
    let text = records[0].text.as_ref().unwrap();
    assert_eq!(text.chars, 100_001);
    assert_eq!(text.shown.chars().count(), 100_000);
}

#[test]
fn charter_scan_listing_limit_counts_rejected_candidates_too() {
    let fixture = Fixture::new();
    for n in 0..=DIR_MAX {
        fs::create_dir(fixture.0.join(format!("{n:04}.md"))).unwrap();
    }
    let (state, records) = scan(&fixture.0, true);
    assert!(records.is_empty());
    assert_eq!(state["count"], 0);
    assert_eq!(state["not_files"].as_array().unwrap().len(), DIR_MAX);
    assert_eq!(state["listing_truncated"], true);
}

#[test]
fn charter_scan_cloud_attributes_are_refused_before_open() {
    for flag in [0x400, 0x1000, 0x40000, 0x400000] {
        assert!(unsafe_attributes(flag));
        assert!(unsafe_attributes(flag | 0x20));
    }
    assert!(!unsafe_attributes(0x20)); // ordinary archive bit
    assert!(!unsafe_attributes(0x80000)); // pinned, locally resident
}

#[cfg(windows)]
#[test]
fn charter_scan_windows_junctions_and_ancestor_replacement_are_refused() {
    let fixture = Fixture::new();
    let outside = fixture.dir("outside");
    fs::write(outside.join("foreign.md"), b"must not read").unwrap();
    let linked = fixture.0.join("linked");
    let make = |link: &Path| {
        let output = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "could not create owned test junction"
        );
    };
    make(&linked);
    let state = scan(&linked, true).0;
    let ancestor = scan(&linked.join("nested"), true).0;
    fs::remove_dir(&linked).unwrap();
    assert_eq!(state["status"], "link_refused");
    assert_eq!(ancestor["status"], "link_refused");
    let root = fixture.dir("root");
    let leaf = root.join("leaf.md");
    make(&leaf);
    let (state, records) = scan(&root, true);
    let direct = read(&leaf);
    fs::remove_dir(&leaf).unwrap();
    assert!(records.is_empty());
    assert!(direct.is_none());
    assert_eq!(state["skipped_links"], json!(["leaf.md"]));
    let pinned = open_directory(&root).unwrap();
    assert!(
        fs::rename(&root, fixture.0.join("replaced")).is_err(),
        "checked ancestor must remain pinned during scan"
    );
    drop(pinned);
    fs::rename(&root, fixture.0.join("replaced")).unwrap();
}

#[cfg(unix)]
#[test]
fn charter_scan_unix_symlinks_are_never_followed() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let outside = fixture.dir("outside");
    fs::write(outside.join("foreign.md"), b"must not read").unwrap();
    let linked = fixture.0.join("linked");
    symlink(&outside, &linked).unwrap();
    assert_eq!(scan(&linked, true).0["status"], "link_refused");
    let root = fixture.dir("root");
    symlink(outside.join("foreign.md"), root.join("leaf.md")).unwrap();
    let (state, records) = scan(&root, true);
    assert!(records.is_empty());
    assert_eq!(state["skipped_links"], json!(["leaf.md"]));
    assert!(read(&root.join("leaf.md")).is_none());
}
