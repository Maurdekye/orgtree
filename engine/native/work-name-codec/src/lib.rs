//! Pure work-name wire compatibility. This crate does not create identities,
//! normalize titles or lookup keys, access storage, or resolve names to items.
//!
//! Callers supply a normalized prefix and trusted UUIDv4 **network-order** bytes.
//! The complete name is the exact lookup key: decoding a token does not authorize
//! creation and does not make a different prefix an alias for an existing item.

use std::fmt;

pub const PREFIX_MAX_LEN: usize = 48;
pub const TOKEN_LEN: usize = 26;
pub const NAME_MAX_LEN: usize = PREFIX_MAX_LEN + 2 + TOKEN_LEN;
const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NameError {
    InvalidPrefix,
    InvalidNameLength,
    MissingSeparator,
    InvalidTokenLength,
    InvalidAlphabet,
    NonZeroPadding,
    InvalidUuidVersion,
    InvalidUuidVariant,
    NonCanonicalToken,
}

impl fmt::Display for NameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidPrefix => {
                "prefix must be 1..48 lowercase ASCII letters/digits with single internal hyphens"
            }
            Self::InvalidNameLength => "complete name must be 29..76 ASCII bytes",
            Self::MissingSeparator => "complete name must include the -- separator",
            Self::InvalidTokenLength => "UUID token must be exactly 26 bytes",
            Self::InvalidAlphabet => "UUID token must use lowercase RFC 4648 base32 a-z2-7",
            Self::NonZeroPadding => "UUID token has nonzero trailing padding bits",
            Self::InvalidUuidVersion => "identity must have UUID version 4",
            Self::InvalidUuidVariant => "identity must have the RFC 4122/9562 UUID variant",
            Self::NonCanonicalToken => "UUID token differs from its canonical re-encoding",
        })
    }
}

impl std::error::Error for NameError {}

fn validate_uuid(uuid: &[u8; 16]) -> Result<(), NameError> {
    if uuid[6] >> 4 != 4 {
        return Err(NameError::InvalidUuidVersion);
    }
    if uuid[8] & 0xc0 != 0x80 {
        return Err(NameError::InvalidUuidVariant);
    }
    Ok(())
}

// Deliberately no length cap here: legacy preflight must also flag anomalously
// long normalized prefixes. The 48-byte cap applies to new names only.
fn is_normalized_prefix(prefix: &str) -> bool {
    let is_alnum = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    let bytes = prefix.as_bytes();
    if !bytes.first().copied().is_some_and(is_alnum) || !bytes.last().copied().is_some_and(is_alnum)
    {
        return false;
    }
    let mut previous_hyphen = false;
    for &byte in bytes {
        if byte == b'-' && !previous_hyphen {
            previous_hyphen = true;
        } else if is_alnum(byte) {
            previous_hyphen = false;
        } else {
            return false;
        }
    }
    true
}

fn validate_prefix(prefix: &str) -> Result<(), NameError> {
    if prefix.len() > PREFIX_MAX_LEN || !is_normalized_prefix(prefix) {
        return Err(NameError::InvalidPrefix);
    }
    Ok(())
}

/// Encode all 128 network-order UUID bits as unpadded lowercase RFC 4648 base32.
/// This deterministic helper validates version/variant; it supplies no entropy.
pub fn encode_token(trusted_uuid: &[u8; 16]) -> Result<String, NameError> {
    validate_uuid(trusted_uuid)?;
    let value = u128::from_be_bytes(*trusted_uuid);
    let mut token = String::with_capacity(TOKEN_LEN);
    for position in 0..25 {
        token.push(ALPHABET[((value >> (123 - position * 5)) & 31) as usize] as char);
    }
    token.push(ALPHABET[((value & 7) << 2) as usize] as char);
    Ok(token)
}

fn alphabet_value(byte: u8) -> Option<u8> {
    match byte {
        b'a'..=b'z' => Some(byte - b'a'),
        b'2'..=b'7' => Some(byte - b'2' + 26),
        _ => None,
    }
}

/// Decode only canonical UUIDv4 tokens. This is a wire primitive, not a public
/// name lookup API: callers must never treat token-only input as a name alias.
pub fn decode_token(token: &str) -> Result<[u8; 16], NameError> {
    if token.len() != TOKEN_LEN {
        return Err(NameError::InvalidTokenLength);
    }
    let mut values = [0u8; TOKEN_LEN];
    for (value, byte) in values.iter_mut().zip(token.bytes()) {
        *value = alphabet_value(byte).ok_or(NameError::InvalidAlphabet)?;
    }
    let last = values[TOKEN_LEN - 1];
    if last & 3 != 0 {
        return Err(NameError::NonZeroPadding);
    }
    let mut value = 0u128;
    for &digit in &values[..25] {
        value = (value << 5) | u128::from(digit);
    }
    value = (value << 3) | u128::from(last >> 2);
    let uuid = value.to_be_bytes();
    validate_uuid(&uuid)?;
    if encode_token(&uuid)? != token {
        return Err(NameError::NonCanonicalToken);
    }
    Ok(uuid)
}

