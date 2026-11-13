//! The saved remote engines: `<data>/remote-engines.json`, replaced whole and
//! atomically like `standalone-clients.json`. A connection's token is sealed
//! with the data root's key (`mqtt/seal.rs`), bound to the connection's id: a
//! row copied to another id does not open. What this protects and what it
//! does not is that module's promise, unchanged.

use std::io::Write;
use std::path::Path;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::mqtt::seal;

pub const FILE: &str = "remote-engines.json";
/// The folder of the sealing key, shared with the watchdog credentials.
pub const SECRETS_DIR: &str = "secrets";
const MAX_FILE: u64 = 8 * 1024 * 1024;
pub const MAX_REMOTES: usize = 32;
/// Organizations remembered per remote engine, gone ones included.
pub const MAX_ORGS: usize = 1024;
const AAD_PREFIX: &[u8] = b"orgtree-remote-engine-v1:";

/// A token in memory: never printed, never serialized.
#[derive(Clone)]
pub struct Token(String);

impl std::fmt::Debug for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Token(*****)")
    }
}

#[nolog]
impl Token {
    pub fn new(token: impl Into<String>) -> Token {
        Token(token.into())
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// One organization of a remote engine, as this desktop knows it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedOrg {
    /// Its slug on the remote engine.
    pub remote_slug: String,
    /// The slug this desktop uses for it: unique here, never changed.
    pub alias: String,
    /// Its id in this desktop's app feed: negative, never reused.
    pub local_id: i64,
    pub org_uuid: String,
    pub name: String,
    /// The last summary the remote sent, shown while it is offline.
    #[serde(default)]
    pub last_summary: Option<Value>,
    pub first_seen: String,
    /// Set when the remote no longer lists it; the alias stays reserved.
    #[serde(default)]
    pub gone_at: Option<String>,
}

/// One saved connection. `sealed_token` is ciphertext (base64).
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedRemote {
    pub id: String,
    pub name: String,
    pub tag: String,
    pub url: String,
    pub data_root_id: String,
    /// The client token this desktop made on the remote, when it could.
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub client_name: Option<String>,
    pub sealed_token: String,
    pub enabled: bool,
    pub created_at: String,
    #[serde(default)]
    pub last_connected_at: Option<String>,
    #[serde(default)]
    pub last_version: Option<String>,
    /// The remote process last seen: a window that loads before the link is
    /// up is stamped with it, so connecting to the same process reloads nothing.
    #[serde(default)]
    pub last_boot_id: Option<String>,
    /// The name this desktop last gave its own client on that engine (the
    /// file's `shown_as` then); absent while it never gave one. The link sends
    /// the name again only when the two differ, so a name the engine's operator
    /// set there stays until this desktop's user chooses another.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_sent: Option<String>,
    #[serde(default)]
    pub orgs: Vec<SavedOrg>,
}

impl std::fmt::Debug for SavedRemote {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SavedRemote").field("id", &self.id).field("name", &self.name).field("url", &self.url)
            .field("enabled", &self.enabled).field("orgs", &self.orgs.len()).finish()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedFile {
    version: u8,
    /// The next local org id to hand out (negative, counting down).
    next_local_id: i64,
    /// What this desktop's user chose to be called where other people see its
    /// actions; absent until they chose (the computer's name is used).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shown_as: Option<String>,
    remotes: Vec<SavedRemote>,
}

/// What the file holds.
pub struct Loaded {
    pub remotes: Vec<SavedRemote>,
    pub next_local_id: i64,
    pub shown_as: Option<String>,
}

/// What the file holds, or why it cannot be used (it is then left alone).
#[nolog]
pub fn load(path: &Path) -> Result<Loaded, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Loaded { remotes: Vec::new(), next_local_id: -1, shown_as: None }),
        Err(error) => return Err(format!("cannot read {FILE}: {error}")),
    };
    if file.metadata().map_err(|e| format!("cannot read {FILE}: {e}"))?.len() > MAX_FILE {
        return Err(format!("{FILE} is too large"));
    }
    let saved: SavedFile = serde_json::from_reader(std::io::BufReader::new(file)).map_err(|e| format!("{FILE} is not valid: {e}"))?;
    if saved.version != 1 {
        return Err(format!("{FILE} has an unknown version"));
    }
    if saved.remotes.len() > MAX_REMOTES || saved.next_local_id >= 0 {
        return Err(format!("{FILE} is not valid"));
    }
    let mut aliases = std::collections::HashSet::new();
    let mut ids = std::collections::HashSet::new();
    let mut local_ids = std::collections::HashSet::new();
    for remote in &saved.remotes {
        if uuid::Uuid::parse_str(&remote.id).is_err() || !ids.insert(remote.id.as_str()) || !valid_tag(&remote.tag)
            || super::address::Address::parse(&remote.url).is_err() || remote.orgs.len() > MAX_ORGS {
            return Err(format!("{FILE} has an invalid connection"));
        }
        for org in &remote.orgs {
            if !valid_slug(&org.alias) || !valid_slug(&org.remote_slug) || !aliases.insert(org.alias.as_str())
                || org.local_id >= 0 || org.local_id <= saved.next_local_id || !local_ids.insert(org.local_id) {
                return Err(format!("{FILE} has an invalid organization"));
            }
        }
    }
    // a name that is no label (edited by hand) is not used: the computer's name is
    let shown_as = saved.shown_as.as_deref().and_then(crate::caller::label);
    Ok(Loaded { remotes: saved.remotes, next_local_id: saved.next_local_id, shown_as })
}

