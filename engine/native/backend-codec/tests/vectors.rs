//! The reference implementation matches every committed Python vector.

use orgtree_backend_codec::vectors::{run, Implementation, COMMITTED};

#[test]
fn reference_matches_every_python_vector() {
    let report = run(COMMITTED, &Implementation::REFERENCE);
    assert!(report.failures.is_empty(), "{} mismatches:\n{}", report.failures.len(), report.failures.join("\n"));
    // Every section is present and non-empty, so a truncated file cannot pass.
    assert_eq!(report.checked.len(), 15, "{:?}", report.checked);
    for (name, n) in &report.checked {
        assert!(*n > 0, "section {name} is empty");
    }
}
