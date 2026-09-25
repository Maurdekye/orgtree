//! Owned-family selection on synthetic snapshots. The regression: a smoke
//! run at 6612067 counted an unrelated `vctip.exe` as owned, because its
//! (dead) parent's PID had been reused inside the postgres family.

use orgtree_pg_custodian::win::{family_pids, ProcessInfo};

fn p(pid: u32, parent: u32, exe: &str, created: Option<u64>) -> ProcessInfo {
    ProcessInfo { pid, parent_pid: parent, exe_name: exe.into(), created }
}

fn sorted(mut v: Vec<u32>) -> Vec<u32> {
    v.sort();
    v
}

#[test]
fn postmaster_shim_and_children() {
    let snap = vec![
        p(1, 0, "explorer.exe", Some(10)),
        p(50, 1, "cmd.exe", Some(100)),
        p(60, 50, "postgres.exe", Some(101)),
        p(61, 60, "postgres.exe", Some(102)),
        p(62, 60, "postgres.exe", Some(103)),
        p(63, 61, "postgres.exe", Some(104)),
        p(70, 50, "conhost.exe", Some(101)),
    ];
    assert_eq!(sorted(family_pids(&snap, 60)), vec![50, 60, 61, 62, 63, 70]);
}

#[test]
fn a_reused_parent_pid_does_not_adopt_an_older_process() {
    // 900 was created BEFORE pid 61's current owner: its real parent was an
    // earlier process that also had pid 61.
    let snap = vec![
        p(50, 1, "cmd.exe", Some(100)),
        p(60, 50, "postgres.exe", Some(101)),
        p(61, 60, "postgres.exe", Some(102)),
        p(900, 61, "vctip.exe", Some(20)),
        p(901, 50, "vctip.exe", Some(30)),
    ];
    assert_eq!(sorted(family_pids(&snap, 60)), vec![50, 60, 61]);
}

#[test]
fn a_parent_that_is_not_the_shim_is_not_owned() {
    let snap = vec![p(40, 1, "pg_ctl.exe", Some(90)), p(60, 40, "postgres.exe", Some(101))];
    assert_eq!(family_pids(&snap, 60), vec![60]);
    // A cmd.exe that took over the parent PID after the postmaster started.
    let snap = vec![p(40, 1, "cmd.exe", Some(500)), p(60, 40, "postgres.exe", Some(101))];
    assert_eq!(family_pids(&snap, 60), vec![60]);
}

#[test]
fn unknown_creation_times_never_link() {
    let snap = vec![p(60, 1, "postgres.exe", Some(101)), p(61, 60, "postgres.exe", None)];
    assert_eq!(family_pids(&snap, 60), vec![60]);
    assert_eq!(family_pids(&snap, 999), Vec::<u32>::new());
}
