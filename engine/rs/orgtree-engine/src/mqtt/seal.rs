//! Inline broker credentials at rest (docs/rust-engine/mqtt-watchdogs.md):
//! sealed with AES-256-GCM (ring) under one random 32-byte key per data
//! root, kept in `<data>/secrets/watchdog-credentials.key`. On Windows the
//! file holds the key wrapped by DPAPI in MACHINE scope: user scope fails in
//! the boot engine's S4U session (credential_context.rs). Elsewhere it holds
//! the raw key in an owner-only (0600) file.
//!
//! What this protects: a copy of the database or data folder taken off the
//! machine. What it does not: a reader on this machine, who can unwrap the
//! machine-scope key (coordinator ruling 2026-10-19).

use std::io::Write;
use std::path::Path;

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};

pub const KEY_FILE: &str = "watchdog-credentials.key";
const MAGIC_DPAPI: &[u8] = b"OTWK1D";
const MAGIC_RAW: &[u8] = b"OTWK1R";
const VERSION: u8 = 1;
const AAD_PREFIX: &[u8] = b"orgtree-mqtt-credentials-v1:";

/// The sealing key: no Debug of its bytes, never serialized.
pub struct Key([u8; 32]);

impl std::fmt::Debug for Key {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Key(*****)")
    }
}

/// The data root's key from `dir`, made there on first use. Two engines
/// racing to make it both end up with the one that was written first.
#[nolog]
pub fn load_or_create(dir: &Path) -> Result<Key, String> {
    let file = dir.join(KEY_FILE);
    if let Ok(bytes) = std::fs::read(&file) {
        return decode(&bytes);
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    let mut key = [0u8; 32];
    SystemRandom::new().fill(&mut key).map_err(|_| "no system randomness for a key".to_string())?;
    let body = encode(&key)?;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    match opts.open(&file) {
        Ok(mut f) => {
            f.write_all(&body).and_then(|_| f.flush()).map_err(|e| format!("could not write {}: {e}", file.display()))?;
            Ok(Key(key))
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            decode(&std::fs::read(&file).map_err(|e| format!("could not read {}: {e}", file.display()))?)
        }
        Err(e) => Err(format!("could not create {}: {e}", file.display())),
    }
}

/// `plain` sealed for the watchdog in row `row`: version, nonce, ciphertext
/// and tag. The row is authenticated, so a blob moved to another dog fails.
#[nolog]
pub fn seal(key: &Key, row: i64, plain: &[u8]) -> Result<Vec<u8>, String> {
    let k = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &key.0).map_err(|_| "bad sealing key".to_string())?);
    let mut nonce = [0u8; NONCE_LEN];
    SystemRandom::new().fill(&mut nonce).map_err(|_| "no system randomness for a nonce".to_string())?;
    let mut buf = plain.to_vec();
    k.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(aad(row)), &mut buf)
        .map_err(|_| "sealing failed".to_string())?;
    let mut out = Vec::with_capacity(1 + NONCE_LEN + buf.len());
    out.push(VERSION);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&buf);
    Ok(out)
}

/// The plaintext of [`seal`]'s output, or why it cannot be opened.
#[nolog]
pub fn unseal(key: &Key, row: i64, sealed: &[u8]) -> Result<Vec<u8>, String> {
    if sealed.len() < 1 + NONCE_LEN + AES_256_GCM.tag_len() || sealed[0] != VERSION {
        return Err("the sealed credentials are not in a known format".into());
    }
    let k = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &key.0).map_err(|_| "bad sealing key".to_string())?);
    let nonce: [u8; NONCE_LEN] = sealed[1..1 + NONCE_LEN].try_into().map_err(|_| "bad nonce".to_string())?;
    let mut buf = sealed[1 + NONCE_LEN..].to_vec();
    let plain = k
        .open_in_place(Nonce::assume_unique_for_key(nonce), Aad::from(aad(row)), &mut buf)
        .map_err(|_| "the sealed credentials do not open with this data folder's key (made on another machine, or altered)".to_string())?;
    Ok(plain.to_vec())
}

#[nolog]
fn aad(row: i64) -> Vec<u8> {
    let mut a = AAD_PREFIX.to_vec();
    a.extend_from_slice(&row.to_be_bytes());
    a
}

#[nolog]
fn encode(key: &[u8; 32]) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        let mut out = MAGIC_DPAPI.to_vec();
        out.extend(dpapi::protect(key)?);
        Ok(out)
    }
    #[cfg(not(windows))]
    {
        let mut out = MAGIC_RAW.to_vec();
        out.extend_from_slice(key);
        Ok(out)
    }
}

