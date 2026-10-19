//! Broker credentials: where a dog's come from and how a connection uses
//! them. Plaintext only ever lives in [`Secret`] / [`SecretBytes`] (Debug
//! prints `*****`; neither is serializable) inside the `#[nolog]` functions
//! here and in `conn.rs`. No error message here quotes a value: JSON errors
//! give a line and column, PEM errors a fixed sentence, and an unknown field
//! is named only when it looks like a mistyped field name.
//!
//! A credentials file is JSON inside the owner's readable folders (checked
//! by the dog, docs/rust-engine/mqtt-watchdogs.md):
//! `{"username", "password", "client_id", "ca_file"|"ca_pem",
//!   "cert_file"|"cert_pem", "key_file"|"key_pem"}`, every field optional.
//! `*_file` paths are relative to the file's own folder and must stay in it.
//! A CA given here is the ONLY trust for that broker (pinning); without one,
//! mqtts:// trusts the Mozilla roots (webpki-roots).

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::Broker;

/// The largest credentials file read.
pub const FILE_MAX: u64 = 64 * 1024;
/// The largest PEM file read.
pub const PEM_MAX: u64 = 256 * 1024;
const FIELD_MAX: usize = 65535;
const CLIENT_ID_MAX: usize = 256;
const FILE_KEYS: &[&str] = &["username", "password", "client_id", "ca_file", "ca_pem", "cert_file", "cert_pem", "key_file", "key_pem"];
const INLINE_KEYS: &[&str] = &["username", "password", "client_id"];

/// A secret string: Debug prints `*****`; never serialized.
#[derive(Clone, Default)]
pub struct Secret(String);

#[logged]
impl Secret {
    #[nolog]
    pub fn new(s: impl Into<String>) -> Secret {
        Secret(s.into())
    }

    #[nolog]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("*****")
    }
}

/// Secret bytes (a private key): Debug prints `*****`; never serialized.
#[derive(Clone)]
pub struct SecretBytes(Vec<u8>);

impl std::fmt::Debug for SecretBytes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("*****")
    }
}

/// Inline credentials from a dog's create call, sealed at rest.
#[derive(Clone)]
pub struct Inline {
    pub username: Secret,
    pub password: Option<Secret>,
    pub client_id: Option<String>,
}

impl std::fmt::Debug for Inline {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Inline").field("username", &self.username).field("password", &self.password).field("client_id", &self.client_id).finish()
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
    pub login: Option<(Secret, Secret)>,
    pub client_id: Option<String>,
    /// For mqtts:// only.
    pub tls: Option<Arc<rustls::ClientConfig>>,
}

/// The identity a connection key keeps of `source`: never the credentials,
/// and for inline ones a digest salted per process.
#[nolog]
pub fn identity(source: &Source, salt: &[u8]) -> String {
    match source {
        Source::None => "none".into(),
        Source::File(p) => format!("file:{}", p.to_string_lossy()),
        Source::Inline(i) => {
            let mut h = Sha256::new();
            h.update(salt);
            let pass = i.password.as_ref().map(|p| p.expose().as_bytes().to_vec());
            for part in [Some(i.username.expose().as_bytes().to_vec()), pass] {
                match part {
                    Some(b) => {
                        h.update([1u8]);
                        h.update((b.len() as u64).to_be_bytes());
                        h.update(&b);
                    }
                    None => h.update([0u8]),
                }
            }
            format!("inline:{}", hex::encode(&h.finalize()[..16]))
        }
    }
}

/// Inline credentials from a create call's `credentials` object.
#[nolog]
pub fn inline_from_args(v: &Value) -> Result<Inline, String> {
    let Some(o) = v.as_object() else { return Err("credentials is a credentials file path or an object {username, password, client_id}".into()) };
    for k in o.keys() {
        if !INLINE_KEYS.contains(&k.as_str()) {
            return Err(format!("inline credentials take username, password and client_id only{}", unknown_hint(k)));
        }
    }
    let username = match o.get("username") {
        Some(Value::String(u)) if !u.is_empty() => u.clone(),
        None | Some(Value::Null) | Some(Value::String(_)) => return Err("inline credentials need a username".into()),
        Some(_) => return Err("username must be a string".into()),
    };
    let password = match o.get("password") {
        None | Some(Value::Null) => None,
        Some(Value::String(p)) => Some(p.clone()),
        Some(_) => return Err("password must be a string".into()),
    };
    if username.len() > FIELD_MAX || password.as_ref().is_some_and(|p| p.len() > FIELD_MAX) {
        return Err(format!("username and password are at most {FIELD_MAX} bytes each"));
    }
    let client_id = client_id(o.get("client_id"))?;
    Ok(Inline { username: Secret::new(username), password: password.map(Secret::new), client_id })
}

