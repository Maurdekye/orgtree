//! Internet access for apps (the `net.fetch` capability, 4.5.0; USER 2026-10-26
//! m95c57abc95fb "build internet access as a permission for the apps"). The
//! sandboxed frame's CSP and its Electron session stay no-network; an app
//! reaches the internet only by asking the engine to make one HTTPS request on
//! its behalf. The engine adds nothing of the user's: no cookies, no proxy, no
//! engine credential, no ambient headers. It connects only to public addresses
//! that are not this machine's own, and re-checks the address and the app's
//! grant at every redirect hop, so neither DNS rebinding nor a redirect can
//! reach the engine, localhost or the LAN.
//!
//! This module is the mechanism. policy.rs decides WHICH hosts an app may reach
//! from the user's stored choices; the bridge passes that decision in as
//! `allow`. Bounds are provisional 4.5.0 values.
use anyhow::Result;
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

pub const CAPABILITY: &str = "net.fetch";
/// Request body, response body, the whole request (every hop), redirect hops.
pub const REQUEST_MAX: usize = 1024 * 1024;
pub const RESPONSE_MAX: usize = 4 * 1024 * 1024;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const MAX_REDIRECTS: usize = 5;
pub const URL_MAX: usize = 8192;
pub const HEADERS_MAX: usize = 64;
pub const HEADER_BYTES_MAX: usize = 64 * 1024;
/// The bridge body a net.fetch call may use: the base64 body plus URL/headers.
pub const BRIDGE_INPUT_MAX: usize = 1536 * 1024;
/// Declared sites per app, stored site choices per app, "Allow once" answers
/// per app, and the per-app rate/concurrency the bridge enforces.
pub const SITES_MAX: usize = 32;
pub const SITE_CHOICES_MAX: usize = 128;
pub const ONCE_MAX: usize = 64;
pub const PER_MINUTE: usize = 120;
pub const CONCURRENT: usize = 8;
const WINDOW: Duration = Duration::from_secs(60);

/// Methods an app may use. No CONNECT/TRACE; nothing that is not a plain fetch.
pub const METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

/// Whether fetch calls `name: value` a CORS-safelisted request-header, one a
/// browser sends to any origin without asking it: Accept, Accept-Language,
/// Content-Language, or Content-Type whose essence is
/// application/x-www-form-urlencoded, multipart/form-data or text/plain. The
/// value is at most 128 bytes and has none of the bytes fetch calls CORS-unsafe;
/// the language headers allow only letters, digits and ` *,-.;=`.
#[nolog]
pub fn cors_safelisted(name: &str, value: &str) -> bool {
    let unsafe_byte = |b: u8| (b < 0x20 && b != b'\t') || b"\"():<>?@[\\]{}\x7f".contains(&b);
    if value.len() > 128 {
        return false;
    }
    match name.to_ascii_lowercase().as_str() {
        "accept" => !value.bytes().any(unsafe_byte),
        "accept-language" | "content-language" => value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b" *,-.;=".contains(&b)),
        "content-type" => {
            !value.bytes().any(unsafe_byte)
                && mime_essence(value).is_some_and(|essence| {
                    matches!(
                        essence.as_str(),
                        "application/x-www-form-urlencoded" | "multipart/form-data" | "text/plain"
                    )
                })
        }
        _ => false,
    }
}

/// A MIME type's essence, `type/subtype` in lowercase, as fetch parses it; None
/// when it does not parse.
#[nolog]
fn mime_essence(value: &str) -> Option<String> {
    let token = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
    };
    let space: &[char] = &['\t', '\n', '\r', ' '];
    let (kind, rest) = value.trim_matches(space).split_once('/')?;
    let sub = rest.split(';').next().unwrap_or_default().trim_end_matches(space);
    (token(kind) && token(sub))
        .then(|| format!("{}/{}", kind.to_ascii_lowercase(), sub.to_ascii_lowercase()))
}

/// The headers a redirect carries to another host or port: the CORS-safelisted
/// ones, and none of them when their values exceed fetch's 1024 bytes together.
/// Any other header an app sets may hold a credential (Authorization,
/// X-API-Key, a session token, or a token in a Content-Type parameter).
#[nolog]
pub fn cross_site_headers(headers: Vec<(String, String)>) -> Vec<(String, String)> {
    let kept: Vec<(String, String)> = headers
        .into_iter()
        .filter(|(name, value)| cors_safelisted(name, value))
        .collect();
    if kept.iter().map(|(_, value)| value.len()).sum::<usize>() > 1024 {
        Vec::new()
    } else {
        kept
    }
}

/// Headers an app may never set: identity/routing the engine owns, and the
/// hop-by-hop set reqwest manages. Matched case-insensitively.
#[nolog]
pub fn header_forbidden(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n == "cookie"
        || n == "host"
        || n == "content-length"
        || n == "connection"
        || n == "keep-alive"
        || n.starts_with("proxy-")
        || n == "transfer-encoding"
        || n == "te"
        || n == "trailer"
        || n == "upgrade"
}

/// A declared site is `host` or `host:port` (port defaults to 443), or the exact
/// token `*` for any site. A host may lead with `*.` for its subdomains. Hosts
/// are lowercase DNS names or IP literals (IPv6 in brackets); no scheme, path,
/// userinfo or spaces.
#[nolog]
pub fn valid_site(site: &str) -> Result<()> {
    if site == "*" {
        return Ok(());
    }
    if site.is_empty()
        || site.len() > 255
        || site.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        crate::refuse!(BadRequest, "a declared site is a host, host:port, or *");
    }
    let (host, port) = split_host_port(site)?;
    if port == Some(0) {
        crate::refuse!(BadRequest, "declared site port must be 1-65535");
    }
    let bare = host.strip_prefix("*.").unwrap_or(host);
    if bare.is_empty() || bare.starts_with('.') || bare.ends_with('.') || bare.contains("..") {
        crate::refuse!(BadRequest, "declared site host is malformed");
    }
    // The characters a DNS name or an IP literal can take; '*' only as the
    // leading subdomain wildcard already stripped above.
    if !bare
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-' || c == ':')
    {
        crate::refuse!(
            BadRequest,
            "declared site hosts are lowercase names or IP addresses"
        );
    }
    Ok(())
}

