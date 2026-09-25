//! postmaster.pid parsing: pid (line 1), port (line 4), status word (line 8).

use orgtree_pg_custodian::cluster::{filetime_to_unix, lock_is_stale, pm_status, read_pid_file};

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
