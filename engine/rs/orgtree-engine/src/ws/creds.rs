//! A websocket dog's credentials (docs/rust-engine/websocket-watchdogs.md):
//! HTTP headers for the upgrade request (any header; `bearer` for
//! `Authorization: Bearer …`; `username` + `password` for Basic), query
//! parameters appended to the URL it dials, and hello messages sent before
//! the dog's own (a login message). They come from a JSON file in the
//! owner's folders, re-read on every connect, which may also hold TLS
//! material as for mqtt (`ca_*` pins trust, `cert_*` + `key_*` a client
//! certificate), or inline, sealed at rest (`crate::mqtt::seal`, the same key
//! and table as mqtt's). Plaintext only ever lives in mqtt's [`Secret`]
//! inside the `#[nolog]` functions here and in `conn.rs`; no error quotes a
//! value, and a header or field name is quoted only when it looks like one.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use base64::Engine as _;
use serde_json::{json, Map, Value};

use super::{Endpoint, HELLO_BYTES, HELLO_MAX};
use crate::mqtt::creds::{io_reason, read_near, tls_config, unknown_hint, Secret, FILE_MAX};

const FILE_KEYS: &[&str] = &["headers", "bearer", "username", "password", "query", "hello", "ca_file", "ca_pem", "cert_file", "cert_pem", "key_file", "key_pem"];
const INLINE_KEYS: &[&str] = &["headers", "bearer", "username", "password", "query", "hello"];
const HEADERS_MAX: usize = 32;
const QUERY_MAX: usize = 16;
const NAME_MAX: usize = 128;
const VALUE_MAX: usize = 8 * 1024;
/// Headers the client writes itself, or that `protocols` sets.
const OWN_HEADERS: &[&str] = &["host", "upgrade", "connection", "content-length", "transfer-encoding", "sec-websocket-key", "sec-websocket-version",
                               "sec-websocket-extensions", "sec-websocket-accept", "sec-websocket-protocol"];

/// One dog's credentials as parsed: everything secret.
#[derive(Clone, Default)]
pub struct Inline {
    headers: Vec<(String, Secret)>,
    query: Vec<(String, Secret)>,
    hello: Vec<Secret>,
}

impl std::fmt::Debug for Inline {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Inline(*****)")
    }
}

/// Where a connection's credentials come from.
#[derive(Clone)]
pub enum Source {
    None,
    /// A credentials file, re-read on every attempt.
    File(PathBuf),
    Inline(Arc<Inline>),
}

impl std::fmt::Debug for Source {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Source::None => f.write_str("None"),
            Source::File(p) => write!(f, "File({})", p.display()),
            Source::Inline(_) => f.write_str("Inline(*****)"),
        }
    }
}

/// One attempt's credentials.
pub struct Resolved {
    /// Header names as given; values secret.
    pub headers: Vec<(String, Secret)>,
    pub query: Vec<(String, Secret)>,
    pub hello: Vec<Secret>,
    /// For wss:// only.
    pub tls: Option<Arc<rustls::ClientConfig>>,
}

/// Inline credentials from a create call's `credentials` object.
#[nolog]
pub fn inline_from_args(v: &Value) -> Result<Inline, String> {
    let Some(o) = v.as_object() else { return Err("credentials is a credentials file path or an object {headers, bearer, username, password, query, hello}".into()) };
    for k in o.keys() {
        if !INLINE_KEYS.contains(&k.as_str()) {
            let tls = ["ca_file", "ca_pem", "cert_file", "cert_pem", "key_file", "key_pem"].contains(&k.as_str());
            return Err(if tls {
                format!("{k} goes in a credentials file (TLS material is never inline): credentials=\"<path to a .json file>\"")
            } else {
                format!("inline credentials take headers, bearer, username, password, query and hello only{}", unknown_hint(k))
            });
        }
    }
    let i = fields(o, "the inline credentials")?;
    if i.headers.is_empty() && i.query.is_empty() && i.hello.is_empty() {
        return Err("the inline credentials are empty: give headers, bearer, username and password, query or hello".into());
    }
    Ok(i)
}