/// `host[:port]` → (host, port). A bracketed IPv6 literal keeps its colons.
#[nolog]
fn split_host_port(site: &str) -> Result<(&str, Option<u16>)> {
    if let Some(rest) = site.strip_prefix('[') {
        // [v6]:port or [v6]
        let close = rest.find(']').ok_or_else(|| {
            crate::domain::UserError::BadRequest("unbalanced IPv6 brackets".into())
        })?;
        let host = &rest[..close];
        let after = &rest[close + 1..];
        let port = match after.strip_prefix(':') {
            Some(p) => Some(
                p.parse::<u16>()
                    .map_err(|_| crate::domain::UserError::BadRequest("invalid port".into()))?,
            ),
            None if after.is_empty() => None,
            None => crate::refuse!(BadRequest, "invalid IPv6 site"),
        };
        return Ok((host, port));
    }
    match site.rsplit_once(':') {
        // A single colon with digits after it is a port; an IPv6 literal has
        // several colons and is required to be bracketed above.
        Some((h, p))
            if !h.contains(':') && p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty() =>
        {
            Ok((
                h,
                Some(
                    p.parse::<u16>()
                        .map_err(|_| crate::domain::UserError::BadRequest("invalid port".into()))?,
                ),
            ))
        }
        _ => Ok((site, None)),
    }
}

/// A concrete site row (no wildcard) as the host and port it names.
#[nolog]
pub fn host_port(site: &str) -> Result<(String, u16)> {
    let (host, port) = split_host_port(site)?;
    Ok((host.to_ascii_lowercase(), port.unwrap_or(443)))
}

/// The row name for one concrete host: `host`, or `host:port` off 443; an IPv6
/// literal goes in brackets.
#[nolog]
pub fn site_key(host: &str, port: u16) -> String {
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    if port == 443 {
        host
    } else {
        format!("{host}:{port}")
    }
}

/// Does a declared site cover this request host and port? `*` covers everything;
/// `*.example.com` covers any subdomain but not the bare apex; an explicit port
/// must equal the request port, and an omitted one means 443.
#[nolog]
pub fn site_matches(decl: &str, host: &str, port: u16) -> bool {
    if decl == "*" {
        return true;
    }
    let Ok((dhost, dport)) = split_host_port(decl) else {
        return false;
    };
    if dport.unwrap_or(443) != port {
        return false;
    }
    let host = host.to_ascii_lowercase();
    match dhost.strip_prefix("*.") {
        // A subdomain wildcard matches host ending in ".suffix" with at least
        // one label before the dot; never the bare apex or a different domain.
        Some(suffix) => {
            let dotted = format!(".{}", suffix.to_ascii_lowercase());
            host.len() > dotted.len() && host.ends_with(&dotted)
        }
        None => host == dhost.to_ascii_lowercase(),
    }
}

/// The URL an app may ask for: HTTPS only, a host, no embedded credentials.
#[nolog]
pub fn validate_url(url: &reqwest::Url) -> Result<()> {
    if url.scheme() != "https" {
        crate::refuse!(BadRequest, "app internet requests must use https");
    }
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        crate::refuse!(
            BadRequest,
            "app internet URL must have a host and no embedded credentials"
        );
    }
    if url.as_str().len() > URL_MAX {
        crate::refuse!(BadRequest, "app internet URL exceeds 8192 characters");
    }
    Ok(())
}

/// The request host and port as the grant check and resolver see them: a DNS
/// name lowercased, an IP literal without IPv6 brackets.
#[nolog]
pub fn url_host_port(url: &reqwest::Url) -> Result<(String, u16)> {
    let host = url.host_str().ok_or_else(|| {
        crate::domain::UserError::BadRequest("app internet URL must have a host".into())
    })?;
    let host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    let port = url.port_or_known_default().unwrap_or(443);
    Ok((host.to_ascii_lowercase(), port))
}

// Address classification, copied from `http/markdown_image.rs` so the engine's
// own image fetcher and this share one definition of "public". Keep them equal.
#[nolog]
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_v4(ip),
        IpAddr::V6(ip) => is_public_v6(ip),
    }
}
#[nolog]
fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_broadcast()
        || a == 0
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113))
}
#[nolog]
fn is_public_v6(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    (s[0] & 0xe000) == 0x2000
        && !(s[0] == 0x2001 && (s[1] <= 0x01ff || s[1] == 0x0db8))
        && !(s[0] == 0x2002)
        && !(s[0] == 0x3fff && (s[1] & 0xf000) == 0)
        && ip.to_ipv4_mapped().is_none()
}

/// Whether an address is one of this machine's own: a public address on its
/// own interface reaches services bound to every interface. A connected UDP
/// socket sends nothing; the OS picks the route's source address, and for an
/// address of this machine that is the address itself. Fails closed.
#[nolog]
pub fn is_own_address(ip: IpAddr) -> bool {
    let any: SocketAddr = if ip.is_ipv4() {
        (Ipv4Addr::UNSPECIFIED, 0).into()
    } else {
        (Ipv6Addr::UNSPECIFIED, 0).into()
    };
    let Ok(socket) = std::net::UdpSocket::bind(any) else {
        return true;
    };
    // No route means no connection either; the TCP connect fails on its own.
    if socket.connect((ip, 9)).is_err() {
        return false;
    }
    socket
        .local_addr()
        .map(|local| local.ip() == ip)
        .unwrap_or(true)
}

/// One app request. `method` is validated against `METHODS`, `headers` against
/// `header_forbidden`; `body` is bounded by `REQUEST_MAX`.
pub struct Fetch {
    pub url: reqwest::Url,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}
pub struct Fetched {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub final_url: String,
    pub redirected: bool,
}
/// Responses are private app content: status and size only.
impl std::fmt::Debug for Fetched {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "[app internet response {} omitted, {} bytes]",
            self.status,
            self.body.len()
        )
    }
}

#[nolog]
pub fn validate_fetch(f: &Fetch) -> Result<()> {
    validate_url(&f.url)?;
    if !METHODS.contains(&f.method.as_str()) {
        crate::refuse!(BadRequest, "unsupported app internet method");
    }
    if f.headers.len() > HEADERS_MAX
        || f.headers
            .iter()
            .map(|(n, v)| n.len() + v.len())
            .sum::<usize>()
            > HEADER_BYTES_MAX
    {
        crate::refuse!(
            BadRequest,
            "app internet request headers exceed 64 entries or 64 KiB"
        );
    }
    for (name, value) in &f.headers {
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c))
        {
            crate::refuse!(BadRequest, "invalid app internet header name");
        }
        if header_forbidden(name) {
            crate::refuse!(
                Forbidden,
                "app internet request may not set the {name} header"
            );
        }
        if value.chars().any(|c| c == '\r' || c == '\n' || c == '\0') {
            crate::refuse!(BadRequest, "invalid app internet header value");
        }
    }
    if f.body.as_ref().is_some_and(|b| b.len() > REQUEST_MAX) {
        crate::refuse!(BadRequest, "app internet request body exceeds 1 MiB");
    }
    if f.body.is_some() && matches!(f.method.as_str(), "GET" | "HEAD") {
        crate::refuse!(BadRequest, "a GET or HEAD app internet request has no body");
    }
    Ok(())
}

