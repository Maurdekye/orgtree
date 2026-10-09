//! "Chat from your phone" (Orgtree 4.1, docket item
//! `orgtree-4-1-chat-from-your-phone-linking-flow-or`): what this PC knows
//! about linking Hubchat on the user's phone to an organization.
//!
//! Tailscale is detected, never installed or configured: `tailscale status
//! --json` gives the PC's state (T0 not installed, T1 installed but not
//! connected, T2 connected: account, PC name, 100.x address, key expiry).
//! In rig mode the CLI is only the rig's fake (`ORGTREE_TAILSCALE_BIN`),
//! never the real one.
//!
//! Phone access is the hub's relay-only door (port 7371). For the Tailscale
//! network only, the hub binds it to this PC's 100.x address
//! (`HUB_PUBLIC_BIND`) and the engine restarts the hub when that address
//! appears, moves or goes away. Windows' firewall gets one inbound rule for
//! the door, limited to Tailscale's addresses (or the local subnet for "Use
//! my home Wi-Fi instead"), added behind one administrator prompt. In rig
//! mode the prompt and the rule are a mock (`rig-home\rig-elevate`,
//! `rig-home\rig-firewall`): the real firewall is never read or changed.

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

/// The firewall rule's name (one rule; turning phone access on again replaces it).
pub const RULE_NAME: &str = "Orgtree phone access";
/// Tailscale's address ranges (CGNAT IPv4 and its ULA IPv6 prefix).
const TAILNET_REMOTE: &str = "100.64.0.0/10,fd7a:115c:a1e0::/48";
const RULE_FRESH: Duration = Duration::from_secs(10);
/// How often the background check looks for a moved Tailscale address.
const DOOR_CHECK: Duration = Duration::from_secs(30);
/// Windows' "the operation was cancelled by the user" (the prompt's No).
const ERROR_CANCELLED: i32 = 1223;

#[derive(Default)]
pub struct Phone {
    ts: ArcSwapOption<(Instant, Tailscale)>,
    rule: ArcSwapOption<(Instant, Option<String>)>,
    /// one settings write at a time
    write: std::sync::Mutex<()>,
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

// ------------------------------------------------------------ settings

#[logged]
fn settings_path(engine: &Engine) -> PathBuf {
    engine.cfg.path("phone.json")
}

/// `<data>/phone.json`: keep-awake, the card's dismissal, the link record.
#[logged]
pub fn settings(engine: &Engine) -> Value {
    let v = std::fs::read_to_string(settings_path(engine)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(Value::is_object);
    let mut v = v.unwrap_or_else(|| json!({}));
    if !v["keep_awake"].is_boolean() {
        v["keep_awake"] = json!(true);
    }
    v
}

/// Change the settings file under the write lock (a short read-modify-write).
#[logged]
pub fn update_settings(engine: &Engine, f: impl FnOnce(&mut Value)) -> std::io::Result<Value> {
    let _one = engine.phone.write.lock().unwrap_or_else(|p| p.into_inner());
    let mut v = settings(engine);
    f(&mut v);
    let path = settings_path(engine);
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&v).unwrap_or_default() + "\n")?;
    std::fs::rename(&tmp, &path)?;
    Ok(v)
}

// ------------------------------------------------------------ the door

/// A0 off · A1 on for the Tailscale network (or, scope "lan", the home
/// network) only · A2 on for every network.
#[logged]
pub fn access(hosting: &Value) -> &'static str {
    if !hosting["public_listener"].as_bool().unwrap_or(false) {
        return "A0";
    }
    match hosting["public_scope"].as_str() {
        Some("tailnet") | Some("lan") => "A1",
        _ => "A2",
    }
}

/// The door's address no longer matches this PC's Tailscale address (it
/// appeared, moved or went away): restart the hub on the new one.
#[logged]
pub async fn reconcile_door(engine: &Arc<Engine>) {
    if !crate::mailhub::hosts() {
        return;
    }
    let cfg = engine.hub.hosting_config();
    if !cfg["public_listener"].as_bool().unwrap_or(false) || cfg["public_scope"].as_str() != Some("tailnet") {
        return;
    }
    let want = tailscale(engine).await.ipv4;
    let st = engine.hub.state.load_full();
    // a hub that failed to start is left for the settings page, not retried here
    if want != st.door && st.running {
        let have = st.door.clone();
        tracing::info!(?want, ?have, "the phone door's Tailscale address changed; restarting the mail hub");
        crate::mailhub::restart(engine).await;
    }
}

