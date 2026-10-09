//! "Chat from your phone" (Orgtree 4.1, docket item
//! `orgtree-4-1-chat-from-your-phone-linking-flow-or`): what this PC knows
//! about linking Hubchat on the user's phone to an organization.
//!
//! Tailscale is detected, never installed or configured: `tailscale status
//! --json` gives the PC's state (T0 not installed, T1 installed but not
//! connected, T2 connected: account, PC name, 100.x address, key expiry).
//! In rig mode the CLI is only the rig's fake (`ORGTREE_TAILSCALE_BIN`),
//! never the real one.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use arc_swap::ArcSwapOption;
use serde::Serialize;
use serde_json::{json, Value};

use crate::engine::Engine;

/// How long one reading of `tailscale status` is reused: the panel asks
/// every few seconds while it is open ("this page updates when it's done").
const TS_FRESH: Duration = Duration::from_secs(2);
const TS_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Default)]
pub struct Phone {
    ts: ArcSwapOption<(Instant, Tailscale)>,
}

/// The PC's Tailscale state, as the panel shows it.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Tailscale {
    /// "T0" not installed · "T1" installed, not connected · "T2" connected
    pub state: &'static str,
    /// Tailscale's own BackendState (Running, NeedsLogin, Stopped, …), or
    /// "NoDaemon" when the CLI is there but its service does not answer
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    /// the signed-in account (the tailnet owner's login name)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// this PC's name on the tailnet
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pc: Option<String>,
    /// its MagicDNS name, without the trailing dot
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dns: Option<String>,
    /// its 100.x address
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ipv4: Option<String>,
    /// when Tailscale signs this PC out (absent: key expiry is off)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_expiry: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The Tailscale CLI: the rig's fake in rig mode, else on PATH or in
/// Program Files (where its installer puts it).
#[logged]
pub fn tailscale_bin() -> Option<PathBuf> {
    if crate::rig::active() {
        return crate::rig::cli_bin("ORGTREE_TAILSCALE_BIN").map(|(p, _)| p);
    }
    crate::providers::which("tailscale").or_else(|| {
        ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
            .iter()
            .filter_map(|v| std::env::var_os(v))
            .map(|d| PathBuf::from(d).join("Tailscale").join("tailscale.exe"))
            .find(|p| p.is_file())
    })
}

/// Read `tailscale status --json` into the panel's terms. Pure, for tests.
#[logged]
pub fn parse_status(v: &Value) -> Tailscale {
    let backend = v["BackendState"].as_str().unwrap_or("").to_string();
    let me = &v["Self"];
    let ipv4 = me["TailscaleIPs"]
        .as_array()
        .or_else(|| v["TailscaleIPs"].as_array())
        .and_then(|ips| ips.iter().filter_map(Value::as_str).find(|ip| ip.parse::<std::net::Ipv4Addr>().is_ok()))
        .map(str::to_string);
    let user = me["UserID"].as_i64().map(|id| &v["User"][id.to_string()]);
    let account = user
        .and_then(|u| u["LoginName"].as_str())
        .or_else(|| v["CurrentTailnet"]["Name"].as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let text = |x: &Value| x.as_str().filter(|s| !s.is_empty()).map(str::to_string);
    let connected = backend == "Running" && ipv4.is_some();
    Tailscale {
        state: if connected { "T2" } else { "T1" },
        backend: Some(backend),
        account: if connected { account } else { None },
        pc: text(&me["HostName"]),
        dns: text(&me["DNSName"]).map(|d| d.trim_end_matches('.').to_string()),
        ipv4: if connected { ipv4 } else { None },
        key_expiry: if connected { text(&me["KeyExpiry"]) } else { None },
        error: None,
    }
}

/// Ask the CLI now.
#[logged]
async fn read_tailscale() -> Tailscale {
    let Some(bin) = tailscale_bin() else { return Tailscale { state: "T0", ..Default::default() } };
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.args(["status", "--json"]).stdin(std::process::Stdio::null()).kill_on_drop(true);
    crate::winproc::no_window(&mut cmd);
    let out = match tokio::time::timeout(TS_TIMEOUT, cmd.output()).await {
        Ok(Ok(o)) => o,
        // the file is there but will not run: treat it as not installed
        Ok(Err(e)) => return Tailscale { state: "T0", error: Some(format!("tailscale could not run: {e}")), ..Default::default() },
        Err(_) => {
            return Tailscale { state: "T1", backend: Some("NoDaemon".into()), error: Some("tailscale status did not answer".into()), ..Default::default() }
        }
    };
    match serde_json::from_slice::<Value>(&out.stdout) {
        Ok(v) if v.is_object() => parse_status(&v),
        // installed, but its service is stopped ("failed to connect to local Tailscale daemon")
        _ => Tailscale {
            state: "T1",
            backend: Some("NoDaemon".into()),
            error: Some(crate::util::gist(String::from_utf8_lossy(&out.stderr).trim(), 300)),
            ..Default::default()
        },
    }
}

/// The PC's Tailscale state, at most `TS_FRESH` old.
#[logged]
pub async fn tailscale(engine: &Engine) -> Tailscale {
    if let Some(c) = engine.phone.ts.load_full() {
        if c.0.elapsed() < TS_FRESH {
            return c.1.clone();
        }
    }
    let t = read_tailscale().await;
    engine.phone.ts.store(Some(Arc::new((Instant::now(), t.clone()))));
    t
}

/// `GET /api/desktop/phone`: everything the "Chat from your phone" panel shows.
#[logged]
pub async fn state(engine: &Arc<Engine>) -> Value {
    let ts = tailscale(engine).await;
    json!({ "tailscale": ts })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connected() {
        let v = json!({
            "BackendState": "Running",
            "Self": { "HostName": "home-pc", "DNSName": "home-pc.tail1234.ts.net.", "UserID": 7,
                      "TailscaleIPs": ["100.101.102.103", "fd7a:115c:a1e0::1"], "KeyExpiry": "2027-04-07T10:00:00Z" },
            "User": { "7": { "LoginName": "alex@gmail.com" } },
            "CurrentTailnet": { "Name": "alex@gmail.com" }
        });
        let t = parse_status(&v);
        assert_eq!(t.state, "T2");
        assert_eq!(t.account.as_deref(), Some("alex@gmail.com"));
        assert_eq!(t.pc.as_deref(), Some("home-pc"));
        assert_eq!(t.dns.as_deref(), Some("home-pc.tail1234.ts.net"));
        assert_eq!(t.ipv4.as_deref(), Some("100.101.102.103"));
        assert_eq!(t.key_expiry.as_deref(), Some("2027-04-07T10:00:00Z"));
    }

    #[test]
    fn signed_out_or_stopped() {
        for b in ["NeedsLogin", "Stopped", "NeedsMachineAuth", "Starting"] {
            let t = parse_status(&json!({ "BackendState": b, "Self": { "HostName": "home-pc", "TailscaleIPs": [] } }));
            assert_eq!(t.state, "T1", "{b}");
            assert_eq!(t.ipv4, None);
            assert_eq!(t.account, None);
        }
        // running but no address yet is not connected
        assert_eq!(parse_status(&json!({ "BackendState": "Running", "Self": {} })).state, "T1");
    }
}
