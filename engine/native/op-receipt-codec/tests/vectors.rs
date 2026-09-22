//! The legacy rules match every committed Python vector.

use orgtree_op_receipt_codec::vectors::{run, COMMITTED, SECTIONS};
use orgtree_op_receipt_codec::Rules;

#[test]
fn legacy_rules_match_every_python_vector() {
    let report = run(COMMITTED, &Rules::LEGACY);
    assert!(
        report.failures.is_empty(),
        "{} mismatches:\n{}",
        report.failures.len(),
        report.failures.join("\n")
    );
    assert_eq!(report.checked.len(), SECTIONS.len(), "{:?}", report.checked);
    for (name, n) in &report.checked {
        assert!(*n > 0, "section {name} is empty");
    }
}

#[test]
fn a_truncated_vectors_file_fails() {
    let cut = COMMITTED
        .find(r#""admission""#)
        .expect("admission section present");
    let truncated = format!("{}}}", COMMITTED[..cut].trim_end().trim_end_matches(','));
    let report = run(&truncated, &Rules::LEGACY);
    assert!(
        report
            .failures
            .iter()
            .any(|f| f.starts_with("admission: missing")),
        "{:?}",
        report.failures
    );
    assert!(
        report
            .failures
            .iter()
            .any(|f| f.starts_with("append: missing")),
        "{:?}",
        report.failures
    );
}
