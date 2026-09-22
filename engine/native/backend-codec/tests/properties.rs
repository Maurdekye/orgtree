//! Deterministic property and boundary checks that do not need Python.

use orgtree_backend_codec::credential::{decode_payload_canonical, decode_payload_legacy, encode_payload, CredentialError, LegacyVerify};
use orgtree_backend_codec::credits::{self, parse_exact, py_float_repr, py_round2, AmountError, Credits, PARITY_MAX_HUNDREDTHS};
use orgtree_backend_codec::identity::{self, Actor, AgentKey, OrgKey, ScopedKey};
use orgtree_backend_codec::json::{self, JsonErrorKind, Limits, Number, Profile, Value};
use orgtree_backend_codec::presence::{self, GenerationError, Presence};
use orgtree_backend_codec::{PyException, PyOutcome, UNRESOLVED};

/// A tiny deterministic generator; no OS entropy is involved.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 11
    }
}

#[test]
fn every_grid_value_round_trips_through_the_nearest_float() {
    // Dense near zero, then sampled up to the parity bound.
    let mut ks: Vec<i64> = (-300_000..=300_000).collect();
    let mut g = Lcg(7);
    for _ in 0..200_000 {
        ks.push((g.next() % PARITY_MAX_HUNDREDTHS as u64) as i64 * if g.next() & 1 == 0 { 1 } else { -1 });
    }
    ks.extend([PARITY_MAX_HUNDREDTHS, -PARITY_MAX_HUNDREDTHS, 1, -1]);
    for k in ks {
        let x = k as f64 / 100.0;
        let q = py_round2(x).unwrap();
        assert_eq!(q.hundredths, k, "{x}");
        // Rust's shortest round-trip formatting agrees with the Python-style
        // repr built from exact hundredths.
        let rust = format!("{x:?}");
        if k != 0 {
            assert_eq!(py_float_repr(q), rust, "{k}");
        }
        let c = Credits::from_hundredths(k).unwrap();
        let back = parse_exact(&Number::Finite(c.to_decimal_string())).unwrap();
        assert_eq!(back, c);
    }
}

#[test]
fn rounding_edges_and_bounds() {
    assert_eq!(py_round2(0.125).unwrap().hundredths, 12); // tie to even
    assert_eq!(py_round2(0.375).unwrap().hundredths, 38);
    assert_eq!(py_round2(2.675).unwrap().hundredths, 267); // really 2.67499…
    let nz = py_round2(-0.001).unwrap();
    assert!(nz.negative_zero && nz.hundredths == 0);
    assert_eq!(py_float_repr(nz), "-0.0");
    assert_eq!(py_round2(f64::NAN), Err(AmountError::NotFinite));
    assert_eq!(py_round2(1e13), Err(AmountError::OutOfRange));
    assert_eq!(py_round2(f64::from_bits(1)).unwrap().hundredths, 0); // smallest subnormal
    assert!(py_round2(-f64::from_bits(1)).unwrap().negative_zero);
}

#[test]
fn exact_amounts_refuse_rather_than_guess() {
    let p = |s: &str| parse_exact(&Number::Finite(s.to_owned()));
    assert_eq!(p("0.10").unwrap().hundredths(), 10);
    assert_eq!(p("1.5e-1").unwrap().hundredths(), 15);
    assert_eq!(p("0.125"), Err(AmountError::Precision));
    assert_eq!(p("1e-3"), Err(AmountError::Precision));
    assert_eq!(p("1e999999999999999999999"), Err(AmountError::OutOfRange));
    assert_eq!(p("0e999999999999999999999").unwrap(), Credits::ZERO);
    assert_eq!(p("10000000000000"), Err(AmountError::OutOfRange));
    assert_eq!(parse_exact(&Number::NaN), Err(AmountError::NotFinite));
    let max = Credits::from_hundredths(PARITY_MAX_HUNDREDTHS).unwrap();
    assert_eq!(max.checked_add(Credits::from_hundredths(1).unwrap()), Err(AmountError::OutOfRange));
    assert_eq!(Credits::checked_sum(vec![max, max]), Err(AmountError::OutOfRange));
    assert_eq!(Credits::from_hundredths(i64::MIN), Err(AmountError::OutOfRange));
}