/// The bytes sealed for inline credentials.
#[nolog]
pub fn inline_to_bytes(i: &Inline) -> Vec<u8> {
    let pairs = |v: &[(String, Secret)]| v.iter().map(|(k, s)| json!([k, s.expose()])).collect::<Vec<_>>();
    serde_json::to_vec(&json!({ "h": pairs(&i.headers), "q": pairs(&i.query), "m": i.hello.iter().map(Secret::expose).collect::<Vec<_>>() }))
        .unwrap_or_default()
}

#[nolog]
pub fn inline_from_bytes(b: &[u8]) -> Result<Inline, String> {
    let v: Value = serde_json::from_slice(b).map_err(|_| "the sealed credentials do not parse".to_string())?;
    let pairs = |k: &str| -> Vec<(String, Secret)> {
        v[k].as_array().map(|a| {
            a.iter().filter_map(|p| Some((p[0].as_str()?.to_string(), Secret::new(p[1].as_str()?)))).collect()
        }).unwrap_or_default()
    };
    let hello = v["m"].as_array().map(|a| a.iter().filter_map(|m| m.as_str().map(Secret::new)).collect()).unwrap_or_default();
    Ok(Inline { headers: pairs("h"), query: pairs("q"), hello })
}

/// A credentials file read at create: fails early (with the reason) on
/// anything a connection would fail on.
#[nolog]
pub fn check_file(path: &Path, endpoint: &Endpoint) -> Result<(), String> {
    resolve(&Source::File(path.to_path_buf()), endpoint).map(|_| ())
}

/// The credentials for one connection attempt (a file is read now).
#[nolog]
pub fn resolve(source: &Source, endpoint: &Endpoint) -> Result<Resolved, String> {
    let (inline, tls) = match source {
        Source::None => (Inline::default(), default_tls(endpoint)?),
        Source::Inline(i) => ((**i).clone(), default_tls(endpoint)?),
        Source::File(p) => read_file(p, endpoint)?,
    };
    Ok(Resolved { headers: inline.headers, query: inline.query, hello: inline.hello, tls })
}

#[nolog]
fn read_file(path: &Path, endpoint: &Endpoint) -> Result<(Inline, Option<Arc<rustls::ClientConfig>>), String> {
    let shown = path.display();
    let md = std::fs::metadata(path).map_err(|e| format!("the credentials file {shown} cannot be read ({})", io_reason(&e)))?;
    if !md.is_file() {
        return Err(format!("the credentials file {shown} is not a file"));
    }
    if md.len() > FILE_MAX {
        return Err(format!("the credentials file {shown} is over {} KB", FILE_MAX / 1024));
    }
    let raw = std::fs::read(path).map_err(|e| format!("the credentials file {shown} cannot be read ({})", io_reason(&e)))?;
    let text = std::str::from_utf8(&raw).map_err(|_| format!("the credentials file {shown} is not UTF-8 text"))?;
    // PowerShell's Out-File and Set-Content write a byte-order mark
    let text = text.trim_start_matches('\u{feff}');
    let v: Value = serde_json::from_str(text)
        .map_err(|e| format!("the credentials file {shown} is not valid JSON (line {}, column {})", e.line(), e.column()))?;
    let Some(o) = v.as_object() else { return Err(format!("the credentials file {shown} must hold one JSON object")) };
    for k in o.keys() {
        if !FILE_KEYS.contains(&k.as_str()) {
            return Err(format!("the credentials file {shown} has an unknown field{}; the fields are {}", unknown_hint(k), FILE_KEYS.join(", ")));
        }
    }
    let inline = fields(o, &format!("the credentials file {shown}"))?;
    let string = |k: &str| -> Result<Option<String>, String> {
        match o.get(k) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => Err(format!("{k} in the credentials file {shown} must be a string")),
        }
    };
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let pem = |file_key: &str, pem_key: &str| -> Result<Option<Vec<u8>>, String> {
        match (string(file_key)?, string(pem_key)?) {
            (Some(_), Some(_)) => Err(format!("give {file_key} or {pem_key} in the credentials file, not both")),
            (Some(rel), None) => read_near(&dir, &rel, file_key).map(Some),
            (None, Some(text)) => Ok(Some(text.into_bytes())),
            (None, None) => Ok(None),
        }
    };
    let ca = pem("ca_file", "ca_pem")?;
    let cert = pem("cert_file", "cert_pem")?;
    let key = pem("key_file", "key_pem")?;
    if !endpoint.tls && (ca.is_some() || cert.is_some() || key.is_some()) {
        return Err("the credentials file holds TLS material (ca/cert/key) but the URL is ws://; use wss://".into());
    }
    let client = match (&cert, &key) {
        (Some(c), Some(k)) => Some((c.as_slice(), k.as_slice())),
        (None, None) => None,
        _ => return Err("the client cert and key go together in the credentials file: give both or neither".into()),
    };
    let tls = if !endpoint.tls {
        None
    } else if ca.is_none() && client.is_none() {
        default_tls(endpoint)?
    } else {
        Some(tls_config(ca.as_deref(), client)?)
    };
    Ok((inline, tls))
}

