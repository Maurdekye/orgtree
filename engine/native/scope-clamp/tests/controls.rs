//! Negative controls. Each one changes a single decision in [`Rules`] to a
//! known-faulty one and reruns the unchanged Python vectors. A control passes
//! only if the vectors report mismatches, and only in the sections that
//! exercise that decision. This shows the vectors are sensitive to these
//! particular defects; it does not prove they would catch every defect.

use orgtree_scope_clamp::vectors::{run, COMMITTED};
use orgtree_scope_clamp::{PathRules, Rules};

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
const PATHS: &[&str] = &[
    "normpath",
    "normcase",
    "norm_dirs",
    "clamp_dirs",
    "apply_ceiling",
];

#[test]
fn c01_posix_path_semantics() {
    detected_only_in(
        Rules {
            path: PathRules {
                posix: true,
                ascii_lower_only: false,
            },
            ..L
        },
        PATHS,
    );
}

#[test]
fn c02_ascii_only_lowercase() {
    detected_only_in(
        Rules {
            path: PathRules {
                posix: false,
                ascii_lower_only: true,
            },
            ..L
        },
        PATHS,
    );
}

#[test]
fn c03_exact_key_only_folder_lookup() {
    detected_only_in(
        Rules {
            exact_key_only: true,
            ..L
        },
        &["clamp_dirs", "apply_ceiling"],
    );
}

#[test]
fn c04_read_only_wins_over_read_write() {
    detected_only_in(
        Rules {
            ro_over_rw: true,
            ..L
        },
        &["clamp_dirs", "apply_ceiling"],
    );
}

#[test]
fn c05_folders_keep_request_order() {
    detected_only_in(
        Rules {
            keep_request_order: true,
            ..L
        },
        &["norm_dirs"],
    );
}

#[test]
fn c06_last_duplicate_folder_wins() {
    detected_only_in(
        Rules {
            last_duplicate_wins: true,
            ..L
        },
        &["norm_dirs"],
    );
}

#[test]
fn c07_mcp_wildcard_not_collapsed() {
    detected_only_in(
        Rules {
            no_star_collapse: true,
            ..L
        },
        &["norm_tools", "clamp_tools", "apply_ceiling"],
    );
}

#[test]
fn c08_ceiling_skips_the_wildcard_note() {
    detected_only_in(
        Rules {
            skip_ceiling_note: true,
            ..L
        },
        &["apply_ceiling"],
    );
}

#[test]
fn c09_tier_cap_refuses_equality() {
    detected_only_in(
        Rules {
            tier_cap_ge: true,
            ..L
        },
        &["tier_ceiling"],
    );
}

#[test]
fn c10_or_tier_seat_from_the_static_table() {
    detected_only_in(
        Rules {
            or_price_static: true,
            ..L
        },
        &["tier_ceiling"],
    );
}

#[test]
fn c11_strict_clamps_demoted() {
    detected_only_in(
        Rules {
            strict_demoted: true,
            ..L
        },
        &["clamp_tools", "clamp_dirs", "clamp_vis"],
    );
}
