//! The host-bracket startup rules (no database).

use std::path::Path;

use orgtree_store_service::boot::{self, Attach, ServerIdentity};

const ATTACH: &str = r#"{"schema":"orgtree.p03.pg-runtime/v1","root_id":"0123456789abcdef0123456789abcdef","system_identifier":"7","instance_token":"tok-1","postmaster_pid":1,"host":"127.0.0.1","port":48380,"admin_role":"orgtree_admin","pgpass_file":"x","started_at_unix":1,"boot_id":"b"}"#;

#[test]
fn the_attach_descriptor_gives_host_port_root_and_token() {
    let a = boot::parse_attach(ATTACH).unwrap();
    assert_eq!(a, Attach { root_id: "0123456789abcdef0123456789abcdef".into(), instance_token: "tok-1".into(), system_identifier: "7".into(), host: "127.0.0.1".into(), port: 48380 });
}

#[test]
fn a_wrong_schema_or_a_non_loopback_host_is_refused() {
    assert!(boot::parse_attach(&ATTACH.replace("pg-runtime/v1", "pg-runtime/v9")).is_err());
    assert!(boot::parse_attach(&ATTACH.replace("\"127.0.0.1\"", "\"10.0.0.5\"")).is_err());
    assert!(boot::parse_attach("{}").is_err());
}

#[test]
fn only_the_runtime_password_is_taken_and_errors_never_echo_one() {
    let creds = r#"{"orgtree_admin":"ADMINPW","orgtree_runtime":"RUNPW","orgtree_repl":"REPLPW"}"#;
    let p = boot::runtime_password(creds).unwrap();
    assert_eq!(format!("{p:?}"), "***");
    let e = boot::runtime_password(r#"{"orgtree_admin":"ADMINPW"}"#).unwrap_err();
    assert!(!e.contains("ADMINPW"), "{e}");
}

#[test]
fn identity_requires_token_root_and_system_identifier() {
    let a = boot::parse_attach(ATTACH).unwrap();
    let good = || ServerIdentity { instance_token: "tok-1".into(), root_id: "0123456789abcdef0123456789abcdef".into(), system_identifier: "7".into() };
    assert!(boot::check_identity(&good(), &a).is_ok());
    let mut s = good();
    s.instance_token = "tok-2".into();
    assert!(boot::check_identity(&s, &a).unwrap_err().contains("instance_token"), "a foreign server on the port must be refused");
    let mut s = good();
    s.root_id = "ffffffffffffffffffffffffffffffff".into();
    assert!(boot::check_identity(&s, &a).unwrap_err().contains("root_id"));
    let mut s = good();
    s.system_identifier = "8".into();
    assert!(boot::check_identity(&s, &a).unwrap_err().contains("system_identifier"));
    let mut s = good();
    s.instance_token.clear();
    assert!(boot::check_identity(&s, &a).is_err(), "a server without the custodian's settings must be refused");
}

#[test]
fn config_from_root_uses_the_runtime_role_and_checks_the_root_id() {
    let dir = std::env::temp_dir().join(format!("p03-ws2-boot-{}", uuid::Uuid::new_v4().simple()));
    let cluster = boot::cluster_dir(&dir);
    std::fs::create_dir_all(cluster.join("secrets")).unwrap();
    std::fs::write(cluster.join("pg-attach.json"), ATTACH).unwrap();
    std::fs::write(cluster.join("secrets").join("credentials.json"), r#"{"orgtree_runtime":"RUNPW"}"#).unwrap();
    let (cfg, _) = boot::config_from_root(&dir, "0123456789abcdef0123456789abcdef").unwrap();
    assert_eq!((cfg.role.as_str(), cfg.database.as_str(), cfg.port), ("orgtree_runtime", "orgtree", 48380));
    assert!(!format!("{cfg:?}").contains("RUNPW"));
    let e = boot::config_from_root(&dir, "ffffffffffffffffffffffffffffffff").unwrap_err();
    assert!(e.contains("belongs to root"), "{e}");
    assert!(boot::config_from_root(Path::new("C:\\definitely\\not\\here"), "x").unwrap_err().contains("not running"));
}

#[test]
fn the_ready_line_is_one_json_object() {
    let l = boot::ready_line(42, 5000, "abc", Path::new("C:\\r\\p03-store-service.json"));
    assert!(!l.contains('\n'));
    let v: serde_json::Value = serde_json::from_str(&l).unwrap();
    assert_eq!(v["type"], "ready");
    assert_eq!(v["port"], 5000);
    assert_eq!(v["service_incarnation"], "abc");
}

#[test]
fn timeout_flags_raise_a_timeout_but_never_switch_it_off() {
    use orgtree_store::ExecConfig;
    let mut cfg = ExecConfig::default();
    boot::set_timeout(&mut cfg, "--lock-timeout-ms", Some("600000")).unwrap();
    boot::set_timeout(&mut cfg, "--statement-timeout-ms", Some("900000")).unwrap();
    boot::set_timeout(&mut cfg, "--idle-in-transaction-timeout-ms", Some("1200000")).unwrap();
    assert_eq!(
        (cfg.lock_timeout_ms, cfg.statement_timeout_ms, cfg.idle_in_transaction_timeout_ms),
        (Some(600_000), Some(900_000), Some(1_200_000))
    );
    let d = ExecConfig::default();
    for bad in [Some("0"), Some("-1"), Some("5s"), Some("3600001"), Some(""), None] {
        for flag in ["--lock-timeout-ms", "--statement-timeout-ms", "--idle-in-transaction-timeout-ms"] {
            let mut c = ExecConfig::default();
            assert!(boot::set_timeout(&mut c, flag, bad).is_err(), "{flag} {bad:?} must be refused");
            assert_eq!(
                (c.lock_timeout_ms, c.statement_timeout_ms, c.idle_in_transaction_timeout_ms),
                (d.lock_timeout_ms, d.statement_timeout_ms, d.idle_in_transaction_timeout_ms),
                "a refused flag changes nothing"
            );
        }
    }
    assert!(boot::set_timeout(&mut cfg, "--other-timeout-ms", Some("5")).is_err());
    // the defaults themselves are on (review F4)
    assert!(d.lock_timeout_ms.is_some() && d.statement_timeout_ms.is_some() && d.idle_in_transaction_timeout_ms.is_some());
}