/// The secret fields of an inline object or a file, checked.
#[nolog]
fn fields(o: &Map<String, Value>, what: &str) -> Result<Inline, String> {
    let string = |k: &str| -> Result<Option<String>, String> {
        match o.get(k) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => Err(format!("{k} in {what} must be a string")),
        }
    };
    let mut headers: Vec<(String, Secret)> = Vec::new();
    match o.get("headers") {
        None | Some(Value::Null) => {}
        Some(Value::Object(h)) => {
            if h.len() > HEADERS_MAX {
                return Err(format!("{what} hold more than {HEADERS_MAX} headers"));
            }
            for (name, v) in h {
                if name.is_empty() || name.len() > NAME_MAX || !name.bytes().all(tchar) {
                    return Err(format!("a header name in {what} is not a valid HTTP header name"));
                }
                if OWN_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
                    let fix = if name.eq_ignore_ascii_case("sec-websocket-protocol") { "; give the subprotocols as the dog's `protocols`" } else { "" };
                    return Err(format!("header {name} is written by the WebSocket client itself and cannot be set{fix}"));
                }
                let Some(v) = v.as_str() else { return Err(format!("header {name} in {what} must be a string")) };
                if !header_value(v) {
                    return Err(format!("the value of header {name} in {what} must be at most {} KB of text without line breaks", VALUE_MAX / 1024));
                }
                headers.push((name.clone(), Secret::new(v)));
            }
        }
        Some(_) => return Err(format!("headers in {what} must be an object {{\"Header-Name\": \"value\"}}")),
    }
    let has_auth = headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("authorization"));
    let bearer = string("bearer")?;
    let (username, password) = (string("username")?, string("password")?);
    if let Some(b) = bearer {
        if has_auth {
            return Err(format!("{what} give bearer and an Authorization header: give one"));
        }
        if b.is_empty() || !header_value(&b) {
            return Err(format!("bearer in {what} must be a token of at most {} KB without line breaks", VALUE_MAX / 1024));
        }
        if username.is_some() || password.is_some() {
            return Err(format!("{what} give bearer and username/password: one Authorization each, give one"));
        }
        headers.push(("Authorization".into(), Secret::new(format!("Bearer {b}"))));
    }
    match (username, password) {
        (None, None) => {}
        (None, Some(_)) => return Err(format!("{what} have a password but no username")),
        (Some(u), p) => {
            if has_auth {
                return Err(format!("{what} give username/password and an Authorization header: give one"));
            }
            if u.is_empty() || u.contains(':') || u.len() > VALUE_MAX || p.as_ref().is_some_and(|p| p.len() > VALUE_MAX) {
                return Err(format!("username in {what} must be 1 to {} bytes without a colon, and password at most as long", VALUE_MAX));
            }
            let pair = format!("{u}:{}", p.unwrap_or_default());
            headers.push(("Authorization".into(), Secret::new(format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(pair)))));
        }
    }
    let mut query: Vec<(String, Secret)> = Vec::new();
    match o.get("query") {
        None | Some(Value::Null) => {}
        Some(Value::Object(q)) => {
            if q.len() > QUERY_MAX {
                return Err(format!("{what} hold more than {QUERY_MAX} query parameters"));
            }
            for (name, v) in q {
                if name.is_empty() || name.len() > NAME_MAX || name.chars().any(|c| c.is_control()) {
                    return Err(format!("a query parameter name in {what} must be 1 to {NAME_MAX} bytes"));
                }
                let Some(v) = v.as_str() else { return Err(format!("query parameter values in {what} must be strings")) };
                if v.len() > VALUE_MAX {
                    return Err(format!("a query parameter value in {what} is over {} KB", VALUE_MAX / 1024));
                }
                query.push((name.clone(), Secret::new(v)));
            }
        }
        Some(_) => return Err(format!("query in {what} must be an object {{\"name\": \"value\"}}")),
    }
    let hello = match o.get("hello") {
        None | Some(Value::Null) => Vec::new(),
        Some(v) => messages(v, &format!("hello in {what}"))?.into_iter().map(Secret::new).collect(),
    };
    Ok(Inline { headers, query, hello })
}

