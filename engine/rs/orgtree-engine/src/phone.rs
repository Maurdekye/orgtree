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
//! my home Wi-Fi instead"), added by the desktop behind one administrator
//! prompt (apps/desktop/main/phonefirewall.ts); the engine only reads it. In
//! rig mode the rule is a mock (`rig-home\rig-firewall\rule.txt`): the real
//! firewall is never read.

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
const RULE_FRESH: Duration = Duration::from_secs(30);
/// How often the background check looks for a moved door address.
const DOOR_CHECK: Duration = Duration::from_secs(30);
/// A reading that disagrees with the door is confirmed by a second one this
/// soon before the hub restarts (a restart drops every local connection).
const DOOR_CONFIRM: Duration = Duration::from_secs(5);
/// How long the card's bar (one database query) is reused.
const BAR_FRESH: Duration = Duration::from_secs(60);
/// Messages naming a wrong code while one is live: after this many the live
/// code is voided (the panel shows "New code").
const CODE_TRIES: u32 = 5;
/// Hub message ids already answered (a redelivery is not answered twice).
const ANSWERED_KEEP: usize = 200;

/// A setup code works once, for this long.
const CODE_LIFE: Duration = Duration::from_secs(10 * 60);
/// A spent or expired code is remembered this long (a redelivered message is
/// not answered twice; a late scan gets "expired", not silence).
const CODE_KEEP: Duration = Duration::from_secs(60 * 60);
/// No 0/O, 1/I: read off a screen without doubt.
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/// Where Hubchat for Android is downloaded (a fixed-name asset of every release).
pub const DOWNLOAD_URL: &str = "https://github.com/Maurdekye/orgtree-hubchat/releases/latest/download/Hubchat-android.apk";
/// The trust note's marked block at the top of org.md.
const BLOCK_START: &str = "<!-- added by Connect your phone; Unlink removes it -->";
const BLOCK_END: &str = "<!-- end of the Connect your phone note -->";

#[derive(Default)]
pub struct Phone {
    ts: ArcSwapOption<(Instant, Tailscale)>,
    rule: ArcSwapOption<(Instant, Option<String>)>,
    /// one settings write at a time
    write: std::sync::Mutex<()>,
    /// the live setup code (one at a time) and recently spent ones
    codes: std::sync::Mutex<Vec<Code>>,
    slow: ArcSwapOption<(Instant, Slow)>,
    /// one link or unlink at a time (phone.json and the trust notes together)
    link_lock: tokio::sync::Mutex<()>,
    /// one org.md writer at a time per org: the trust note and the charter editor
    orgmd: std::sync::Mutex<std::collections::HashMap<i64, Arc<tokio::sync::Mutex<()>>>>,
    /// hub message ids whose setup code was answered
    answered: std::sync::Mutex<std::collections::VecDeque<String>>,
    /// a door address read once that disagrees with the door: restart only
    /// when the next reading says the same
    door_miss: std::sync::Mutex<Option<Option<String>>>,
    /// the panel is open: check the door now rather than at the next tick
    nudge: tokio::sync::Notify,
    /// the card's bar per org window (None: Home), with when it was read
    bar: std::sync::Mutex<std::collections::HashMap<Option<i64>, (Instant, Vec<String>)>>,
}

/// A setup code: held in memory only (an engine restart voids it; the panel
/// shows a new one).
#[derive(Clone, Debug)]
struct Code {
    /// `XXXX-XXXX`
    code: String,
    org_id: i64,
    org: String,
    minted: Instant,
    expires_at: chrono::DateTime<chrono::Utc>,
    /// the hub message that spent it
    used_by: Option<String>,
    /// replaced by a newer code ("New code")
    void: bool,
    /// the QR's link
    url: String,
    /// persons on the hub when it was minted: one that appears after is
    /// probably the phone that scanned it ("Waiting for your phone…")
    persons: Vec<String>,
    /// messages that named a wrong code for this org while this one was live
    tries: u32,
}

impl Code {
    #[nolog]
    fn live(&self) -> bool {
        self.used_by.is_none() && !self.void && self.minted.elapsed() < code_life()
    }
}

