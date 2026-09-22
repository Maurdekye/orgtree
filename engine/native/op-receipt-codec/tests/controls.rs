//! Negative controls. Each one changes a single decision in [`Rules`] to a
//! known-faulty one and reruns the unchanged Python vectors. A control passes
//! only if the vectors report mismatches, and only in the sections that
//! exercise that decision. This shows the vectors are sensitive to these
//! particular defects; it does not prove they would catch every defect.

use orgtree_op_receipt_codec::vectors::{run, COMMITTED};
use orgtree_op_receipt_codec::{sha256, Rules};

fn detected_only_in(rules: Rules, sections: &[&str]) {
    let report = run(COMMITTED, &rules);
    assert!(
        !report.failures.is_empty(),
        "control was not detected (expected in {sections:?})"
    );
    for s in report.failed_sections() {
        assert!(
            sections.contains(&s),
            "control also failed unrelated section {s}: {:?}",
            report.failures
        );
    }
}

const L: Rules = Rules::LEGACY;

#[test]
fn c01_truncated_fingerprint() {
    detected_only_in(
        Rules {
            fingerprint_hex_len: 32,
            ..L
        },
        &["fingerprint", "find", "admission"],
    );
}

#[test]
fn c02_ascii_only_key_digits() {
    detected_only_in(
        Rules {
            key_unicode_digits: false,
            ..L
        },
        &["key", "admission"],
    );
}

#[test]
fn c03_no_final_newline_allowance() {
    detected_only_in(
        Rules {
            key_final_newline: false,
            ..L
        },
        &["key", "admission"],
    );
}

#[test]
fn c04_ensure_ascii() {
    detected_only_in(
        Rules {
            ensure_ascii: true,
            ..L
        },
        &["canonical", "fingerprint"],
    );
}

#[test]
fn c05_utf16_key_order() {
    detected_only_in(
        Rules {
            utf16_key_order: true,
            ..L
        },
        &["canonical", "fingerprint"],
    );
}

#[test]
fn c06_rust_float_formatting() {
    detected_only_in(
        Rules {
            python_float_repr: false,
            ..L
        },
        &["float", "canonical", "fingerprint", "admission"],
    );
}

#[test]
fn c07_generation_as_find_matcher() {
    detected_only_in(
        Rules {
            generation_matches_in_find: true,
            ..L
        },
        &["admission"],
    );
}

#[test]
fn c08_find_oldest_first() {
    detected_only_in(
        Rules {
            find_newest_first: false,
            ..L
        },
        &["find", "admission"],
    );
}

#[test]
fn c09_fingerprint_at_caller_node() {
    detected_only_in(
        Rules {
            fp_node_from_row: false,
            ..L
        },
        &["admission"],
    );
}

#[test]
fn c10_future_bound_off_by_one() {
    detected_only_in(
        Rules {
            future_inclusive: true,
            ..L
        },
        &["admission"],
    );
}

#[test]
fn c11_stale_bound_off_by_one() {
    detected_only_in(
        Rules {
            stale_inclusive: true,
            ..L
        },
        &["admission"],
    );
}

#[test]
fn c12_watermark_bound_off_by_one() {
    detected_only_in(
        Rules {
            watermark_inclusive: true,
            ..L
        },
        &["admission"],
    );
}

#[test]
fn c13_skew_constant() {
    detected_only_in(
        Rules {
            skew_ms: 59_999,
            ..L
        },
        &["admission"],
    );
}

#[test]
fn c14_horizon_constant() {
    detected_only_in(
        Rules {
            horizon_ms: 900_001,
            ..L
        },
        &["admission"],
    );
}

#[test]
fn c15_schema_checked_before_row() {
    detected_only_in(
        Rules {
            schema_before_row: true,
            ..L
        },
        &["admission"],
    );
}

#[test]
fn c16_foreign_generation_before_fenced() {
    detected_only_in(
        Rules {
            foreign_before_fenced: true,
            ..L
        },
        &["admission"],
    );
}

#[test]
fn c17_ceiling_off_by_one() {
    detected_only_in(
        Rules {
            ceiling_inclusive: true,
            ..L
        },
        &["append"],
    );
}

#[test]
fn c18_trim_target() {
    detected_only_in(Rules { trim_to: 399, ..L }, &["append"]);
}

#[test]
fn c19_watermark_from_last_evicted_row() {
    detected_only_in(
        Rules {
            watermark_from_last_evicted: true,
            ..L
        },
        &["append"],
    );
}

#[test]
fn c20_watermark_not_monotonic() {
    detected_only_in(
        Rules {
            monotonic_watermark: false,
            ..L
        },
        &["append"],
    );
}

static CORRUPT_K: [u32; 64] = {
    let mut k = sha256::K;
    k[17] ^= 1;
    k
};

#[test]
fn c21_corrupted_sha256_round_constant() {
    detected_only_in(
        Rules {
            sha256_k: &CORRUPT_K,
            ..L
        },
        &["sha256", "fingerprint", "find", "admission"],
    );
}

/// The defect this crate had before it carried exact integers: values
/// beyond `i64` were reported as outside the parity domain.
#[test]
fn c22_integers_narrowed_to_i64() {
    detected_only_in(
        Rules {
            i64_ints: true,
            ..L
        },
        &["py_int", "fingerprint", "meta", "admission", "append"],
    );
}

#[test]
fn c23_int_str_limit_one_too_high() {
    detected_only_in(
        Rules {
            int_str_max_digits: 4301,
            ..L
        },
        &["fingerprint", "admission"],
    );
}

#[test]
fn c24_int_str_limit_one_too_low() {
    detected_only_in(
        Rules {
            int_str_max_digits: 4299,
            ..L
        },
        &["fingerprint", "admission"],
    );
}

#[test]
fn c25_refusal_detail_exceptions_dropped() {
    detected_only_in(
        Rules {
            detail_raises: false,
            ..L
        },
        &["admission"],
    );
}

#[test]
fn legacy_rules_pass() {
    let report = run(COMMITTED, &L);
    assert!(report.failures.is_empty(), "{:?}", report.failures);
}
