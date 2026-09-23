//! The committed Python-oracle vectors pass under the legacy rules, every
//! required section is present and non-empty, and the runner itself notices
//! a changed expectation.

use orgtree_funding_core::vectors::{run, COMMITTED, SECTIONS};
use orgtree_funding_core::Rules;

#[test]
fn legacy_rules_match_every_vector() {
    let report = run(COMMITTED, &Rules::LEGACY);
    assert!(
        report.failures.is_empty(),
        "{:#?}",
        &report.failures[..report.failures.len().min(20)]
    );
    let names: Vec<&str> = report.checked.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names, SECTIONS);
    for (name, n) in &report.checked {
        assert!(*n > 0, "section {name} is empty");
    }
    assert!(report.total() > 3000, "only {} rows", report.total());
}

#[test]
fn vectors_carry_their_oracle_identity() {
    assert!(COMMITTED.contains(r#""schema": "orgtree.funding-core-vectors/v1""#));
    assert!(COMMITTED.contains(r#""python":"3.13.15""#));
    assert!(COMMITTED.contains(r#""engine/backend/orgtree/ledger.py":""#));
}

/// Change one expected value and one expected read; the runner must name
/// the section each lives in.
#[test]
fn runner_detects_a_changed_expectation() {
    let first_value = COMMITTED.find(r#","value":"#).expect("a value row") + 1;
    let end = first_value + COMMITTED[first_value..].find(',').expect("value end");
    let mut tampered = COMMITTED.to_owned();
    tampered.replace_range(first_value..end, r#""value":12345.67"#);
    let report = run(&tampered, &Rules::LEGACY);
    assert_eq!(
        report.failing_sections().into_iter().collect::<Vec<_>>(),
        ["value"]
    );

    let read = COMMITTED.find(r#""t:haiku""#).expect("a tier read");
    let mut tampered = COMMITTED.to_owned();
    tampered.replace_range(read..read + 9, r#""t:hiku!""#);
    let report = run(&tampered, &Rules::LEGACY);
    assert_eq!(report.failures.len(), 1, "{:?}", report.failures);
}

#[test]
fn missing_section_fails() {
    let cut = COMMITTED.replace(r#""outside": ["#, r#""outsid": ["#);
    let report = run(&cut, &Rules::LEGACY);
    assert!(
        report
            .failures
            .iter()
            .any(|f| f.starts_with("outside: missing")),
        "{:?}",
        report.failures
    );
}
