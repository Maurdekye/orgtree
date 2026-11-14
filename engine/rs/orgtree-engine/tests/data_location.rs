//! Black-box integration tests for `data-location.json` resolution and
//! crash-resumable post-move PostgreSQL + Claude profile relocation.
//!
//! These tests compile against the pre-feature engine baseline (`bc99c6d`) with
//! zero edits to `src/` and run against an isolated scratch PostgreSQL cluster
//! created per test run (never touching any live data folder or live database).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

static COUNTER: AtomicU64 = AtomicU64::new(1);

fn exe_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

fn strip_verbatim_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p.to_path_buf(),
    }
}

fn strip_plain(raw: &str) -> String {
    let trimmed = raw.trim();
    let plain = trimmed.strip_prefix(r"\\?\").unwrap_or(trimmed);
    plain.trim_end_matches(['\\', '/']).to_string()
}

fn encode_claude_dir(path_str: &str) -> String {
    path_str
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn owned_scratch_dir(label: &str) -> PathBuf {
    let base = std::fs::canonicalize(std::env::temp_dir()).unwrap_or_else(|_| std::env::temp_dir());
    let base = strip_verbatim_path(&base);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = base.join(format!(
        "orgtree-dataloc-it-{label}-{}-{stamp:x}-{seq}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create isolated scratch dir");
    dir
}

fn find_bundled_pg_bin() -> PathBuf {
    for var in ["ORGTREE_P03_PG_BIN", "ORGTREE_DATA_RELOCATE_PG_BIN"] {
        if let Ok(val) = std::env::var(var) {
            let p = PathBuf::from(val.trim());
            if p.join(exe_name("postgres")).is_file() {
                return p;
            }
        }
    }
    let engine_exe = PathBuf::from(env!("CARGO_BIN_EXE_orgtree-engine"));
    if let Some(dir) = engine_exe.parent() {
        let candidate = dir.join("postgresql").join("bin");
        if candidate.join(exe_name("postgres")).is_file() {
            return candidate;
        }
    }
    for root in [r"S:\orgtree\build", r"C:\orgtree-build"] {
        let Ok(agents) = std::fs::read_dir(root) else {
            continue;
        };
        for agent_entry in agents.flatten() {
            let Ok(jobs) = std::fs::read_dir(agent_entry.path()) else {
                continue;
            };
            for job_entry in jobs.flatten() {
                let candidate = job_entry
                    .path()
                    .join("package")
                    .join("win-unpacked")
                    .join("resources")
                    .join("engine")
                    .join("postgresql")
                    .join("bin");
                if candidate.join(exe_name("postgres")).is_file() {
                    return candidate;
                }
            }
        }
    }
    panic!(
        "Bundled PostgreSQL binaries not found; set ORGTREE_P03_PG_BIN to postgresql/bin so the real-PG relocation kill test can run"
    );
}

fn ensure_scratch_postmaster_stopped(pg_bin: &Path, data_root: &Path) {
    let data_dir = data_root.join("pg").join("cluster").join("data");
    let pid_file = data_dir.join("postmaster.pid");
    if !pid_file.exists() {
        return;
    }
    let deadline = Instant::now() + Duration::from_millis(1500);
    while Instant::now() < deadline {
        if !pid_file.exists() {
            return;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    let pg_ctl = pg_bin.join(exe_name("pg_ctl"));
    if pg_ctl.is_file() && data_dir.join("PG_VERSION").is_file() {
        let _ = Command::new(pg_ctl)
            .arg("stop")
            .arg("-D")
            .arg(&data_dir)
            .args(["-m", "immediate", "-w", "-t", "10"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn http_request(port: u16, method: &str, path: &str, token: &str) -> (u16, String) {
    let mut stream =
        TcpStream::connect(("127.0.0.1", port)).expect("connect to scratch test engine HTTP port");
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .expect("set read timeout");
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nx-orgtree-desktop-token: {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).expect("write HTTP request");
    let mut resp = String::new();
    let _ = stream.read_to_string(&mut resp);
    let status = resp
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);
    let body = resp
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_string())
        .unwrap_or_default();
    (status, body)
}

async fn connect_live_scratch_pg(data_root: &Path) -> tokio_postgres::Client {
    let cluster_dir = data_root.join("pg").join("cluster");
    let creds_raw = std::fs::read_to_string(cluster_dir.join("secrets").join("credentials.json"))
        .expect("read scratch credentials.json");
    let creds: Value = serde_json::from_str(&creds_raw).expect("parse credentials.json");
    let admin_pw = creds["orgtree_admin"]
        .as_str()
        .expect("orgtree_admin password in credentials.json");

    let port: u16 = std::fs::read_to_string(cluster_dir.join("pg-attach.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["port"].as_u64())
        .map(|p| p as u16)
        .or_else(|| {
            let pid_text =
                std::fs::read_to_string(cluster_dir.join("data").join("postmaster.pid")).ok()?;
            pid_text.lines().nth(3)?.trim().parse::<u16>().ok()
        })
        .expect("discover live scratch PostgreSQL port");

    let mut cfg = tokio_postgres::Config::new();
    cfg.host("127.0.0.1")
        .port(port)
        .user("orgtree_admin")
        .password(admin_pw)
        .dbname("orgtree_engine")
        .connect_timeout(Duration::from_secs(10));
    let (client, conn) = cfg
        .connect(tokio_postgres::NoTls)
        .await
        .expect("connect to live scratch PostgreSQL");
    tokio::spawn(async move {
        let _ = conn.await;
    });
    client
}

struct HostProbeResult {
    code: i32,
    stderr: String,
}

fn run_host_probe(
    scratch: &Path,
    appdata: &Path,
    env_override: Option<&Path>,
) -> HostProbeResult {
    let empty_ui = scratch.join("empty-ui-dir");
    let fake_home = scratch.join("host-fake-home");
    std::fs::create_dir_all(&empty_ui).unwrap();
    std::fs::create_dir_all(&fake_home).unwrap();

    let mut cmd = Command::new(env!("CARGO_BIN_EXE_orgtree-engine"));
    cmd.arg("host")
        .env("ORGTREE_V2_UI_DIR", &empty_ui)
        .env("APPDATA", appdata)
        .env("LOCALAPPDATA", fake_home.join("Local"))
        .env("USERPROFILE", &fake_home)
        .env("HOME", &fake_home)
        .env("XDG_CONFIG_HOME", appdata)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match env_override {
        Some(p) => {
            cmd.env("ORGTREE_V2_DATA", p);
        }
        None => {
            cmd.env_remove("ORGTREE_V2_DATA");
        }
    }
    let out = cmd.output().expect("spawn orgtree-engine host probe");
    HostProbeResult {
        code: out.status.code().unwrap_or(-1),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
    }
}

#[cfg(windows)]
#[test]
fn host_data_root_honors_data_location_json_env_override_and_active_move_guard() {
    let scratch = owned_scratch_dir("host-root");
    let appdata = scratch.join("Roaming");
    let user_data = appdata.join("Orgtree v2");
    let default_root = user_data.join("data");
    let custom_root = scratch.join("Custom Orgtree Data");
    let env_root = scratch.join("Explicit Env Data");
    std::fs::create_dir_all(&user_data).unwrap();
    std::fs::create_dir_all(&custom_root).unwrap();
    std::fs::create_dir_all(&env_root).unwrap();

    // 1. Default when neither ORGTREE_V2_DATA nor data-location.json is present:
    //    `host` resolves `<APPDATA>\Orgtree v2\data` and logs its UI-dir refusal there.
    let def_res = run_host_probe(&scratch, &appdata, None);
    assert_eq!(def_res.code, 1);
    assert!(
        default_root.join("diagnostics").join("boot-host.log").is_file(),
        "default host run must resolve <userData>/data; stderr={}",
        def_res.stderr
    );

    // 2. Canonicalized verbatim path (`\\?\...`) in `data-location.json` resolves to `custom_root`!
    let custom_verbatim = std::fs::canonicalize(&custom_root).unwrap();
    std::fs::write(
        user_data.join("data-location.json"),
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "dataRoot": custom_verbatim.to_string_lossy(),
            "previousRoot": default_root.to_string_lossy(),
            "movedAt": "2026-11-14T09:00:00Z"
        }))
        .unwrap(),
    )
    .unwrap();
    let cfg_res = run_host_probe(&scratch, &appdata, None);
    assert!(
        custom_root.join("diagnostics").join("boot-host.log").is_file(),
        "host must honor data-location.json dataRoot ({}); stderr={}",
        custom_root.display(),
        cfg_res.stderr
    );

    // 3. `ORGTREE_V2_DATA` overrides `data-location.json`.
    let env_res = run_host_probe(&scratch, &appdata, Some(&env_root));
    assert_eq!(env_res.code, 1);
    assert!(
        env_root.join("diagnostics").join("boot-host.log").is_file(),
        "ORGTREE_V2_DATA must take precedence over data-location.json; stderr={}",
        env_res.stderr
    );

    // 4. Missing custom folder (e.g. unmounted drive) is refused without creating an empty directory!
    let missing_custom = scratch.join("OfflineDrive").join("Orgtree data");
    std::fs::write(
        user_data.join("data-location.json"),
        serde_json::to_vec(&json!({
            "version": 1,
            "dataRoot": missing_custom.to_string_lossy()
        }))
        .unwrap(),
    )
    .unwrap();
    let miss_res = run_host_probe(&scratch, &appdata, None);
    assert_eq!(miss_res.code, 1);
    assert!(
        !missing_custom.exists(),
        "host must never auto-create a missing custom data folder"
    );
    assert!(
        miss_res.stderr.contains("not available"),
        "expected missing custom folder diagnostic, got: {}",
        miss_res.stderr
    );

    // 5. Malformed or path-traversal `data-location.json` entries are rejected.
    for bad in [
        json!({ "version": 99, "dataRoot": custom_root.to_string_lossy() }),
        json!({ "version": 1, "dataRoot": "" }),
        json!({ "version": 1, "dataRoot": "relative/data" }),
        json!({ "version": 1, "dataRoot": format!(r"{}\..\escape", custom_root.display()) }),
    ] {
        std::fs::write(
            user_data.join("data-location.json"),
            serde_json::to_vec(&bad).unwrap(),
        )
        .unwrap();
        let bad_res = run_host_probe(&scratch, &appdata, None);
        assert_eq!(bad_res.code, 1, "malformed config {bad} must fail");
    }

    // Restore valid `data-location.json` pointing to `custom_root`.
    let _ = std::fs::remove_file(custom_root.join("diagnostics").join("boot-host.log"));
    std::fs::write(
        user_data.join("data-location.json"),
        serde_json::to_vec(&json!({
            "version": 1,
            "dataRoot": custom_verbatim.to_string_lossy()
        }))
        .unwrap(),
    )
    .unwrap();

    // 6. Live PID in `.data-move-in-progress.json` makes `host` stand down cleanly (exit 0) without touching `custom_root`.
    std::fs::write(
        user_data.join(".data-move-in-progress.json"),
        serde_json::to_vec(&json!({
            "version": 1,
            "pid": std::process::id()
        }))
        .unwrap(),
    )
    .unwrap();
    let moving_res = run_host_probe(&scratch, &appdata, None);
    assert_eq!(
        moving_res.code, 0,
        "live .data-move-in-progress.json must make boot host wait cleanly; stderr={}",
        moving_res.stderr
    );
    assert!(
        moving_res.stderr.contains("move in progress"),
        "expected move-in-progress message, got: {}",
        moving_res.stderr
    );
    assert!(
        !custom_root.join("diagnostics").join("boot-host.log").exists(),
        "host must not touch custom_root while move is in progress"
    );

    // 7. Stale `.data-move-in-progress.json` (mismatched creation timestamp / dead PID) does NOT wedge `host`.
    std::fs::write(
        user_data.join(".data-move-in-progress.json"),
        serde_json::to_vec(&json!({
            "version": 1,
            "pid": std::process::id(),
            "created": "1"
        }))
        .unwrap(),
    )
    .unwrap();
    let stale_res = run_host_probe(&scratch, &appdata, None);
    assert_eq!(stale_res.code, 1);
    assert!(
        custom_root.join("diagnostics").join("boot-host.log").is_file(),
        "stale .data-move-in-progress.json must be ignored so recovery never wedges"
    );

    let _ = std::fs::remove_dir_all(&scratch);
}

fn spawn_serve_child(
    scratch: &Path,
    data_root: &Path,
    pg_bin: &Path,
    token: &str,
    checkpoint: Option<(&str, &Path)>,
) -> (Child, mpsc::Receiver<String>) {
    let fake_home = scratch.join("serve-fake-home");
    std::fs::create_dir_all(&fake_home).unwrap();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_orgtree-engine"));
    cmd.arg("serve")
        .env("ORGTREE_DATA", data_root)
        .env("ORGTREE_V2_DATA", data_root)
        .env("ORGTREE_P03_PG_BIN", pg_bin)
        .env("ORGTREE_PG_BOOTSTRAP", "1")
        .env("ORGTREE_V2_TOKEN", token)
        .env("ORGTREE_ENGINE_SAFE_START", "1")
        .env("ORGTREE_ENGINE_RIG", "1")
        .env("APPDATA", fake_home.join("Roaming"))
        .env("LOCALAPPDATA", fake_home.join("Local"))
        .env("USERPROFILE", &fake_home)
        .env("HOME", &fake_home)
        .env_remove("ORGTREE_CORE_MODE")
        .env_remove("ORGTREE_V2_PARENT_PID")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    if let Some((stage, sig)) = checkpoint {
        cmd.env("ORGTREE_TEST_RELOCATE_CHECKPOINT", stage)
            .env("ORGTREE_TEST_RELOCATE_SIGNAL_FILE", sig);
    } else {
        cmd.env_remove("ORGTREE_TEST_RELOCATE_CHECKPOINT")
            .env_remove("ORGTREE_TEST_RELOCATE_SIGNAL_FILE");
    }

    let mut child = cmd.spawn().expect("spawn scratch orgtree-engine serve child");
    let stdout = child.stdout.take().expect("child stdout");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    (child, rx)
}

fn parse_ready_port(line: &str) -> Option<u16> {
    let trimmed = line.trim();
    if !trimmed.starts_with('{') {
        return None;
    }
    let val: Value = serde_json::from_str(trimmed).ok()?;
    if val.get("type").and_then(Value::as_str) == Some("ready") {
        val.get("port").and_then(Value::as_u64).map(|p| p as u16)
    } else {
        None
    }
}

async fn wait_for_ready_port(
    child: &mut Child,
    rx: &mpsc::Receiver<String>,
    pg_bin: &Path,
    data_root: &Path,
    scratch: &Path,
    label: &str,
) -> u16 {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        while let Ok(line) = rx.try_recv() {
            if let Some(port) = parse_ready_port(&line) {
                return port;
            }
        }
        if let Ok(Some(exit)) = child.try_wait() {
            ensure_scratch_postmaster_stopped(pg_bin, data_root);
            let _ = std::fs::remove_dir_all(scratch);
            panic!("{label}: engine child exited ({exit}) before emitting ready");
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            ensure_scratch_postmaster_stopped(pg_bin, data_root);
            let _ = std::fs::remove_dir_all(scratch);
            panic!("{label}: timed out waiting for engine child to emit ready");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn real_pg_engine_boot_relocates_all_tables_and_profiles_across_mid_relocation_kills() {
    // Sanity-check that all 16 expected path-bearing tables exist in migrations/*.sql.
    let mig_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut all_sql = String::new();
    for entry in std::fs::read_dir(&mig_dir).expect("read migrations dir").flatten() {
        if entry.path().extension().and_then(|e| e.to_str()) == Some("sql") {
            all_sql.push_str(&std::fs::read_to_string(entry.path()).unwrap());
            all_sql.push('\n');
        }
    }
    for table in [
        "CREATE TABLE ot.orgs",
        "CREATE TABLE ot.agents",
        "CREATE TABLE ot.agent_sessions",
        "CREATE TABLE ot.accounts",
        "CREATE TABLE ot.mail",
        "CREATE TABLE ot.org_inbox",
        "CREATE TABLE ot.net_transfers",
        "CREATE TABLE ot.net_downloads",
        "CREATE TABLE ot.uploads",
        "CREATE TABLE ot.upload_stages",
        "CREATE TABLE ot.deliveries",
        "CREATE TABLE ot.work_attachments",
        "CREATE TABLE ot.work_items",
        "CREATE TABLE ot.watchdogs",
        "CREATE TABLE ot.custom_app_file_grants",
        "CREATE TABLE ot.custom_app_file_refs",
    ] {
        assert!(all_sql.contains(table), "schema missing expected table: {table}");
    }

    let pg_bin = find_bundled_pg_bin();
    let scratch = owned_scratch_dir("pg-reloc");
    let old_dir = scratch.join("Old Orgtree Data");
    let new_dir = scratch.join("Orgtree data");
    std::fs::create_dir_all(old_dir.join("scratch").join("orgtree").join("coord")).unwrap();
    std::fs::create_dir_all(new_dir.join("scratch").join("orgtree").join("coord")).unwrap();
    // Mark `new_dir` as an isolated synthetic rig root so `serve` never reads or
    // writes any host user profile, CLI, or live folder.
    std::fs::write(new_dir.join(".orgtree-rig-root"), "1\n").unwrap();

    let old_verbatim = std::fs::canonicalize(&old_dir).unwrap();
    let new_verbatim = std::fs::canonicalize(&new_dir).unwrap();
    let old_plain = strip_plain(&old_verbatim.to_string_lossy());
    let new_plain = strip_plain(&new_verbatim.to_string_lossy());
    let new_canon = strip_verbatim_path(&new_verbatim);
    let token = "0123456789abcdef0123456789abcdef";

    // 1. Bootstrap a real isolated PostgreSQL cluster inside `new_dir` by starting
    //    `orgtree-engine serve` once, seeding all 16 path-bearing `ot.*` tables
    //    (including `\\?\` verbatim canonical paths, `/`-separated paths, sibling
    //    paths, external paths, URLs, and command watchdogs), and shutting down cleanly.
    let (mut seed_child, seed_rx) = spawn_serve_child(&scratch, &new_canon, &pg_bin, token, None);
    let seed_port = wait_for_ready_port(
        &mut seed_child,
        &seed_rx,
        &pg_bin,
        &new_canon,
        &scratch,
        "bootstrap",
    )
    .await;
    {
        let client = connect_live_scratch_pg(&new_canon).await;

        let org_id: i64 = client
            .query_one(
                "INSERT INTO ot.orgs (uuid, slug, name, settings) VALUES ($1, 'reloc-org', 'Reloc Org', $2) RETURNING id",
                &[
                    &uuid::Uuid::new_v4(),
                    &json!({
                        "dirs": [
                            { "path": format!(r"{}\scratch\reloc-org\_shared", old_verbatim.display()), "mode": "rw" },
                            { "path": r"S:\orgtree", "mode": "rw" }
                        ]
                    }),
                ],
            )
            .await
            .unwrap()
            .get(0);

        let agent_id: i64 = client
            .query_one(
                "INSERT INTO ot.agents (org_id, name, state, tier, born, scratch_dir, scope)
                 VALUES ($1, 'coord', 'archived', 'opus', '2026-11-14', $2, $3) RETURNING id",
                &[
                    &org_id,
                    &format!(r"{old_plain}\scratch\orgtree\coord"),
                    &json!({
                        "add_dirs": [
                            { "path": format!("{}/scratch/orgtree/_teams/601", old_plain.replace('\\', "/")), "mode": "rw" },
                            { "path": format!("{old_plain}-sibling\\untouched"), "mode": "ro" },
                            { "path": r"S:\orgtree", "mode": "rw" }
                        ]
                    }),
                ],
            )
            .await
            .unwrap()
            .get(0);

        client
            .execute(
                "INSERT INTO ot.agent_sessions (agent_id, generation, provider, session_id, transcript_file)
                 VALUES ($1, 1, 'claude', 'sess-1', $2)",
                &[
                    &agent_id,
                    &format!(r"{old_plain}\profiles\claude-primary\projects\x\sess-1.jsonl"),
                ],
            )
            .await
            .unwrap();

        client
            .execute(
                "INSERT INTO ot.accounts (id, provider, kind, config_dir)
                 VALUES ('claude-primary', 'claude', 'managed', $1)",
                &[&format!(r"{old_plain}\profiles\claude-primary")],
            )
            .await
            .unwrap();

        client
            .execute(
                "INSERT INTO ot.mail (uid, org_id, sender, recipient_kind, recipient_name, body, state, attachments)
                 VALUES ('m1', $1, 'coord', 'user', '@user', 'hi', 'delivered', $2)",
                &[
                    &org_id,
                    &json!([
                        { "name": "a.txt", "path": format!(r"{old_plain}\uploads\a.txt") },
                        { "name": "ext.txt", "path": r"D:\keep\ext.txt" }
                    ]),
                ],
            )
            .await
            .unwrap();

        let inbox_id: i64 = client
            .query_one(
                "INSERT INTO ot.org_inbox (uid, org_id, dir, peer, body, state, attachments)
                 VALUES ('oi1', $1, 'out', '@org:peer', 'hello', 'sent', $2) RETURNING id",
                &[
                    &org_id,
                    &json!([{ "name": "b.txt", "path": format!(r"{old_plain}\uploads\b.txt") }]),
                ],
            )
            .await
            .unwrap()
            .get(0);

        client
            .execute(
                "INSERT INTO ot.net_transfers (id, org_id, inbox_id, file_no, hub, address, source, state, total)
                 VALUES ('nt1', $1, $2, 0, 'wss://hub.invalid', '@org:peer', $3, 'complete', 10)",
                &[
                    &org_id,
                    &inbox_id,
                    &json!({ "path": format!(r"{old_plain}\uploads\b.txt") }),
                ],
            )
            .await
            .unwrap();

        client
            .execute(
                "INSERT INTO ot.net_incoming (id, org_id, hub, address, net_id, envelope, state)
                 VALUES ('ni1', $1, 'wss://hub.invalid', '@org:peer', 'net1', '{}'::jsonb, 'complete')",
                &[&org_id],
            )
            .await
            .unwrap();

        client
            .execute(
                "INSERT INTO ot.net_downloads (id, incoming_id, file_no, route, name, path, complete)
                 VALUES ('nd1', 'ni1', 0, '{}'::jsonb, 'dl.bin', $1, true)",
                &[&format!(r"{old_plain}\uploads\dl.bin")],
            )
            .await
            .unwrap();

        client
            .execute(
                "INSERT INTO ot.uploads (id, org_id, name, path, bytes)
                 VALUES ('up1', $1, 'u.txt', $2, 5)",
                &[&org_id, &format!(r"{old_plain}\uploads\u.txt")],
            )
            .await
            .unwrap();

        client
            .execute(
                "INSERT INTO ot.upload_stages (id, org_id, name, path, total, state)
                 VALUES ('us1', $1, 's.txt', $2, 5, 'complete')",
                &[&org_id, &format!(r"{old_plain}\uploads\s.txt")],
            )
            .await
            .unwrap();

        client
            .execute(
                "INSERT INTO ot.deliveries (uid, org_id, agent_id, name, path, bytes)
                 VALUES ('del1', $1, $2, 'out.pdf', $3, 99)",
                &[&org_id, &agent_id, &format!(r"{old_plain}\deliveries\out.pdf")],
            )
            .await
            .unwrap();

        let work_id: i64 = client
            .query_one(
                "INSERT INTO ot.work_items (org_id, slug, title, status, created_by, evidence)
                 VALUES ($1, 'item-1', 'Item 1', 'in_progress', '{}'::jsonb, $2) RETURNING id",
                &[
                    &org_id,
                    &json!([
                        { "kind": "file", "ref": format!(r"{old_plain}\deliveries\proof.png") },
                        { "kind": "log", "ref": format!(r"{old_plain}\diagnostics\logs\run.log") },
                        { "kind": "url", "ref": "https://example.org/doc" }
                    ]),
                ],
            )
            .await
            .unwrap()
            .get(0);

        client
            .execute(
                "INSERT INTO ot.work_attachments (id, work_id, name, bytes, path, by)
                 VALUES ('wa1', $1, 'att.json', 12, $2, '{}'::jsonb)",
                &[&work_id, &format!(r"{old_plain}\uploads\att.json")],
            )
            .await
            .unwrap();

        client
            .execute(
                "INSERT INTO ot.watchdogs (uid, org_id, owner_agent_id, name, kind, target, interval_s, state)
                 VALUES ('wd-file', $1, $2, 'file-dog', 'file', $3, 60, 'spent'),
                        ('wd-cmd', $1, $2, 'cmd-dog', 'command', $4, 60, 'spent')",
                &[
                    &org_id,
                    &agent_id,
                    &format!(r"{old_plain}\scratch\orgtree\sentinel.txt"),
                    &format!(r"{old_plain}\keep-command-literal"),
                ],
            )
            .await
            .unwrap();

        client
            .execute(
                "INSERT INTO ot.custom_apps (org_id, id, name, html, rev, created_by)
                 VALUES ($1, 'app1', 'App 1', '<div>ok</div>', 1, 'coord')",
                &[&org_id],
            )
            .await
            .unwrap();
        client
            .execute(
                "INSERT INTO ot.custom_panels (org_id, id, app_id, label, rev, is_open)
                 VALUES ($1, 'pan1', 'app1', 'Panel 1', 1, false)",
                &[&org_id],
            )
            .await
            .unwrap();
        client
            .execute(
                "INSERT INTO ot.custom_app_file_grants (org_id, app_id, id, app_rev, scope, path)
                 VALUES ($1, 'app1', 'g1', 1, 'file', $2)",
                &[&org_id, &format!(r"{old_plain}\uploads\granted.csv")],
            )
            .await
            .unwrap();
        client
            .execute(
                "INSERT INTO ot.custom_app_file_refs (org_id, app_id, panel_id, id, app_rev, grant_id, path)
                 VALUES ($1, 'app1', 'pan1', 'r1', 1, 'g1', $2)",
                &[&org_id, &format!(r"{old_plain}\uploads\granted.csv")],
            )
            .await
            .unwrap();
    }
    let (seed_stop, _) = http_request(seed_port, "POST", "/api/desktop/shutdown", token);
    assert_eq!(seed_stop, 200, "shutdown bootstrap engine");
    let seed_exit = seed_child.wait().expect("wait bootstrap engine exit");
    assert!(seed_exit.success(), "bootstrap engine exited with {seed_exit}");
    ensure_scratch_postmaster_stopped(&pg_bin, &new_canon);

    // 2. Seed managed Claude profile files + external sibling + `.data-location-moved.json`.
    let profile = new_dir.join("profiles").join("claude-primary");
    let old_cwd = format!(r"{old_plain}\scratch\orgtree\coord");
    let old_enc = encode_claude_dir(&old_cwd);
    let ext_cwd = format!(r"{old_plain}-sibling\repo");
    let ext_enc = encode_claude_dir(&ext_cwd);
    std::fs::create_dir_all(profile.join("projects").join(&old_enc).join("memory")).unwrap();
    std::fs::create_dir_all(profile.join("projects").join(&ext_enc)).unwrap();
    std::fs::write(
        profile.join("projects").join(&old_enc).join("s1.jsonl"),
        "{\"turn\":1}\n",
    )
    .unwrap();
    std::fs::write(
        profile.join("projects").join(&old_enc).join("s2.jsonl"),
        "{\"turn\":2}\n",
    )
    .unwrap();
    std::fs::write(
        profile
            .join("projects")
            .join(&old_enc)
            .join("memory")
            .join("MEMORY.md"),
        "# Remembered\n",
    )
    .unwrap();
    std::fs::write(
        profile.join("projects").join(&ext_enc).join("ext.jsonl"),
        "{\"ext\":true}\n",
    )
    .unwrap();
    std::fs::write(
        profile.join(".claude.json"),
        serde_json::to_vec_pretty(&json!({
            "projects": {
                old_cwd.clone(): { "allowedTools": ["Read"] },
                ext_cwd.clone(): { "allowedTools": ["Bash"] }
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let moved_marker = new_dir.join(".data-location-moved.json");
    std::fs::write(
        &moved_marker,
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "fromRoot": old_verbatim.to_string_lossy(),
            "fromRootVariants": [old_plain.clone(), old_verbatim.to_string_lossy()],
            "toRoot": new_verbatim.to_string_lossy(),
            "movedAt": "2026-11-14T09:15:00Z"
        }))
        .unwrap(),
    )
    .unwrap();

    // 3. Spawn real `orgtree-engine serve` children and hard-kill (`Child::kill()`) at
    //    each crash boundary:
    //      - `mid-sql-before-commit`: uncommitted SQL tx rolls back cleanly;
    //      - `after-sql-before-profiles`: SQL already committed, profiles still unmoved;
    //      - `mid-profiles`: partial Claude project dir merge interrupted mid-copy.
    for stage in [
        "mid-sql-before-commit",
        "after-sql-before-profiles",
        "mid-profiles",
    ] {
        let sig = scratch.join(format!("checkpoint-{stage}.sig"));
        let (mut child, rx) =
            spawn_serve_child(&scratch, &new_canon, &pg_bin, token, Some((stage, &sig)));
        let deadline = Instant::now() + Duration::from_secs(60);
        let mut premature_ready_port: Option<u16> = None;
        while !sig.exists() {
            while let Ok(line) = rx.try_recv() {
                if let Some(port) = parse_ready_port(&line) {
                    premature_ready_port = Some(port);
                    break;
                }
            }
            if premature_ready_port.is_some() {
                break;
            }
            if let Ok(Some(exit)) = child.try_wait() {
                ensure_scratch_postmaster_stopped(&pg_bin, &new_canon);
                let _ = std::fs::remove_dir_all(&scratch);
                panic!("engine child exited early ({exit}) before reaching relocation checkpoint {stage}");
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                ensure_scratch_postmaster_stopped(&pg_bin, &new_canon);
                let _ = std::fs::remove_dir_all(&scratch);
                panic!("timed out waiting for relocation checkpoint {stage}");
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }

        if let Some(port) = premature_ready_port {
            // Baseline (RED) behavior: engine booted right past `.data-location-moved.json`
            // without running relocation! Shut down cleanly and fail with the product reason.
            let _ = http_request(port, "POST", "/api/desktop/shutdown", token);
            let _ = child.wait();
            ensure_scratch_postmaster_stopped(&pg_bin, &new_canon);
            let marker_left = moved_marker.exists();
            let _ = std::fs::remove_dir_all(&scratch);
            panic!(
                "engine reached ready without running {stage} relocation (`.data-location-moved.json` left unconsumed = {marker_left})"
            );
        }

        // Kill owned child mid-relocation (`Child::kill()`) and reap!
        child
            .kill()
            .expect("kill owned engine child mid-relocation");
        let _ = child.wait().expect("reap killed engine child");
        ensure_scratch_postmaster_stopped(&pg_bin, &new_canon);

        assert!(
            moved_marker.exists(),
            ".data-location-moved.json must remain on disk when engine is killed at {stage}"
        );
    }

    // 4. Final clean boot (`orgtree-engine serve`, no checkpoint): must resume idempotently,
    //    finish relocating DB + Claude profiles, write audit receipt, remove
    //    `.data-location-moved.json`, and serve `/api/desktop/identity`.
    let (mut clean_child, rx) = spawn_serve_child(&scratch, &new_canon, &pg_bin, token, None);
    let port = wait_for_ready_port(
        &mut clean_child,
        &rx,
        &pg_bin,
        &new_canon,
        &scratch,
        "clean-resume",
    )
    .await;

    let (status, ident_body) = http_request(port, "GET", "/api/desktop/identity", token);
    assert_eq!(status, 200, "GET /api/desktop/identity must succeed");
    let ident_json: Value = serde_json::from_str(&ident_body).expect("parse identity JSON");
    assert_eq!(
        ident_json["dataRootId"].as_str(),
        Some(new_canon.to_string_lossy().as_ref())
    );

    // 5. While the resumed engine's scratch PostgreSQL cluster is live, verify all 16 tables!
    {
        let client = connect_live_scratch_pg(&new_canon).await;

        let org_settings: Value = client
            .query_one("SELECT settings FROM ot.orgs WHERE slug = 'reloc-org'", &[])
            .await
            .unwrap()
            .get(0);
        let org_dir0 = org_settings["dirs"][0]["path"].as_str().unwrap();
        assert_eq!(
            strip_plain(org_dir0),
            format!(r"{new_plain}\scratch\reloc-org\_shared")
        );
        assert_eq!(org_settings["dirs"][1]["path"], r"S:\orgtree");

        let agent_row = client
            .query_one(
                "SELECT scratch_dir, scope FROM ot.agents WHERE name = 'coord'",
                &[],
            )
            .await
            .unwrap();
        let scratch_dir: String = agent_row.get(0);
        let scope: Value = agent_row.get(1);
        assert_eq!(scratch_dir, format!(r"{new_plain}\scratch\orgtree\coord"));
        assert_eq!(
            scope["add_dirs"][0]["path"],
            format!("{}/scratch/orgtree/_teams/601", new_plain.replace('\\', "/"))
        );
        assert_eq!(
            scope["add_dirs"][1]["path"],
            format!("{old_plain}-sibling\\untouched")
        );
        assert_eq!(scope["add_dirs"][2]["path"], r"S:\orgtree");

        let sess_tf: String = client
            .query_one(
                "SELECT transcript_file FROM ot.agent_sessions WHERE session_id = 'sess-1'",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(
            sess_tf,
            format!(r"{new_plain}\profiles\claude-primary\projects\x\sess-1.jsonl")
        );

        let acct_dir: String = client
            .query_one(
                "SELECT config_dir FROM ot.accounts WHERE id = 'claude-primary'",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(acct_dir, format!(r"{new_plain}\profiles\claude-primary"));

        let mail_att: Value = client
            .query_one("SELECT attachments FROM ot.mail WHERE uid = 'm1'", &[])
            .await
            .unwrap()
            .get(0);
        assert_eq!(mail_att[0]["path"], format!(r"{new_plain}\uploads\a.txt"));
        assert_eq!(mail_att[1]["path"], r"D:\keep\ext.txt");

        let inbox_att: Value = client
            .query_one(
                "SELECT attachments FROM ot.org_inbox WHERE uid = 'oi1'",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(inbox_att[0]["path"], format!(r"{new_plain}\uploads\b.txt"));

        let nt_src: Value = client
            .query_one(
                "SELECT source FROM ot.net_transfers WHERE id = 'nt1'",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(nt_src["path"], format!(r"{new_plain}\uploads\b.txt"));

        for (sql, expected) in [
            (
                "SELECT path FROM ot.net_downloads WHERE id = 'nd1'",
                format!(r"{new_plain}\uploads\dl.bin"),
            ),
            (
                "SELECT path FROM ot.uploads WHERE id = 'up1'",
                format!(r"{new_plain}\uploads\u.txt"),
            ),
            (
                "SELECT path FROM ot.upload_stages WHERE id = 'us1'",
                format!(r"{new_plain}\uploads\s.txt"),
            ),
            (
                "SELECT path FROM ot.deliveries WHERE uid = 'del1'",
                format!(r"{new_plain}\deliveries\out.pdf"),
            ),
            (
                "SELECT path FROM ot.work_attachments WHERE id = 'wa1'",
                format!(r"{new_plain}\uploads\att.json"),
            ),
            (
                "SELECT target FROM ot.watchdogs WHERE uid = 'wd-file'",
                format!(r"{new_plain}\scratch\orgtree\sentinel.txt"),
            ),
            (
                "SELECT target FROM ot.watchdogs WHERE uid = 'wd-cmd'",
                format!(r"{old_plain}\keep-command-literal"),
            ),
            (
                "SELECT path FROM ot.custom_app_file_grants WHERE id = 'g1'",
                format!(r"{new_plain}\uploads\granted.csv"),
            ),
            (
                "SELECT path FROM ot.custom_app_file_refs WHERE id = 'r1'",
                format!(r"{new_plain}\uploads\granted.csv"),
            ),
        ] {
            let actual: String = client.query_one(sql, &[]).await.unwrap().get(0);
            assert_eq!(actual, expected, "unexpected column after relocation for query: {sql}");
        }

        let work_ev: Value = client
            .query_one(
                "SELECT evidence FROM ot.work_items WHERE slug = 'item-1'",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(
            work_ev[0]["ref"],
            format!(r"{new_plain}\deliveries\proof.png")
        );
        assert_eq!(
            work_ev[1]["ref"],
            format!(r"{new_plain}\diagnostics\logs\run.log")
        );
        assert_eq!(work_ev[2]["ref"], "https://example.org/doc");
    }

    let (stop_status, _) = http_request(port, "POST", "/api/desktop/shutdown", token);
    assert_eq!(stop_status, 200, "POST /api/desktop/shutdown must succeed");
    let exit_status = clean_child.wait().expect("wait for clean engine shutdown");
    assert!(
        exit_status.success(),
        "clean engine must exit 0 after /api/desktop/shutdown, got {exit_status}"
    );
    ensure_scratch_postmaster_stopped(&pg_bin, &new_canon);

    // 6. Verify filesystem relocation artifacts!
    assert!(
        !moved_marker.exists(),
        ".data-location-moved.json must be removed after relocation finishes"
    );
    let receipt_file = new_dir.join("diagnostics").join("data-relocation.jsonl");
    assert!(
        receipt_file.is_file(),
        "diagnostics/data-relocation.jsonl receipt must be written"
    );
    let receipt_text = std::fs::read_to_string(&receipt_file).unwrap();
    let receipt_json: Value =
        serde_json::from_str(receipt_text.lines().next().expect("receipt line")).unwrap();
    // Crash #2 (`post-sql-commit`) already committed all 16 SQL tables, so the
    // final clean resume proves idempotent DB replay (`dbRowsUpdated == 0`) while
    // finishing the interrupted `mid-profiles` directory merge (`claudeProjectDirsMoved == 1`).
    assert_eq!(receipt_json["dbRowsUpdated"].as_u64(), Some(0));
    assert_eq!(receipt_json["claudeProjectDirsMoved"].as_u64(), Some(1));

    let new_cwd = format!(r"{new_plain}\scratch\orgtree\coord");
    let new_enc = encode_claude_dir(&new_cwd);
    assert!(
        !profile.join("projects").join(&old_enc).exists(),
        "old encoded Claude project folder must be merged and removed"
    );
    assert_eq!(
        std::fs::read_to_string(profile.join("projects").join(&new_enc).join("s1.jsonl")).unwrap(),
        "{\"turn\":1}\n"
    );
    assert_eq!(
        std::fs::read_to_string(profile.join("projects").join(&new_enc).join("s2.jsonl")).unwrap(),
        "{\"turn\":2}\n"
    );
    assert_eq!(
        std::fs::read_to_string(
            profile
                .join("projects")
                .join(&new_enc)
                .join("memory")
                .join("MEMORY.md")
        )
        .unwrap(),
        "# Remembered\n"
    );
    assert!(
        profile
            .join("projects")
            .join(&ext_enc)
            .join("ext.jsonl")
            .is_file(),
        "external sibling project folder must stay untouched"
    );
    let claude_cfg: Value =
        serde_json::from_str(&std::fs::read_to_string(profile.join(".claude.json")).unwrap())
            .unwrap();
    assert!(claude_cfg["projects"].get(&new_cwd).is_some());
    assert!(claude_cfg["projects"].get(&old_cwd).is_none());
    assert!(claude_cfg["projects"].get(&ext_cwd).is_some());

    let _ = std::fs::remove_dir_all(&scratch);
}
