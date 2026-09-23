//! Negative controls. Each one changes a single decision in [`Rules`] to a
//! known-faulty one and reruns the unchanged Python vectors. A control passes
//! only if the vectors report mismatches, and only in the sections that
//! exercise that decision. This shows the vectors are sensitive to these
//! particular defects; it does not prove they would catch every defect.

use orgtree_funding_core::pynum::{Round2, SumModel};
use orgtree_funding_core::vectors::{run, COMMITTED};
use orgtree_funding_core::Rules;

fn detected_only_in(rules: Rules, sections: &[&str]) {
    let report = run(COMMITTED, &rules);
    assert!(
        !report.failures.is_empty(),
        "control was not detected (expected in {sections:?})"
    );
    for s in report.failing_sections() {
        assert!(
            sections.contains(&s.as_str()),
            "control also failed unrelated section {s}: {:?}",
            &report.failures[..report.failures.len().min(5)]
        );
    }
}

const L: Rules = Rules::LEGACY;
const FUNDING: &[&str] = &["value", "acquire", "reallocate", "hire", "rehire"];

#[test]
fn c01_rounding_half_up_in_floating_point() {
    detected_only_in(
        Rules {
            round: Round2::NaiveHalfUp,
            ..L
        },
        FUNDING,
    );
}

#[test]
fn c02_no_quantisation() {
    detected_only_in(
        Rules {
            round: Round2::Identity,
            ..L
        },
        FUNDING,
    );
}

#[test]
fn c03_uncompensated_sum() {
    detected_only_in(
        Rules {
            sum: SumModel {
                compensated: false,
                long_bits: 32,
            },
            ..L
        },
        &["sum", "value"],
    );
}

#[test]
fn c04_sum_with_a_64_bit_long() {
    detected_only_in(
        Rules {
            sum: SumModel {
                compensated: true,
                long_bits: 64,
            },
            ..L
        },
        &["sum", "value"],
    );
}

#[test]
fn c05_format_g_ties_up() {
    detected_only_in(
        Rules {
            fmt_half_even: false,
            ..L
        },
        &["fmt_g"],
    );
}

#[test]
fn c06_children_in_document_order() {
    detected_only_in(
        Rules {
            sort_children: false,
            ..L
        },
        &["acquire", "reallocate"],
    );
}

#[test]
fn c07_contributions_top_down() {
    detected_only_in(
        Rules {
            local_first: false,
            ..L
        },
        &["acquire", "reallocate", "hire", "rehire"],
    );
}

#[test]
fn c08_no_user_whole_credit_carry() {
    detected_only_in(
        Rules {
            user_carry: false,
            ..L
        },
        &["acquire", "reallocate", "hire", "rehire"],
    );
}

#[test]
fn c09_stranding_from_live_free_not_snapshot() {
    detected_only_in(
        Rules {
            strand_from_snapshot: false,
            ..L
        },
        &["acquire", "reallocate", "hire", "rehire"],
    );
}

#[test]
fn c10_no_cap_check_in_acquisition() {
    detected_only_in(
        Rules {
            acquire_cap_check: false,
            ..L
        },
        &["acquire", "reallocate", "hire", "rehire"],
    );
}

#[test]
fn c11_cap_refuses_equality() {
    detected_only_in(
        Rules {
            cap_strictly_above: false,
            ..L
        },
        &["acquire", "reallocate", "hire", "rehire"],
    );
}

#[test]
fn c12_no_reallocate_snap_up() {
    detected_only_in(
        Rules {
            snap_up: false,
            ..L
        },
        &["reallocate"],
    );
}

#[test]
fn c13_stranding_upper_bound_exclusive() {
    detected_only_in(
        Rules {
            strand_upper_inclusive: false,
            ..L
        },
        &["acquire", "reallocate", "hire"],
    );
}

#[test]
fn c14_cascade_settings_ignored() {
    detected_only_in(
        Rules {
            honor_cascade: false,
            ..L
        },
        &["reallocate", "hire", "rehire"],
    );
}

#[test]
fn c15_narrowed_read_set() {
    detected_only_in(
        Rules {
            whole_scan_reads: false,
            ..L
        },
        FUNDING,
    );
}

#[test]
fn c16_rehire_pretended_atomic() {
    detected_only_in(
        Rules {
            partial_effects: false,
            ..L
        },
        &["rehire"],
    );
}
