//! P03 WS1 custodian: the ONE component allowed to create, start, stop and
//! identify the private PostgreSQL instance (P03-PLAN.md, WS1).
//!
//! Milestone 1 ("dev cluster") scope: prototype-root guard, `init` (initdb
//! with quarantine-then-rename), `start` (loopback, SCRAM only, occupied-port
//! refusal), `identify` (system_identifier + instance token + data directory,
//! plus the readiness settings), `stop` (native `pg_ctl stop`, then waits on
//! handles to the whole owned process family), `destroy`.
//!
//! Built since: three SCRAM roles with asserted attributes, the migration
//! runner (`migrate`), owner-only secrets and the `pg-attach.json` descriptor
//! with `attach`, the qualification-logging switch, the dev-cluster CLI.
//! The prototype-root guard lives in the shared `orgtree-prototype-guard`.
//!
//! Not yet built: backup/restore, host integration (`service_host.py`), the
//! G5 drills and the four WS1 unsafe controls. The publication allowlist is
//! WS6's catalog.

pub mod acl;
pub mod cluster;
pub mod dev;
pub mod error;
pub mod guard;
pub mod migrate;
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