/// A code's life: 10 minutes; a rig run may shorten it
/// (`rig-home/rig-phone-code-seconds`) so a proof can see one expire.
#[logged]
fn code_life() -> Duration {
    rig_dir("rig-phone-code-seconds")
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|t| t.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(CODE_LIFE)
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

/// T1's "Sign in": start `tailscale login` and hand back the sign-in address
/// it prints, for the desktop to open in the browser. The CLI keeps waiting
/// for the sign-in to finish (at most 10 minutes); the panel sees T2 then.
#[logged]
pub async fn tailscale_login() -> Result<Value, crate::http::error::ApiError> {
    use crate::http::error::ApiError;
    use tokio::io::AsyncBufReadExt;
    let Some(bin) = tailscale_bin() else { return Err(ApiError::conflict("Tailscale is not installed on this PC.")) };
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("login")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    crate::winproc::no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| ApiError::internal(format!("tailscale could not run: {e}")))?;
    let mut out = tokio::io::BufReader::new(child.stdout.take().expect("piped")).lines();
    let mut err = tokio::io::BufReader::new(child.stderr.take().expect("piped")).lines();
    let found = tokio::time::timeout(Duration::from_secs(20), async {
        let (mut out_done, mut err_done) = (false, false);
        while !(out_done && err_done) {
            let line = tokio::select! {
                l = out.next_line(), if !out_done => l.ok().flatten().or_else(|| { out_done = true; None }),
                l = err.next_line(), if !err_done => l.ok().flatten().or_else(|| { err_done = true; None }),
            };
            if let Some(url) = line.as_deref().and_then(|l| l.split_whitespace().find(|w| w.starts_with("https://"))) {
                return Some(url.to_string());
            }
        }
        None
    })
    .await
    .ok()
    .flatten();
    // the sign-in finishes in the browser; the CLI is left to notice it
    tokio::spawn(async move {
        let _ = tokio::time::timeout(Duration::from_secs(600), child.wait()).await;
    });
    match found {
        Some(url) => Ok(json!({ "url": url })),
        None => Err(ApiError::conflict("Tailscale did not give a sign-in address. Open Tailscale from the Start menu and sign in there.")),
    }
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

/// Where the door should listen for its scope, read now: Some(Some(ip))
/// bound to that address, Some(None) closed (Tailscale signed out or
/// stopped), None unknown (Tailscale did not answer, or no LAN address) and
/// nothing is done. Only the "tailnet" and "lan" scopes follow an address.
#[logged]
async fn door_wanted(engine: &Engine, scope: &str) -> Option<Option<String>> {
    match scope {
        "tailnet" => {
            let t = read_tailscale().await;
            engine.phone.ts.store(Some(Arc::new((Instant::now(), t.clone()))));
            // a CLI that timed out or a service that does not answer says
            // nothing about the address
            if t.error.is_some() || t.backend.as_deref() == Some("NoDaemon") {
                return None;
            }
            Some(t.ipv4)
        }
        "lan" => lan_bind().map(Some),
        _ => None,
    }
}

/// The address the door binds for "Use my home Wi-Fi instead": this PC's LAN
/// address (a rig run's hub never listens beyond loopback).
#[logged]
pub fn lan_bind() -> Option<String> {
    if crate::rig::active() {
        return Some("127.0.0.1".into());
    }
    lan_ipv4()
}

/// One check of the door against this PC's address: the hub restarts only
/// when two readings in a row agree on a different address.
#[logged]
pub async fn reconcile_door(engine: &Arc<Engine>) {
    if !crate::mailhub::hosts() {
        return;
    }
    let cfg = engine.hub.hosting_config();
    let scope = cfg["public_scope"].as_str().unwrap_or("all").to_string();
    if !cfg["public_listener"].as_bool().unwrap_or(false) {
        *engine.phone.door_miss.lock().unwrap_or_else(|p| p.into_inner()) = None;
        return;
    }
    let Some(want) = door_wanted(engine, &scope).await else {
        *engine.phone.door_miss.lock().unwrap_or_else(|p| p.into_inner()) = None;
        return;
    };
    let st = engine.hub.state.load_full();
    // a hub that failed to start is left for the settings page, not retried here
    if want == st.door || !st.running {
        *engine.phone.door_miss.lock().unwrap_or_else(|p| p.into_inner()) = None;
        return;
    }
    let confirmed = {
        let mut miss = engine.phone.door_miss.lock().unwrap_or_else(|p| p.into_inner());
        let same = miss.as_ref() == Some(&want);
        *miss = if same { None } else { Some(want.clone()) };
        same
    };
    if confirmed {
        tracing::info!(?want, have = ?st.door, %scope, "the phone door's address changed; restarting the mail hub");
        crate::mailhub::restart_door(engine, &scope, want).await;
    }
}

/// The background check for a moved door address (every `DOOR_CHECK`, sooner
/// to confirm a change, or at once when the panel asks).
#[logged]
pub fn start(engine: &Arc<Engine>) {
    let eng = engine.clone();
    tokio::spawn(async move {
        loop {
            let wait = if eng.phone.door_miss.lock().unwrap_or_else(|p| p.into_inner()).is_some() { DOOR_CONFIRM } else { DOOR_CHECK };
            tokio::select! {
                _ = eng.shutdown.cancelled() => return,
                _ = tokio::time::sleep(wait) => {}
                _ = eng.phone.nudge.notified() => {}
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

/// "Turn on phone access" (and "Limit it to Tailscale"): the hub's door for
/// `scope`. The firewall rule is added first, by the desktop, behind one
/// administrator prompt (apps/desktop/main/phonefirewall.ts): an engine the
/// boot task started has no desktop to show that prompt on.
#[logged]
pub async fn turn_on(engine: &Arc<Engine>, scope: &str, keep_awake: Option<bool>) -> Result<Value, crate::http::error::ApiError> {
    use crate::http::error::ApiError;
    if scope != "tailnet" && scope != "lan" {
        return Err(ApiError::bad_request("scope must be tailnet or lan"));
    }
    if scope == "tailnet" && tailscale(engine).await.state != "T2" {
        return Err(ApiError::conflict("Tailscale is not connected on this PC"));
    }
    engine.phone.rule.store(None);
    if let Some(k) = keep_awake {
        update_settings(engine, |v| v["keep_awake"] = json!(k)).map_err(|e| ApiError::internal(format!("could not save phone.json: {e}")))?;
    }
    crate::mailhub::configure(engine, &json!({ "public_listener": true, "public_scope": scope })).await.map_err(ApiError::unprocessable)?;
    Ok(state(engine, None).await)
}

// ------------------------------------------------------------ setup codes

// the setup code is a secret while it is live: it and the link that carries
// it never reach the log (#[nolog] wherever they pass)
#[nolog]
fn new_code() -> String {
    use rand::Rng;
    let mut rng = rand::rngs::OsRng;
    let c: String = (0..8).map(|_| CODE_ALPHABET[rng.gen_range(0..CODE_ALPHABET.len())] as char).collect();
    format!("{}-{}", &c[..4], &c[4..])
}

/// The code a message carries: its last non-empty line, `Setup code: XXXX-XXXX`
/// (any case, the dash optional), as `XXXX-XXXX` in upper case.
#[nolog]
pub fn code_line(body: &str) -> Option<String> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"(?i)^\s*setup code:\s*([a-z0-9]{4})-?([a-z0-9]{4})\s*$").expect("code regex"));
    let last = body.lines().rev().find(|l| !l.trim().is_empty())?;
    let c = re.captures(last)?;
    Some(format!("{}-{}", &c[1], &c[2]).to_uppercase())
}

/// A hub address safe to write into org.md (a hub slug: letters, digits, `.`, `_`, `-`).
#[nolog]
fn plain_address(a: &str) -> bool {
    !a.is_empty() && a.len() <= 200 && a.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// This PC's address on its local network (the route to the internet's
/// interface; no packet is sent), for "Use my home Wi-Fi instead".
#[logged]
fn lan_ipv4() -> Option<String> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    match s.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(ip) if !ip.is_unspecified() && !ip.is_loopback() => Some(ip.to_string()),
        _ => None,
    }
}

/// A QR code as an SVG (black on white, with its quiet zone), for the panel
/// and the cards to show as an image. Not logged: the setup QR's text is the
/// link carrying the live code.
#[nolog]
pub fn qr_svg(text: &str) -> Option<String> {
    let code = qrcode::QrCode::with_error_correction_level(text.as_bytes(), qrcode::EcLevel::M).ok()?;
    Some(code.render::<qrcode::render::svg::Color>().min_dimensions(200, 200).quiet_zone(true).build())
}

#[nolog]
fn enc(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
}

/// "New code" / the setup QR's first showing: a code for `org_slug` (any
/// earlier one stops working) and the `hubchat://setup` link it rides in.
#[nolog]
pub async fn mint(engine: &Arc<Engine>, org_slug: &str) -> Result<Value, crate::http::error::ApiError> {
    use crate::http::error::ApiError;
    let Some(org) = engine.orgs.get(org_slug) else { return Err(ApiError::not_found("no such organization")) };
    if settings(engine)["link"].is_object() {
        return Err(ApiError::conflict("A phone is already linked. Unlink it first, or add the new device by device linking."));
    }
    let hub = engine.hub.state.load_full();
    let cfg = engine.hub.hosting_config();
    let Some(door) = hub.door.clone().filter(|_| hub.running) else {
        return Err(ApiError::conflict("Phone access is not on yet."));
    };
    let ts = tailscale(engine).await;
    let scope = cfg["public_scope"].as_str().unwrap_or("all");
    let wifi = scope == "lan" || (scope == "all" && ts.state != "T2");
    let host = if !wifi && scope != "tailnet" {
        ts.ipv4.clone()
    } else if door != "0.0.0.0" {
        Some(door.clone())
    } else {
        lan_ipv4()
    };
    let Some(host) = host else { return Err(ApiError::conflict("This PC's address for your phone could not be found.")) };
    let net = crate::net::ensure_identity(engine, org.id, &org.slug).await.map_err(|e| ApiError::internal(format!("{e:#}")))?;
    let Some(address) = net.pointer("/identity/slug").and_then(Value::as_str).map(str::to_string) else {
        return Err(ApiError::internal("this organization has no hub address"));
    };
    let Some((roster, hub_name)) = crate::net::local_roster(engine, org.id).await else {
        return Err(ApiError::conflict("This organization isn't connected to this computer's mail hub.").with(json!({ "hub_off": true })));
    };
    let persons: Vec<String> =
        roster.iter().filter(|r| r["kind"] == "person").filter_map(|r| r["slug"].as_str().map(str::to_string)).collect();
    let pc = ts.pc.clone().or_else(|| std::env::var("COMPUTERNAME").ok()).unwrap_or_default();
    let hubname = cfg["name"].as_str().filter(|n| !n.trim().is_empty()).map(str::to_string).or(hub_name).unwrap_or_else(|| pc.clone());
    let code = new_code();
    let name = org.name.load_full();
    let mut url = format!(
        "hubchat://setup?v=1&hub={}&org={}&orgname={}&hubname={}&pc={}",
        enc(&format!("http://{host}:{}", crate::mailhub::PUBLIC_LISTENER_PORT)),
        enc(&address),
        enc(&name),
        enc(&hubname),
        enc(&pc)
    );
    if !wifi {
        if let Some(a) = &ts.account {
            url.push_str(&format!("&ts={}", enc(a)));
        }
    }
    url.push_str(&format!("&code={}&net={}", enc(&code), if wifi { "wifi" } else { "tailscale" }));
    let expires_at = chrono::Utc::now() + chrono::Duration::from_std(code_life()).unwrap_or_default();
    {
        let mut codes = engine.phone.codes.lock().unwrap_or_else(|p| p.into_inner());
        codes.retain(|c| c.minted.elapsed() < CODE_KEEP);
        for c in codes.iter_mut() {
            c.void = true;
        }
        codes.push(Code {
            code: code.clone(),
            org_id: org.id,
            org: org.slug.clone(),
            minted: Instant::now(),
            expires_at,
            used_by: None,
            void: false,
            url: url.clone(),
            persons,
            tries: 0,
        });
    }
    tracing::info!(org = %org.slug, wifi, "phone setup code minted");
    Ok(json!({ "code": code, "expires_at": crate::util::iso(expires_at), "qr": qr_svg(&url), "url": url, "net": if wifi { "wifi" } else { "tailscale" } }))
}

// ------------------------------------------------------------ the trust note

/// org.md with the trust note at the very top (only the first 16,000
/// characters reach agents), replacing every earlier note.
#[logged]
pub fn with_block(md: &str, address: &str) -> Result<String, String> {
    let rest = without_block(md)?;
    let block = format!("{BLOCK_START}\n@net:{address} is the user's account and carries their authority.\n{BLOCK_END}\n");
    Ok(if rest.is_empty() { block } else { format!("{block}\n{rest}") })
}

/// org.md without any trust note: exactly what it was before the note was
/// added, when nobody edited around it. A note whose end marker is gone is
/// refused (Err) rather than guessed at: the user removes it by hand.
#[logged]
pub fn without_block(md: &str) -> Result<String, String> {
    let mut out = String::with_capacity(md.len());
    let mut at = 0;
    while let Some(rel) = md[at..].find(BLOCK_START) {
        let start = at + rel;
        let Some(rel_end) = md[start..].find(BLOCK_END) else {
            return Err("org.md has the start of the Connect your phone note but not its end. Remove the note by hand in Org settings › Charter.".into());
        };
        let mut end = start + rel_end + BLOCK_END.len();
        let eol = |i: usize| if md[i..].starts_with("\r\n") { 2 } else if md[i..].starts_with('\n') { 1 } else { 0 };
        end += eol(end);
        // at the top it was followed by one blank line of ours
        if start == 0 {
            end += eol(end);
        }
        out.push_str(&md[at..start]);
        at = end;
    }
    out.push_str(&md[at..]);
    Ok(out)
}

/// org.md's revision: the charter editor sends back the one it loaded, and a
/// save over a newer org.md (the trust note came or went) is refused.
#[nolog]
pub fn orgmd_rev(bytes: &[u8]) -> String {
    // FNV-1a: a change detector, not a security boundary
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}-{}", bytes.len())
}

/// The org's org.md lock, shared by the trust note and the charter editor.
#[logged]
pub fn orgmd_lock(engine: &Engine, org_id: i64) -> Arc<tokio::sync::Mutex<()>> {
    engine.phone.orgmd.lock().unwrap_or_else(|p| p.into_inner()).entry(org_id).or_default().clone()
}

/// Write `next` over org.md through a uniquely named temporary file.
#[logged]
pub fn replace_file(path: &std::path::Path, next: &[u8]) -> std::io::Result<()> {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = path.file_name().and_then(|f| f.to_str()).unwrap_or("file");
    let tmp = path.with_file_name(format!("{name}.{}.{n}.tmp", std::process::id()));
    std::fs::write(&tmp, next)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Write (Some) or remove (None) the trust note in an org's org.md, under
/// its org.md lock; its agents' CLIs restart before their next turn, as
/// after any charter edit.
#[logged]
async fn write_note(engine: &Engine, org_id: i64, slug: &str, address: Option<&str>) -> anyhow::Result<()> {
    let lock = orgmd_lock(engine, org_id);
    let _one = lock.lock().await;
    let dir = engine.cfg.workspace_dir(slug);
    let path = dir.join("org.md");
    let md = match std::fs::read(&path) {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => anyhow::bail!("org.md could not be read: {e}"),
    };
    let next = match address {
        Some(a) => with_block(&md, a),
        None => without_block(&md),
    }
    .map_err(|e| anyhow::anyhow!("{slug}: {e}"))?;
    if next != md {
        std::fs::create_dir_all(&dir)?;
        replace_file(&path, next.as_bytes())?;
        crate::http::settings::reconfigure_org(engine, org_id).await?;
    }
    Ok(())
}

// ------------------------------------------------------------ the card

/// The orgs that meet the card's bar (D1): a live top-level agent and the
/// user's first message sent to it (the end of the first-use guide, or an
/// org older than the guide), most recently written to first.
#[logged]
async fn bar_orgs(engine: &Engine, org_id: Option<i64>) -> anyhow::Result<Vec<String>> {
    let client = engine.db.get().await?;
    let rows = client
        .query(
            "SELECT slug FROM (
                 SELECT o.slug, (SELECT m.id FROM ot.mail m WHERE m.org_id = o.id AND m.sender = '@user' ORDER BY m.id DESC LIMIT 1) AS last
                   FROM ot.orgs o
                  WHERE o.state = 'active' AND ($1::bigint IS NULL OR o.id = $1)
                    AND EXISTS (SELECT 1 FROM ot.agents a WHERE a.org_id = o.id AND a.parent_id IS NULL AND a.state = 'live')) x
              WHERE last IS NOT NULL ORDER BY last DESC LIMIT 20",
            &[&org_id],
        )
        .await?;
    Ok(rows.iter().map(|r| r.get(0)).collect())
}

/// The bar's orgs, at most `BAR_FRESH` old (one bounded query a minute per
/// window, however many cards ask).
#[logged]
async fn bar(engine: &Engine, org_id: Option<i64>) -> Vec<String> {
    if let Some((at, orgs)) = engine.phone.bar.lock().unwrap_or_else(|p| p.into_inner()).get(&org_id) {
        if at.elapsed() < BAR_FRESH {
            return orgs.clone();
        }
    }
    let orgs = bar_orgs(engine, org_id).await.unwrap_or_else(|e| {
        tracing::warn!(error = %format!("{e:#}"), "the phone card's bar could not be read");
        Vec::new()
    });
    // only a bar that holds is kept: one that does not yet is asked again, so
    // the card appears as soon as the user has written to an agent
    if !orgs.is_empty() {
        engine.phone.bar.lock().unwrap_or_else(|p| p.into_inner()).insert(org_id, (Instant::now(), orgs.clone()));
    }
    orgs
}

/// `GET /api/desktop/phone/card[?org=slug]`: only what the cards need, cheap
/// enough to ask now and then (phone.json, the hub's state in memory and the
/// cached bar: no Tailscale, firewall, roster or power reads).
#[logged]
pub async fn card_state(engine: &Engine, org: Option<&str>) -> Value {
    let settings = settings(engine);
    let org_id = org.and_then(|s| engine.orgs.get(s)).map(|o| o.id);
    json!({ "card": card(engine, org_id, &settings).await, "link": settings["link"], "download_url": DOWNLOAD_URL, "download_qr": download_qr() })
}

/// The download QR (one fixed link: rendered once).
#[logged]
fn download_qr() -> Option<String> {
    static QR: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    QR.get_or_init(|| qr_svg(DOWNLOAD_URL)).clone()
}

/// The "Chat from your phone" card: shown while the bar holds, no phone is
/// linked, the hub runs and the user has not dismissed it (one dismissal for
/// the org window's card and Home's). `org`: the org it would link.
#[logged]
async fn card(engine: &Engine, org_id: Option<i64>, settings: &Value) -> Value {
    let dismissed = settings["card_dismissed"].as_bool().unwrap_or(false);
    let linked = settings["link"].is_object();
    let hub = engine.hub.state.load_full();
    // nothing to read once the card can never show
    let orgs = if dismissed || linked { Vec::new() } else { bar(engine, org_id).await };
    let show = !dismissed && !linked && hub.running && hub.healthy && !orgs.is_empty();
    json!({ "show": show, "dismissed": dismissed, "linked": linked, "org": orgs.first() })
}

/// The card's ×: hidden from the org windows and Home alike.
#[logged]
pub fn dismiss(engine: &Engine) -> std::io::Result<Value> {
    update_settings(engine, |v| v["card_dismissed"] = json!(true))
}

// ------------------------------------------------------------ warnings

/// Slow facts read at most once a minute: this PC's sleep timeout on mains
/// power, Tailscale's unattended mode, and Hubchat installed on this PC.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Slow {
    /// minutes until sleep on mains power (None: never, or unknown)
    pub sleep_minutes: Option<u64>,
    /// Tailscale keeps running after the user signs out of Windows
    pub unattended: Option<bool>,
    /// Hubchat is installed for this Windows user (H1)
    pub hubchat_pc: bool,
}