/// Replace the file with these connections (a temporary file beside it, then
/// one atomic move), owner-only where the platform has file modes.
#[nolog]
pub fn save(path: &Path, remotes: &[SavedRemote], next_local_id: i64, shown_as: Option<&str>) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(&SavedFile { version: 1, next_local_id, shown_as: shown_as.map(str::to_string), remotes: remotes.to_vec() })?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let tmp = path.with_file_name(format!(".remote-engines-{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        // On Windows a scanner or indexer can hold the old file for a moment
        // and the replace is refused; that passes, so it is tried again.
        let mut tried = 0;
        loop {
            match crate::client_tokens::replace(&tmp, path) {
                Ok(()) => return Ok(()),
                Err(error) if tried < 5 && cfg!(windows) => {
                    tried += 1;
                    tracing::info!(error = %error, tried, "remote-engines.json could not be replaced yet");
                    std::thread::sleep(std::time::Duration::from_millis(15 * tried));
                }
                Err(error) => return Err(error),
            }
        }
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[nolog]
fn aad(id: &str) -> Vec<u8> {
    let mut a = AAD_PREFIX.to_vec();
    a.extend_from_slice(id.as_bytes());
    a
}

/// `token` sealed for the connection `id`, as the file keeps it.
#[nolog]
pub fn seal_token(key: &seal::Key, id: &str, token: &Token) -> Result<String, String> {
    let sealed = seal::seal_with_aad(key, &aad(id), token.expose().as_bytes())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(sealed))
}

/// The token [`seal_token`] sealed for this very connection.
#[nolog]
pub fn open_token(key: &seal::Key, id: &str, sealed: &str) -> Result<Token, String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(sealed).map_err(|_| "the saved token is not in a known format".to_string())?;
    let plain = seal::unseal_with_aad(key, &aad(id), &bytes)?;
    String::from_utf8(plain).map(Token::new).map_err(|_| "the saved token is not text".to_string())
}

/// An organization slug as the desktop's window identity admits it
/// (`isOrgSlug`, packages/contracts/desktop-window.ts): `[a-z0-9@-]+`. A
/// remote engine's slugs are outside input and are held to the same rule.
#[nolog]
pub fn valid_slug(slug: &str) -> bool {
    !slug.is_empty() && slug.len() <= 200 && slug.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'@' || b == b'-')
}

/// A connection's tag: the suffix an alias takes on a name clash.
#[nolog]
pub fn valid_tag(tag: &str) -> bool {
    !tag.is_empty() && tag.len() <= 32 && tag.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !tag.starts_with('-') && !tag.ends_with('-')
}

/// A display name: 1 to 100 characters, no control characters.
#[nolog]
pub fn valid_name(name: &str) -> bool {
    !name.trim().is_empty() && name.chars().count() <= 100 && !name.chars().any(char::is_control)
}

/// The tag for a connection named `name`: its slug, cut to 24, made unique
/// among `taken` with `-2`, `-3`...
#[nolog]
pub fn tag_for(name: &str, taken: &[&str]) -> String {
    let mut base: String = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            base.push(c.to_ascii_lowercase());
        } else if !base.is_empty() && !base.ends_with('-') {
            base.push('-');
        }
        if base.len() >= 24 {
            break;
        }
    }
    let base = base.trim_matches('-').to_string();
    let base = if base.is_empty() { "remote".to_string() } else { base };
    if !taken.contains(&base.as_str()) {
        return base;
    }
    let mut n = 2u32;
    loop {
        let candidate = format!("{base}-{n}");
        if !taken.contains(&candidate.as_str()) {
            return candidate;
        }
        n += 1;
    }
}

