//! Properties that hold beyond the committed vectors, plus the non-authority
//! guard over the library source.

use orgtree_backend_codec::json::{self, Limits, Object, Profile, Value};
use orgtree_op_receipt_codec::admission::{admit, AdmitCall, Decision};
use orgtree_op_receipt_codec::canonical::{canonical, py_float_repr};
use orgtree_op_receipt_codec::eviction::plan_append;
use orgtree_op_receipt_codec::fingerprint::fingerprint;
use orgtree_op_receipt_codec::key::{parse_key, py_decimal_value};
use orgtree_op_receipt_codec::sha256::{hex, sha256};
use orgtree_op_receipt_codec::{PyOutcome, CEILING, TRIM_TO};

/// A small deterministic generator; the tests read no clock or entropy.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

fn obj(text: &str) -> Object {
    match json::parse(text, Profile::PythonLegacy, Limits::TEST) {
        Ok(Value::Object(o)) => o,
        other => panic!("not an object: {other:?}"),
    }
}

fn value(text: &str) -> Value {
    json::parse(text, Profile::PythonLegacy, Limits::TEST).expect("valid JSON")
}

#[test]
fn float_repr_round_trips_and_uses_pythons_notation_rule() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for _ in 0..200_000 {
        let x = f64::from_bits(rng.next());
        if !x.is_finite() {
            continue;
        }
        let r = py_float_repr(x);
        assert_eq!(r.parse::<f64>().unwrap().to_bits(), x.to_bits(), "{r}");
        let exponent_form = r.contains('e');
        let a = x.abs();
        let fixed_range = a == 0.0 || (1e-4..1e16).contains(&a);
        assert_eq!(exponent_form, !fixed_range, "{x:e} -> {r}");
        if !exponent_form {
            assert!(r.contains('.'), "{r}");
        }
    }
}

#[test]
fn canonical_text_ignores_member_order() {
    let a = value(r#"{"b": [1, {"y": 2, "x": 1}], "a": "t", "c": null}"#);
    let b = value(r#"{"c": null, "a": "t", "b": [1, {"x": 1, "y": 2}]}"#);
    assert_eq!(canonical(&a), canonical(&b));
}

#[test]
fn fingerprint_is_full_lowercase_hex_and_covers_every_identity_field() {
    let args = value(r#"{"to": "beta"}"#);
    let base = fingerprint("orgtree_message", "alpha", 1, &args);
    assert_eq!(base.len(), 64);
    assert!(base
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    assert_ne!(base, fingerprint("orgtree_message", "alpha", 2, &args));
    assert_ne!(base, fingerprint("orgtree_message", "alphb", 1, &args));
    assert_ne!(base, fingerprint("orgtree_messagf", "alpha", 1, &args));
    assert_ne!(
        base,
        fingerprint("orgtree_message", "alpha", 1, &value(r#"{"to": "betb"}"#))
    );
}

#[test]
fn sha256_matches_fips_examples() {
    assert_eq!(
        hex(&sha256(b"abc")),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        hex(&sha256(b"")),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

#[test]
fn every_decimal_digit_has_its_value() {
    for zero in orgtree_op_receipt_codec::key::DECIMAL_ZEROS {
        for d in 0..10 {
            assert_eq!(py_decimal_value(char::from_u32(zero + d).unwrap()), Some(d));
        }
    }
    assert_eq!(py_decimal_value('a'), None);
}

#[test]
fn accepted_keys_have_ordinary_mint_times() {
    let mut rng = Rng(7);
    for _ in 0..20_000 {
        let n = 13 + (rng.next() % 2) as usize;
        let digits: String = (0..n)
            .map(|_| char::from(b'0' + (rng.next() % 10) as u8))
            .collect();
        let tail: String = (0..24)
            .map(|_| char::from(b"0123456789abcdef"[(rng.next() % 16) as usize]))
            .collect();
        let key = format!("{digits}-{tail}");
        assert_eq!(parse_key(&key), Some(digits.parse::<i64>().unwrap()));
        assert_eq!(parse_key(&format!("{key}0")), None);
        assert_eq!(
            parse_key(&format!("{digits}-{}", tail.to_uppercase())),
            if tail.bytes().any(|b| b.is_ascii_alphabetic()) {
                None
            } else {
                Some(digits.parse::<i64>().unwrap())
            }
        );
    }
}

#[test]
fn rows_of_other_nodes_do_not_change_admission() {
    let args = value(r#"{"to": "beta"}"#);
    let key = "1758000000000-000000000000000000000abc";
    let call = AdmitCall {
        node: "alpha",
        generation: 1,
        key,
        tool: "orgtree_message",
        args: &args,
        now_ms: 1_758_000_000_000,
        epoch_ok: true,
    };
    let plain = admit(&obj(r#"{}"#), &call);
    let other = format!(
        r#"{{"op_receipts": [{{"key": "{key}", "node": "beta", "gen": 1, "tool": "orgtree_message", "fp": "x"}}]}}"#
    );
    assert_eq!(admit(&obj(&other), &call), plain);
    match plain {
        PyOutcome::Value(a) => assert_eq!(a.decision, Decision::Admit),
        other => panic!("{other:?}"),
    }
}

#[test]
fn eviction_watermark_never_decreases_and_passes_every_evicted_mint() {
    let mut rng = Rng(42);
    for _ in 0..300 {
        let n = 495 + (rng.next() % 20) as usize;
        let mints: Vec<i64> = (0..n)
            .map(|_| (rng.next() % 2_000_000_000_000) as i64)
            .collect();
        let old = (rng.next() % 2_000_000_000_000) as i64;
        let rows: Vec<String> = mints
            .iter()
            .map(|m| format!(r#"{{"mint_ms": {m}}}"#))
            .collect();
        let doc = obj(&format!(
            r#"{{"op_receipts": [{}], "op_receipts_meta": {{"from_ms": {old}}}}}"#,
            rows.join(",")
        ));
        let PyOutcome::Value(plan) = plan_append(&doc) else {
            panic!("plan failed")
        };
        assert!(plan.len_after <= CEILING);
        assert!(plan.watermark_after >= old);
        if plan.cut > 0 {
            assert_eq!(plan.len_after, TRIM_TO);
            assert!(mints[..plan.cut].iter().all(|m| *m < plan.watermark_after));
        } else {
            assert_eq!(plan.watermark_after, old);
        }
    }
}

/// The library holds no listener, storage, SQL, clock, entropy, process or
/// environment access. Only the stdout driver reads a file.
#[test]
fn library_source_has_no_authority() {
    let sources = [
        include_str!("../src/lib.rs"),
        include_str!("../src/key.rs"),
        include_str!("../src/canonical.rs"),
        include_str!("../src/sha256.rs"),
        include_str!("../src/fingerprint.rs"),
        include_str!("../src/admission.rs"),
        include_str!("../src/eviction.rs"),
        include_str!("../src/vectors.rs"),
    ];
    let forbidden = [
        "std::net",
        "std::fs",
        "std::time",
        "std::process",
        "std::env",
        "std::thread",
        "SystemTime",
        "Instant",
        "TcpStream",
        "UdpSocket",
        "File::",
        "unsafe",
        "postgres",
        "sqlx",
        "rusqlite",
        "tokio",
    ];
    for src in sources {
        for word in forbidden {
            assert!(!src.contains(word), "library source mentions {word}");
        }
    }
    let manifest = include_str!("../Cargo.toml");
    let deps = manifest.split("[dependencies]").nth(1).unwrap_or("");
    for line in deps
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
    {
        assert!(line.contains("path = "), "non-path dependency: {line}");
    }
}