/// A list of messages as text: a string is sent as it is, any other JSON
/// value as compact JSON. At most [`HELLO_MAX`] of them in [`HELLO_BYTES`].
#[nolog]
pub fn messages(v: &Value, what: &str) -> Result<Vec<String>, String> {
    let Some(list) = v.as_array() else { return Err(format!("{what} must be a list of messages (strings or JSON values)")) };
    if list.len() > HELLO_MAX {
        return Err(format!("{what} holds more than {HELLO_MAX} messages"));
    }
    let out: Vec<String> = list.iter().map(message_text).collect();
    if out.iter().any(String::is_empty) {
        return Err(format!("{what} holds an empty message"));
    }
    if out.iter().map(String::len).sum::<usize>() > HELLO_BYTES {
        return Err(format!("{what} is over {} KB in all", HELLO_BYTES / 1024));
    }
    Ok(out)
}

/// One message as the text frame that carries it.
#[nolog]
pub fn message_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// An HTTP token character (RFC 9110 `tchar`).
#[nolog]
fn tchar(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
}

#[nolog]
fn header_value(v: &str) -> bool {
    v.len() <= VALUE_MAX && !v.chars().any(|c| c == '\r' || c == '\n' || c == '\0')
}

/// The trust for a wss:// server with no TLS fields: the Mozilla roots.
#[nolog]
fn default_tls(endpoint: &Endpoint) -> Result<Option<Arc<rustls::ClientConfig>>, String> {
    static DEFAULT: OnceLock<Result<Arc<rustls::ClientConfig>, String>> = OnceLock::new();
    if !endpoint.tls {
        return Ok(None);
    }
    DEFAULT.get_or_init(|| tls_config(None, None)).clone().map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CANARY: &str = "WS-CANARY-90210";

    fn ep(tls: bool) -> Endpoint {
        Endpoint { tls, host: "feed.example".into(), port: if tls { 443 } else { 80 }, resource: "/ws".into() }
    }

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("orgtree-ws-creds-{}", crate::util::random_hex(6)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn header<'a>(r: &'a Resolved, name: &str) -> Option<&'a str> {
        r.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.expose())
    }

    #[test]
    fn inline_credentials_parse_seal_and_never_print() {
        let v = json!({"headers": {"X-Api-Key": CANARY, "Origin": "http://localhost"}, "query": {"token": CANARY},
                       "hello": [{"type": "auth", "access_token": CANARY}, "subscribe"]});
        let i = inline_from_args(&v).unwrap();
        let shown = format!("{i:?} {:?}", Source::Inline(Arc::new(i.clone())));
        assert!(!shown.contains(CANARY), "{shown}");
        let back = inline_from_bytes(&inline_to_bytes(&i)).unwrap();
        let r = resolve(&Source::Inline(Arc::new(back)), &ep(false)).unwrap();
        assert_eq!(header(&r, "x-api-key"), Some(CANARY));
        assert_eq!(header(&r, "origin"), Some("http://localhost"));
        assert_eq!(r.query.len(), 1);
        assert_eq!(r.query[0].1.expose(), CANARY);
        assert_eq!(r.hello.iter().map(|h| h.expose().to_string()).collect::<Vec<_>>(),
                   vec![format!("{{\"type\":\"auth\",\"access_token\":\"{CANARY}\"}}"), "subscribe".to_string()],
                   "a JSON hello is sent as compact JSON, a string as it is");
        assert!(r.tls.is_none());
    }

    #[test]
    fn bearer_and_basic_become_one_authorization_header() {
        let r = resolve(&Source::Inline(Arc::new(inline_from_args(&json!({"bearer": CANARY})).unwrap())), &ep(true)).unwrap();
        assert_eq!(header(&r, "authorization"), Some(format!("Bearer {CANARY}").as_str()));
        assert!(r.tls.is_some(), "wss:// without TLS fields trusts the Mozilla roots");
        let r = resolve(&Source::Inline(Arc::new(inline_from_args(&json!({"username": "ha", "password": "pw"})).unwrap())), &ep(false)).unwrap();
        assert_eq!(header(&r, "authorization"), Some("Basic aGE6cHc="));
        for bad in [json!({"bearer": "a", "headers": {"Authorization": "x"}}), json!({"bearer": "a", "username": "u"}),
                    json!({"password": "p"}), json!({"username": "a:b"}), json!({"bearer": ""}), json!({"bearer": "a\r\nX: y"})] {
            assert!(inline_from_args(&bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn bad_fields_are_refused_without_quoting_a_value() {
        for (bad, why) in [
            (json!("x"), "file path or an object"),
            (json!({}), "empty"),
            (json!({"headers": {"Host": "evil"}}), "written by the WebSocket client"),
            (json!({"headers": {"Sec-WebSocket-Protocol": "x"}}), "protocols"),
            (json!({"headers": {"Bad Name": "x"}}), "not a valid HTTP header name"),
            (json!({"headers": {"X-A": CANARY.to_string() + "\n"}}), "without line breaks"),
            (json!({"headers": {"X-A": 5}}), "must be a string"),
            (json!({"headers": [CANARY]}), "must be an object"),
            (json!({"query": {"a": 1}}), "must be strings"),
            (json!({"hello": CANARY}), "list of messages"),
            (json!({"hello": [""]}), "empty message"),
            (json!({"ca_pem": "x"}), "credentials file"),
            (json!({"bearer": CANARY, "tokn": "x"}), "\"tokn\""),
        ] {
            let e = inline_from_args(&bad).err().unwrap_or_else(|| panic!("{bad} must be refused"));
            assert!(e.contains(why), "{bad}: {e}");
            assert!(!e.contains(CANARY), "no value is quoted: {e}");
        }
        let e = inline_from_args(&json!({"bearer": "x", CANARY: "y"})).unwrap_err();
        assert!(!e.contains(CANARY), "a secret pasted in as a key is not echoed: {e}");
        let many: Map<String, Value> = (0..17).map(|i| (format!("q{i}"), json!("v"))).collect();
        assert!(inline_from_args(&json!({"query": many})).unwrap_err().contains("more than 16"));
        let hellos: Vec<Value> = (0..17).map(|_| json!("x")).collect();
        assert!(inline_from_args(&json!({"hello": hellos})).unwrap_err().contains("more than 16"));
    }

    #[test]
    fn a_credentials_file_is_read_again_and_its_tls_needs_wss() {
        let d = dir();
        let f = d.join("feed.json");
        std::fs::write(&f, format!("\u{feff}{{\"bearer\":\"{CANARY}\",\"hello\":[\"hi\"]}}")).unwrap();
        let r = resolve(&Source::File(f.clone()), &ep(false)).unwrap();
        assert_eq!(header(&r, "authorization"), Some(format!("Bearer {CANARY}").as_str()));
        std::fs::write(&f, r#"{"headers":{"Cookie":"a=b"}}"#).unwrap();
        let r = resolve(&Source::File(f.clone()), &ep(false)).unwrap();
        assert_eq!(header(&r, "cookie"), Some("a=b"), "the file is read again on every attempt");
        std::fs::write(&f, r#"{"ca_pem":"-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"}"#).unwrap();
        assert!(resolve(&Source::File(f.clone()), &ep(false)).err().unwrap().contains("use wss://"));
        std::fs::write(&f, r#"{"cert_pem":"x"}"#).unwrap();
        assert!(resolve(&Source::File(f.clone()), &ep(true)).err().unwrap().contains("give both or neither"));
        for (body, why) in [
            (format!("{{\"bearer\":\"{CANARY}\""), "not valid JSON"),
            (format!("[\"{CANARY}\"]"), "one JSON object"),
            (format!("{{\"{CANARY}\":1}}"), "unknown field"),
        ] {
            std::fs::write(&f, &body).unwrap();
            let e = resolve(&Source::File(f.clone()), &ep(true)).err().unwrap_or_default();
            assert!(e.contains(why) && !e.contains(CANARY), "{why}: {e}");
        }
        assert!(resolve(&Source::File(d.join("nope.json")), &ep(false)).err().unwrap().contains("not found"));
        std::fs::remove_dir_all(&d).ok();
    }
}
