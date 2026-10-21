//! The postmaster never holds administrator rights, whatever the engine
//! holds. postgres.exe refuses them ("Execution of PostgreSQL by a user with
//! administrative permissions is not permitted"): the engine "Run this
//! session as admin" started on the user's PC died there (alpha.29,
//! 2026-10-21 22:47Z). Its token is read from outside, as PostgreSQL's own
//! test reads it. Ignored by default: it creates and starts a scratch cluster
//! from ORGTREE_PG_RIGHTS_TEST_BIN under ORGTREE_PG_RIGHTS_TEST_ROOT.

use super::*;
use crate::winproc::token_probe as probe;

const ADMINISTRATORS: &str = "S-1-5-32-544";
const POWER_USERS: &str = "S-1-5-32-547";

#[tokio::test]
#[ignore = "requires ORGTREE_PG_RIGHTS_TEST_BIN (PostgreSQL's bin folder) and ORGTREE_PG_RIGHTS_TEST_ROOT (a scratch folder)"]
async fn the_postmaster_runs_without_administrator_rights() {
    let bin = PathBuf::from(std::env::var("ORGTREE_PG_RIGHTS_TEST_BIN").expect("PostgreSQL's bin folder"));
    let scratch = PathBuf::from(std::env::var("ORGTREE_PG_RIGHTS_TEST_ROOT").expect("a scratch folder"));
    // a space, as in "Orgtree v2": the data folder reaches postgres quoted
    let root = scratch.join(format!("pg rights {}", crate::util::random_hex(4)));
    std::fs::create_dir_all(&root).unwrap();
    let cfg = Config {
        data_root: root.clone(),
        data_root_id: root.to_string_lossy().to_string(),
        desktop_token: String::new(),
        ui_dir: None,
        parent_pid: None,
        pg_bin: Some(bin),
        exe_dir: PathBuf::new(),
        pg_bootstrap: true,
        standalone: false,
        bind: std::net::IpAddr::from([127, 0, 0, 1]),
        port: None,
        standalone_generated_token: false,
    };
    let mut cluster = Cluster::start(&cfg, &|_: &str| {}).await.expect("the scratch cluster starts");
    let pid = cluster.child.as_ref().and_then(|c| c.id()).expect("the postmaster's pid");
    let listed = std::fs::read_to_string(cluster.data_dir.join("postmaster.pid")).unwrap_or_default();
    let attach: serde_json::Value =
        serde_json::from_slice(&std::fs::read(cluster.cluster_dir.join("pg-attach.json")).unwrap_or_default()).unwrap_or_default();

    // read everything while it runs, stop it, then judge
    let me_process = probe::process(std::process::id());
    let me = probe::token(&me_process);
    let postmaster = probe::process(pid);
    let token = probe::token(&postmaster);
    let groups = probe::groups(&token);
    let privileges = probe::privileges(&token);
    let integrity = probe::integrity(&token);
    let (user, my_user) = (probe::user(&token), probe::user(&me));
    let (session, my_session) = (probe::session(&token), probe::session(&me));
    let dacl = probe::default_dacl(&token);
    let usable = [ADMINISTRATORS, POWER_USERS].map(|sid| probe::member(&token, sid));
    let jobs = (probe::in_job(&me_process), probe::in_job(&postmaster));
    let parent = (probe::integrity(&me), probe::member(&me, ADMINISTRATORS), probe::privileges(&me));
    drop((token, postmaster));
    cluster.stop().await;
    let log = std::fs::read_to_string(cluster.cluster_dir.join("log").join("postgres.log")).unwrap_or_default();
    let gone = !winproc::process_alive(pid);
    println!(
        "test parent: integrity {:#x}, Administrators enabled {}, privileges {:?}\npostmaster {pid}: integrity {integrity:#x}, privileges {privileges:?}, \
         session {session}, Administrators/Power Users usable {usable:?}, default DACL {dacl:?}, in a job {} (parent {})",
        parent.0, parent.1, parent.2, jobs.1, jobs.0
    );

    let mut failures: Vec<String> = Vec::new();
    let mut check = |ok: bool, what: String| {
        if !ok {
            failures.push(what);
        }
    };
    for (sid, name) in [(ADMINISTRATORS, "Administrators"), (POWER_USERS, "Power Users")] {
        if let Some((_, bits)) = groups.iter().find(|(s, _)| s == sid) {
            check(
                bits & probe::SE_GROUP_USE_FOR_DENY_ONLY != 0 && bits & probe::SE_GROUP_ENABLED == 0,
                format!("{name} is not deny-only in the postmaster's token (attributes {bits:#x})"),
            );
        }
    }
    check(usable == [false, false], format!("PostgreSQL's own test would refuse the postmaster's token: {usable:?}"));
    check(
        privileges.iter().all(|p| p == "SeChangeNotifyPrivilege"),
        format!("the postmaster keeps privileges beyond SeChangeNotify: {privileges:?}"),
    );
    check(integrity <= probe::MEDIUM_RID, format!("the postmaster runs above Medium integrity: {integrity:#x}"));
    check(user == my_user, format!("the postmaster runs as {user}, not the engine's user {my_user}"));
    check(session == my_session, format!("the postmaster runs in session {session}, not the engine's {my_session}"));
    check(dacl.contains(&my_user), format!("the postmaster's default DACL does not grant the user: {dacl:?}"));
    check(!jobs.0 || jobs.1, "the postmaster left the engine's job".to_string());
    check(
        listed.lines().next().map(str::trim) == Some(pid.to_string().as_str()),
        format!("postmaster.pid names {:?}, not the child {pid}", listed.lines().next()),
    );
    check(attach["postmaster_pid"] == serde_json::json!(pid), format!("pg-attach.json records {}", attach["postmaster_pid"]));
    check(log.contains("database system is ready to accept connections"), "postgres's stderr did not reach postgres.log".to_string());
    check(log.contains("database system is shut down"), "postgres.log has no clean shutdown".to_string());
    check(gone, format!("the postmaster {pid} outlived stop()"));
    assert!(failures.is_empty(), "{failures:#?}");
    std::fs::remove_dir_all(&root).ok();
}