/// The bytes sealed for inline credentials.
#[nolog]
pub fn inline_to_bytes(i: &Inline) -> Vec<u8> {
    serde_json::to_vec(&json!({ "u": i.username.expose(), "p": i.password.as_ref().map(|p| p.expose()), "c": i.client_id }))
        .unwrap_or_default()
}

#[nolog]
pub fn inline_from_bytes(b: &[u8]) -> Result<Inline, String> {
    let v: Value = serde_json::from_slice(b).map_err(|_| "the sealed credentials do not parse".to_string())?;
    let Some(u) = v["u"].as_str() else { return Err("the sealed credentials have no username".into()) };
    Ok(Inline {
        username: Secret::new(u),
        password: v["p"].as_str().map(Secret::new),
        client_id: v["c"].as_str().map(str::to_string),
    })
}

/// A credentials file read at create: fails early (with the reason) on
/// anything a connection would fail on, and returns its client id.
#[nolog]
pub fn check_file(path: &Path, broker: &Broker) -> Result<Option<String>, String> {
    let r = resolve(&Source::File(path.to_path_buf()), broker)?;
    Ok(r.client_id)
}

/// The credentials for one connection attempt (a file is read now).
#[nolog]
pub fn resolve(source: &Source, broker: &Broker) -> Result<Resolved, String> {
    match source {
        Source::None => Ok(Resolved { login: None, client_id: None, tls: default_tls(broker)? }),
        Source::Inline(i) => Ok(Resolved {
            login: Some((i.username.clone(), i.password.clone().unwrap_or_default())),
            client_id: i.client_id.clone(),
            tls: default_tls(broker)?,
        }),
        Source::File(p) => {
            let f = read_file(p)?;
            let has_tls = f.ca.is_some() || f.cert.is_some() || f.key.is_some();
            if !broker.tls && has_tls {
                return Err("the credentials file holds TLS material (ca/cert/key) but the broker is mqtt://; use mqtts://".into());
            }
            let client = match (&f.cert, &f.key) {
                (Some(c), Some(k)) => Some((c.as_slice(), k.0.as_slice())),
                (None, None) => None,
                _ => return Err("the client cert and key go together in the credentials file: give both or neither".into()),
            };
            let tls = if !broker.tls {
                None
            } else if f.ca.is_none() && client.is_none() {
                default_tls(broker)?
            } else {
                Some(tls_config(f.ca.as_deref(), client)?)
            };
            let login = match (f.username, f.password) {
                (Some(u), p) => Some((u, p.unwrap_or_default())),
                (None, Some(_)) => return Err("the credentials file has a password but no username".into()),
                (None, None) => None,
            };
            Ok(Resolved { login, client_id: f.client_id, tls })
        }
    }
}

struct FileCreds {
    username: Option<Secret>,
    password: Option<Secret>,
    client_id: Option<String>,
    ca: Option<Vec<u8>>,
    cert: Option<Vec<u8>>,
    key: Option<SecretBytes>,
}

#[nolog]
fn read_file(path: &Path) -> Result<FileCreds, String> {
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
    let string = |k: &str| -> Result<Option<String>, String> {
        match o.get(k) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => Err(format!("{k} in the credentials file {shown} must be a string")),
        }
    };
    let username = string("username")?.filter(|u| !u.is_empty());
    let password = string("password")?;
    if username.as_ref().is_some_and(|u| u.len() > FIELD_MAX) || password.as_ref().is_some_and(|p| p.len() > FIELD_MAX) {
        return Err(format!("username and password are at most {FIELD_MAX} bytes each"));
    }
    let client_id = client_id(o.get("client_id"))?;
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
    let key = pem("key_file", "key_pem")?.map(SecretBytes);
    Ok(FileCreds { username: username.map(Secret::new), password: password.map(Secret::new), client_id, ca, cert, key })
}

/// A PEM file named by a credentials file: relative to its folder, inside it.
#[nolog]
fn read_near(dir: &Path, rel: &str, field: &str) -> Result<Vec<u8>, String> {
    let p = Path::new(rel);
    if rel.trim().is_empty() || p.components().any(|c| matches!(c, Component::Prefix(_) | Component::RootDir)) {
        return Err(format!("{field} must be a path relative to the credentials file's folder"));
    }
    let full = dir.join(p);
    let real = std::fs::canonicalize(&full).map_err(|e| format!("{field} {} cannot be read ({})", full.display(), io_reason(&e)))?;
    let root = std::fs::canonicalize(dir).map_err(|e| format!("the credentials file's folder cannot be read ({})", io_reason(&e)))?;
    if !real.starts_with(&root) {
        return Err(format!("{field} must stay inside the credentials file's folder"));
    }
    let md = std::fs::metadata(&real).map_err(|e| format!("{field} {} cannot be read ({})", full.display(), io_reason(&e)))?;
    if !md.is_file() || md.len() > PEM_MAX {
        return Err(format!("{field} {} is not a file of at most {} KB", full.display(), PEM_MAX / 1024));
    }
    std::fs::read(&real).map_err(|e| format!("{field} {} cannot be read ({})", full.display(), io_reason(&e)))
}

