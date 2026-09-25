//! The service descriptor the door reads to find and authenticate to the
//! store service: `<prototype root>\p03-store-service.json`.
//!
//! It carries the per-boot token, so it is written owner-only and FAILS
//! CLOSED: an empty temporary is created, restricted to the current user +
//! SYSTEM + Administrators with inheritance removed (the pattern of
//! `engine/service_host.py:161-182`), then the content is written and the
//! file renamed into place. If the restriction fails, nothing is published.
//! (Residual, labelled inferred: a handle opened on the empty temporary in the
//! instant before its restriction keeps read access; `service_host.py`'s
//! at-birth DACL closes that and a later hardening can port it.)

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

pub const DESCRIPTOR_FILE: &str = "p03-store-service.json";
pub const DESCRIPTOR_SCHEMA: &str = "orgtree.p03.store-service/v1";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Descriptor {
    pub schema: String,
    pub root_id: String,
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub service_incarnation: String,
    pub qualification: bool,
}

fn current_user_sid() -> Option<String> {
    let out = Command::new("whoami").args(["/user", "/fo", "csv", "/nh"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&out.stdout);
    let sid = line.trim().rsplit(',').next()?.trim_matches('"').to_string();
    sid.starts_with("S-1-").then_some(sid)
}

fn restrict(path: &Path) -> Result<(), String> {
    let sid = current_user_sid().ok_or("cannot determine the current user's SID")?;
    let st = Command::new("icacls")
        .arg(path)
        .args(["/inheritance:r", "/grant:r"])
        .arg(format!("*{sid}:F"))
        .args(["/grant", "*S-1-5-18:F", "/grant", "*S-1-5-32-544:F"])
        .output()
        .map_err(|e| format!("icacls not runnable: {e}"))?;
    if !st.status.success() {
        return Err(format!("icacls failed: {}", String::from_utf8_lossy(&st.stderr).trim()));
    }
    Ok(())
}

pub fn path_in(root: &Path) -> PathBuf {
    root.join(DESCRIPTOR_FILE)
}

pub fn write(root: &Path, d: &Descriptor) -> Result<PathBuf, String> {
    let final_path = path_in(root);
    let tmp = root.join(format!(".{DESCRIPTOR_FILE}.{}.tmp", uuid::Uuid::new_v4().simple()));
    std::fs::File::create(&tmp).map_err(|e| format!("create descriptor temporary: {e}"))?;
    if let Err(e) = restrict(&tmp) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("descriptor not published (fail closed): {e}"));
    }
    let body = serde_json::to_vec_pretty(d).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::write(&tmp, body) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("write descriptor: {e}"));
    }
    std::fs::rename(&tmp, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("publish descriptor: {e}")
    })?;
    Ok(final_path)
}

pub fn remove(root: &Path) {
    let _ = std::fs::remove_file(path_in(root));
}