/// Encode a complete name from a pre-normalized prefix and trusted UUID bytes.
/// Empty prefixes are rejected; title derivation (including `item` fallback)
/// belongs to the caller. Never pass mixed-endian Windows GUID bytes here.
pub fn encode_name(prefix: &str, trusted_uuid: &[u8; 16]) -> Result<String, NameError> {
    validate_prefix(prefix)?;
    Ok(format!("{prefix}--{}", encode_token(trusted_uuid)?))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecodedName<'a> {
    pub prefix: &'a str,
    pub uuid: [u8; 16],
}

/// Strictly parse a complete name without normalization or alias resolution.
/// Successful parsing establishes syntax only, not an existing lookup key.
pub fn decode_name(name: &str) -> Result<DecodedName<'_>, NameError> {
    if !(1 + 2 + TOKEN_LEN..=NAME_MAX_LEN).contains(&name.len()) {
        return Err(NameError::InvalidNameLength);
    }
    let (prefix, token) = name.split_once("--").ok_or(NameError::MissingSeparator)?;
    validate_prefix(prefix)?;
    Ok(DecodedName {
        prefix,
        uuid: decode_token(token)?,
    })
}

/// Caller-selected resource bounds for one complete imported corpus. No default
/// production policy is implied. Zero permits only the corresponding empty input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreflightLimits {
    pub max_entries: usize,
    pub max_name_bytes: usize,
    pub max_total_bytes: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreflightError {
    TooManyEntries {
        actual: usize,
        limit: usize,
    },
    NameTooLarge {
        index: usize,
        actual: usize,
        limit: usize,
    },
    TotalBytesExceeded {
        index: usize,
        limit: usize,
    },
    AllocationFailed,
}

impl fmt::Display for PreflightError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooManyEntries { actual, limit } => {
                write!(f, "legacy corpus has {actual} entries; limit is {limit}")
            }
            Self::NameTooLarge {
                index,
                actual,
                limit,
            } => write!(
                f,
                "legacy entry {index} has {actual} bytes; limit is {limit}"
            ),
            Self::TotalBytesExceeded { index, limit } => write!(
                f,
                "legacy corpus exceeds {limit} total bytes at entry {index}"
            ),
            Self::AllocationFailed => f.write_str("cannot allocate legacy conflict report"),
        }
    }
}

impl std::error::Error for PreflightError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LegacyConflict<'a> {
    /// Zero-based position in the supplied corpus; duplicates remain separate.
    pub index: usize,
    /// The exact imported string, borrowed without normalization or rewriting.
    pub name: &'a str,
}

#[derive(Debug, PartialEq, Eq)]
pub struct LegacyPreflight<'a> {
    pub conflicts: Vec<LegacyConflict<'a>>,
}

impl LegacyPreflight<'_> {
    /// Whether this bounded corpus is disjoint from the reserved new namespace.
    /// This says nothing about corpus completeness or any other activation gate.
    pub fn namespace_is_disjoint(&self) -> bool {
        self.conflicts.is_empty()
    }
}

fn legacy_namespace_collision(name: &str) -> bool {
    let Some((prefix, token)) = name.split_once("--") else {
        return false;
    };
    is_normalized_prefix(prefix)
        && token.len() == TOKEN_LEN
        && token.bytes().all(|byte| alphabet_value(byte).is_some())
}

/// Pure, conservative preflight over caller-supplied UTF-8 legacy strings.
/// Any normalized nonempty prefix + `--` + 26 lowercase `a-z2-7` characters
/// conflicts, even when UUID bits or token padding are invalid. Prefixes longer
/// than 48 bytes also conflict. Arbitrary other strings remain untouched.
///
/// All count/byte limits are checked before scanning or allocating a report;
/// an error is an incomplete check, never permission to activate. Supply the
/// full frozen active/archived/deleted corpus, not separately approved pages.
/// No storage, renaming, exact-lookup implementation, or cutover happens here.
pub fn preflight_legacy_names<'a>(
    names: &[&'a str],
    limits: PreflightLimits,
) -> Result<LegacyPreflight<'a>, PreflightError> {
    if names.len() > limits.max_entries {
        return Err(PreflightError::TooManyEntries {
            actual: names.len(),
            limit: limits.max_entries,
        });
    }
    let mut total = 0usize;
    for (index, name) in names.iter().enumerate() {
        if name.len() > limits.max_name_bytes {
            return Err(PreflightError::NameTooLarge {
                index,
                actual: name.len(),
                limit: limits.max_name_bytes,
            });
        }
        total = total
            .checked_add(name.len())
            .filter(|&n| n <= limits.max_total_bytes)
            .ok_or(PreflightError::TotalBytesExceeded {
                index,
                limit: limits.max_total_bytes,
            })?;
    }
    let count = names
        .iter()
        .filter(|name| legacy_namespace_collision(name))
        .count();
    let mut conflicts = Vec::new();
    conflicts
        .try_reserve_exact(count)
        .map_err(|_| PreflightError::AllocationFailed)?;
    for (index, &name) in names.iter().enumerate() {
        if legacy_namespace_collision(name) {
            conflicts.push(LegacyConflict { index, name });
        }
    }
    Ok(LegacyPreflight { conflicts })
}