/// The background check for a moved Tailscale address.
#[logged]
pub fn start(engine: &Arc<Engine>) {
    let eng = engine.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = eng.shutdown.cancelled() => return,
                _ = tokio::time::sleep(DOOR_CHECK) => {}
            }
            reconcile_door(&eng).await;
        }
    });
}

/// The remote addresses the firewall rule admits, for a scope.
#[logged]
fn rule_remote(scope: &str) -> &'static str {
    match scope {
        "tailnet" => TAILNET_REMOTE,
        "lan" => "LocalSubnet",
        _ => "Any",
    }
}

/// A rig-mode mock folder under the fake home (None outside rig mode).
#[logged]
fn rig_dir(sub: &str) -> Option<PathBuf> {
    if !crate::rig::active() {
        return None;
    }
    crate::rig::home_dir().map(|h| h.join(sub))
}

/// The rule's remote addresses as Windows has them (None: no rule).
#[logged]
async fn read_rule() -> Option<String> {
    if let Some(dir) = rig_dir("rig-firewall") {
        return std::fs::read_to_string(dir.join("rule.txt")).ok().map(|t| t.trim().to_string());
    }
    let script = format!(
        "$r = Get-NetFirewallRule -DisplayName '{RULE_NAME}' -ErrorAction SilentlyContinue | Select-Object -First 1; \
         if ($r) {{ ($r | Get-NetFirewallAddressFilter).RemoteAddress -join ',' }}"
    );
    let mut cmd = tokio::process::Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encode_ps(&script)]).stdin(std::process::Stdio::null()).kill_on_drop(true);
    crate::winproc::no_window(&mut cmd);
    let out = tokio::time::timeout(Duration::from_secs(15), cmd.output()).await.ok()?.ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// The firewall rule, at most `RULE_FRESH` old.
#[logged]
pub async fn firewall_rule(engine: &Engine) -> Option<String> {
    if let Some(c) = engine.phone.rule.load_full() {
        if c.0.elapsed() < RULE_FRESH {
            return c.1.clone();
        }
    }
    let r = read_rule().await;
    engine.phone.rule.store(Some(Arc::new((Instant::now(), r.clone()))));
    r
}

