//! The checks before a token is trusted to an address, in order
//! (docs/rust-engine/remote-org.md, "Adding a remote engine"): the address
//! rule, reach, version and, when adding, scope. The first failure stops
//! with its own sentence. The same checks open every later connection.
//!
//! Everything here is `#[nolog]`: each call carries the token.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use serde_json::Value;

use super::address::{self, Address, Transport};
use super::store::Token;
use super::{text, Kind, Refusal, Timing, REMOTE_MIN_ENGINE};

/// What the checks learned about the engine at an address.
pub struct Probe {
    pub address: Address,
    pub addrs: Vec<SocketAddr>,
    pub transport: Transport,
    /// A client for this connection: no proxy, no redirects, and for plain
    /// http pinned to the addresses the rule passed.
    pub http: reqwest::Client,
    pub data_root_id: String,
    pub version: String,
    /// The remote process (`X-Orgtree-Instance`), empty when it sent none.
    pub boot_id: String,
}

/// The HTTP client of one connection: never through a proxy, never
/// following a redirect, and for plain http only to `addrs`.
#[nolog]
pub fn client(address: &Address, addrs: &[SocketAddr], timing: &Timing) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(timing.connect)
        .pool_idle_timeout(Duration::from_secs(60))
        .user_agent(concat!("Orgtree/", env!("CARGO_PKG_VERSION"), " (remote engine link)"));
    if !address.tls && address.host.parse::<IpAddr>().is_err() {
        builder = builder.resolve_to_addrs(&address.host, addrs);
    }
    builder.build().map_err(|e| format!("the connection could not be set up: {e}"))
}

/// Resolve the saved address, ask the rule, and make the client.
#[nolog]
pub async fn client_for_saved(url: &str, timing: &Timing) -> Result<(reqwest::Client, String), String> {
    let address = Address::parse(url).map_err(str::to_string)?;
    let addrs = address::resolve(&address).await?;
    let ips: Vec<IpAddr> = addrs.iter().map(|a| a.ip()).collect();
    address::vet(address.tls, &ips).map_err(str::to_string)?;
    Ok((client(&address, &addrs, timing)?, address.base()))
}

/// The `detail` of an engine's refusal, or nothing.
#[nolog]
fn detail(body: &[u8]) -> String {
    serde_json::from_slice::<Value>(body).ok().and_then(|v| v["detail"].as_str().map(str::to_string)).unwrap_or_default()
}

/// What a 403 from an engine means.
#[nolog]
fn refusal_403(detail: &str) -> Refusal {
    if detail.contains("desktop token required") {
        Refusal::new(Kind::Refused, "E5", text::E5)
    } else if detail.contains("read-only") || detail.contains("viewer token") {
        Refusal::new(Kind::Refused, "E6", text::E6)
    } else {
        Refusal::new(Kind::Auth, "E4", text::E4)
    }
}

/// `a.b.c` from `orgtree-engine a.b.c[-pre]`.
#[nolog]
pub fn engine_version(host: &Value) -> Option<String> {
    let engine = host["engine"].as_str()?;
    let version = engine.strip_prefix("orgtree-engine ")?.trim();
    (!version.is_empty() && version.len() <= 64 && version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+')))
        .then(|| version.to_string())
}

/// The numeric `major.minor.patch` of a version; a pre-release suffix is not compared.
#[nolog]
pub fn triple(version: &str) -> Option<(u64, u64, u64)> {
    let core = version.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let triple = (parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, parts.next()?.parse().ok()?);
    parts.next().is_none().then_some(triple)
}

/// Steps 1 to 3 (and 4 when `scope`): may the token go there, is it an
/// Orgtree engine that takes the token, is it new enough, and may the token
/// do everything. `name` is how texts call the engine.
#[nolog]
pub async fn probe(address: &Address, token: &Token, timing: &Timing, name: &str, scope: bool) -> Result<Probe, Refusal> {
    let unreachable = || Refusal::new(Kind::Offline, "E3", text::e3(&address.base()));
    // 1. the address rule, on what the name resolves to now
    let addrs = address::resolve(address).await.map_err(|_| unreachable())?;
    let ips: Vec<IpAddr> = addrs.iter().map(|a| a.ip()).collect();
    let transport = address::vet(address.tls, &ips).map_err(|e| Refusal::new(Kind::Refused, "E2", e))?;
    let http = client(address, &addrs, timing).map_err(|_| unreachable())?;
    let base = address.base();
    let get = |path: &'static str| {
        let request = http.get(format!("{base}{path}")).bearer_auth(token.expose()).timeout(timing.request);
        async move {
            let response = request.send().await.map_err(|_| ())?;
            let status = response.status().as_u16();
            let boot = response.headers().get("x-orgtree-instance").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
            let body = read_capped(response, 1 << 20).await.map_err(|_| ())?;
            Ok::<_, ()>((status, boot, body))
        }
    };
    // 2. reach: an Orgtree engine that takes this token
    let (status, boot_id, body) = get("/api/desktop/alive").await.map_err(|_| unreachable())?;
    let data_root_id = match status {
        200 => serde_json::from_slice::<Value>(&body).ok().and_then(|v| v["dataRootId"].as_str().map(str::to_string)).filter(|id| !id.is_empty() && id.len() <= 200)
            .ok_or_else(unreachable)?,
        403 => return Err(refusal_403(&detail(&body))),
        _ => return Err(unreachable()),
    };
    // 3. version
    let (status, _, body) = get("/api/host").await.map_err(|_| unreachable())?;
    let version = match status {
        200 => serde_json::from_slice::<Value>(&body).ok().and_then(|v| engine_version(&v)).ok_or_else(unreachable)?,
        403 => return Err(refusal_403(&detail(&body))),
        _ => return Err(unreachable()),
    };
    if triple(&version).is_none_or(|v| v < REMOTE_MIN_ENGINE) {
        let min = format!("{}.{}.{}", REMOTE_MIN_ENGINE.0, REMOTE_MIN_ENGINE.1, REMOTE_MIN_ENGINE.2);
        return Err(Refusal::new(Kind::Refused, "E7", text::e7(name, &version, &min)));
    }
    // 4. scope: the standalone API, with a token that may do everything
    if scope {
        let (status, _, body) = get("/api/standalone/clients").await.map_err(|_| unreachable())?;
        match status {
            200 => {}
            403 => return Err(refusal_403(&detail(&body))),
            404 => return Err(Refusal::new(Kind::Refused, "E5", text::E5)),
            _ => return Err(unreachable()),
        }
    }
    Ok(Probe { address: address.clone(), addrs, transport, http, data_root_id, version, boot_id })
}

