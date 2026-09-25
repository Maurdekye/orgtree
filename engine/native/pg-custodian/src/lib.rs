//! P03 WS1 custodian: the ONE component allowed to create, start, stop and
//! identify the private PostgreSQL instance (P03-PLAN.md, WS1).
//!
//! Milestone 1 ("dev cluster") scope: prototype-root guard, `init` (initdb
//! with quarantine-then-rename), `start` (loopback, SCRAM only, occupied-port
//! refusal), `identify` (system_identifier + instance token + data directory,
//! plus the readiness settings), `stop` (native `pg_ctl stop`, then waits on
//! handles to the whole owned process family), `destroy`.
//!
//! Not yet built (later WS1 milestones): the three-role credential set,
//! publication allowlist and role-privilege readiness, descriptor-based
//! attach from a second window or `service_host.py`, backup/restore,
//! migration runner, host integration hooks, the G5 drills and the four
//! WS1 unsafe controls.

pub mod cluster;
pub mod dev;
pub mod error;
pub mod guard;
pub mod win;

pub use error::{CustodianError, Result};

use serde::Serialize;
use std::path::Path;

pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Write JSON to a sibling temp file, then rename over the target.
pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|e| CustodianError::new("json.encode", e.to_string()))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text + "\n").map_err(|e| CustodianError::io("json.write", &tmp, e))?;
    std::fs::rename(&tmp, path).map_err(|e| CustodianError::io("json.write", path, e))
}