#[nolog]
fn client_id(v: Option<&Value>) -> Result<Option<String>, String> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.is_empty() || s.len() > CLIENT_ID_MAX || s.chars().any(char::is_control) => {
            Err(format!("client_id must be 1 to {CLIENT_ID_MAX} bytes without control characters"))
        }
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err("client_id must be a string".into()),
    }
}

/// Name an unknown field only when it looks like a mistyped field name, so
/// a secret pasted in as a key is never echoed.
#[nolog]
fn unknown_hint(k: &str) -> String {
    if !k.is_empty() && k.len() <= 24 && k.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
        format!(" ({k:?})")
    } else {
        String::new()
    }
}

#[nolog]
fn io_reason(e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => "not found".into(),
        std::io::ErrorKind::PermissionDenied => "permission denied".into(),
        _ => e.to_string(),
    }
}

/// The trust for an mqtts:// broker with no TLS fields: the Mozilla roots.
#[nolog]
fn default_tls(broker: &Broker) -> Result<Option<Arc<rustls::ClientConfig>>, String> {
    static DEFAULT: OnceLock<Result<Arc<rustls::ClientConfig>, String>> = OnceLock::new();
    if !broker.tls {
        return Ok(None);
    }
    DEFAULT.get_or_init(|| tls_config(None, None)).clone().map(Some)
}

