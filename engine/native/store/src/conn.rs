//! The connection factory (CONTRACT-M1 §3.8). Every PostgreSQL connection
//! the store service or its helpers open goes through [`Factory`], which
//! registers it with the trace sink as `(purpose, backend pid,
//! backend_start, host, port, role, database)`.
//!
//! Credentials never leave this module: [`Secret`] has no `Display`, its
//! `Debug` prints `***`, and the connection-opened event carries host, port,
//! role and database only (v6 PROFILING:13; lead note 2026-09-25).

use std::fmt;

use crate::hooks::{EventKind, Hooks, Scope};

/// A password. Deliberately not `Display`, and redacted in `Debug`.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(s: impl Into<String>) -> Secret {
        Secret(s.into())
    }
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PgConfig {
    pub host: String,
    pub port: u16,
    pub role: String,
    pub password: Secret,
    pub database: String,
}

impl PgConfig {
    /// Parse `postgresql://role:password@host:port/database[?sslmode=disable]`,
    /// the form WS1's `pg-custodian dev up` prints. Errors never echo the URL.
    pub fn from_url(url: &str) -> Result<PgConfig, String> {
        let rest = url
            .strip_prefix("postgresql://")
            .or_else(|| url.strip_prefix("postgres://"))
            .ok_or("connection URL must start with postgresql://")?;
        let rest = rest.split('?').next().unwrap_or(rest);
        let (auth, hostpart) = rest.rsplit_once('@').ok_or("connection URL has no credentials")?;
        let (role, password) = auth.split_once(':').ok_or("connection URL has no password")?;
        let (hostport, database) = hostpart.split_once('/').ok_or("connection URL has no database")?;
        let (host, port) = hostport.rsplit_once(':').ok_or("connection URL has no port")?;
        let port: u16 = port.parse().map_err(|_| "connection URL port is not a number".to_string())?;
        if role.is_empty() || database.is_empty() || host.is_empty() {
            return Err("connection URL has an empty role, host or database".into());
        }
        Ok(PgConfig { host: host.into(), port, role: role.into(), password: Secret::new(password), database: database.into() })
    }
}

/// Build the one event a factory emits per connection. Pure, so the
/// no-credentials rule is unit-tested without a database.
pub fn conn_opened<'a>(cfg: &'a PgConfig, purpose: &'a str, backend_pid: Option<i32>, backend_start: Option<i64>) -> EventKind<'a> {
    EventKind::ConnOpened {
        purpose,
        backend_pid,
        backend_start,
        host: &cfg.host,
        port: cfg.port,
        role: &cfg.role,
        database: &cfg.database,
    }
}

/// Opens registered connections for one purpose (executor pool, lookup pool,
/// liveness, read worker, replication, snapshot, backup).
#[derive(Clone)]
pub struct Factory {
    pub cfg: PgConfig,
    pub purpose: &'static str,
    pub hooks: Hooks,
}

impl Factory {
    pub fn new(cfg: PgConfig, purpose: &'static str, hooks: Hooks) -> Factory {
        Factory { cfg, purpose, hooks }
    }

    pub(crate) fn register(&self, backend_pid: Option<i32>, backend_start: Option<i64>) {
        let s = Scope { hooks: &self.hooks, family: "conn", verb: self.purpose, op: None, op_tag: None, attempt: 0 };
        s.emit(conn_opened(&self.cfg, self.purpose, backend_pid, backend_start), false);
    }

    /// Trace a statement the factory itself ran on a new session.
    pub(crate) fn traced_setup(&self, label: &str, sql: &str, backend_pid: Option<i32>) {
        let s = Scope { hooks: &self.hooks, family: "conn", verb: self.purpose, op: None, op_tag: None, attempt: 0 };
        s.emit(EventKind::Statement { label, sql, micros: 0, rows: 1, sqlstate: None, backend_pid }, false);
    }

    /// The registration path, callable without a database (credential test).
    #[doc(hidden)]
    pub fn register_for_test(&self, backend_pid: Option<i32>, backend_start: Option<i64>) {
        self.register(backend_pid, backend_start)
    }
}
