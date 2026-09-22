//! Properties that hold beyond the committed vectors, plus the non-authority
//! guard over the library source.

use orgtree_backend_codec::json::{self, Limits, Object, Profile, Value};
use orgtree_op_receipt_codec::admission::{admit, AdmitCall, Decision};
use orgtree_op_receipt_codec::canonical::{canonical, py_float_repr};
use orgtree_op_receipt_codec::eviction::plan_append;
use orgtree_op_receipt_codec::fingerprint::fingerprint;
use orgtree_op_receipt_codec::key::{parse_key, py_decimal_value};
use orgtree_op_receipt_codec::sha256::{hex, sha256};
use orgtree_op_receipt_codec::{PyInt, PyOutcome, CEILING, TRIM_TO};

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
    let fp = |tool: &str, node: &str, generation: i64, args: &Value| match fingerprint(
        tool,
        node,
        &PyInt::from(generation),
        args,
    ) {
        PyOutcome::Value(h) => h,
        other => panic!("{other:?}"),
    };
    let base = fp("orgtree_message", "alpha", 1, &args);
    assert_eq!(base.len(), 64);
    assert!(base
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    assert_ne!(base, fp("orgtree_message", "alpha", 2, &args));
    assert_ne!(base, fp("orgtree_message", "alphb", 1, &args));
    assert_ne!(base, fp("orgtree_messagf", "alpha", 1, &args));
    assert_ne!(
        base,
        fp("orgtree_message", "alpha", 1, &value(r#"{"to": "betb"}"#))
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
        generation: PyInt::from(1i64),
        key,
        tool: "orgtree_message",
        args: &args,
        now_ms: PyInt::from(1_758_000_000_000i64),
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
        assert!(plan.watermark_after >= PyInt::from(old));
        if plan.cut > 0 {
            assert_eq!(plan.len_after, TRIM_TO);
            assert!(mints[..plan.cut]
                .iter()
                .all(|m| PyInt::from(*m) < plan.watermark_after));
        } else {
            assert_eq!(plan.watermark_after, PyInt::from(old));
        }
    }
}

/// A random value around the `i64` edge, scaled by up to 2^60 either way.
fn edge_i128(rng: &mut Rng) -> i128 {
    let v = i128::from(rng.next() as i64);
    match rng.next() % 4 {
        0 => v,
        1 => v << (rng.next() % 60),
        2 => v >> (rng.next() % 60),
        _ => i128::from(i64::MAX) + i128::from((rng.next() % 5) as i64) - 2,
    }
}

fn big(v: i128) -> PyInt {
    PyInt::parse_decimal(&v.to_string()).expect("decimal")
}

#[test]
fn exact_integers_agree_with_i128_arithmetic() {
    let mut rng = Rng(7);
    for _ in 0..20_000 {
        let (a, b) = (edge_i128(&mut rng), edge_i128(&mut rng));
        let (x, y) = (big(a), big(b));
        assert_eq!(x.to_string(), a.to_string());
        assert_eq!(x.cmp(&y), a.cmp(&b), "{a} vs {b}");
        assert_eq!(x.add(&y).to_string(), (a + b).to_string());
        assert_eq!(x.sub(&y).to_string(), (a - b).to_string());
        assert_eq!(x.to_i64(), i64::try_from(a).ok());
        assert_eq!(x.digit_count(), a.unsigned_abs().to_string().len());
    }
    assert_eq!(PyInt::parse_decimal("-0"), Some(PyInt::zero()));
    assert_eq!(
        PyInt::parse_decimal("000123").map(|v| v.to_string()),
        Some("123".to_owned())
    );
    for bad in ["", "-", "+1", "1_0", " 1", "1.0"] {
        assert_eq!(PyInt::parse_decimal(bad), None, "{bad:?}");
    }
}

#[test]
fn float_to_int_truncates_exactly() {
    let mut rng = Rng(11);
    for _ in 0..20_000 {
        let x = f64::from_bits(rng.next());
        if !x.is_finite() || x.abs() >= 2f64.powi(126) {
            continue;
        }
        // `as i128` truncates toward zero and is exact below 2^127.
        assert_eq!(PyInt::from_f64_trunc(x), Some(big(x as i128)), "{x:e}");
    }
    let max = PyInt::from_f64_trunc(f64::MAX).expect("finite");
    assert_eq!(max.digit_count(), 309);
    assert_eq!(
        max.to_string(),
        "179769313486231570814527423731704356798070567525844996598917476803157260780028538760589558632766878171540458953514382464234321326889464182768467546703537516986049910576551282076245490090389328944075868508455133942304583236903222948165808559332123348274797826204144723168738177180919299881250404026184124858368"
    );
    assert_eq!(PyInt::from_f64_trunc(-0.9), Some(PyInt::zero()));
    assert_eq!(PyInt::from_f64_trunc(f64::NAN), None);
    assert_eq!(PyInt::from_f64_trunc(f64::NEG_INFINITY), None);
}

#[test]
fn wide_watermarks_stay_exact_and_monotonic() {
    let wide = "123456789012345678901234567890";
    let rows: Vec<String> = (0..501).map(|i| format!(r#"{{"mint_ms": {i}}}"#)).collect();
    let doc = obj(&format!(
        r#"{{"op_receipts": [{}], "op_receipts_meta": {{"from_ms": {wide}, "seq": {wide}, "evicted": -{wide}}}}}"#,
        rows.join(",")
    ));
    let PyOutcome::Value(plan) = plan_append(&doc) else {
        panic!("plan failed")
    };
    assert_eq!(plan.watermark_after.to_string(), wide);
    assert_eq!(plan.seq.to_string(), "123456789012345678901234567891");
    assert_eq!(
        plan.evicted_total.map(|v| v.to_string()),
        Some("-123456789012345678901234567788".to_owned())
    );
}

/// The library holds no listener, storage, SQL, clock, entropy, process or
/// environment access. Only the stdout driver reads a file.
#[test]
fn library_source_has_no_authority() {
    let sources = [
        include_str!("../src/lib.rs"),
        include_str!("../src/key.rs"),
        include_str!("../src/pyint.rs"),
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