/// A rustls client config on ring: `ca` as the only trust (else the Mozilla
/// roots), and a client certificate when given.
#[nolog]
pub(crate) fn tls_config(ca: Option<&[u8]>, client: Option<(&[u8], &[u8])>) -> Result<Arc<rustls::ClientConfig>, String> {
    use rustls::pki_types::pem::PemObject;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};
    let mut roots = rustls::RootCertStore::empty();
    match ca {
        Some(pem) => {
            let certs = CertificateDer::pem_slice_iter(pem).collect::<Result<Vec<_>, _>>()
                .map_err(|_| "the CA certificate is not PEM (-----BEGIN CERTIFICATE-----)".to_string())?;
            let (added, _) = roots.add_parsable_certificates(certs);
            if added == 0 {
                return Err("the CA PEM holds no usable certificate".into());
            }
        }
        None => roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned()),
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS setup failed: {e}"))?
        .with_root_certificates(roots);
    let config = match client {
        None => builder.with_no_client_auth(),
        Some((cert, key)) => {
            let chain = CertificateDer::pem_slice_iter(cert).collect::<Result<Vec<_>, _>>()
                .map_err(|_| "the client certificate is not PEM (-----BEGIN CERTIFICATE-----)".to_string())?;
            if chain.is_empty() {
                return Err("the client certificate PEM holds no certificate".into());
            }
            let key = PrivateKeyDer::from_pem_slice(key)
                .map_err(|_| "the client key is not an unencrypted PEM private key (PKCS#8, PKCS#1 or SEC1)".to_string())?;
            builder.with_client_auth_cert(chain, key).map_err(|_| "the client certificate and key do not belong together".to_string())?
        }
    };
    Ok(Arc::new(config))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CANARY: &str = "S3CRET-CANARY-7731";

    fn broker(tls: bool) -> Broker {
        Broker { tls, host: "broker.example".into(), port: if tls { 8883 } else { 1883 } }
    }

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("orgtree-mqtt-creds-{}", crate::util::random_hex(6)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn inline_credentials_parse_and_never_print() {
        let i = inline_from_args(&json!({"username": "ha", "password": CANARY, "client_id": "dog-1"})).unwrap();
        assert_eq!(i.username.expose(), "ha");
        assert_eq!(i.client_id.as_deref(), Some("dog-1"));
        let shown = format!("{i:?} {:?}", Source::Inline(Arc::new(i.clone())));
        assert!(!shown.contains(CANARY) && !shown.contains("\"ha\""), "{shown}");
        let back = inline_from_bytes(&inline_to_bytes(&i)).unwrap();
        assert_eq!(back.password.unwrap().expose(), CANARY);
        for bad in [json!("x"), json!({}), json!({"username": ""}), json!({"username": 1}), json!({"username": "a", "password": 5}),
                    json!({"username": "a", "token": "t"}), json!({"username": "a", "client_id": ""})] {
            assert!(inline_from_args(&bad).is_err(), "{bad} must be refused");
        }
        let e = inline_from_args(&json!({"username": "a", CANARY: "x"})).unwrap_err();
        assert!(!e.contains(CANARY), "a secret pasted in as a key is not echoed: {e}");
        let e = inline_from_args(&json!({"username": "a", "passwrd": "x"})).unwrap_err();
        assert!(e.contains("\"passwrd\""), "a mistyped field is named: {e}");
    }

    #[test]
    fn equal_credentials_share_an_identity_that_holds_no_secret() {
        let salt = [7u8; 16];
        let a = Source::Inline(Arc::new(inline_from_args(&json!({"username": "u", "password": CANARY})).unwrap()));
        let b = Source::Inline(Arc::new(inline_from_args(&json!({"username": "u", "password": CANARY})).unwrap()));
        let c = Source::Inline(Arc::new(inline_from_args(&json!({"username": "u", "password": "other"})).unwrap()));
        let d = Source::Inline(Arc::new(inline_from_args(&json!({"username": "u"})).unwrap()));
        assert_eq!(identity(&a, &salt), identity(&b, &salt));
        assert_ne!(identity(&a, &salt), identity(&c, &salt));
        assert_ne!(identity(&d, &salt), identity(&a, &salt));
        assert_ne!(identity(&a, &salt), identity(&a, &[8u8; 16]), "salted per process");
        assert!(!identity(&a, &salt).contains(CANARY));
        assert_eq!(identity(&Source::File(PathBuf::from("/x/c.json")), &salt), "file:/x/c.json");
    }

    #[test]
    fn a_credentials_file_is_read_with_errors_that_quote_no_value() {
        let d = dir();
        let f = d.join("broker.json");
        std::fs::write(&f, format!("\u{feff}{{\"username\":\"ha\",\"password\":\"{CANARY}\",\"client_id\":\"orgtree-ha\"}}")).unwrap();
        let r = resolve(&Source::File(f.clone()), &broker(false)).unwrap();
        let (u, p) = r.login.unwrap();
        assert_eq!((u.expose(), p.expose()), ("ha", CANARY));
        assert_eq!(r.client_id.as_deref(), Some("orgtree-ha"));
        assert!(r.tls.is_none());
        for (body, why) in [
            (format!("{{\"username\":\"u\",\"password\":{}}}", "1234567"), "must be a string"),
            (format!("{{\"username\":\"u\",\"password\":\"{CANARY}\""), "not valid JSON"),
            (format!("[\"{CANARY}\"]"), "one JSON object"),
            (format!("{{\"{CANARY}\":1}}"), "unknown field"),
            (format!("{{\"password\":\"{CANARY}\"}}"), "no username"),
        ] {
            std::fs::write(&f, &body).unwrap();
            let e = resolve(&Source::File(f.clone()), &broker(false)).err().unwrap_or_default();
            assert!(e.contains(why), "{why}: {e}");
            assert!(!e.contains(CANARY) && !e.contains("1234567"), "no value is quoted: {e}");
        }
        let missing = resolve(&Source::File(d.join("nope.json")), &broker(false)).err().unwrap();
        assert!(missing.contains("not found"), "{missing}");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn pem_files_stay_in_the_credentials_folder_and_need_mqtts() {
        let d = dir();
        let inner = d.join("creds");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(d.join("outside.pem"), "x").unwrap();
        let f = inner.join("broker.json");
        std::fs::write(&f, r#"{"ca_file":"../outside.pem"}"#).unwrap();
        let e = resolve(&Source::File(f.clone()), &broker(true)).err().unwrap();
        assert!(e.contains("inside the credentials file's folder"), "{e}");
        std::fs::write(&f, r#"{"ca_file":"C:/Windows/win.ini"}"#).unwrap();
        assert!(resolve(&Source::File(f.clone()), &broker(true)).is_err());
        std::fs::write(&f, r#"{"ca_pem":"-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"}"#).unwrap();
        let e = resolve(&Source::File(f.clone()), &broker(false)).err().unwrap();
        assert!(e.contains("use mqtts://"), "{e}");
        std::fs::write(&f, r#"{"cert_pem":"x"}"#).unwrap();
        let e = resolve(&Source::File(f.clone()), &broker(true)).err().unwrap();
        assert!(e.contains("give both or neither"), "{e}");
        std::fs::write(&f, format!("{{\"ca_pem\":\"-----BEGIN CERTIFICATE-----\\n{CANARY}\\n-----END CERTIFICATE-----\\n\"}}")).unwrap();
        let e = resolve(&Source::File(f.clone()), &broker(true)).err().unwrap();
        assert!(!e.contains(CANARY), "{e}");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn mqtts_without_tls_fields_trusts_the_mozilla_roots() {
        let r = resolve(&Source::None, &broker(true)).unwrap();
        assert!(r.tls.is_some() && r.login.is_none());
        assert!(resolve(&Source::None, &broker(false)).unwrap().tls.is_none());
    }
}
