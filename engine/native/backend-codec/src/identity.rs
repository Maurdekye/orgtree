//! Identity and name namespaces.
//!
//! Source facts (engine/backend/orgtree/ledger.py):
//!
//! * Actors are one of three kinds. `@user`, `@system` and `@extern` are
//!   sentinels; every agent node id is produced by `slugify`, which can never
//!   emit `@`, so an agent may itself be called `user` without colliding.
//! * `slugify(name)` is `re.sub(r"[^a-z0-9]+", "-", name.strip().lower())
//!   .strip("-")` and refuses an empty result. Node ids and organization
//!   slugs both come from it (hire adds `-2`, `-3`… on collision).
//! * `Org._work_slugify(title)` lowercases `str(title or "")`, collapses the
//!   same runs, cuts to 48 characters, strips hyphens again and falls back to
//!   `item`. It derives the readable prefix only.
//! * Work items are looked up by exact, case-sensitive name. The retired
//!   opaque-id shape `^w[0-9a-f]{8}$` only adds guidance after a miss.
//!
//! The new-format work name (prefix, `--`, 26-character RFC 4648 token) is
//! implemented by the reviewed `orgtree-work-name-codec` crate and is reused
//! here, not re-implemented.

use orgtree_work_name_codec as work_name;
use std::fmt;

pub const USER: &str = "@user";
pub const SYSTEM: &str = "@system";
pub const EXTERN: &str = "@extern";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdentityError {
    /// `slugify` found no letters or digits (Python raises LedgerError).
    EmptySlug,
    /// Not of the form `[a-z0-9]+(-[a-z0-9]+)*`.
    NotCanonicalKey,
    /// Starts with `@` but is not one of the three sentinels.
    UnknownSentinel,
}

impl IdentityError {
    pub fn as_str(self) -> &'static str {
        match self {
            IdentityError::EmptySlug => "empty_slug",
            IdentityError::NotCanonicalKey => "not_canonical_key",
            IdentityError::UnknownSentinel => "unknown_sentinel",
        }
    }
}

impl fmt::Display for IdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::error::Error for IdentityError {}

/// Unicode version of the Python lowercase table below (CPython 3.13.15
/// `unicodedata.unidata_version`).
pub const PYTHON_UNICODE_VERSION: &str = "15.1.0";

/// Every non-ASCII code point whose Python `str.lower()` contains an ASCII
/// letter or digit, with that exact lowercase text. The vectors oracle
/// recomputes this table over all code points and the tests compare it, so
/// a new Unicode version in Python shows up as a failing check.
pub const PYTHON_LOWER_TO_ASCII: &[(char, &str)] = &[('\u{130}', "i\u{307}"), ('\u{212a}', "k")];

/// Append Python's lowercase of `c`, reduced to what the slug regex can see:
/// ASCII letters and digits survive, anything else is a separator (`-`).
fn push_py_lower_for_slug(c: char, out: &mut String) {
    if c.is_ascii() {
        let l = c.to_ascii_lowercase();
        out.push(if l.is_ascii_lowercase() || l.is_ascii_digit() { l } else { '-' });
        return;
    }
    match PYTHON_LOWER_TO_ASCII.iter().find(|(k, _)| *k == c) {
        Some((_, lower)) => {
            for l in lower.chars() {
                out.push(if l.is_ascii_lowercase() || l.is_ascii_digit() { l } else { '-' });
            }
        }
        None => out.push('-'),
    }
}

/// `re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")`, exact for Python
/// 3.13.15. Python's `strip()` of whitespace before lowering cannot change
/// the result: edge whitespace becomes hyphens that are stripped anyway.
fn py_slug_core(s: &str) -> String {
    let mut marked = String::with_capacity(s.len());
    for c in s.chars() {
        push_py_lower_for_slug(c, &mut marked);
    }
    let mut out = String::with_capacity(marked.len());
    for c in marked.chars() {
        if c == '-' {
            if !out.ends_with('-') {
                out.push('-');
            }
        } else {
            out.push(c);
        }
    }
    out.trim_matches('-').to_owned()
}