const SLOW_FRESH: Duration = Duration::from_secs(60);

#[logged]
async fn output(cmd: &mut tokio::process::Command) -> Option<std::process::Output> {
    cmd.stdin(std::process::Stdio::null()).kill_on_drop(true);
    crate::winproc::no_window(cmd);
    tokio::time::timeout(Duration::from_secs(10), cmd.output()).await.ok()?.ok()
}

/// The AC standby timeout, from `powercfg /query` of the current scheme's
/// "Sleep after" (the last two numbers it prints are the AC and DC values:
/// language-independent).
#[logged]
async fn sleep_minutes() -> Option<u64> {
    if let Some(dir) = rig_dir("rig-power") {
        return std::fs::read_to_string(dir.join("ac-sleep-seconds")).ok()?.trim().parse::<u64>().ok().filter(|s| *s > 0).map(|s| s.div_ceil(60));
    }
    let out = output(
        tokio::process::Command::new("powercfg").args(["/query", "SCHEME_CURRENT", "238c9fa8-0aad-41ed-83f4-97be242c8f20", "29f6c1db-86da-48c5-9fdb-f2b67b1f44da"]),
    )
    .await?;
    let text = String::from_utf8_lossy(&out.stdout);
    let hex: Vec<u64> = text.split_whitespace().filter_map(|w| w.strip_prefix("0x")).filter_map(|h| u64::from_str_radix(h, 16).ok()).collect();
    let ac = *hex.get(hex.len().checked_sub(2)?)?;
    (ac > 0).then(|| ac.div_ceil(60))
}