#[test]
fn seat_rule_quirks() {
    let h = |p: f64| match credits::py_seat_for(p) {
        PyOutcome::Value(v) => Ok(v.hundredths),
        other => Err(other),
    };
    assert_eq!(h(f64::NAN), Ok(10));
    assert_eq!(h(-5.0), Ok(10));
    assert_eq!(h(0.02), Ok(10));
    assert_eq!(h(0.75), Ok(75));
    assert_eq!(h(2.9999999999), Ok(300));
    assert_eq!(h(1.5), Ok(100));
    assert_eq!(h(f64::INFINITY), Err(PyOutcome::Raises(PyException::OverflowError)));
}

#[test]
fn json_keeps_presence_order_and_lexemes() {
    let v = json::parse(r#"{"b":null,"a":1.50,"c":[]}"#, Profile::Strict, Limits::TEST).unwrap();
    let Value::Object(o) = v else { panic!() };
    assert_eq!(o.get("b"), Presence::Null);
    assert_eq!(o.get("zz"), Presence::Absent);
    assert!(matches!(o.get("a"), Presence::Present(Value::Number(n)) if n.lexeme() == "1.50"));
    let keys: Vec<&str> = o.members().iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(keys, ["b", "a", "c"]);

    // Legacy duplicates: first position, last value.
    let v = json::parse(r#"{"a":1,"b":2,"a":3}"#, Profile::PythonLegacy, Limits::TEST).unwrap();
    let Value::Object(o) = v else { panic!() };
    assert_eq!(o.members().len(), 2);
    assert_eq!(o.members()[0].0, "a");
    assert!(matches!(&o.members()[0].1, Value::Number(n) if n.lexeme() == "3"));
    let e = json::parse(r#"{"a":1,"a":3}"#, Profile::Strict, Limits::TEST).unwrap_err();
    assert_eq!(e.kind, JsonErrorKind::DuplicateKey);
}

#[test]
fn json_bounds_are_checked() {
    let deep = "[".repeat(70) + &"]".repeat(70);
    assert_eq!(json::parse(&deep, Profile::Strict, Limits::TEST).unwrap_err().kind, JsonErrorKind::TooDeep);
    let small = Limits { max_bytes: 4, max_depth: 8 };
    assert_eq!(json::parse("[1,2]", Profile::Strict, small).unwrap_err().kind, JsonErrorKind::TooLarge);
    assert_eq!(json::parse(r#""\ud800""#, Profile::PythonLegacy, Limits::TEST).unwrap_err().kind, JsonErrorKind::LoneSurrogate);
}

#[test]
fn generation_absent_and_null_differ() {
    let obj = |t: &str| match json::parse(t, Profile::PythonLegacy, Limits::TEST).unwrap() {
        Value::Object(o) => o,
        _ => panic!(),
    };
    assert_eq!(presence::node_generation(&obj("{}")), Ok(None));
    assert_eq!(presence::node_generation(&obj(r#"{"generation":null}"#)), Err(GenerationError::Null));
    assert_eq!(presence::legacy_api_generation(&obj("{}")), PyOutcome::Value(0));
    assert_eq!(presence::legacy_api_generation(&obj(r#"{"generation":null}"#)), PyOutcome::Raises(PyException::TypeError));
    assert_eq!(presence::node_generation(&obj(r#"{"generation":true}"#)), Err(GenerationError::NotInteger));
    assert_eq!(presence::legacy_api_generation(&obj(r#"{"generation":true}"#)), PyOutcome::Value(1));
}

#[test]
fn namespaces_do_not_collide() {
    // An agent may be named "user"; it is never the USER root.
    assert_eq!(Actor::parse("@user").unwrap(), Actor::User);
    assert!(matches!(Actor::parse("user").unwrap(), Actor::Agent(_)));
    assert_ne!(Actor::parse("user").unwrap(), Actor::User);
    assert!(Actor::parse("@users").is_err());
    // The same key text in two organizations, or in two namespaces, differs.
    let a = OrgKey::parse("alpha").unwrap();
    let b = OrgKey::parse("beta").unwrap();
    let k = AgentKey::parse("probe").unwrap();
    let in_a = ScopedKey::Agent { org: a.clone(), key: k.clone() };
    let in_b = ScopedKey::Agent { org: b, key: k };
    let work = ScopedKey::WorkName { org: a, name: "probe".to_owned() };
    assert_ne!(in_a, in_b);
    assert_ne!(in_a, work);
    // A new-format work name is never a canonical agent key (it has "--").
    let name = identity::new_work_name(Some("Probe"), &[0x5a, 0x1f, 0x3c, 0x77, 0x10, 0x02, 0x4c, 0x11, 0x8e, 0x01, 0, 0, 0, 0, 0, 1]).unwrap();
    assert!(name.contains("--"));
    assert!(AgentKey::parse(&name).is_err());
    // Work names are exact: case is not folded.
    assert_ne!(name.to_uppercase(), name);
}

#[test]
fn slug_edges() {
    assert_eq!(identity::py_slugify("İx").unwrap(), "i-x"); // i + combining dot
    assert_eq!(identity::py_slugify("\u{212a}elvin").unwrap(), "kelvin");
    assert!(identity::py_slugify("---").is_err());
    assert_eq!(identity::py_work_slugify(None), "item");
    assert_eq!(identity::py_work_slugify(Some(&("x".repeat(47) + "-yy"))), "x".repeat(47));
    assert!(identity::py_is_retired_work_id_shape("w12345678\n"));
    assert!(!identity::py_is_retired_work_id_shape("w12345678\n\n"));
}

#[test]
fn credential_payload_round_trips_and_refuses_noncanonical_text() {
    let mut g = Lcg(11);
    for i in 0..500 {
        let org = format!("org-{}", g.next() % 1000);
        let node = if i % 3 == 0 { format!("é\u{212a}-{i}") } else { format!("agent-{i}") };
        let gen = (g.next() % 1_000_000) as i64;
        let p = encode_payload(&org, &node, gen).unwrap();
        let c = decode_payload_canonical(&p).unwrap();
        assert_eq!((c.org.as_str(), c.node.as_str(), c.generation), (org.as_str(), node.as_str(), gen));
        assert_eq!(decode_payload_legacy(&p), LegacyVerify::Accepted(c));
    }
    assert_eq!(encode_payload("o", "n", -1), Err(CredentialError::NegativeGeneration));
    assert_eq!(decode_payload_canonical("WyJvIiwibiIsMV0="), Err(CredentialError::Alphabet));
    assert_eq!(decode_payload_canonical("WyJvIiwibiIsMV1"), Err(CredentialError::NonCanonicalBits));
    assert!(matches!(decode_payload_legacy("WyJvIiwibiIsMV1"), LegacyVerify::Accepted(_)));
}

#[test]
fn unresolved_cases_are_listed_once() {
    let mut ids: Vec<&str> = UNRESOLVED.iter().map(|u| u.id).collect();
    let n = ids.len();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), n);
    assert!(n >= 10);
}

/// The library has no listener, process, file, environment, clock or
/// entropy access. Only the local driver binary reads a file and its
/// arguments.
#[test]
fn library_sources_have_no_io_or_authority_surfaces() {
    let sources = [
        ("lib.rs", include_str!("../src/lib.rs")),
        ("json.rs", include_str!("../src/json.rs")),
        ("presence.rs", include_str!("../src/presence.rs")),
        ("credits.rs", include_str!("../src/credits.rs")),
        ("identity.rs", include_str!("../src/identity.rs")),
        ("credential.rs", include_str!("../src/credential.rs")),
        ("vectors.rs", include_str!("../src/vectors.rs")),
    ];
    let forbidden = ["std::net", "TcpListener", "UdpSocket", "std::process", "std::fs", "std::env", "SystemTime", "Instant::now", "std::thread", "unsafe "];
    for (name, text) in sources {
        for f in forbidden {
            assert!(!text.contains(f), "{name} contains {f}");
        }
    }
    let bin = include_str!("../src/bin/codec-vectors.rs");
    assert!(!bin.contains("std::net") && !bin.contains("TcpListener"));
    let manifest = include_str!("../Cargo.toml");
    let deps = manifest.split("[dependencies]").nth(1).unwrap();
    let deps: Vec<&str> = deps.lines().filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#')).collect();
    assert_eq!(deps, ["orgtree-work-name-codec = { path = \"../work-name-codec\" }"]);
}