/// At most `cap` bytes of a response body.
#[nolog]
async fn read_capped(mut response: reqwest::Response, cap: usize) -> Result<Vec<u8>, ()> {
    let mut out = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if out.len() + chunk.len() > cap {
            return Err(());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// Step 5: this desktop's own named client token on the remote, made with
/// the pasted one. Answers the new token and its client id.
#[nolog]
pub async fn mint(probe: &Probe, pasted: &Token, client_name: &str, timing: &Timing) -> Result<(Token, String), String> {
    let response = probe.http.post(format!("{}/api/standalone/clients", probe.address.base())).bearer_auth(pasted.expose())
        .timeout(timing.request).json(&serde_json::json!({ "name": client_name })).send().await.map_err(|_| "no answer".to_string())?;
    let status = response.status().as_u16();
    let body = read_capped(response, 64 * 1024).await.map_err(|_| "unreadable answer".to_string())?;
    if status != 200 {
        return Err(format!("HTTP {status}"));
    }
    let value: Value = serde_json::from_slice(&body).map_err(|_| "unreadable answer".to_string())?;
    let (Some(token), Some(id)) = (value["token"].as_str(), value["id"].as_str()) else {
        return Err("the answer has no token".into());
    };
    if token.is_empty() || token.len() > 512 || id.is_empty() || id.len() > 100 {
        return Err("the answer's token is not usable".into());
    }
    Ok((Token::new(token), id.to_string()))
}

/// Take back a client token on the remote, with that very token. The remote
/// drops the caller's connection as it revokes, so an answer may never come:
/// then the token is tried once more, and a refusal proves the revocation.
#[nolog]
pub async fn revoke(http: &reqwest::Client, base: &str, token: &Token, client_id: &str, wait: Duration) -> bool {
    let sent = http.delete(format!("{base}/api/standalone/clients/{client_id}")).bearer_auth(token.expose()).timeout(wait).send().await;
    if let Ok(response) = &sent {
        if response.status().as_u16() == 200 {
            return true;
        }
    }
    match http.get(format!("{base}/api/desktop/alive")).bearer_auth(token.expose()).timeout(wait).send().await {
        Ok(response) => response.status().as_u16() == 403,
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_engine_version_is_read_from_the_host_answer_and_compared_by_its_numbers() {
        let host = |engine: &str| serde_json::json!({ "engine": engine });
        assert_eq!(engine_version(&host("orgtree-engine 4.5.11")).as_deref(), Some("4.5.11"));
        assert_eq!(engine_version(&host("orgtree-engine 4.6.0-alpha.2")).as_deref(), Some("4.6.0-alpha.2"));
        assert_eq!(engine_version(&host("something else 1.0")), None);
        assert_eq!(engine_version(&host("orgtree-engine <script>")), None);
        assert_eq!(triple("4.5.11"), Some((4, 5, 11)));
        assert_eq!(triple("4.6.0-alpha.2"), Some((4, 6, 0)));
        assert_eq!(triple("4.5"), None);
        assert_eq!(triple("4.5.x"), None);
        assert!(triple("4.5.10").unwrap() < REMOTE_MIN_ENGINE && triple("4.5.11").unwrap() >= REMOTE_MIN_ENGINE);
        assert!(triple("4.10.0").unwrap() > triple("4.9.9").unwrap(), "numbers, not text");
    }

    #[test]
    fn a_refusal_names_what_the_engine_said() {
        assert_eq!(refusal_403("standalone token required").code, "E4");
        assert_eq!(refusal_403("desktop token required").code, "E5");
        assert_eq!(refusal_403("this client token is read-only").code, "E6");
        assert_eq!(refusal_403("this viewer token's org no longer exists").code, "E6");
        assert_eq!(refusal_403("").code, "E4");
        assert_eq!(detail(br#"{"detail":"standalone token required"}"#), "standalone token required");
        assert_eq!(detail(b"<html>"), "");
    }
}
