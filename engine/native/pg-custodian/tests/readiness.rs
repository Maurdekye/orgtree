//! Readiness evaluation without a database: every asserted setting, broken
//! one at a time, must produce a failure naming it.

use orgtree_pg_custodian::cluster::readiness_failures;
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

#[test]
fn a_missing_setting_is_a_failure() {
    for k in good().keys() {
        let mut s = good();
        s.remove(k);
        let f = readiness_failures(&s);
        assert_eq!(f.len(), 1, "without {k}: {f:?}");
    }
}