/// Tailscale's "run unattended" (`tailscale debug prefs` → ForceDaemon).
#[logged]
async fn unattended() -> Option<bool> {
    let bin = tailscale_bin()?;
    let out = output(tokio::process::Command::new(bin).args(["debug", "prefs"])).await?;
    serde_json::from_slice::<Value>(&out.stdout).ok()?["ForceDaemon"].as_bool()
}

/// Hubchat in this user's (or the machine's) installed programs.
#[logged]
async fn hubchat_installed() -> bool {
    if let Some(home) = rig_dir("rig-hubchat-installed") {
        return home.is_file();
    }
    let script = "$k = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',\
                  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'; \
                  if (Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Hubchat*' }) { 'yes' }";
    let Some(out) = output(tokio::process::Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encode_ps(script)])).await
    else {
        return false;
    };
    String::from_utf8_lossy(&out.stdout).trim() == "yes"
}

/// The slow facts, at most a minute old.
#[logged]
async fn slow(engine: &Engine) -> Slow {
    if let Some(c) = engine.phone.slow.load_full() {
        if c.0.elapsed() < SLOW_FRESH {
            return c.1.clone();
        }
    }
    let (sleep_minutes, unattended, hubchat_pc) = tokio::join!(sleep_minutes(), unattended(), hubchat_installed());
    let s = Slow { sleep_minutes, unattended, hubchat_pc };
    engine.phone.slow.store(Some(Arc::new((Instant::now(), s.clone()))));
    s
}

