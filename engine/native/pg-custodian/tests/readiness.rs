//! Readiness evaluation without a database: every asserted setting, broken
//! one at a time, must produce a failure naming it.

use orgtree_pg_custodian::cluster::{qual_logging_failures, qual_logging_settings, readiness_failures, role_failures};
use std::collections::BTreeMap;

fn good() -> BTreeMap<String, String> {
    [
        ("max_prepared_transactions", "0"),
        ("wal_level", "logical"),
        ("listen_addresses", "127.0.0.1"),
        ("max_slot_wal_keep_size", "256MB"),
        ("max_wal_senders", "4"),
        ("max_replication_slots", "4"),
        ("password_encryption", "scram-sha-256"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

#[test]
fn a_correct_cluster_is_ready() {
    assert_eq!(readiness_failures(&good()), Vec::<String>::new());
}

#[test]
fn each_misconfiguration_is_named() {
    let cases = [
        ("max_prepared_transactions", "5"),
        ("wal_level", "replica"),
        ("listen_addresses", "*"),
        ("listen_addresses", "127.0.0.1,::1"),
        ("max_slot_wal_keep_size", "-1"),
        ("max_wal_senders", "0"),
        ("max_replication_slots", "0"),
        ("password_encryption", "md5"),
    ];
    for (k, v) in cases {
        let mut s = good();
        s.insert(k.to_string(), v.to_string());
        let f = readiness_failures(&s);
        assert_eq!(f.len(), 1, "{k}={v} gave {f:?}");
        assert!(f[0].starts_with(k), "{k}={v} gave {f:?}");
    }
}

fn roles() -> Vec<Vec<String>> {
    let row = |r: &[&str]| r.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    vec![
        row(&["orgtree_admin", "t", "t", "t", "t", "t", "t", "t"]),
        row(&["orgtree_repl", "f", "t", "f", "f", "t", "f", "t"]),
        row(&["orgtree_runtime", "f", "f", "f", "f", "t", "f", "t"]),
    ]
}

#[test]
fn correct_roles_pass() {
    assert_eq!(role_failures(&roles()), Vec::<String>::new());
}

#[test]
fn every_extra_runtime_attribute_is_a_failure() {
    // superuser, replication, createdb, createrole, bypassrls; and no login,
    // and a non-SCRAM password.
    for col in 1..=7 {
        let mut r = roles();
        let flipped = if r[2][col] == "t" { "f" } else { "t" };
        r[2][col] = flipped.to_string();
        let f = role_failures(&r);
        assert_eq!(f.len(), 1, "runtime column {col}: {f:?}");
        assert!(f[0].starts_with("role orgtree_runtime"), "{f:?}");
    }
}

#[test]
fn replication_role_must_not_be_superuser_and_missing_roles_fail() {
    let mut r = roles();
    r[1][1] = "t".into();
    assert_eq!(role_failures(&r).len(), 1);
    let mut r = roles();
    r.remove(0);
    assert_eq!(role_failures(&r), vec!["role orgtree_admin is missing".to_string()]);
}

fn qual_on() -> BTreeMap<String, String> {
    [
        ("logging_collector", "on"),
        ("log_destination", "jsonlog"),
        ("log_statement", "all"),
        ("log_replication_commands", "on"),
        ("log_parameter_max_length", "0"),
        ("log_parameter_max_length_on_error", "0"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

#[test]
fn qualification_logging_must_match_its_switch() {
    assert!(qual_logging_failures(true, &qual_on()).is_empty());
    for (k, bad) in [("log_parameter_max_length", "-1"), ("log_parameter_max_length_on_error", "64"), ("log_statement", "ddl"), ("logging_collector", "off")] {
        let mut s = qual_on();
        s.insert(k.into(), bad.into());
        let f = qual_logging_failures(true, &s);
        assert_eq!(f.len(), 1, "{k}={bad}: {f:?}");
    }
    let mut off = qual_on();
    off.insert("log_statement".into(), "none".into());
    assert!(qual_logging_failures(false, &off).is_empty());
    assert_eq!(qual_logging_failures(false, &qual_on()).len(), 1, "switch off but server logs everything");
}

#[test]
fn switch_settings_never_log_bind_values() {
    let s = qual_logging_settings(std::path::Path::new("C:\\x y\\qual-logs"));
    assert_eq!(s["log_parameter_max_length"], "0");
    assert_eq!(s["log_parameter_max_length_on_error"], "0");
    assert_eq!(s["log_directory"], "'C:/x y/qual-logs'");
    assert_eq!(s["log_truncate_on_rotation"], "on");
}

#[test]
fn a_missing_setting_is_a_failure() {
    for k in good().keys() {
        let mut s = good();
        s.remove(k);
        let f = readiness_failures(&s);
        assert_eq!(f.len(), 1, "without {k}: {f:?}");
    }
}