/// PowerShell's -EncodedCommand form (UTF-16LE, base64): no quoting at all.
#[nolog]
fn encode_ps(script: &str) -> String {
    use base64::Engine as _;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The script the administrator prompt runs: replace the rule.
#[logged]
fn rule_script(scope: &str) -> String {
    let port = crate::mailhub::PUBLIC_LISTENER_PORT;
    let remote = rule_remote(scope);
    format!(
        "$ErrorActionPreference = 'Stop'\n\
         Remove-NetFirewallRule -DisplayName '{RULE_NAME}' -ErrorAction SilentlyContinue\n\
         New-NetFirewallRule -DisplayName '{RULE_NAME}' -Description 'Lets Hubchat on your phone reach the Orgtree mail hub (its relay-only door). Added by Connect your phone.' \
         -Direction Inbound -Action Allow -Protocol TCP -LocalPort {port} -RemoteAddress {remote} -Profile Any | Out-Null\n\
         exit 0"
    )
}

/// Why an elevated step did not happen.
#[derive(Debug)]
pub enum Elevation {
    /// the user answered No to Windows' prompt
    Declined,
    Failed(String),
}

/// Run `script` as administrator: one Windows prompt. In rig mode nothing is
/// elevated: the script is logged, `rig-elevate\answer` ("no") plays the
/// user's No, and a Yes applies the rule to the mock firewall.
#[logged]
async fn elevate(script: &str, scope: &str) -> Result<(), Elevation> {
    if let Some(dir) = rig_dir("rig-elevate") {
        let _ = std::fs::create_dir_all(&dir);
        let mut log = std::fs::read_to_string(dir.join("calls.log")).unwrap_or_default();
        log.push_str(&format!("--- {}\n{script}\n", crate::util::now_iso()));
        let _ = std::fs::write(dir.join("calls.log"), log);
        let answer = std::fs::read_to_string(dir.join("answer")).unwrap_or_default();
        if answer.trim().eq_ignore_ascii_case("no") {
            return Err(Elevation::Declined);
        }
        let fw = rig_dir("rig-firewall").ok_or_else(|| Elevation::Failed("rig".into()))?;
        let _ = std::fs::create_dir_all(&fw);
        return std::fs::write(fw.join("rule.txt"), rule_remote(scope)).map_err(|e| Elevation::Failed(e.to_string()));
    }
    let outer = format!(
        "try {{ $p = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand','{}' \
         -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop; exit $p.ExitCode }} catch {{ exit {ERROR_CANCELLED} }}",
        encode_ps(script)
    );
    let mut cmd = tokio::process::Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encode_ps(&outer)]).stdin(std::process::Stdio::null()).kill_on_drop(true);
    crate::winproc::no_window(&mut cmd);
    // the prompt waits for the user
    let out = tokio::time::timeout(Duration::from_secs(600), cmd.output())
        .await
        .map_err(|_| Elevation::Failed("the administrator prompt was not answered within 10 minutes".into()))?
        .map_err(|e| Elevation::Failed(format!("powershell could not run: {e}")))?;
    match out.status.code() {
        Some(0) => Ok(()),
        Some(ERROR_CANCELLED) => Err(Elevation::Declined),
        c => Err(Elevation::Failed(format!(
            "the firewall rule could not be added (exit code {})",
            c.map(|c| c.to_string()).unwrap_or_else(|| "?".into())
        ))),
    }
}

/// "Turn on phone access" (and "Limit it to Tailscale"): the firewall rule
/// behind one administrator prompt, then the hub's door for `scope`.
#[logged]
pub async fn turn_on(engine: &Arc<Engine>, scope: &str, keep_awake: Option<bool>) -> Result<Value, crate::http::error::ApiError> {
    use crate::http::error::ApiError;
    if scope != "tailnet" && scope != "lan" {
        return Err(ApiError::bad_request("scope must be tailnet or lan"));
    }
    if scope == "tailnet" && tailscale(engine).await.state != "T2" {
        return Err(ApiError::conflict("Tailscale is not connected on this PC"));
    }
    match elevate(&rule_script(scope), scope).await {
        Ok(()) => {}
        Err(Elevation::Declined) => {
            return Err(ApiError::conflict("Nothing changed: phone access stays as it was.").with(json!({ "declined": true })))
        }
        Err(Elevation::Failed(e)) => return Err(ApiError::internal(e)),
    }
    engine.phone.rule.store(None);
    if let Some(k) = keep_awake {
        update_settings(engine, |v| v["keep_awake"] = json!(k)).map_err(|e| ApiError::internal(format!("could not save phone.json: {e}")))?;
    }
    crate::mailhub::configure(engine, &json!({ "public_listener": true, "public_scope": scope })).await.map_err(ApiError::unprocessable)?;
    Ok(state(engine).await)
}

/// `GET /api/desktop/phone`: everything the "Chat from your phone" panel shows.
#[logged]
pub async fn state(engine: &Arc<Engine>) -> Value {
    reconcile_door(engine).await;
    let ts = tailscale(engine).await;
    let hub = crate::mailhub::hosting(engine).await;
    let settings = settings(engine);
    json!({
        "tailscale": ts,
        "access": {
            "state": access(&hub),
            "scope": hub["public_scope"],
            "port": crate::mailhub::PUBLIC_LISTENER_PORT,
            "door": hub["status"]["door"],
            "door_waiting": hub["status"]["door_waiting"],
            "firewall": firewall_rule(engine).await,
        },
        "hub": { "running": hub["status"]["running"], "healthy": hub["status"]["healthy"], "error": hub["error"] },
        "keep_awake": settings["keep_awake"],
    })
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