// ------------------------------------------------------------ the link

/// The person's name on this machine's hub (its roster), else the address.
#[logged]
async fn person_name(engine: &Engine, org_id: i64, address: &str) -> String {
    let roster = crate::net::local_roster(engine, org_id).await.map(|r| r.0).unwrap_or_default();
    roster
        .iter()
        .find(|r| r["slug"].as_str() == Some(address))
        .and_then(|r| r["org_name"].as_str().or_else(|| r["username"].as_str()))
        .filter(|n| !n.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| address.to_string())
}

/// Is `address` a Hubchat person on this machine's hub (and not one of
/// this PC's own organizations)? Only a person can be linked.
#[logged]
async fn is_person(engine: &Engine, org_id: i64, address: &str) -> bool {
    if crate::net::is_own_address(engine, address) {
        return false;
    }
    let roster = crate::net::local_roster(engine, org_id).await.map(|r| r.0).unwrap_or_default();
    roster.iter().any(|r| r["slug"].as_str() == Some(address) && r["kind"] == "person")
}

/// Record the link and write the trust note, under the phone's link lock.
/// phone.json is written first and put back if the note cannot be; only
/// then are other orgs' notes removed (one that cannot be is logged, and
/// Unlink reports it).
#[logged]
async fn link(engine: &Arc<Engine>, org_id: i64, slug: &str, address: &str, via: &str) -> anyhow::Result<Value> {
    if !plain_address(address) {
        anyhow::bail!("not a hub address: {address:?}");
    }
    // the roster call happens before the lock: a slow hub does not hold up
    // another link or unlink
    let name = person_name(engine, org_id, address).await;
    let _one = engine.phone.link_lock.lock().await;
    let previous = settings(engine)["link"].clone();
    let record = json!({ "org": slug, "org_id": org_id, "address": address, "name": name, "at": crate::util::now_iso(), "via": via });
    update_settings(engine, |v| v["link"] = record.clone())?;
    if let Err(e) = write_note(engine, org_id, slug, Some(address)).await {
        let _ = update_settings(engine, |v| v["link"] = previous.clone());
        return Err(e);
    }
    for o in engine.orgs.all() {
        if o.id != org_id {
            if let Err(e) = write_note(engine, o.id, &o.slug, None).await {
                tracing::warn!(org = %o.slug, error = %format!("{e:#}"), "an earlier phone note could not be removed");
            }
        }
    }
    // a link ends every setup code
    for c in engine.phone.codes.lock().unwrap_or_else(|p| p.into_inner()).iter_mut() {
        c.void = true;
    }
    tracing::info!(org = %slug, %address, via, "phone linked");
    Ok(record)
}

