//! Who holds a postmaster.pid's pid (review finding B1).
//!
//! Every postgres.exe that runs from the same bin has the same image: other
//! agents' clusters and every backend. So the image alone proves nothing, and
//! only a postmaster whose own `-D` is this data folder is ours.
//!
//! The live cases use a stand-in postmaster: a copy of cmd.exe named
//! postgres.exe in a private bin folder, started as `/d /q /k rem <args>`. It
//! stays alive while its stdin is open, and its command line carries whatever
//! `-D` we give it, so these tests need no database.

use orgtree_pg_custodian::cluster::{self, classify_holder, data_dir_arg, holder, wait_for_new_postmaster, Holder, HolderFacts, PgBin};
use orgtree_pg_custodian::win;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("orgtree p03 holder-{tag} {}", win::random_hex(4).unwrap()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// A private bin folder whose postgres.exe is a copy of cmd.exe.
fn fake_bin() -> PgBin {
    let dir = tmp("bin");
    let sys = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    std::fs::copy(sys.join("System32").join("cmd.exe"), dir.join("postgres.exe")).unwrap();
    PgBin { dir, version: "18.6".into() }
}

struct Fake(Child);
impl Drop for Fake {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
impl Fake {
    fn pid(&self) -> u32 {
        self.0.id()
    }
}

fn spawn(bin: &PgBin, args: &[&str]) -> Fake {
    let child = Command::new(bin.exe("postgres"))
        .args(["/d", "/q", "/k", "rem"])
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    Fake(child)
}

/// postmaster.pid: pid, data dir, start time, port, socket dir, listen, shmem, status.
fn write_lock(data: &Path, pid: u32, started_unix: u64, port: u16, status: &str) {
    std::fs::write(data.join("postmaster.pid"), format!("{pid}\n{}\n{started_unix}\n{port}\n\n127.0.0.1\n  1  2\n{status}\n", data.display())).unwrap();
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

fn facts(argv: Option<&[&str]>) -> HolderFacts {
    HolderFacts { present: true, image_is_ours: Some(true), created_unix: Some(1000), argv: argv.map(s) }
}

#[test]
fn the_d_argument_is_read_in_both_spellings() {
    assert_eq!(data_dir_arg(&s(&["postgres", "-D", "E:/a b/data", "-p", "5"])), Some("E:/a b/data"));
    assert_eq!(data_dir_arg(&s(&["postgres", "-DE:/x", "-p", "5"])), Some("E:/x"));
    assert_eq!(data_dir_arg(&s(&["postgres", "-p", "5"])), None);
    // argv[0] is never an option, and a trailing -D has no value.
    assert_eq!(data_dir_arg(&s(&["-DE:/x"])), None);
    assert_eq!(data_dir_arg(&s(&["postgres", "-D"])), None);
}

#[test]
fn only_a_postmaster_for_this_data_folder_is_ours() {
    let data = tmp("data");
    let other = tmp("other");
    let fwd = data.display().to_string().replace('\\', "/").to_uppercase();
    let started = Some(1000);
    // Ours: -D names this folder (pg_ctl passes forward slashes; case differs).
    assert_eq!(classify_holder(&facts(Some(&["postgres", "-D", &fwd, "-p", "41000"])), started, &data), Holder::Ours);
    // B1: the same binary running ANOTHER cluster.
    let d_other = other.display().to_string();
    assert!(matches!(classify_holder(&facts(Some(&["postgres", "-D", &d_other])), started, &data), Holder::Foreign(r) if r.contains("another data folder")));
    // B1: one of a cluster's own children (backends carry --forkchild, no -D).
    assert!(matches!(classify_holder(&facts(Some(&["postgres", "--forkchild=backend", "123"])), started, &data), Holder::Foreign(r) if r.contains("child")));
    // A reused pid is foreign even if its -D matches.
    let reused = HolderFacts { created_unix: Some(5000), ..facts(Some(&["postgres", "-D", &fwd])) };
    assert!(matches!(classify_holder(&reused, started, &data), Holder::Foreign(r) if r.contains("reused")));
    // Not running at all.
    assert!(matches!(classify_holder(&HolderFacts::default(), started, &data), Holder::Foreign(_)));
    // Nothing provable: never ours, never removed.
    for (f, why) in [
        (facts(None), "command line"),
        (facts(Some(&["postgres", "-p", "5"])), "no -D"),
        (facts(Some(&["postgres", "-D", r"E:\no such folder\data"])), "cannot compare"),
        (HolderFacts { image_is_ours: None, ..facts(Some(&["postgres", "-D", &fwd])) }, "image"),
        (HolderFacts { image_is_ours: Some(false), ..facts(Some(&["postgres", "-D", &fwd])) }, "not our postgres.exe"),
    ] {
        assert!(matches!(classify_holder(&f, started, &data), Holder::Unidentified(ref r) if r.contains(why)), "{why}: {:?}", classify_holder(&f, started, &data));
    }
    std::fs::remove_dir_all(&data).unwrap();
    std::fs::remove_dir_all(&other).unwrap();
}

#[test]
fn a_live_process_command_line_is_read_back() {
    let bin = fake_bin();
    let data = tmp("argv");
    let d = data.display().to_string();
    let fake = spawn(&bin, &["-D", &d, "-p", "41999"]);
    let h = win::ProcessHandle::open(fake.pid()).unwrap();
    let argv = h.argv().expect("the command line must be readable for our own child");
    assert_eq!(&argv[1..], &s(&["/d", "/q", "/k", "rem", "-D", &d, "-p", "41999"])[..], "{argv:?}");
    assert!(h.creation_time().is_some());
    drop(fake);
    std::fs::remove_dir_all(&data).unwrap();
    std::fs::remove_dir_all(&bin.dir).unwrap();
}

/// The reviewer's repro, without a database: a lock naming a LIVE postgres.exe
/// of the same bin that serves ANOTHER data folder.
#[test]
fn a_same_binary_postmaster_for_another_folder_is_never_ours() {
    let bin = fake_bin();
    let data = tmp("mine");
    let theirs = tmp("theirs");
    let now = orgtree_pg_custodian::now_unix();
    let foreign = spawn(&bin, &["-D", &theirs.display().to_string()]);
    // (1) The reviewer's shape: the lock predates the holder by an hour.
    write_lock(&data, foreign.pid(), now - 3600, 41001, "ready");
    assert!(matches!(holder(&data, &bin, foreign.pid(), None).unwrap(), Holder::Foreign(_)));
    // (2) The creation-time rule cannot fire (the lock claims a later start):
    // the -D check alone must still refuse.
    write_lock(&data, foreign.pid(), now + 60, 41001, "ready");
    assert!(matches!(holder(&data, &bin, foreign.pid(), None).unwrap(), Holder::Foreign(r) if r.contains("another data folder")));
    // (3) A child of some cluster.
    let child = spawn(&bin, &["--forkchild=backend", "7"]);
    write_lock(&data, child.pid(), now + 60, 41001, "ready");
    assert!(matches!(holder(&data, &bin, child.pid(), None).unwrap(), Holder::Foreign(r) if r.contains("child")));
    // Positive control: the same stand-in started for THIS folder is ours,
    // so the refusals above are not a check that refuses everything.
    let mine = spawn(&bin, &["-D", &data.display().to_string().replace('\\', "/")]);
    write_lock(&data, mine.pid(), now + 60, 41001, "ready");
    assert_eq!(holder(&data, &bin, mine.pid(), None).unwrap(), Holder::Ours);
    // ...and the foreign one is still alive: nothing here signals anything.
    assert!(win::ProcessHandle::open(foreign.pid()).map(|h| !h.wait_exit(0)).unwrap_or(false));
    drop((foreign, child, mine));
    std::fs::remove_dir_all(&data).unwrap();
    std::fs::remove_dir_all(&theirs).unwrap();
    std::fs::remove_dir_all(&bin.dir).unwrap();
}

/// Review N1: one case per conjunct of the wait's acceptance, each with only
/// that condition false, beside a positive control where all hold.
#[test]
fn each_condition_of_the_new_postmaster_wait_is_required() {
    let bin = fake_bin();
    let data = tmp("wait");
    let other = tmp("wait-other");
    let port = 55001;
    let launched = orgtree_pg_custodian::now_unix().saturating_sub(5);
    let t = Duration::from_millis(400);
    let mine = spawn(&bin, &["-D", &data.display().to_string()]);
    let theirs = spawn(&bin, &["-D", &other.display().to_string()]);

    write_lock(&data, mine.pid(), launched, port, "ready");
    assert_eq!(wait_for_new_postmaster(&data, &bin, port, launched, t).unwrap(), (mine.pid(), Some(port)), "positive control");

    let refuse = |why: &str, pid: u32, port_in_lock: u16, status: &str, launched_at: u64, b: &PgBin| {
        write_lock(&data, pid, launched, port_in_lock, status);
        let e = wait_for_new_postmaster(&data, b, port, launched_at, t).unwrap_err();
        assert_eq!(e.code, "start.port_mismatch", "{why}");
        e.message
    };
    let m = refuse("port", mine.pid(), port + 1, "ready", launched, &bin);
    assert!(m.contains(&format!("port Some({})", port + 1)), "{m}");
    let m = refuse("status", mine.pid(), port, "starting", launched, &bin);
    assert!(m.contains("status Some(\"starting\")") && m.contains("fresh true") && m.contains("ours true"), "{m}");
    let m = refuse("fresh", mine.pid(), port, "ready", launched + 3600, &bin);
    assert!(m.contains("fresh false") && m.contains("ours true") && m.contains("our_dir true"), "{m}");
    let not_our_bin = PgBin { dir: std::env::temp_dir(), version: "18.6".into() };
    let m = refuse("ours", mine.pid(), port, "ready", launched, &not_our_bin);
    assert!(m.contains("fresh true") && m.contains("ours false") && m.contains("our_dir true"), "{m}");
    let m = refuse("our_dir", theirs.pid(), port, "ready", launched, &bin);
    assert!(m.contains("fresh true") && m.contains("ours true") && m.contains("our_dir false"), "{m}");

    drop((mine, theirs));
    let _ = cluster::read_pid_file(&data);
    std::fs::remove_dir_all(&data).unwrap();
    std::fs::remove_dir_all(&other).unwrap();
    std::fs::remove_dir_all(&bin.dir).unwrap();
}