/// The alias for an organization whose slug on the remote is `remote_slug`:
/// that slug when nothing here holds it, else `<slug>-<tag>`, then `-2`, `-3`...
#[nolog]
pub fn alias_for(remote_slug: &str, tag: &str, taken: &dyn Fn(&str) -> bool) -> String {
    if !taken(remote_slug) {
        return remote_slug.to_string();
    }
    let tagged = format!("{remote_slug}-{tag}");
    if !taken(&tagged) {
        return tagged;
    }
    let mut n = 2u32;
    loop {
        let candidate = format!("{tagged}-{n}");
        if !taken(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("orgtree-remote-store-{}", crate::util::random_hex(6)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn remote(id: &str, sealed: String) -> SavedRemote {
        SavedRemote { id: id.into(), name: "Galaxy".into(), tag: "galaxy".into(), url: "http://127.0.0.1:7430".into(),
            data_root_id: "root-1".into(), client_id: Some("c1".into()), client_name: Some("Orgtree desktop (test)".into()),
            sealed_token: sealed, enabled: true, created_at: crate::util::now_iso(), last_connected_at: None, last_version: None,
            last_boot_id: None, label_sent: None, orgs: vec![SavedOrg { remote_slug: "acme".into(), alias: "acme".into(), local_id: -1, org_uuid: "u".into(),
                name: "Acme".into(), last_summary: None, first_seen: crate::util::now_iso(), gone_at: None }] }
    }

    #[test]
    fn a_sealed_token_opens_only_for_its_own_connection_and_is_never_plain_at_rest() {
        let d = dir();
        let key = seal::load_or_create(&d.join(SECRETS_DIR)).unwrap();
        let (a, b) = (uuid::Uuid::new_v4().to_string(), uuid::Uuid::new_v4().to_string());
        let token = Token::new("REMOTE-TOKEN-CANARY-7731");
        let sealed = seal_token(&key, &a, &token).unwrap();
        assert!(!sealed.contains("REMOTE-TOKEN-CANARY-7731"));
        assert_eq!(open_token(&key, &a, &sealed).unwrap().expose(), "REMOTE-TOKEN-CANARY-7731");
        assert!(open_token(&key, &b, &sealed).is_err(), "a row copied to another connection does not open");
        assert!(open_token(&key, &a, "not base64 !").is_err());
        assert_eq!(format!("{token:?}"), "Token(*****)");
        // the file never holds the token, and what it holds reads back the same
        let path = d.join(FILE);
        let saved = vec![remote(&a, sealed)];
        save(&path, &saved, -2, None).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("REMOTE-TOKEN-CANARY-7731"));
        assert!(format!("{:?}", saved[0]).find("sealed").is_none(), "Debug shows no token field");
        let Loaded { remotes: back, next_local_id: next, shown_as } = load(&path).unwrap();
        assert!(back == saved && next == -2 && shown_as.is_none());
        let beside: Vec<String> = std::fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert!(beside.iter().all(|n| !n.ends_with(".tmp")), "no temporary file is left: {beside:?}");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_missing_file_is_an_empty_list_and_a_damaged_one_is_refused_not_replaced() {
        let d = dir();
        let path = d.join(FILE);
        assert_eq!(load(&path).unwrap().remotes.len(), 0);
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(load(&path).is_err());
        std::fs::write(&path, br#"{"version":2,"next_local_id":-1,"remotes":[]}"#).unwrap();
        assert!(load(&path).is_err());
        // two organizations with one alias, or a reused local id, cannot be loaded
        let id = uuid::Uuid::new_v4().to_string();
        let mut r = remote(&id, "x".into());
        r.orgs.push(r.orgs[0].clone());
        save(&path, &[r], -3, None).unwrap();
        assert!(load(&path).is_err());
        std::fs::remove_dir_all(&d).ok();
    }

    /// The name this desktop shows to others, and the name each engine was
    /// last given, are kept. A file that has neither is written exactly as
    /// before they existed, so an older app still reads it.
    #[test]
    fn the_name_shown_to_others_is_kept_and_a_file_without_one_is_as_before() {
        let d = dir();
        let path = d.join(FILE);
        let id = uuid::Uuid::new_v4().to_string();
        let mut r = remote(&id, "x".into());
        save(&path, &[r.clone()], -2, None).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("shown_as") && !text.contains("label_sent"), "{text}");
        r.label_sent = Some("Sam".into());
        save(&path, &[r.clone()], -2, Some("Sam")).unwrap();
        let back = load(&path).unwrap();
        assert_eq!(back.shown_as.as_deref(), Some("Sam"));
        assert_eq!(back.remotes[0].label_sent.as_deref(), Some("Sam"));
        // a name edited into something that is no label is not used
        let long = "x".repeat(41);
        save(&path, &[r], -2, Some(&long)).unwrap();
        assert_eq!(load(&path).unwrap().shown_as, None);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn aliases_keep_a_free_slug_and_suffix_a_taken_one() {
        let held = ["acme", "acme-galaxy"];
        let taken = |s: &str| held.contains(&s);
        assert_eq!(alias_for("beta", "galaxy", &taken), "beta");
        assert_eq!(alias_for("acme", "moon", &taken), "acme-moon");
        assert_eq!(alias_for("acme", "galaxy", &taken), "acme-galaxy-2");
        assert!(valid_slug("acme-galaxy-2") && valid_slug("a@b") && !valid_slug("Acme") && !valid_slug("") && !valid_slug("a/b") && !valid_slug("a b"));
    }

    #[test]
    fn a_tag_is_the_names_slug_made_unique() {
        assert_eq!(tag_for("Galaxy Server", &[]), "galaxy-server");
        assert_eq!(tag_for("100.64.0.1", &[]), "100-64-0-1");
        assert_eq!(tag_for("Galaxy", &["galaxy"]), "galaxy-2");
        assert_eq!(tag_for("Galaxy", &["galaxy", "galaxy-2"]), "galaxy-3");
        assert_eq!(tag_for("???", &[]), "remote");
        assert!(valid_tag(&tag_for("A very long name that goes on and on and on", &[])));
        assert!(valid_tag("galaxy-2") && !valid_tag("-x") && !valid_tag("") && !valid_tag("UP"));
    }
}
