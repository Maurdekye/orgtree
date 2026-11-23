//! The seal of an export: how an import tells a file this computer made from
//! any other (docs/rust-engine/agent-export.md, "Files from elsewhere").
//!
//! The exporting engine seals a few facts of the manifest with a key that
//! never leaves its data folder (the watchdog credentials' key,
//! `mqtt/seal.rs`, under an AAD of this module's own, so a seal is nothing
//! else's ciphertext and nothing else's is a seal). The facts name the index
//! of the file, and the index names every part with its SHA-256, so a seal
//! that opens says: this engine wrote exactly these parts.
//!
//! A file whose seal does not open here is "foreign": made on another
//! computer, or changed since. USER 2026-11-23 20:32Z m62418cf863fe: an
//! agent's import of a foreign file needs no approval; the user's own import
//! of one shows a notice. Nothing else depends on the seal.

use base64::Engine as _;

use super::format::Manifest;
use crate::engine::Engine;

const AAD: &[u8] = b"orgtree-export-manifest-v1:";

/// What a seal covers, as bytes: the index's digest, when and where it was made.
#[nolog]
fn facts(manifest: &Manifest) -> Vec<u8> {
    let mut out = AAD.to_vec();
    for fact in [&manifest.index_sha256, &manifest.exported_at, &manifest.origin.engine, &manifest.origin.org_uuid, &manifest.root] {
        out.extend_from_slice(&(fact.len() as u64).to_be_bytes());
        out.extend_from_slice(fact.as_bytes());
    }
    out
}

#[nolog]
fn key(engine: &Engine) -> Option<std::sync::Arc<crate::mqtt::seal::Key>> {
    engine.dogs.mqtt.key(&engine.cfg.data_root.join("secrets")).ok()
}

/// The seal of `manifest`, or none when this data folder can hold no key.
#[nolog]
pub fn sign(engine: &Engine, manifest: &Manifest) -> Option<String> {
    let sealed = crate::mqtt::seal::seal_with_aad(&*key(engine)?, &facts(manifest), b"").ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(sealed))
}

/// Whether this engine sealed `manifest` as it reads now.
#[nolog]
pub fn made_here(engine: &Engine, manifest: &Manifest) -> bool {
    let Some(seal) = manifest.seal.as_deref() else { return false };
    let Ok(sealed) = base64::engine::general_purpose::STANDARD.decode(seal) else { return false };
    key(engine).is_some_and(|key| crate::mqtt::seal::unseal_with_aad(&key, &facts(manifest), &sealed).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An engine with a data folder of its own, and so a key of its own.
    fn engine() -> (crate::engine::EngineRef, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("orgtree-export-seal-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        (Engine::for_tests(root.clone()), root)
    }

    fn manifest() -> Manifest {
        let mut m = Manifest { index_sha256: "ab".repeat(32), exported_at: "2026-11-23T20:40:00Z".into(), root: "lead".into(), ..Manifest::default() };
        m.origin.engine = "engine-1".into();
        m.origin.org_uuid = "org-1".into();
        m
    }

    #[tokio::test]
    async fn a_seal_opens_only_on_the_engine_that_made_it_and_only_for_what_it_sealed() {
        let ((here, here_root), (there, there_root)) = (engine(), engine());
        let mut m = manifest();
        assert!(!made_here(&here, &m), "no seal");
        m.seal = sign(&here, &m);
        assert!(m.seal.is_some());
        assert!(made_here(&here, &m));
        assert!(!made_here(&there, &m), "another computer's key");
        // what the seal does not cover may differ: another version writes other members
        let mut later = m.clone();
        later.orgtree_version = "9.9.9".into();
        later.counts.files = 7;
        assert!(made_here(&here, &later));
        // every fact it covers
        for change in [
            |m: &mut Manifest| m.index_sha256 = "cd".repeat(32),
            |m: &mut Manifest| m.exported_at.push('x'),
            |m: &mut Manifest| m.origin.engine.push('x'),
            |m: &mut Manifest| m.origin.org_uuid.push('x'),
            |m: &mut Manifest| m.root.push('x'),
            |m: &mut Manifest| m.seal = Some("not base64 at all".into()),
            |m: &mut Manifest| m.seal = Some(String::new()),
        ] {
            let mut changed = m.clone();
            change(&mut changed);
            assert!(!made_here(&here, &changed));
        }
        // two facts that only swap a character between them are not the same facts
        let mut moved = m.clone();
        moved.origin.engine = "engine-".into();
        moved.origin.org_uuid = "1org-1".into();
        assert!(!made_here(&here, &moved));
        for root in [here_root, there_root] {
            assert!(root.file_name().unwrap().to_string_lossy().starts_with("orgtree-export-seal-"));
            std::fs::remove_dir_all(&root).unwrap();
        }
    }
}