#[nolog]
fn unwrap_dpapi(blob: &[u8]) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        dpapi::unprotect(blob)
    }
    #[cfg(not(windows))]
    {
        let _ = blob;
        Err("the watchdog credentials key was wrapped by Windows DPAPI and cannot be opened here".into())
    }
}

#[nolog]
fn decode(bytes: &[u8]) -> Result<Key, String> {
    let raw = if let Some(blob) = bytes.strip_prefix(MAGIC_DPAPI) {
        unwrap_dpapi(blob)?
    } else if let Some(raw) = bytes.strip_prefix(MAGIC_RAW) {
        raw.to_vec()
    } else {
        return Err(format!("{KEY_FILE} is not a watchdog credentials key"));
    };
    let key: [u8; 32] = raw.as_slice().try_into().map_err(|_| format!("{KEY_FILE} holds a key of the wrong length"))?;
    Ok(Key(key))
}

#[cfg(windows)]
mod dpapi {
    use windows_sys::Win32::Foundation::{GetLastError, LocalFree};
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    const ENTROPY: &[u8] = b"orgtree-watchdog-credentials-key";

    fn blob(b: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: b.len() as u32, pbData: b.as_ptr() as *mut u8 }
    }

    /// Copy DPAPI's output and free it.
    fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        if out.pbData.is_null() {
            return Vec::new();
        }
        // SAFETY: DPAPI returned `cbData` bytes at `pbData`, freed below with LocalFree.
        let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
        unsafe { LocalFree(out.pbData as _) };
        v
    }

    #[nolog]
    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(plain);
        let entropy = blob(ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // SAFETY: every pointer is valid for the call; the output is taken and freed by `take`.
        let ok = unsafe {
            CryptProtectData(&input, std::ptr::null(), &entropy, std::ptr::null(), std::ptr::null(),
                             CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        if ok == 0 {
            return Err(format!("DPAPI could not wrap the watchdog credentials key (error {})", unsafe { GetLastError() }));
        }
        Ok(take(out))
    }

    #[nolog]
    pub fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(sealed);
        let entropy = blob(ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // SAFETY: as in `protect`; no description is asked for.
        let ok = unsafe {
            CryptUnprotectData(&input, std::ptr::null_mut(), &entropy, std::ptr::null(), std::ptr::null(),
                               CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        if ok == 0 {
            return Err(format!("DPAPI could not unwrap the watchdog credentials key (error {}): it was made on another machine", unsafe {
                GetLastError()
            }));
        }
        Ok(take(out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("orgtree-mqtt-seal-{}", crate::util::random_hex(6)))
    }

    #[test]
    fn a_key_is_made_once_and_read_back() {
        let d = dir();
        let a = load_or_create(&d).unwrap();
        let b = load_or_create(&d).unwrap();
        assert_eq!(a.0, b.0, "the second engine reads the first one's key");
        let file = std::fs::read(d.join(KEY_FILE)).unwrap();
        #[cfg(windows)]
        assert!(file.starts_with(MAGIC_DPAPI) && !file.windows(32).any(|w| w == &a.0[..]),
                "on Windows the file holds the DPAPI-wrapped key, never the raw key");
        #[cfg(not(windows))]
        assert!(file.starts_with(MAGIC_RAW));
        assert!(format!("{a:?}") == "Key(*****)");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn sealing_round_trips_and_binds_the_row() {
        let d = dir();
        let key = load_or_create(&d).unwrap();
        let sealed = seal(&key, 42, b"{\"u\":\"ha\",\"p\":\"S3CRET\"}").unwrap();
        assert!(!sealed.windows(6).any(|w| w == &b"S3CRET"[..]), "no plaintext at rest");
        assert_eq!(unseal(&key, 42, &sealed).unwrap(), b"{\"u\":\"ha\",\"p\":\"S3CRET\"}");
        assert!(unseal(&key, 43, &sealed).is_err(), "a blob moved to another dog does not open");
        let mut bent = sealed.clone();
        *bent.last_mut().unwrap() ^= 1;
        assert!(unseal(&key, 42, &bent).is_err(), "an altered blob does not open");
        let other = load_or_create(&dir()).unwrap();
        assert!(unseal(&other, 42, &sealed).is_err(), "another data root's key does not open it");
        assert_ne!(seal(&key, 42, b"x").unwrap(), seal(&key, 42, b"x").unwrap(), "fresh nonce each time");
        std::fs::remove_dir_all(&d).ok();
    }
}
