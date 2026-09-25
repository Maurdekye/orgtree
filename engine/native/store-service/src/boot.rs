//! How the host starts, checks and stops the store service (the host bracket,
//! lead ruling on WS1's item; call shape agreed with WS1 2026-09-25).
//!
//! * Connection facts come from the custodian's files under the prototype
//!   root — `pg/cluster/pg-attach.json` (schema `orgtree.p03.pg-runtime/v1`)
//!   and `pg/cluster/secrets/credentials.json` (role → password) — so no
//!   password travels through the host's environment or command line. Only
//!   the runtime role is used.
//! * Identity: the attach descriptor's `root_id` must equal the prototype
//!   marker's, and the server must answer — as the runtime role — with the
//!   descriptor's `instance_token` (GUC `orgtree.instance_token`), `root_id`
//!   (GUC `orgtree.root_id`) and `system_identifier`
//!   (`pg_control_system()`), the three values WS1 verified the runtime role
//!   can read. A foreign or replaced server on that port is refused.
//! * Ready: after the service descriptor is written, ONE stdout line
//!   `{"type":"ready",...}`; nothing else ever goes to stdout.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use orgtree_store::conn::{PgConfig, Secret};

pub const ATTACH_SCHEMA: &str = "orgtree.p03.pg-runtime/v1";
pub const RUNTIME_ROLE: &str = "orgtree_runtime";
pub const APP_DB: &str = "orgtree";
pub const IDENTITY_SQL: &str = "SELECT coalesce(current_setting('orgtree.instance_token', true), ''), \
    coalesce(current_setting('orgtree.root_id', true), ''), \
    (SELECT system_identifier::text FROM pg_control_system())";

#[derive(Debug, PartialEq, Eq)]
pub struct Attach {
    pub root_id: String,
    pub instance_token: String,
    pub system_identifier: String,
    pub host: String,
    pub port: u16,
}

pub fn cluster_dir(root: &Path) -> PathBuf {
    root.join("pg").join("cluster")
}

/// Parse the custodian's attach descriptor (only the fields the service needs).
pub fn parse_attach(text: &str) -> Result<Attach, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("pg-attach.json is not JSON: {e}"))?;
    if v.get("schema").and_then(Value::as_str) != Some(ATTACH_SCHEMA) {
        return Err(format!("pg-attach.json schema is not {ATTACH_SCHEMA}"));
    }
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string).ok_or_else(|| format!("pg-attach.json has no {k}"));
    let port = v.get("port").and_then(Value::as_u64).and_then(|p| u16::try_from(p).ok()).ok_or("pg-attach.json has no port")?;
    let host = s("host")?;
    if host != "127.0.0.1" {
        return Err(format!("pg-attach.json names host {host}: only loopback is accepted"));
    }
    Ok(Attach { root_id: s("root_id")?, instance_token: s("instance_token")?, system_identifier: s("system_identifier")?, host, port })
}

/// The runtime role's password from `credentials.json` (role → password).
/// Errors never echo a password.
pub fn runtime_password(text: &str) -> Result<Secret, String> {
    let v: Value = serde_json::from_str(text).map_err(|_| "credentials.json is not JSON".to_string())?;
    v.get(RUNTIME_ROLE).and_then(Value::as_str).filter(|p| !p.is_empty()).map(Secret::new).ok_or_else(|| format!("credentials.json has no {RUNTIME_ROLE} entry"))
}

/// Everything the service needs to connect, from the custodian's files.
pub fn config_from_root(root: &Path, marker_root_id: &str) -> Result<(PgConfig, Attach), String> {
    let dir = cluster_dir(root);
    let attach_text = std::fs::read_to_string(dir.join("pg-attach.json")).map_err(|_| "the cluster is not running: no pg-attach.json".to_string())?;
    let attach = parse_attach(&attach_text)?;
    if attach.root_id != marker_root_id {
        return Err(format!("pg-attach.json belongs to root {} but this root is {marker_root_id}", attach.root_id));
    }
    let creds = std::fs::read_to_string(dir.join("secrets").join("credentials.json")).map_err(|_| "cannot read secrets/credentials.json".to_string())?;
    let password = runtime_password(&creds)?;
    let cfg = PgConfig { host: attach.host.clone(), port: attach.port, role: RUNTIME_ROLE.into(), password, database: APP_DB.into() };
    Ok((cfg, attach))
}

/// What the server reported about itself.
#[derive(Debug, PartialEq, Eq)]
pub struct ServerIdentity {
    pub instance_token: String,
    pub root_id: String,
    pub system_identifier: String,
}

/// All three must equal the descriptor's values; an empty answer never passes.
pub fn check_identity(server: &ServerIdentity, attach: &Attach) -> Result<(), String> {
    for (what, got, want) in [
        ("instance_token", &server.instance_token, &attach.instance_token),
        ("root_id", &server.root_id, &attach.root_id),
        ("system_identifier", &server.system_identifier, &attach.system_identifier),
    ] {
        if got.is_empty() || got != want {
            return Err(format!("the server on the attach port is not this root's instance ({what} mismatch)"));
        }
    }
    Ok(())
}

/// The one stdout line the host waits for.
pub fn ready_line(pid: u32, port: u16, service_incarnation: &str, descriptor: &Path) -> String {
    json!({"type": "ready", "pid": pid, "port": port, "service_incarnation": service_incarnation,
           "descriptor": descriptor.display().to_string()})
    .to_string()
}

/// Upper bound for a `--*-timeout-ms` flag: one hour.
pub const MAX_TIMEOUT_MS: u64 = 3_600_000;

/// Apply one `--lock-timeout-ms` / `--statement-timeout-ms` /
/// `--idle-in-transaction-timeout-ms` flag (review N3). The value must be a
/// whole number of milliseconds in `1..=MAX_TIMEOUT_MS`: a timeout can be
/// raised for a WS7 schedule but never switched off (review F4). A refused
/// flag leaves `cfg` unchanged.
pub fn set_timeout(cfg: &mut orgtree_store::ExecConfig, flag: &str, value: Option<&str>) -> Result<(), String> {
    let v = value.ok_or_else(|| format!("{flag} needs a value in milliseconds"))?;
    let ms: u64 = v.parse().map_err(|_| format!("{flag}: {v:?} is not a whole number of milliseconds"))?;
    if ms == 0 || ms > MAX_TIMEOUT_MS {
        return Err(format!("{flag}: {ms} is outside 1..={MAX_TIMEOUT_MS} (a timeout cannot be switched off)"));
    }
    let slot = match flag {
        "--lock-timeout-ms" => &mut cfg.lock_timeout_ms,
        "--statement-timeout-ms" => &mut cfg.statement_timeout_ms,
        "--idle-in-transaction-timeout-ms" => &mut cfg.idle_in_transaction_timeout_ms,
        other => return Err(format!("unknown timeout flag {other}")),
    };
    *slot = Some(ms);
    Ok(())
}