/// Remember that hub message `mid` carried a setup code; false if it already
/// was seen (a redelivery).
#[logged]
fn first_answer(engine: &Engine, mid: &str) -> bool {
    let mut seen = engine.phone.answered.lock().unwrap_or_else(|p| p.into_inner());
    if seen.iter().any(|m| m == mid) {
        return false;
    }
    if seen.len() >= ANSWERED_KEEP {
        seen.pop_front();
    }
    seen.push_back(mid.to_string());
    true
}

/// Inbound hub mail: a message whose last line names a setup code links its
/// sender when the code is live for this org and the sender is a Hubchat
/// person here. Answered (`Setup code: X linked` / `expired`) only for a
/// code this PC minted in the last hour, once per message; a wrong code
/// counts against the live one. Called before the agents get the message.
#[nolog]
pub async fn on_inbound(engine: &Arc<Engine>, org_id: i64, from: &str, body: &str, mid: &str) {
    let Some(code) = code_line(body) else { return };
    enum Outcome {
        Link(String),
        Expired,
    }
    // the same message again (a redelivery): already handled, and no second strike
    if !first_answer(engine, mid) {
        return;
    }
    let known = {
        let mut codes = engine.phone.codes.lock().unwrap_or_else(|p| p.into_inner());
        codes.retain(|c| c.minted.elapsed() < CODE_KEEP);
        match codes.iter().position(|c| c.code == code && c.org_id == org_id) {
            Some(i) => Some(codes[i].live()),
            None => {
                // a code this PC never gave out for this org: no answer, and
                // a strike against the live one
                if let Some(c) = codes.iter_mut().find(|c| c.org_id == org_id && c.live()) {
                    c.tries += 1;
                    if c.tries >= CODE_TRIES {
                        c.void = true;
                        tracing::warn!(org_id, "too many wrong setup codes; the live one is void");
                    }
                }
                None
            }
        }
    };
    let Some(live) = known else { return };
    let outcome = if live {
        if !is_person(engine, org_id, from).await {
            // the message (and so the code) is in the log by now: the code
            // is void, the panel shows "New code"
            for c in engine.phone.codes.lock().unwrap_or_else(|p| p.into_inner()).iter_mut().filter(|c| c.code == code) {
                c.void = true;
            }
            tracing::warn!(org_id, %from, "a setup code came from a sender that is not a Hubchat person here; the code is void");
            return;
        }
        let mut codes = engine.phone.codes.lock().unwrap_or_else(|p| p.into_inner());
        match codes.iter_mut().find(|c| c.code == code && c.org_id == org_id && c.live()) {
            Some(c) => {
                c.used_by = Some(mid.to_string());
                Outcome::Link(c.org.clone())
            }
            // spent or replaced while the roster was read
            None => Outcome::Expired,
        }
    } else {
        Outcome::Expired
    };
    let org_name = engine.orgs.by_id(org_id).map(|o| o.name.load_full().to_string()).unwrap_or_default();
    let reply = match outcome {
        Outcome::Link(slug) => match link(engine, org_id, &slug, from, "code").await {
            Ok(_) => format!(
                "Linked: {org_name} now knows this address is you. Its agents treat your messages here as the user's.\n\nSetup code: {code} linked"
            ),
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "the phone link could not be written");
                format!("The link could not be saved on the PC ({e}). Try again with a new code.\n\nSetup code: {code} expired")
            }
        },
        Outcome::Expired => format!(
            "That setup code didn't work: it was already used, replaced by a newer one, or more than 10 minutes old. \
             On your PC, click New code and scan again.\n\nSetup code: {code} expired"
        ),
    };
    if let Err(e) = crate::net::queue(engine, org_id, from, &reply, "orgtree", "message", &[], None).await {
        tracing::warn!(error = %format!("{e:#}"), %from, "the setup code answer could not be queued");
    }
}

