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
    /// What the engine says it is (`GET /api/host`, `mode`): `host` for a desktop that lets
    /// this computer open some of its organizations, `standalone` for an engine that runs by
    /// itself, empty for an engine older than 4.6.0 (which is a standalone one).
    pub mode: String,
    /// The computer that engine runs on, when it says so.
    pub computer: Option<String>,
}

#[nolog]
impl Probe {
    /// Is this a hosting desktop? Then what was pasted is a one-time code: it makes this
    /// desktop's own token and is nothing after that.
    pub fn hosted(&self) -> bool {
        self.mode == "host"
    }
}

/// What an engine says it is, as far as this side goes by it.
#[nolog]
fn host_mode(host: &Value) -> String {
    match host["mode"].as_str() {
        Some(mode @ ("host" | "standalone")) => mode.to_string(),
        _ => String::new(),
    }
}

/// The name of the computer an engine runs on: printable, at most 60 characters.
#[nolog]
fn host_computer(host: &Value) -> Option<String> {
    let name = host["computer"].as_str()?.trim();
    (!name.is_empty() && name.chars().count() <= 60 && !name.chars().any(char::is_control)).then(|| name.to_string())
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
    let (version, mode, computer) = match status {
        200 => {
            let host: Value = serde_json::from_slice(&body).map_err(|_| unreachable())?;
            (engine_version(&host).ok_or_else(unreachable)?, host_mode(&host), host_computer(&host))
        }
        403 => return Err(refusal_403(&detail(&body))),
        _ => return Err(unreachable()),
    };
    if triple(&version).is_none_or(|v| v < REMOTE_MIN_ENGINE) {
        let min = format!("{}.{}.{}", REMOTE_MIN_ENGINE.0, REMOTE_MIN_ENGINE.1, REMOTE_MIN_ENGINE.2);
        return Err(Refusal::new(Kind::Refused, "E7", text::e7(name, &version, &min)));
    }
    // 4. scope: the standalone API, with a token that may do everything. A hosting desktop is
    //    not asked: what was pasted there is a one-time code, which may read no list at all,
    //    and the token this desktop then holds is a member's by design.
    if scope && mode != "host" {
        let (status, _, body) = get("/api/standalone/clients").await.map_err(|_| unreachable())?;
        match status {
            200 => {}
            403 => return Err(refusal_403(&detail(&body))),
            404 => return Err(Refusal::new(Kind::Refused, "E5", text::E5)),
            _ => return Err(unreachable()),
        }
    }
    Ok(Probe { address: address.clone(), addrs, transport, http, data_root_id, version, boot_id, mode, computer })
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

/// The remote engine's client list as this token may read it: the clients,
/// and from 4.6.0 `you` (whose token asked) and who is connected. Nothing
/// when the engine did not answer with one.
#[nolog]
pub async fn clients(http: &reqwest::Client, base: &str, token: &Token, wait: Duration) -> Option<Value> {
    let response = http.get(format!("{base}/api/standalone/clients")).bearer_auth(token.expose()).timeout(wait).send().await.ok()?;
    if response.status().as_u16() != 200 {
        return None;
    }
    serde_json::from_slice(&read_capped(response, 1 << 20).await.ok()?).ok()
}

/// Give this desktop's own client on the remote the name other people see
/// (`None`: its own name again). Answers the name it has there now; nothing
/// when the engine did not take it (an engine older than 4.6.0 has no such route).
#[nolog]
pub async fn set_label(http: &reqwest::Client, base: &str, token: &Token, client_id: &str, label: Option<&str>, wait: Duration) -> Option<String> {
    let response = http.patch(format!("{base}/api/standalone/clients/{client_id}")).bearer_auth(token.expose()).timeout(wait)
        .json(&serde_json::json!({ "label": label })).send().await.ok()?;
    if response.status().as_u16() != 200 {
        return None;
    }
    let row: Value = serde_json::from_slice(&read_capped(response, 64 * 1024).await.ok()?).ok()?;
    row["label"].as_str().map(|label| label.chars().take(crate::caller::LABEL_MAX).collect())
}

/// Take back a client token on the remote, with that very token, within
/// `wait`. The remote ends every connection of the client as it revokes it,
/// the one that carries this request too, and promises no answer; a
/// connection kept from before can fail once more as it is found dead. So a
/// request that ends without an answer is made again: an engine that no
/// longer knows the token then proves the revocation. Any other answer is
/// final, and an engine that cannot be reached is not asked twice.
#[nolog]
pub async fn revoke(http: &reqwest::Client, base: &str, token: &Token, client_id: &str, wait: Duration) -> bool {
    let end = tokio::time::Instant::now() + wait;
    let mut pause = Duration::from_millis(100);
    loop {
        let left = end.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            return false;
        }
        match http.delete(format!("{base}/api/standalone/clients/{client_id}")).bearer_auth(token.expose()).timeout(left).send().await {
            Ok(response) => {
                return match response.status().as_u16() {
                    200 => true,
                    // the token is not known there any more: the request before this one revoked it, and its answer was cut.
                    // An engine that is no longer standalone, or takes the token for reading only, proves nothing.
                    403 => refusal_403(&detail(&read_capped(response, 16 * 1024).await.unwrap_or_default())).code == "E4",
                    _ => false,
                };
            }
            Err(error) if error.is_connect() || error.is_timeout() => return false,
            Err(_) => {}
        }
        tokio::time::sleep(pause.min(left)).await;
        pause *= 2;
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

    /// Just enough HTTP for `revoke`: every connection is treated as the next
    /// entry of `script` says, the last entry for all that follow. `None`
    /// reads the request and ends the connection without an answer, as an
    /// engine does to every connection of a client it revokes; `Some((status,
    /// detail))` answers with that status and that `detail`. Answers the base
    /// address and the request lines heard.
    async fn scripted(script: Vec<Option<(u16, &'static str)>>) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let heard = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = heard.clone();
        tokio::spawn(async move {
            let mut at = 0;
            while let Ok((mut socket, _)) = listener.accept().await {
                let step = script[at.min(script.len() - 1)];
                at += 1;
                let (mut request, mut buf) = (Vec::new(), [0u8; 1024]);
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match socket.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                seen.lock().unwrap().push(String::from_utf8_lossy(&request).lines().next().unwrap_or("").to_string());
                if let Some((status, detail)) = step {
                    let body = serde_json::json!({ "detail": detail }).to_string();
                    let head = format!("HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
                    let _ = socket.write_all(format!("{head}{body}").as_bytes()).await;
                    let _ = socket.shutdown().await;
                }
            }
        });
        (base, heard)
    }

    fn plain_client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    /// The engine that revokes a client ends every connection of that client,
    /// the one that carried the request too, and promises no answer. A
    /// connection kept from before can then fail once more as it is found
    /// dead. Neither may be read as "not revoked".
    #[tokio::test]
    async fn a_revocation_whose_answer_never_came_is_proved_by_asking_again() {
        let (base, heard) = scripted(vec![None, None, Some((403, "standalone token required"))]).await;
        let revoked = revoke(&plain_client(), &base, &Token::new("own-client-token"), "client-1", Duration::from_secs(5)).await;
        assert!(revoked, "the token is refused now: it was revoked; heard {:?}", heard.lock().unwrap());
        assert_eq!(heard.lock().unwrap().len(), 3, "{:?}", heard.lock().unwrap());
    }

    #[tokio::test]
    async fn an_engine_that_answers_without_revoking_is_not_asked_again() {
        let (base, heard) = scripted(vec![None, Some((404, "active client token not found"))]).await;
        let revoked = revoke(&plain_client(), &base, &Token::new("own-client-token"), "client-1", Duration::from_secs(5)).await;
        assert!(!revoked, "an answer that neither revokes nor refuses the token is the end");
        assert_eq!(heard.lock().unwrap().len(), 2, "{:?}", heard.lock().unwrap());
    }

    /// 403 is also what an engine answers that is not standalone any more, or
    /// that takes the token for reading only: neither says the client is gone.
    #[tokio::test]
    async fn a_refusal_that_is_not_about_an_unknown_token_proves_nothing() {
        for detail in ["desktop token required", "this client token is read-only"] {
            let (base, _) = scripted(vec![None, Some((403, detail))]).await;
            let revoked = revoke(&plain_client(), &base, &Token::new("own-client-token"), "client-1", Duration::from_secs(5)).await;
            assert!(!revoked, "{detail}");
        }
    }

    #[tokio::test]
    async fn an_engine_that_never_answers_is_given_up_within_the_wait() {
        let (base, heard) = scripted(vec![None]).await;
        let started = std::time::Instant::now();
        let revoked = revoke(&plain_client(), &base, &Token::new("own-client-token"), "client-1", Duration::from_millis(700)).await;
        assert!(!revoked, "nothing proved a revocation");
        assert!(started.elapsed() < Duration::from_secs(3), "took {:?}", started.elapsed());
        assert!(heard.lock().unwrap().len() >= 2, "asked more than once: {:?}", heard.lock().unwrap());
    }
}