/// Python `ledger.slugify(name)`: the agent node id and organization slug
/// derivation.
pub fn py_slugify(name: &str) -> Result<String, IdentityError> {
    let s = py_slug_core(name);
    if s.is_empty() { Err(IdentityError::EmptySlug) } else { Ok(s) }
}

/// Python `Org._work_slugify(title)`. `None` stands for Python's `None`
/// (and any other falsy title), which gives `item`.
pub fn py_work_slugify(title: Option<&str>) -> String {
    let s = py_slug_core(title.unwrap_or(""));
    // The core output is ASCII, so a byte cut is a character cut.
    let cut = &s[..s.len().min(work_name::PREFIX_MAX_LEN)];
    let cut = cut.trim_matches('-');
    if cut.is_empty() { "item".to_owned() } else { cut.to_owned() }
}

/// The v6 new-format work name for a title and a trusted UUIDv4, composed
/// from `py_work_slugify` and the reviewed work-name codec. Generating the
/// UUID, uniqueness and receipts are not part of this crate.
pub fn new_work_name(title: Option<&str>, trusted_uuid: &[u8; 16]) -> Result<String, work_name::NameError> {
    work_name::encode_name(&py_work_slugify(title), trusted_uuid)
}

/// Python `Org._WORK_OLD_ID.match(ref)` with `^w[0-9a-f]{8}$`. Python's `$`
/// also matches just before one final `\n`, so `"w12345678\n"` has the old
/// shape too. The shape only decides guidance text after an exact lookup
/// has already missed; it is never a lookup key.
pub fn py_is_retired_work_id_shape(s: &str) -> bool {
    let s = s.strip_suffix('\n').unwrap_or(s);
    s.len() == 9 && s.starts_with('w') && s[1..].bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// True for `[a-z0-9]+(-[a-z0-9]+)*`, the fixed points of `slugify`.
pub fn is_canonical_key(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && !s.ends_with('-')
        && !s.contains("--")
        && s.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-'))
}

/// An agent node id inside one organization.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct AgentKey(String);

impl AgentKey {
    pub fn parse(s: &str) -> Result<AgentKey, IdentityError> {
        if is_canonical_key(s) { Ok(AgentKey(s.to_owned())) } else { Err(IdentityError::NotCanonicalKey) }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// An organization slug.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct OrgKey(String);

impl OrgKey {
    pub fn parse(s: &str) -> Result<OrgKey, IdentityError> {
        if is_canonical_key(s) { Ok(OrgKey(s.to_owned())) } else { Err(IdentityError::NotCanonicalKey) }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Who acted. Sentinels and agents are different kinds, so an agent named
/// `user` is never the USER root.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Actor {
    User,
    System,
    Extern,
    Agent(AgentKey),
}

impl Actor {
    pub fn parse(s: &str) -> Result<Actor, IdentityError> {
        match s {
            USER => Ok(Actor::User),
            SYSTEM => Ok(Actor::System),
            EXTERN => Ok(Actor::Extern),
            _ if s.starts_with('@') => Err(IdentityError::UnknownSentinel),
            _ => AgentKey::parse(s).map(Actor::Agent),
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Actor::User => "user",
            Actor::System => "system",
            Actor::Extern => "extern",
            Actor::Agent(_) => "agent",
        }
    }
}

/// A key qualified by its organization and namespace. Two keys with the same
/// text are different when either the organization or the namespace differs,
/// mirroring v6's org-scoped foreign keys.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum ScopedKey {
    Agent { org: OrgKey, key: AgentKey },
    /// A work item's complete public name, compared byte for byte.
    WorkName { org: OrgKey, name: String },
}

impl ScopedKey {
    pub fn org(&self) -> &OrgKey {
        match self {
            ScopedKey::Agent { org, .. } | ScopedKey::WorkName { org, .. } => org,
        }
    }
}