/// Resolve `host:port` to one public socket address, refusing if any resolved
/// address is non-public or this machine's own (so a name that resolves partly
/// to such an address cannot be used to reach it). IP literals are classified
/// directly.
#[nolog]
async fn resolve_public(host: &str, port: u16) -> Result<SocketAddr> {
    let refused = |ip: IpAddr| !is_public_ip(ip) || is_own_address(ip);
    if let Ok(ip) = host.parse::<IpAddr>() {
        if refused(ip) {
            crate::refuse!(Forbidden, "app internet target is not a public address");
        }
        return Ok(SocketAddr::new(ip, port));
    }
    let addrs = tokio::net::lookup_host((host, port)).await.map_err(|_| {
        crate::domain::UserError::BadRequest("app internet host did not resolve".into())
    })?;
    let mut chosen = None;
    for addr in addrs {
        if refused(addr.ip()) {
            crate::refuse!(
                Forbidden,
                "app internet target resolves to a non-public address"
            );
        }
        chosen.get_or_insert(addr);
    }
    chosen.ok_or_else(|| {
        crate::domain::UserError::BadRequest("app internet host did not resolve".into()).into()
    })
}

/// Tests reach a local TLS server under a test host name; this route exists
/// only in test builds, never in the engine binary.
#[cfg(test)]
pub(crate) static TEST_ROUTES: Mutex<Vec<(String, SocketAddr, Vec<u8>)>> = Mutex::new(Vec::new());
#[cfg(test)]
#[nolog]
fn test_route(host: &str) -> Option<(SocketAddr, Vec<u8>)> {
    let routes = TEST_ROUTES.lock().ok()?;
    routes
        .iter()
        .find(|(h, ..)| h == host)
        .map(|(_, addr, ca)| (*addr, ca.clone()))
}
#[cfg(not(test))]
#[nolog]
fn test_route(_host: &str) -> Option<(SocketAddr, Vec<u8>)> {
    None
}

