//! `win::run_restricted`: the launcher the bootstrap `postgres --single` runs
//! under so an Orgtree started as administrator can still create its cluster
//! (the user's first v3 launch, 2026-09-29). No database; cmd.exe and the
//! Windows tools stand in for postgres.
#![cfg(windows)]

use orgtree_pg_custodian::win;
use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pgc-restricted-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn system32(exe: &str) -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32").join(exe)
}

fn env() -> Vec<(OsString, OsString)> {
    std::env::vars_os().collect()
}

fn run(exe: &str, args: &[&str], env: &[(OsString, OsString)], stdin: &[u8], tag: &str) -> (u32, String) {
    let log = scratch(tag).join("out.log");
    let args: Vec<&OsStr> = args.iter().map(OsStr::new).collect();
    let code = win::run_restricted(&system32(exe), &args, env, stdin, &log).expect("run_restricted");
    (code, String::from_utf8_lossy(&std::fs::read(&log).unwrap()).into_owned())
}

#[test]
fn the_child_holds_no_privilege_but_change_notify() {
    // A normal (non-elevated) token still has several privileges, such as
    // SeShutdownPrivilege; DISABLE_MAX_PRIVILEGE leaves only SeChangeNotify.
    let (code, out) = run("whoami.exe", &["/priv", "/fo", "csv", "/nh"], &env(), b"", "priv");
    assert_eq!(code, 0, "{out}");
    let privs: Vec<&str> = out.lines().filter(|l| !l.trim().is_empty()).collect();
    assert_eq!(privs.len(), 1, "{out}");
    assert!(privs[0].contains("SeChangeNotifyPrivilege"), "{out}");
}

#[test]
fn administrators_is_deny_only_in_the_child() {
    let (code, out) = run("whoami.exe", &["/groups", "/fo", "csv", "/nh"], &env(), b"", "groups");
    assert_eq!(code, 0, "{out}");
    for line in out.lines().filter(|l| l.contains("S-1-5-32-544") || l.contains("S-1-5-32-547")) {
        assert!(line.contains("Group used for deny only"), "{line}");
    }
}

#[test]
fn stdin_reaches_the_child_and_output_reaches_the_log() {
    let (code, out) = run("sort.exe", &[], &env(), b"zeta\r\nalpha\r\n", "stdin");
    assert_eq!(code, 0, "{out}");
    assert_eq!(out.split_whitespace().collect::<Vec<_>>(), ["alpha", "zeta"]);
}

#[test]
fn the_child_gets_exactly_the_given_environment_and_its_exit_code_returns() {
    let mut e = env();
    e.retain(|(k, _)| !k.eq_ignore_ascii_case("P03_RESTRICTED_PROBE"));
    e.push(("P03_RESTRICTED_PROBE".into(), "given value".into()));
    let (code, out) = run("cmd.exe", &["/d", "/c", "echo [%P03_RESTRICTED_PROBE%] & exit /b 7"], &e, b"", "env");
    assert_eq!(code, 7, "{out}");
    assert!(out.contains("[given value]"), "{out}");
    let (_, out) = run("cmd.exe", &["/d", "/c", "echo [%P03_RESTRICTED_PROBE%]"], &env(), b"", "env2");
    assert!(out.contains("[%P03_RESTRICTED_PROBE%]"), "an unset variable must stay unset: {out}");
}

#[link(name = "shell32")]
extern "system" {
    fn CommandLineToArgvW(cmd: *const u16, argc: *mut i32) -> *mut *mut u16;
}

#[test]
fn the_command_line_splits_back_into_the_same_arguments() {
    let exe = PathBuf::from(r"C:\Program Files\Orgtree\resources\engine\postgresql\bin\postgres.exe");
    let args = [
        "--single",
        r"C:\Users\x\AppData\Roaming\Orgtree v2\data\pg\staging-1\data",
        "",
        r#"say "hi""#,
        r"trailing\",
        r"two\\",
        r"C:\a folder with spaces\",
        r"spaced two\\",
        r#"a\"b"#,
        "tab\there",
    ];
    let os: Vec<&OsStr> = args.iter().map(OsStr::new).collect();
    let mut line = win::command_line(&exe, &os);
    line.push(0);
    let mut argc = 0i32;
    let argv = unsafe { CommandLineToArgvW(line.as_ptr(), &mut argc) };
    assert!(!argv.is_null());
    let got: Vec<String> = (0..argc as usize)
        .map(|i| {
            let p = unsafe { *argv.add(i) };
            let n = (0..).take_while(|&j| unsafe { *p.add(j) } != 0).count();
            String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(p, n) })
        })
        .collect();
    let mut want = vec![exe.to_string_lossy().into_owned()];
    want.extend(args.iter().map(|s| s.to_string()));
    assert_eq!(got, want);
}

#[test]
fn postgres_refusing_an_administrator_is_recognised() {
    // bootstrap.log from the user's failed first launch, verbatim.
    let log = "Execution of PostgreSQL by a user with administrative permissions is not\r\npermitted.\r\n\
               The server must be started under an unprivileged user ID to prevent\r\n";
    assert!(win::refused_as_admin(log));
    assert!(!win::refused_as_admin("FATAL:  database \"postgres\" does not exist"));
}