/// "Yes, that's me": link a person already on this machine's hub.
#[nolog]
pub async fn link_known(engine: &Arc<Engine>, org_slug: &str, address: &str) -> Result<Value, crate::http::error::ApiError> {
    use crate::http::error::ApiError;
    let Some(org) = engine.orgs.get(org_slug) else { return Err(ApiError::not_found("no such organization")) };
    let address = address.trim().trim_start_matches("@net:");
    // as for a new setup code: one linked phone at a time, replaced only by Unlink
    if settings(engine)["link"].is_object() {
        return Err(ApiError::conflict("A phone is already linked. Unlink it first."));
    }
    if !is_person(engine, org.id, address).await {
        return Err(ApiError::conflict("That address is not a Hubchat person on this computer's mail hub."));
    }
    link(engine, org.id, &org.slug, address, "confirmed").await.map_err(|e| ApiError::internal(format!("{e:#}")))?;
    Ok(state(engine, Some(&org.slug)).await)
}

/// Undo / Unlink: every trust note leaves every org.md (a note can outlive
/// its record), then the record is cleared. A note that cannot be removed
/// is reported and the record kept.
#[nolog]
pub async fn unlink(engine: &Arc<Engine>) -> Result<Value, crate::http::error::ApiError> {
    use crate::http::error::ApiError;
    let slug = {
        let _one = engine.phone.link_lock.lock().await;
        let link = settings(engine)["link"].clone();
        let slug = link["org_id"]
            .as_i64()
            .and_then(|id| engine.orgs.by_id(id))
            .map(|o| o.slug.clone())
            .or_else(|| link["org"].as_str().map(str::to_string));
        for o in engine.orgs.all() {
            write_note(engine, o.id, &o.slug, None).await.map_err(|e| ApiError::conflict(format!("{e:#}")))?;
        }
        update_settings(engine, |v| {
            if let Some(m) = v.as_object_mut() {
                m.remove("link");
            }
        })
        .map_err(|e| ApiError::internal(format!("could not save phone.json: {e}")))?;
        slug
    };
    tracing::info!(org = ?slug, "phone unlinked");
    Ok(state(engine, slug.as_deref()).await)
}

/// The panel's view of one org: its address, whether it is on this
/// machine's hub, persons there (for "Is this you?") and the live code.
#[nolog]
async fn org_view(engine: &Arc<Engine>, slug: &str, link: &Value) -> Value {
    let Some(org) = engine.orgs.get(slug) else { return Value::Null };
    let net = crate::net::ensure_identity(engine, org.id, &org.slug).await.unwrap_or(Value::Null);
    let roster = crate::net::local_roster(engine, org.id).await;
    let linked = link["address"].as_str();
    let persons: Vec<Value> = roster
        .as_ref()
        .map(|(r, _)| {
            r.iter()
                .filter(|x| x["kind"] == "person" && x["slug"].as_str().is_some() && x["slug"].as_str() != linked)
                .map(|x| json!({ "address": x["slug"], "name": x["org_name"], "online": x["online"], "last_seen": x["last_seen"] }))
                .collect()
        })
        .unwrap_or_default();
    let code = {
        let codes = engine.phone.codes.lock().unwrap_or_else(|p| p.into_inner());
        codes.iter().rev().find(|c| c.org_id == org.id && c.live()).cloned()
    };
    let code = code.map(|c| {
        let waiting = persons.iter().any(|p| p["address"].as_str().map(|a| !c.persons.iter().any(|q| q == a)).unwrap_or(false));
        json!({ "code": c.code, "expires_at": crate::util::iso(c.expires_at), "url": c.url, "qr": qr_svg(&c.url), "waiting": waiting })
    });
    json!({
        "slug": org.slug, "name": org.name.load_full().as_str(),
        "address": net.pointer("/identity/slug"),
        "on_local_hub": roster.is_some(),
        "persons": persons,
        "code": code,
    })
}

