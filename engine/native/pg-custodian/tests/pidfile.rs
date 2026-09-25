//! postmaster.pid parsing: pid (line 1), port (line 4), status word (line 8).

use orgtree_pg_custodian::cluster::{pm_status, read_pid_file};

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
