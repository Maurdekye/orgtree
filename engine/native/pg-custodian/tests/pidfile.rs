//! postmaster.pid parsing: pid (line 1), port (line 4), status word (line 8).

use orgtree_pg_custodian::cluster::{filetime_to_unix, lock_is_stale, pm_status, read_pid_file, wait_for_new_postmaster, PgBin};

#[test]
fn a_lock_is_stale_only_when_provably_so() {
    // The pid is not running at all.
    assert!(lock_is_stale(false, None, Some(100)));
    // The pid now belongs to a process created after the lock's postmaster.
    assert!(lock_is_stale(true, Some(200), Some(100)));
    // Same second (or earlier): might be the live postmaster itself.
    assert!(!lock_is_stale(true, Some(101), Some(100)));
    assert!(!lock_is_stale(true, Some(50), Some(100)));
    // Present but unreadable, or no start time: never assumed stale.
    assert!(!lock_is_stale(true, None, Some(100)));
    assert!(!lock_is_stale(true, Some(200), None));
}

#[test]
fn filetime_converts_to_unix_seconds() {
    // 2026-09-25T00:00:00Z = 1790294400 unix; FILETIME = (unix + 11644473600) * 1e7.
    let ft = (1_790_294_400u64 + 11_644_473_600) * 10_000_000 + 9_999_999;
    assert_eq!(filetime_to_unix(ft), 1_790_294_400);
}

#[test]
fn pid_port_and_status_come_from_their_lines() {
    let dir = std::env::temp_dir().join(format!("orgtree-p03-pidfile-{}", orgtree_pg_custodian::win::random_hex(4).unwrap()));
    std::fs::create_dir_all(&dir).unwrap();
    let body = "5620\nE:/x/data\n1790326125\n48380\n\n127.0.0.1\n  1234     5678\nstopping  \n";
    std::fs::write(dir.join("postmaster.pid"), body).unwrap();
    assert_eq!(read_pid_file(&dir), Some((5620, Some(48380))));
    assert_eq!(pm_status(&dir).as_deref(), Some("stopping"));
    std::fs::write(dir.join("postmaster.pid"), "5620\nE:/x/data\n1\n48380\n").unwrap();
    assert_eq!(pm_status(&dir), None, "an old-format file has no status line");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_stale_ready_lock_file_is_never_taken_for_the_new_postmaster() {
    // pg_ctl on Windows can report "started" from a leftover lock file that
    // says `ready` (drill finding 43d2683). The wait must refuse a lock whose
    // pid is not our freshly created postgres.exe, whatever the file says.
    let dir = std::env::temp_dir().join(format!("orgtree-p03-waitpm-{}", orgtree_pg_custodian::win::random_hex(4).unwrap()));
    std::fs::create_dir_all(&dir).unwrap();
    let me = std::process::id(); // alive, but not postgres.exe and created before "launch"
    std::fs::write(dir.join("postmaster.pid"), format!("{me}\nE:/x/data\n1\n55555\n\n127.0.0.1\n  1  2\nready\n")).unwrap();
    let bin = PgBin { dir: std::env::temp_dir(), version: "18.6".into() };
    let launched = orgtree_pg_custodian::now_unix() + 3600;
    let e = wait_for_new_postmaster(&dir, &bin, 55555, launched, std::time::Duration::from_millis(400)).unwrap_err();
    assert_eq!(e.code, "start.port_mismatch");
    assert!(e.message.contains("fresh false") && e.message.contains("ours false"), "{e}");
    std::fs::remove_dir_all(&dir).unwrap();
}