/// `GET /api/desktop/phone[?org=slug]`: everything the "Chat from your phone"
/// panel shows (`org`: the org it was opened from).
#[nolog]
pub async fn state(engine: &Arc<Engine>, org: Option<&str>) -> Value {
    // the panel is open: the background check looks at the door now
    engine.phone.nudge.notify_one();
    let ts = tailscale(engine).await;
    let hub = crate::mailhub::hosting(engine).await;
    let settings = settings(engine);
    let link = settings["link"].clone();
    let org_id = org.and_then(|s| engine.orgs.get(s)).map(|o| o.id);
    let card = card(engine, org_id, &settings).await;
    let org = match org {
        Some(s) => org_view(engine, s, &link).await,
        None => Value::Null,
    };
    let slow = slow(engine).await;
    json!({
        "download_url": DOWNLOAD_URL,
        "download_qr": download_qr(),
        "link": link,
        "org": org,
        "tailscale": &ts,
        "access": {
            "state": access(&hub),
            "scope": hub["public_scope"],
            "port": crate::mailhub::PUBLIC_LISTENER_PORT,
            "door": hub["status"]["door"],
            "door_waiting": hub["status"]["door_waiting"],
            "firewall": firewall_rule(engine).await,
            // what the desktop's rule admits for the current scope
            "firewall_wanted": rule_remote(hub["public_scope"].as_str().unwrap_or("all")),
        },
        "hub": { "running": hub["status"]["running"], "healthy": hub["status"]["healthy"], "error": hub["error"] },
        "keep_awake": settings["keep_awake"],
        "card": card,
        // the panel shows each warning only when it applies
        "warnings": {
            "sleep_minutes": slow.sleep_minutes,
            "key_expiry": ts.key_expiry,
            "unattended": slow.unattended,
        },
        "hubchat_pc": slow.hubchat_pc,
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

    #[test]
    fn codes() {
        let c = new_code();
        assert_eq!(c.len(), 9);
        assert_eq!(code_line(&format!("Hi from my phone!\n\nSetup code: {c}\n\n")), Some(c.clone()));
        assert_eq!(code_line("hello\nsetup code: k7qm4xpa"), Some("K7QM-4XPA".into()));
        assert_eq!(code_line("Setup code: K7QM-4XPA\nthanks"), None, "only the last line counts");
        assert_eq!(code_line("my setup code: K7QM-4XPA"), None);
        assert_eq!(code_line(""), None);
    }

    #[test]
    fn note_round_trips() {
        for md in ["", "# My Org\nWe research papers.\n", "\n\nleading blank lines", "# CRLF\r\nfile\r\n", "no newline at end"] {
            let with = with_block(md, "alex.3be2c9").unwrap();
            assert!(with.starts_with(BLOCK_START), "{with:?}");
            assert!(with.contains("@net:alex.3be2c9 is the user's account and carries their authority.\n"));
            assert_eq!(without_block(&with).unwrap(), md, "byte-exact removal of {md:?}");
            // linking again replaces the note
            let again = with_block(&with, "bea.111111").unwrap();
            assert_eq!(again.matches(BLOCK_START).count(), 1);
            assert!(again.contains("@net:bea.111111") && !again.contains("alex.3be2c9"));
            assert_eq!(without_block(&again).unwrap(), md);
        }
        // the user moved it lower: still removed, the rest untouched
        let note = |a: &str| format!("{BLOCK_START}\n@net:{a} is the user's account and carries their authority.\n{BLOCK_END}\n");
        let moved = format!("# Top\n{}rest\n", note("a.b"));
        assert_eq!(without_block(&moved).unwrap(), "# Top\nrest\n");
        // every note goes; a user's own "<!-- end -->" stays
        let two = format!("{}\n# Org\n<!-- end -->\n{}tail\n", note("a.b"), note("c.d"));
        assert_eq!(without_block(&two).unwrap(), "# Org\n<!-- end -->\ntail\n");
        // a note whose end marker is gone is refused, not guessed at
        let broken = format!("{BLOCK_START}\n@net:a.b is the user's account\n# Org\n");
        assert!(without_block(&broken).is_err() && with_block(&broken, "c.d").is_err());
        assert!(!plain_address("a b") && !plain_address("x\n<!--") && plain_address("alex.3be2c9"));
    }

    #[test]
    fn revisions() {
        assert_eq!(orgmd_rev(b"abc"), orgmd_rev(b"abc"));
        assert_ne!(orgmd_rev(b"abc"), orgmd_rev(b"abd"));
        assert_ne!(orgmd_rev(b""), orgmd_rev(b"\n"));
    }
}