/// Make the request. `allow(host, port)` is the caller's current grant check; it
/// is consulted for the initial URL and again for every redirect target, so a
/// redirect can only reach a host the app is still granted. No cookie store, no
/// proxy, no default headers, no engine credential; connection pinned to the
/// vetted address; redirects followed by hand and re-checked; one deadline for
/// the whole request, every hop and the body included.
#[nolog]
pub async fn fetch(mut f: Fetch, allow: &(dyn Fn(&str, u16) -> bool + Sync)) -> Result<Fetched> {
    validate_fetch(&f)?;
    let deadline = tokio::time::Instant::now() + REQUEST_TIMEOUT;
    let left = || {
        deadline
            .checked_duration_since(tokio::time::Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or_else(|| {
                anyhow::Error::from(crate::domain::UserError::BadRequest(
                    "app internet request timed out after 30 seconds".into(),
                ))
            })
    };
    for hop in 0..=MAX_REDIRECTS {
        validate_url(&f.url)?;
        let (host, port) = url_host_port(&f.url)?;
        if !allow(&host, port) {
            crate::refuse!(
                Forbidden,
                "app is not granted internet access to {}",
                site_key(&host, port)
            );
        }
        let route = test_route(&host);
        let addr = match &route {
            Some((addr, _)) => *addr,
            None => tokio::time::timeout(left()?, resolve_public(&host, port))
                .await
                .map_err(|_| {
                    crate::domain::UserError::BadRequest(
                        "app internet request timed out after 30 seconds".into(),
                    )
                })??,
        };
        // reqwest is built WITHOUT the "cookies" feature, so there is no cookie
        // jar at all: no Cookie is sent and Set-Cookie is dropped. No proxy, no
        // Referer, https only, and the connection is pinned to the vetted address.
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .referer(false)
            .https_only(true)
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(left()?);
        if host.parse::<IpAddr>().is_err() {
            builder = builder.resolve(&host, addr);
        }
        if let Some((_, ca)) = &route {
            builder = builder.add_root_certificate(reqwest::Certificate::from_der(ca)?);
        }
        let client = builder.build()?;
        let method = reqwest::Method::from_bytes(f.method.as_bytes()).map_err(|_| {
            crate::domain::UserError::BadRequest("unsupported app internet method".into())
        })?;
        let mut req = client.request(method, f.url.clone());
        for (name, value) in &f.headers {
            req = req.header(name.as_str(), value.as_str());
        }
        if let Some(body) = f.body.clone() {
            req = req.body(body);
        }
        let response = req.send().await.map_err(|e| {
            crate::domain::UserError::BadRequest(if e.is_timeout() {
                "app internet request timed out after 30 seconds".into()
            } else {
                "app internet request failed".into()
            })
        })?;
        let status = response.status();
        if status.is_redirection() && response.headers().contains_key(reqwest::header::LOCATION) {
            if hop == MAX_REDIRECTS {
                crate::refuse!(
                    BadRequest,
                    "app internet request exceeded the redirect limit"
                );
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| {
                    crate::domain::UserError::BadRequest(
                        "app internet redirect location is invalid".into(),
                    )
                })?;
            let next = f.url.join(location).map_err(|_| {
                crate::domain::UserError::BadRequest(
                    "app internet redirect location is invalid".into(),
                )
            })?;
            // 307/308 keep the method and body; every other redirect continues
            // as a GET without a body, as browsers do.
            if !matches!(status.as_u16(), 307 | 308) {
                f.method = if f.method == "HEAD" {
                    "HEAD".into()
                } else {
                    "GET".into()
                };
                f.body = None;
                f.headers
                    .retain(|(n, _)| !n.eq_ignore_ascii_case("content-type"));
            }
            // Credentials the app chose for one site never follow it elsewhere:
            // a hop to another host or port keeps only CORS-safelisted headers,
            // judged by name and value (review B8: dropping Authorization alone
            // sent X-API-Key on; names alone sent a token in Content-Type on).
            if url_host_port(&next)? != (host.clone(), port) {
                f.headers = cross_site_headers(std::mem::take(&mut f.headers));
            }
            f.url = next;
            continue;
        }
        let final_url = response.url().to_string();
        let headers: Vec<(String, String)> = response
            .headers()
            .iter()
            .filter(|(n, _)| {
                !n.as_str().eq_ignore_ascii_case("set-cookie")
                    && !n.as_str().eq_ignore_ascii_case("set-cookie2")
            })
            .map(|(n, v)| {
                (
                    n.as_str().to_owned(),
                    String::from_utf8_lossy(v.as_bytes()).into_owned(),
                )
            })
            .collect();
        let body = bounded_body(response).await?;
        return Ok(Fetched {
            status: status.as_u16(),
            headers,
            body,
            final_url,
            redirected: hop > 0,
        });
    }
    crate::refuse!(
        BadRequest,
        "app internet request exceeded the redirect limit"
    );
}

/// Read a response body, refusing past `RESPONSE_MAX` without buffering it all.
#[nolog]
async fn bounded_body(response: reqwest::Response) -> Result<Vec<u8>> {
    use futures::StreamExt;
    if response
        .content_length()
        .is_some_and(|len| len > RESPONSE_MAX as u64)
    {
        crate::refuse!(BadRequest, "app internet response exceeds 4 MiB");
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            crate::domain::UserError::BadRequest(if e.is_timeout() {
                "app internet request timed out after 30 seconds".into()
            } else {
                "app internet response failed".into()
            })
        })?;
        if body.len().saturating_add(chunk.len()) > RESPONSE_MAX {
            crate::refuse!(BadRequest, "app internet response exceeds 4 MiB");
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// What the engine keeps in memory per app: "Allow once" answers for a running
/// copy (its panel and run generation, so a stop, restart or code change ends
/// them), the requests in flight that a revoke aborts, and the per-app rate and
/// concurrency budget. Nothing here survives an engine restart.
#[derive(Default)]
pub struct Registry {
    apps: Mutex<HashMap<(i64, String), AppNet>>,
}
#[derive(Default)]
struct AppNet {
    once: HashSet<(String, i64, String)>,
    inflight: HashMap<u64, (String, CancellationToken)>,
    recent: VecDeque<Instant>,
    next: u64,
}
/// One admitted request; dropping it frees its concurrency slot.
pub struct Ticket<'a> {
    registry: &'a Registry,
    key: (i64, String),
    id: u64,
    pub cancel: CancellationToken,
}
impl Drop for Ticket<'_> {
    #[nolog]
    fn drop(&mut self) {
        if let Ok(mut apps) = self.registry.apps.lock() {
            if let Some(app) = apps.get_mut(&self.key) {
                app.inflight.remove(&self.id);
            }
        }
    }
}
impl Registry {
    #[nolog]
    fn lock(&self) -> Result<MutexGuard<'_, HashMap<(i64, String), AppNet>>> {
        self.apps
            .lock()
            .map_err(|_| anyhow::anyhow!("Apps internet registry unavailable"))
    }
    /// Admit one request for this app, within 120 a minute and 8 at a time
    /// across its copies (apart from the 60/min budget of other app actions).
    #[nolog]
    pub fn admit(&self, org: i64, app: &str, panel: &str) -> Result<Ticket<'_>> {
        let mut apps = self.lock()?;
        let now = Instant::now();
        apps.retain(|_, a| {
            !a.inflight.is_empty()
                || !a.once.is_empty()
                || a.recent
                    .back()
                    .is_some_and(|at| now.duration_since(*at) < WINDOW)
        });
        let key = (org, app.to_owned());
        let a = apps.entry(key.clone()).or_default();
        while a
            .recent
            .front()
            .is_some_and(|at| now.duration_since(*at) >= WINDOW)
        {
            a.recent.pop_front();
        }
        if a.inflight.len() >= CONCURRENT {
            crate::refuse!(
                Conflict,
                "an app may have at most 8 internet requests in flight"
            );
        }
        if a.recent.len() >= PER_MINUTE {
            crate::refuse!(
                Conflict,
                "app internet requests are limited to 120 per minute"
            );
        }
        a.recent.push_back(now);
        a.next += 1;
        let id = a.next;
        let cancel = CancellationToken::new();
        a.inflight.insert(id, (panel.to_owned(), cancel.clone()));
        Ok(Ticket {
            registry: self,
            key,
            id,
            cancel,
        })
    }
    /// The sites this running copy was allowed once.
    #[nolog]
    pub fn once(
        &self,
        org: i64,
        app: &str,
        panel: &str,
        generation: i64,
    ) -> Result<HashSet<String>> {
        let apps = self.lock()?;
        Ok(apps
            .get(&(org, app.to_owned()))
            .map(|a| {
                a.once
                    .iter()
                    .filter(|(p, g, _)| p == panel && *g == generation)
                    .map(|(.., site)| site.clone())
                    .collect()
            })
            .unwrap_or_default())
    }
    /// "Allow once": this site, this running copy, until it is hidden, stopped
    /// or restarted, or a permission or code change revokes it.
    #[nolog]
    pub fn allow_once(
        &self,
        org: i64,
        app: &str,
        panel: &str,
        generation: i64,
        site: &str,
    ) -> Result<()> {
        let mut apps = self.lock()?;
        let a = apps.entry((org, app.to_owned())).or_default();
        // Answers for an older run of a copy are dead; drop them first.
        a.once.retain(|(p, g, _)| p != panel || *g == generation);
        if a.once.len() >= ONCE_MAX {
            crate::refuse!(
                Conflict,
                "too many sites allowed once for this app; use Always allow in its settings"
            );
        }
        a.once
            .insert((panel.to_owned(), generation, site.to_owned()));
        Ok(())
    }
    /// A permission change, code change, deletion, power off or Stop all: abort
    /// the matching requests in flight and forget their "Allow once" answers.
    /// None matches every app (or every copy).
    #[nolog]
    pub fn revoke(&self, org: i64, app: Option<&str>, panel: Option<&str>) {
        let Ok(mut apps) = self.apps.lock() else {
            return;
        };
        for ((o, a), state) in apps.iter_mut() {
            if *o != org || app.is_some_and(|x| x != a) {
                continue;
            }
            for (p, cancel) in state.inflight.values() {
                if panel.is_none_or(|x| x == p) {
                    cancel.cancel();
                }
            }
            state.once.retain(|(p, ..)| panel.is_some_and(|x| x != p));
        }
    }
    /// Hide ends a copy's "Allow once" answers; its requests in flight finish.
    #[nolog]
    pub fn forget_once(&self, org: i64, panel: &str) {
        if let Ok(mut apps) = self.apps.lock() {
            for ((o, _), state) in apps.iter_mut() {
                if *o == org {
                    state.once.retain(|(p, ..)| p != panel);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declared_sites_accept_hosts_ports_and_wildcards_but_refuse_junk() {
        for ok in [
            "example.com",
            "api.example.com",
            "*.example.org",
            "example.net:8443",
            "*",
            "10.0.0.5",
            "[2001:db8::1]:443",
            "[2606:4700::1]",
        ] {
            assert!(valid_site(ok).is_ok(), "{ok}");
        }
        let long = "a".repeat(300);
        for bad in [
            "",
            " ",
            "has space.com",
            "http://example.com",
            "example.com/path",
            "user@example.com",
            "example.com:0",
            "example.com:99999",
            "Example.com",
            "*.",
            "..",
            ".example.com",
            "ex*ample.com",
            "*.*.example.com",
            long.as_str(),
        ] {
            assert!(valid_site(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn site_matching_respects_host_port_and_subdomain_wildcard() {
        assert!(site_matches("*", "anything.example", 443));
        assert!(site_matches("*", "anything.example", 8443));
        assert!(site_matches("example.com", "example.com", 443));
        assert!(site_matches("example.com", "EXAMPLE.com", 443));
        assert!(
            !site_matches("example.com", "example.com", 8443),
            "default port is 443"
        );
        assert!(site_matches("example.com:8443", "example.com", 8443));
        assert!(site_matches("example.com:443", "example.com", 443));
        // Subdomain wildcard covers subdomains, not the apex or a different domain.
        assert!(site_matches("*.example.com", "api.example.com", 443));
        assert!(site_matches("*.example.com", "a.b.example.com", 443));
        assert!(!site_matches("*.example.com", "example.com", 443));
        assert!(!site_matches("*.example.com", "notexample.com", 443));
        assert!(!site_matches("*.example.com", "evilexample.com", 443));
        assert!(!site_matches("api.example.com", "other.example.com", 443));
        // IPv6 rows are bracketed; request hosts are not.
        assert!(site_matches("[2001:db8::1]:8443", "2001:db8::1", 8443));
        assert_eq!(site_key("2001:db8::1", 8443), "[2001:db8::1]:8443");
        assert_eq!(site_key("example.com", 443), "example.com");
        assert_eq!(
            host_port("[2001:db8::1]").unwrap(),
            ("2001:db8::1".into(), 443)
        );
    }

    #[test]
    fn urls_must_be_https_with_a_host_and_no_credentials() {
        assert!(validate_url(&"https://example.com/x".parse().unwrap()).is_ok());
        for bad in [
            "http://example.com",
            "https://user:pw@example.com",
            "ftp://example.com",
            "https://user@example.com",
            "file:///C:/Windows/win.ini",
            "data:text/plain,hi",
        ] {
            assert!(validate_url(&bad.parse().unwrap()).is_err(), "{bad}");
        }
        let long: reqwest::Url = format!("https://example.com/{}", "a".repeat(URL_MAX))
            .parse()
            .unwrap();
        assert!(validate_url(&long).is_err());
        let v6: reqwest::Url = "https://[2001:db8::1]:8443/x".parse().unwrap();
        assert_eq!(url_host_port(&v6).unwrap(), ("2001:db8::1".into(), 8443));
        let named: reqwest::Url = "https://API.Example.com/x".parse().unwrap();
        assert_eq!(
            url_host_port(&named).unwrap(),
            ("api.example.com".into(), 443)
        );
    }

    #[test]
    fn only_public_addresses_are_allowed() {
        assert!(is_public_ip("8.8.8.8".parse().unwrap()));
        assert!(is_public_ip("2606:4700::1".parse().unwrap()));
        for bad in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "255.255.255.255",
            "::1",
            "::",
            "fd00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "64:ff9b::7f00:1",
            "2002:7f00:1::1",
            "2001:db8::1",
        ] {
            assert!(!is_public_ip(bad.parse().unwrap()), "{bad}");
        }
    }

    // This machine's own address is refused even where it would classify as
    // public. Measured on the test machine: the source address the OS picks for
    // an outbound route is one of its own interface addresses.
    #[test]
    fn this_machines_own_addresses_are_recognised() {
        assert!(is_own_address("127.0.0.1".parse().unwrap()));
        let probe = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
        if probe.connect("8.8.8.8:53").is_ok() {
            let own = probe.local_addr().unwrap().ip();
            if !own.is_unspecified() {
                assert!(is_own_address(own), "own interface address {own}");
            }
        }
        assert!(!is_own_address("8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn forbidden_headers_and_methods_are_refused() {
        for h in [
            "Cookie",
            "cookie",
            "HOST",
            "Proxy-Authorization",
            "proxy-x",
            "Connection",
            "Transfer-Encoding",
            "content-length",
            "User-Agent",
            "user-agent",
        ] {
            assert!(header_forbidden(h), "{h}");
        }
        for h in ["Authorization", "Content-Type", "Accept", "X-App"] {
            assert!(!header_forbidden(h), "{h}");
        }
        let url: reqwest::Url = "https://example.com".parse().unwrap();
        let f = |method: &str, headers: Vec<(String, String)>, body: Option<Vec<u8>>| Fetch {
            url: url.clone(),
            method: method.into(),
            headers,
            body,
        };
        assert!(validate_fetch(&f("GET", vec![], None)).is_ok());
        assert!(validate_fetch(&f(
            "POST",
            vec![("X-App".into(), "1".into())],
            Some(vec![1])
        ))
        .is_ok());
        for bad in [
            f("CONNECT", vec![], None),
            f("get", vec![], None),
            f("GET", vec![("Cookie".into(), "x".into())], None),
            f("GET", vec![("User-Agent".into(), "Spoofed/1".into())], None),
            f("GET", vec![("Bad Name".into(), "x".into())], None),
            f(
                "POST",
                vec![("X".into(), "line\r\nInjected: y".into())],
                None,
            ),
            f("POST", vec![], Some(vec![0u8; REQUEST_MAX + 1])),
            f("GET", vec![], Some(vec![1])),
            f(
                "GET",
                (0..65).map(|i| (format!("X-{i}"), "v".into())).collect(),
                None,
            ),
        ] {
            assert!(validate_fetch(&bad).is_err());
        }
    }

    #[test]
    fn cors_safelisted_headers_follow_fetch() {
        for (name, value) in [
            ("Accept", "application/json"),
            ("accept", "*/*"),
            ("Accept-Language", "en-US,en;q=0.9"),
            ("Content-Language", "de-DE"),
            ("Content-Type", "text/plain"),
            ("content-type", "Text/Plain; charset=UTF-8"),
            ("Content-Type", "multipart/form-data; boundary=x-1"),
            ("Content-Type", " application/x-www-form-urlencoded "),
        ] {
            assert!(cors_safelisted(name, value), "{name}: {value}");
        }
        let long = format!("text/plain;{}", "a=b;".repeat(30));
        for (name, value) in [
            ("Content-Type", "application/json"),
            ("Content-Type", "application/json; api-key=k"),
            ("Content-Type", "text/plain; key=\"k\""),
            ("Content-Type", "text /plain"),
            ("Content-Type", "text"),
            ("Content-Type", long.as_str()),
            ("Accept", "application/json; key=\"k\""),
            ("Accept", "text/html\u{1}"),
            ("Accept-Language", "en_US"),
            ("Content-Language", "de/DE"),
            ("Authorization", "Bearer k"),
            ("X-API-Key", "k"),
            ("Range", "bytes=0-1"),
        ] {
            assert!(!cors_safelisted(name, value), "{name}: {value}");
        }
        let h = |n: &str, v: &str| (n.to_string(), v.to_string());
        assert_eq!(
            cross_site_headers(vec![
                h("Accept", "a"),
                h("X-API-Key", "k"),
                h("Content-Type", "application/json"),
            ]),
            vec![h("Accept", "a")]
        );
        // 1024 bytes of values together are kept; past that, none is.
        let wide = "a".repeat(128);
        assert_eq!(
            cross_site_headers((0..8).map(|_| h("Accept", &wide)).collect()).len(),
            8
        );
        assert!(cross_site_headers((0..9).map(|_| h("Accept", &wide)).collect()).is_empty());
    }

    #[test]
    fn the_registry_bounds_rate_and_concurrency_per_app() {
        let r = Registry::default();
        let held: Vec<_> = (0..CONCURRENT)
            .map(|_| r.admit(1, "a", "p").unwrap())
            .collect();
        assert!(r.admit(1, "a", "p").is_err(), "a ninth concurrent request");
        assert!(r.admit(1, "b", "p").is_ok(), "apps have separate budgets");
        assert!(
            r.admit(2, "a", "p").is_ok(),
            "organizations have separate budgets"
        );
        drop(held);
        for _ in CONCURRENT..PER_MINUTE {
            drop(r.admit(1, "a", "p").unwrap());
        }
        assert!(
            r.admit(1, "a", "p").is_err(),
            "the 121st request in a minute"
        );
    }

    #[test]
    fn revoke_aborts_requests_in_flight_and_forgets_once_answers() {
        let r = Registry::default();
        let mine = r.admit(1, "a", "p1").unwrap();
        let other_copy = r.admit(1, "a", "p2").unwrap();
        let other_app = r.admit(1, "b", "q1").unwrap();
        r.allow_once(1, "a", "p1", 3, "example.com").unwrap();
        r.allow_once(1, "a", "p2", 3, "example.com").unwrap();
        assert!(r.once(1, "a", "p1", 3).unwrap().contains("example.com"));
        assert!(
            r.once(1, "a", "p1", 4).unwrap().is_empty(),
            "a restart is a new run"
        );
        r.revoke(1, None, Some("p1"));
        assert!(mine.cancel.is_cancelled());
        assert!(!other_copy.cancel.is_cancelled() && !other_app.cancel.is_cancelled());
        assert!(r.once(1, "a", "p1", 3).unwrap().is_empty());
        assert!(r.once(1, "a", "p2", 3).unwrap().contains("example.com"));
        r.revoke(1, Some("a"), None);
        assert!(other_copy.cancel.is_cancelled() && !other_app.cancel.is_cancelled());
        assert!(r.once(1, "a", "p2", 3).unwrap().is_empty());
        r.allow_once(1, "a", "p1", 5, "example.com").unwrap();
        r.forget_once(1, "p1");
        assert!(
            r.once(1, "a", "p1", 5).unwrap().is_empty(),
            "hide ends once answers"
        );
        r.revoke(1, None, None);
        assert!(
            other_app.cancel.is_cancelled(),
            "Stop all reaches every app"
        );
    }
}

/// The real request path against a local TLS server reached through the
/// test-only route: grants, refusals, redirects, cookies, bounds and abort.
#[cfg(test)]
mod tls_tests {
    use super::*;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct Server {
        port: u16,
        heads: Arc<Mutex<Vec<String>>>,
    }

    /// A CA and one leaf for the test names; returns (CA DER, server config).
    fn tls(names: &[&str]) -> (Vec<u8>, Arc<rustls::ServerConfig>) {
        use rcgen::{
            BasicConstraints, CertificateParams, CertifiedIssuer, ExtendedKeyUsagePurpose, IsCa,
            KeyPair, KeyUsagePurpose,
        };
        use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
        let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        ca_params.key_usages = vec![
            KeyUsagePurpose::KeyCertSign,
            KeyUsagePurpose::DigitalSignature,
        ];
        let ca = CertifiedIssuer::self_signed(ca_params, KeyPair::generate().unwrap()).unwrap();
        let key = KeyPair::generate().unwrap();
        let mut leaf =
            CertificateParams::new(names.iter().map(|n| n.to_string()).collect::<Vec<_>>())
                .unwrap();
        leaf.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        let cert = leaf.signed_by(&key, &ca).unwrap();
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![cert.der().clone()],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
            )
            .unwrap();
        (ca.der().to_vec(), Arc::new(config))
    }

    /// Serves fixed responses by path; records each request head.
    async fn serve(names: &[&str]) -> Server {
        let (ca, config) = tls(names);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        {
            let mut routes = TEST_ROUTES.lock().unwrap();
            for name in names {
                routes.retain(|(h, ..)| h != name);
                routes.push((name.to_string(), addr, ca.clone()));
            }
        }
        let heads = Arc::new(Mutex::new(Vec::new()));
        let seen = heads.clone();
        let port = addr.port();
        tokio::spawn(async move {
            let acceptor = tokio_rustls::TlsAcceptor::from(config);
            loop {
                let Ok((tcp, _)) = listener.accept().await else {
                    return;
                };
                let acceptor = acceptor.clone();
                let seen = seen.clone();
                tokio::spawn(async move {
                    let Ok(mut tls) = acceptor.accept(tcp).await else {
                        return;
                    };
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        match tls.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        }
                    }
                    let head = String::from_utf8_lossy(&buf).to_string();
                    seen.lock().unwrap().push(head.clone());
                    let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let reply = |status: &str, extra: &str, body: &[u8]| {
                        let mut out = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n", body.len()).into_bytes();
                        out.extend_from_slice(body);
                        out
                    };
                    let out = match path.as_str() {
                        "/ok" => reply("200 OK", "Content-Type: text/plain\r\nSet-Cookie: session=secret\r\nX-Test: yes\r\n", b"hello"),
                        "/to-other" => reply("302 Found", &format!("Location: https://other.test:{port}/ok\r\n"), b""),
                        "/to-loopback" => reply("302 Found", &format!("Location: https://127.0.0.1:{port}/ok\r\n"), b""),
                        "/to-granted" => reply("302 Found", &format!("Location: https://granted.test:{port}/ok\r\n"), b""),
                        "/loop" => reply("302 Found", "Location: /loop\r\n", b""),
                        "/to-ok" => reply("302 Found", "Location: /ok\r\n", b""),
                        p if p.starts_with("/hop/") => reply("302 Found", &format!("Location: https://{}:{port}/ok\r\n", &p[5..]), b""),
                        p if p.starts_with("/307/") => reply("307 Temporary Redirect", &format!("Location: https://{}:{port}/ok\r\n", &p[5..]), b""),
                        p if p.starts_with("/303/") => reply("303 See Other", &format!("Location: https://{}:{port}/ok\r\n", &p[5..]), b""),
                        "/big" => reply("200 OK", "", &vec![b'x'; RESPONSE_MAX + 1]),
                        "/slow" => {
                            tokio::time::sleep(Duration::from_secs(20)).await;
                            reply("200 OK", "", b"late")
                        }
                        _ => reply("404 Not Found", "", b""),
                    };
                    let _ = tls.write_all(&out).await;
                    let _ = tls.shutdown().await;
                });
            }
        });
        Server { port, heads }
    }

    fn get(url: &str) -> Fetch {
        Fetch {
            url: url.parse().unwrap(),
            method: "GET".into(),
            headers: vec![("Authorization".into(), "Bearer app-token".into())],
            body: None,
        }
    }

    #[tokio::test]
    async fn granted_hosts_work_and_everything_else_is_refused() {
        let s = serve(&["granted.test", "other.test"]).await;
        let port = s.port;
        let only_granted = move |h: &str, p: u16| h == "granted.test" && p == port;
        // Granted: the request goes out without any cookie, and Set-Cookie
        // never reaches the app.
        let ok = fetch(
            get(&format!("https://granted.test:{port}/ok")),
            &only_granted,
        )
        .await
        .unwrap();
        assert_eq!(
            (ok.status, ok.body.as_slice(), ok.redirected),
            (200, &b"hello"[..], false)
        );
        assert!(ok.headers.iter().any(|(n, v)| n == "x-test" && v == "yes"));
        assert!(!ok
            .headers
            .iter()
            .any(|(n, _)| n.eq_ignore_ascii_case("set-cookie")));
        let head = s.heads.lock().unwrap().last().unwrap().to_ascii_lowercase();
        assert!(!head.contains("\r\ncookie:"), "no cookie went out: {head}");
        assert!(
            head.contains("authorization: bearer app-token"),
            "the app's own header went out"
        );
        // No grant: refused before any connection.
        let before = s.heads.lock().unwrap().len();
        let refused = fetch(get(&format!("https://other.test:{port}/ok")), &only_granted)
            .await
            .unwrap_err()
            .to_string();
        assert!(refused.contains("not granted"), "{refused}");
        // A redirect from a granted host to another host is re-checked.
        let refused = fetch(
            get(&format!("https://granted.test:{port}/to-other")),
            &only_granted,
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(
            refused.contains("not granted") && refused.contains("other.test"),
            "{refused}"
        );
        assert_eq!(
            s.heads.lock().unwrap().len(),
            before + 1,
            "only the redirecting request reached the server"
        );
        // Even a granted redirect target must be public: loopback is refused.
        let everything = |_: &str, _: u16| true;
        let refused = fetch(
            get(&format!("https://granted.test:{port}/to-loopback")),
            &everything,
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(refused.contains("not a public address"), "{refused}");
        // A redirect between granted hosts works and drops the app's
        // credentials when the host changes.
        let both = move |h: &str, p: u16| (h == "granted.test" || h == "other.test") && p == port;
        let moved = fetch(get(&format!("https://other.test:{port}/to-granted")), &both)
            .await
            .unwrap();
        assert_eq!((moved.status, moved.redirected), (200, true));
        assert!(moved.final_url.contains("granted.test"));
        let head = s.heads.lock().unwrap().last().unwrap().to_ascii_lowercase();
        assert!(
            !head.contains("authorization:"),
            "credentials followed a redirect: {head}"
        );
        // Redirect loops end at the hop limit.
        let refused = fetch(
            get(&format!("https://granted.test:{port}/loop")),
            &only_granted,
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(refused.contains("redirect limit"), "{refused}");
        // Responses are bounded.
        let refused = fetch(
            get(&format!("https://granted.test:{port}/big")),
            &only_granted,
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(refused.contains("exceeds 4 MiB"), "{refused}");
        // Plain http, an engine-style loopback URL and a LAN address never connect.
        for url in [
            "http://granted.test/ok".to_string(),
            format!("https://127.0.0.1:{port}/ok"),
            "https://192.168.1.1/".into(),
        ] {
            assert!(fetch(get(&url), &everything).await.is_err(), "{url}");
        }
    }

    /// Review B8 (4.5.0, 7b18db1caaea F2): a redirect to another host dropped
    /// only Authorization, so X-API-Key and any other header an app keeps a
    /// credential in went on to that host.
    #[tokio::test]
    async fn a_redirect_to_another_host_carries_only_safelisted_headers() {
        let s = serve(&["creds-a.test", "creds-b.test"]).await;
        let port = s.port;
        let both = move |h: &str, p: u16| (h == "creds-a.test" || h == "creds-b.test") && p == port;
        let request = |url: String| Fetch {
            url: url.parse().unwrap(),
            method: "GET".into(),
            headers: [
                ("Authorization", "Bearer app-token"),
                ("X-API-Key", "app-key"),
                ("X-Session", "app-session"),
                ("Accept", "application/json"),
                ("Accept-Language", "en"),
            ]
            .iter()
            .map(|(n, v)| (n.to_string(), v.to_string()))
            .collect(),
            body: None,
        };
        let last_two = || {
            let heads = s.heads.lock().unwrap();
            let n = heads.len();
            (
                heads[n - 2].to_ascii_lowercase(),
                heads[n - 1].to_ascii_lowercase(),
            )
        };
        // A redirect on the same host keeps every header the app set.
        let stayed = fetch(request(format!("https://creds-a.test:{port}/to-ok")), &both)
            .await
            .unwrap();
        assert_eq!((stayed.status, stayed.redirected), (200, true));
        let (_, second) = last_two();
        for kept in [
            "authorization: bearer app-token",
            "x-api-key: app-key",
            "x-session: app-session",
            "accept: application/json",
            "accept-language: en",
        ] {
            assert!(second.contains(kept), "{kept} missing on the same host: {second}");
        }
        // To another host: the first hop had everything, the next hop only the
        // CORS-safelisted headers.
        let moved = fetch(
            request(format!("https://creds-a.test:{port}/hop/creds-b.test")),
            &both,
        )
        .await
        .unwrap();
        assert_eq!((moved.status, moved.redirected), (200, true));
        assert!(moved.final_url.contains("creds-b.test"));
        let (first, second) = last_two();
        assert!(
            first.starts_with("get /hop/creds-b.test ") && first.contains("x-api-key: app-key"),
            "{first}"
        );
        assert!(
            second.starts_with("get /ok ") && second.contains("host: creds-b.test"),
            "{second}"
        );
        for dropped in ["authorization:", "x-api-key:", "x-session:"] {
            assert!(!second.contains(dropped), "{dropped} followed the redirect: {second}");
        }
        for kept in ["accept: application/json", "accept-language: en"] {
            assert!(second.contains(kept), "{kept} missing after the redirect: {second}");
        }
    }

    /// The `User-Agent` values in a recorded request head, the name matched case-insensitively.
    fn user_agents(head: &str) -> Vec<String> {
        head.lines()
            .filter_map(|line| line.split_once(':'))
            .filter(|(name, _)| name.eq_ignore_ascii_case("user-agent"))
            .map(|(_, value)| value.trim().to_string())
            .collect()
    }

    /// GitHub's API answers 403 to a request without a User-Agent (found by the School cut dry run, 2026-10-29,
    /// on 4.5.1). Every request the engine makes for an app, on every hop, carries one fixed `Orgtree/<version>`
    /// and nothing else that names a user, computer, org, app or panel; an app cannot set or replace it.
    #[tokio::test]
    async fn every_hop_carries_the_fixed_orgtree_user_agent_and_an_app_cannot_replace_it() {
        let s = serve(&["agent-a.test", "agent-b.test"]).await;
        let port = s.port;
        let both = move |h: &str, p: u16| (h == "agent-a.test" || h == "agent-b.test") && p == port;
        let expected = vec![format!("Orgtree/{}", env!("CARGO_PKG_VERSION"))];
        // A plain request: one User-Agent, and no header beyond the app's own and the client's basics.
        let ok = fetch(get(&format!("https://agent-a.test:{port}/ok")), &both).await.unwrap();
        assert_eq!(ok.status, 200);
        let head = s.heads.lock().unwrap().last().unwrap().clone();
        assert_eq!(user_agents(&head), expected, "{head}");
        let mut names: Vec<String> = head
            .lines()
            .skip(1)
            .filter_map(|line| line.split_once(':'))
            .map(|(name, _)| name.to_ascii_lowercase())
            .collect();
        names.sort();
        assert_eq!(names, ["accept", "authorization", "host", "user-agent"], "{head}");
        // A redirect to another host drops the app's headers, but the client's own User-Agent goes on every hop.
        let moved = fetch(get(&format!("https://agent-a.test:{port}/hop/agent-b.test")), &both).await.unwrap();
        assert!(moved.redirected && moved.final_url.contains("agent-b.test"));
        let heads = s.heads.lock().unwrap().clone();
        let [first, second] = &heads[heads.len() - 2..] else { panic!("two hops expected: {heads:?}") };
        assert_eq!(user_agents(first), expected, "{first}");
        assert_eq!(user_agents(second), expected, "{second}");
        assert!(!second.to_ascii_lowercase().contains("authorization:"), "{second}");
        // An app that sets its own User-Agent is refused before any connection, so it can never replace ours.
        let before = s.heads.lock().unwrap().len();
        let mut spoofed = get(&format!("https://agent-a.test:{port}/ok"));
        spoofed.headers.push(("User-Agent".into(), "Spoofed/1".into()));
        let refused = fetch(spoofed, &both).await.unwrap_err().to_string();
        assert!(refused.contains("may not set the User-Agent header"), "{refused}");
        assert_eq!(s.heads.lock().unwrap().len(), before, "nothing was sent");
    }

    /// Review of d3dd69a (B8 follow-up): the cross-site filter read header names
    /// only, so a 307 to another host carried `Content-Type: application/json;
    /// api-key=...` and any other value an app hid a credential in. A hop keeps
    /// a header only when fetch would call it CORS-safelisted, value included.
    #[tokio::test]
    async fn a_redirect_to_another_host_keeps_only_cors_safelisted_values() {
        let s = serve(&["values-a.test", "values-b.test"]).await;
        let port = s.port;
        let both = move |h: &str, p: u16| (h == "values-a.test" || h == "values-b.test") && p == port;
        let post = |path: &str, headers: &[(&str, &str)]| Fetch {
            url: format!("https://values-a.test:{port}{path}").parse().unwrap(),
            method: "POST".into(),
            headers: headers
                .iter()
                .map(|(n, v)| (n.to_string(), v.to_string()))
                .collect(),
            body: Some(b"x=1".to_vec()),
        };
        let last = || s.heads.lock().unwrap().last().unwrap().to_ascii_lowercase();
        // A 307 keeps the method and the body, so only the values decide.
        let unsafe_values = fetch(
            post(
                "/307/values-b.test",
                &[
                    ("Content-Type", "application/json; api-key=app-key"),
                    ("Accept", "application/json; key=\"app-key\""),
                    ("Accept-Language", "en_US/app-key"),
                ],
            ),
            &both,
        )
        .await
        .unwrap();
        assert_eq!((unsafe_values.status, unsafe_values.redirected), (200, true));
        let head = last();
        assert!(
            head.starts_with("post /ok ") && head.contains("host: values-b.test"),
            "{head}"
        );
        assert!(!head.contains("app-key"), "an unsafe value followed the redirect: {head}");
        assert!(!head.contains("content-type:"), "{head}");
        // Safelisted values go on.
        let safe = fetch(
            post(
                "/307/values-b.test",
                &[
                    ("Content-Type", "text/plain;charset=utf-8"),
                    ("Accept", "application/json"),
                    ("Accept-Language", "en-US,en;q=0.9"),
                ],
            ),
            &both,
        )
        .await
        .unwrap();
        assert_eq!((safe.status, safe.redirected), (200, true));
        let head = last();
        for kept in [
            "content-type: text/plain;charset=utf-8",
            "accept: application/json",
            "accept-language: en-us,en;q=0.9",
        ] {
            assert!(head.contains(kept), "{kept} missing after the redirect: {head}");
        }
        // Over 1024 bytes together, none of them is safelisted any more.
        let wide = "a".repeat(120);
        let many: Vec<(&str, &str)> = (0..9).map(|_| ("Accept", wide.as_str())).collect();
        let crowded = fetch(post("/307/values-b.test", &many), &both).await.unwrap();
        assert_eq!((crowded.status, crowded.redirected), (200, true));
        let head = last();
        assert!(!head.contains(&wide), "1080 bytes of Accept followed the redirect: {head}");
        // A redirect that turns the request into a bodyless GET (303 here, as
        // 301 and 302 do) drops Content-Type, safelisted or not.
        let get = fetch(
            post("/303/values-b.test", &[("Content-Type", "text/plain")]),
            &both,
        )
        .await
        .unwrap();
        assert_eq!((get.status, get.redirected), (200, true));
        let head = last();
        assert!(
            head.starts_with("get /ok ") && !head.contains("content-type:"),
            "{head}"
        );
    }

    #[tokio::test]
    async fn a_revoke_aborts_a_request_in_flight() {
        let s = serve(&["slow.test"]).await;
        let port = s.port;
        let registry = Registry::default();
        let ticket = registry.admit(9, "app", "copy").unwrap();
        let allow = move |h: &str, p: u16| h == "slow.test" && p == port;
        let started = std::time::Instant::now();
        let request = fetch(get(&format!("https://slow.test:{port}/slow")), &allow);
        let revoke = async {
            tokio::time::sleep(Duration::from_millis(500)).await;
            registry.revoke(9, Some("app"), None);
        };
        let (out, ()) = tokio::join!(
            async {
                tokio::select! {
                    _ = ticket.cancel.cancelled() => None,
                    r = request => Some(r),
                }
            },
            revoke
        );
        assert!(out.is_none(), "the request was aborted, not answered");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
        drop(ticket);
        assert!(
            registry.admit(9, "app", "copy").is_ok(),
            "the slot is free again"
        );
    }
}
