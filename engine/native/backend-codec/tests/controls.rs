//! Negative controls. Each one replaces a single real decision with a known
//! faulty one and reruns the unchanged Python vectors. A control passes only
//! if the vectors report mismatches, and only in the sections that exercise
//! that decision. This shows the vectors are sensitive to these particular
//! defects; it does not prove they would catch every possible defect.

use orgtree_backend_codec::credential::{self, CredentialClaim, CredentialError, LegacyVerify};
use orgtree_backend_codec::credits::{self, AmountError, Credits, LegacyGrant, PyFloat2};
use orgtree_backend_codec::identity::{self, Actor, AgentKey, IdentityError};
use orgtree_backend_codec::json::{self, JsonError, Limits, Number, Object, Profile, Value};
use orgtree_backend_codec::presence::{self, GenerationError};
use orgtree_backend_codec::vectors::{run, Implementation, COMMITTED};
use orgtree_backend_codec::PyOutcome;

fn detected_only_in(imp: Implementation, sections: &[&str]) {
    let report = run(COMMITTED, &imp);
    assert!(!report.failures.is_empty(), "control was not detected (expected in {sections:?})");
    for s in report.failed_sections() {
        assert!(sections.contains(&s), "control also failed unrelated section {s}: {:?}", report.failures);
    }
}

// C1: multiply by 100 in floating point and round half away from zero.
fn naive_round2(x: f64) -> Result<PyFloat2, AmountError> {
    if !x.is_finite() {
        return Err(AmountError::NotFinite);
    }
    let h = (x * 100.0).round();
    if h.abs() > credits::PARITY_MAX_HUNDREDTHS as f64 {
        return Err(AmountError::OutOfRange);
    }
    Ok(PyFloat2 { hundredths: h as i64, negative_zero: h == 0.0 && x.is_sign_negative() })
}

#[test]
fn c01_float_multiply_rounding_is_detected() {
    detected_only_in(Implementation { py_round2: naive_round2, ..Implementation::REFERENCE }, &["py_round2", "parse_exact", "seat_for"]);
}

// C2: silently round sub-grid input instead of refusing it.
fn rounding_parse_exact(n: &Number) -> Result<Credits, AmountError> {
    credits::py_round2(n.to_f64()).map(|p| p.credits())
}

#[test]
fn c02_rounding_instead_of_precision_refusal_is_detected() {
    detected_only_in(Implementation { parse_exact: rounding_parse_exact, ..Implementation::REFERENCE }, &["parse_exact"]);
}

// C3: treat a present null as absent.
fn collapsing_presence(o: &Object, k: &str) -> &'static str {
    match o.get(k).kind() {
        "null" => "absent",
        other => other,
    }
}

#[test]
fn c03_null_collapsed_to_absent_is_detected() {
    detected_only_in(Implementation { presence_kind: collapsing_presence, ..Implementation::REFERENCE }, &["presence"]);
}

// C4: strict generation decoding that reads null as absent.
fn null_as_absent_generation(o: &Object) -> Result<Option<u64>, GenerationError> {
    match presence::node_generation(o) {
        Err(GenerationError::Null) => Ok(None),
        other => other,
    }
}

#[test]
fn c04_strict_generation_null_as_absent_is_detected() {
    detected_only_in(Implementation { node_generation: null_as_absent_generation, ..Implementation::REFERENCE }, &["generation"]);
}

// C5: the legacy door reproduction applies the default to null as well.
fn null_defaults_api_generation(o: &Object) -> PyOutcome<i64> {
    if o.get("generation").is_null() {
        return PyOutcome::Value(0);
    }
    presence::legacy_api_generation(o)
}

#[test]
fn c05_legacy_generation_default_on_null_is_detected() {
    detected_only_in(Implementation { legacy_api_generation: null_defaults_api_generation, ..Implementation::REFERENCE }, &["generation"]);
}

// C6: a "strict" parser that quietly accepts duplicates and NaN.
fn permissive_strict(t: &str, p: Profile, l: Limits) -> Result<Value, JsonError> {
    let _ = p;
    json::parse(t, Profile::PythonLegacy, l)
}

#[test]
fn c06_strict_json_accepting_duplicates_is_detected() {
    detected_only_in(Implementation { json_parse: permissive_strict, ..Implementation::REFERENCE }, &["json"]);
}

// C7: lowercase ASCII only, ignoring Python's non-ASCII lowercase table.
fn ascii_only_slugify(name: &str) -> Result<String, IdentityError> {
    let ascii: String = name.chars().map(|c| if c.is_ascii() { c } else { ' ' }).collect();
    identity::py_slugify(&ascii)
}

fn ascii_only_work_slugify(title: Option<&str>) -> String {
    let ascii: Option<String> = title.map(|t| t.chars().map(|c| if c.is_ascii() { c } else { ' ' }).collect());
    identity::py_work_slugify(ascii.as_deref())
}

#[test]
fn c07_ascii_only_lowercasing_is_detected() {
    detected_only_in(Implementation { py_slugify: ascii_only_slugify, ..Implementation::REFERENCE }, &["slugify"]);
    detected_only_in(
        Implementation { py_work_slugify: ascii_only_work_slugify, ..Implementation::REFERENCE },
        // new_work_name also derives its prefix, but it goes through the
        // reference function, so only work_slugify may fail here.
        &["work_slugify"],
    );
    detected_only_in(Implementation { lower_table: &[], ..Implementation::REFERENCE }, &["lower_table"]);
}

// C8: an agent literally named "user" mistaken for the USER root.
fn sentinel_confusing_actor(s: &str) -> Result<Actor, IdentityError> {
    match s {
        "user" => Ok(Actor::User),
        _ => Actor::parse(s),
    }
}

