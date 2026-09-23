//! The committed Python-oracle vectors, run through the public API.

use orgtree_scope_clamp::vectors::{run, COMMITTED, SECTIONS};
use orgtree_scope_clamp::Rules;

#[test]
fn committed_vectors_match_the_python_oracle() {
    let report = run(COMMITTED, &Rules::LEGACY);
    assert!(
        report.failures.is_empty(),
        "{} failures, first: {:?}",
        report.failures.len(),
        &report.failures[..report.failures.len().min(5)]
    );
    assert_eq!(report.checked.len(), SECTIONS.len());
    for (name, n) in &report.checked {
        assert!(*n > 0, "section {name} is empty");
    }
    assert!(report.total() > 10_000);
}

#[test]
fn a_missing_section_fails() {
    let cut = COMMITTED.replacen("\"tier_ceiling\"", "\"tier_ceiling_gone\"", 1);
    let report = run(&cut, &Rules::LEGACY);
    assert!(report
        .failures
        .iter()
        .any(|f| f == "tier_ceiling: missing section"));
}

#[test]
fn a_tampered_row_fails() {
    // the first refusal text in the file, with one character changed
    let at = COMMITTED.find("\"refused\":\"").expect("a refusal row") + 11;
    let mut t = COMMITTED.to_owned();
    let c = &t[at..at + 1];
    let swap = if c == "x" { "y" } else { "x" };
    t.replace_range(at..at + 1, swap);
    let report = run(&t, &Rules::LEGACY);
    assert_eq!(report.failures.len(), 1, "{:?}", report.failures);
}

#[test]
fn the_vectors_are_stamped_with_the_captured_tables() {
    let stamp = format!(
        "\"tables_sha256\":\"{}\"",
        orgtree_scope_clamp::tables::TABLES_SHA256
    );
    assert!(COMMITTED.contains(&stamp));
    let win = format!(
        "\"windows\":\"{}\"",
        orgtree_scope_clamp::tables::WINDOWS_BUILD
    );
    assert!(COMMITTED.contains(&win));
}