// C8b: an unknown @-string accepted as an agent key.
fn at_as_agent(s: &str) -> Result<Actor, IdentityError> {
    match Actor::parse(s) {
        Err(IdentityError::UnknownSentinel) => Ok(Actor::Agent(AgentKey::parse("x").unwrap())),
        other => other,
    }
}

#[test]
fn c08_namespace_mistakes_are_detected() {
    detected_only_in(Implementation { actor_parse: sentinel_confusing_actor, ..Implementation::REFERENCE }, &["actor"]);
    detected_only_in(Implementation { actor_parse: at_as_agent, ..Implementation::REFERENCE }, &["actor"]);
}

// C9: a whole-string match that misses Python's `$`-before-newline rule.
fn fullmatch_retired_shape(s: &str) -> bool {
    s.len() == 9 && s.starts_with('w') && s[1..].bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[test]
fn c09_retired_id_regex_quirk_is_detected() {
    detected_only_in(Implementation { retired_shape: fullmatch_retired_shape, ..Implementation::REFERENCE }, &["retired_shape"]);
}

// C10: seat rule without the 1e-9 guard.
fn seat_without_epsilon(p: f64) -> PyOutcome<PyFloat2> {
    if (1.0..1e12).contains(&p) {
        return PyOutcome::Value(PyFloat2 { hundredths: p.floor() as i64 * 100, negative_zero: false });
    }
    credits::py_seat_for(p)
}

#[test]
fn c10_seat_rule_without_epsilon_is_detected() {
    detected_only_in(Implementation { py_seat_for: seat_without_epsilon, ..Implementation::REFERENCE }, &["seat_for"]);
}

// C11: canonical credential decoding that ignores unused base64 bits.
fn lax_canonical(p: &str) -> Result<CredentialClaim, CredentialError> {
    match credential::decode_payload_legacy(p) {
        LegacyVerify::Accepted(c) if c.generation >= 0 => Ok(c),
        _ => Err(CredentialError::Shape),
    }
}

#[test]
fn c11_noncanonical_credential_bits_are_detected() {
    detected_only_in(Implementation { decode_payload_canonical: lax_canonical, ..Implementation::REFERENCE }, &["credential_decode"]);
}

// C12: payload JSON written as raw UTF-8 instead of Python's ASCII escapes.
fn utf8_payload(org: &str, node: &str, g: i64, seat: &str) -> Result<String, CredentialError> {
    if g < 0 {
        return Err(CredentialError::NegativeGeneration);
    }
    let raw = format!("[\"{org}\",\"{node}\",{g},\"{seat}\"]");
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in raw.as_bytes().chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..=chunk.len() {
            out.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    Ok(out)
}

#[test]
fn c12_non_ascii_payload_encoding_is_detected() {
    detected_only_in(Implementation { encode_payload: utf8_payload, ..Implementation::REFERENCE }, &["credential_encode"]);
}

// C13: work names built from an uncut prefix.
fn uncut_work_name(title: Option<&str>, u: &[u8; 16]) -> Result<String, orgtree_work_name_codec::NameError> {
    let prefix = identity::py_slugify(title.unwrap_or("")).unwrap_or_else(|_| "item".to_owned());
    Ok(format!("{prefix}--{}", orgtree_work_name_codec::encode_token(u)?))
}

#[test]
fn c13_uncut_work_name_prefix_is_detected() {
    detected_only_in(Implementation { new_work_name: uncut_work_name, ..Implementation::REFERENCE }, &["new_work_name"]);
}

// C14: refusing boolean grants, which current Python accepts as int.
fn bool_refusing_grant(v: &Value) -> PyOutcome<LegacyGrant> {
    if matches!(v, Value::Bool(_)) {
        return PyOutcome::Raises(orgtree_backend_codec::PyException::TypeError);
    }
    credits::legacy_hire_grant(v)
}

#[test]
fn c14_grant_characterization_drift_is_detected() {
    detected_only_in(Implementation { legacy_hire_grant: bool_refusing_grant, ..Implementation::REFERENCE }, &["hire_grant"]);
}

// C15: a payload that drops the seat (the pre-P04a-2 three-field credential).
fn seatless_payload(org: &str, node: &str, g: i64, _seat: &str) -> Result<String, CredentialError> {
    credential::encode_payload(org, node, g, "x").map(|_| {
        let raw = format!("[{},{},{g}]", json::python_ascii_string(org), json::python_ascii_string(node));
        const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::new();
        for chunk in raw.as_bytes().chunks(3) {
            let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
            for i in 0..=chunk.len() {
                out.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
            }
        }
        out
    })
}

#[test]
fn c15_seatless_credential_payload_is_detected() {
    detected_only_in(Implementation { encode_payload: seatless_payload, ..Implementation::REFERENCE }, &["credential_encode"]);
}

// C16: canonical decoding that accepts shape-invalid payloads, among them a
// three-field (seatless) payload and one with an empty seat id.
fn empty_seat_canonical(p: &str) -> Result<CredentialClaim, CredentialError> {
    match credential::decode_payload_canonical(p) {
        Err(CredentialError::Shape) => match credential::decode_payload_legacy(p) {
            LegacyVerify::Rejected => Ok(CredentialClaim { org: String::new(), node: String::new(), generation: 0, seat: String::new() }),
            _ => Err(CredentialError::Shape),
        },
        other => other,
    }
}

#[test]
fn c16_empty_or_missing_seat_acceptance_is_detected() {
    detected_only_in(Implementation { decode_payload_canonical: empty_seat_canonical, ..Implementation::REFERENCE }, &["credential_decode"]);
}
