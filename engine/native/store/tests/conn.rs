//! The connection factory never lets a password or connection string reach
//! the trace sink (CONTRACT-M1 §3.8; lead note 2026-09-25, v6 PROFILING:13).

use std::sync::{Arc, Mutex};

use orgtree_store::conn::{conn_opened, Factory, PgConfig};
use orgtree_store::hooks::{Hooks, TraceEvent, TraceSink};

const PW: &str = "9f3a1c77e0b24d5f8a6e";
const URL: &str = "postgresql://orgtree_runtime:9f3a1c77e0b24d5f8a6e@127.0.0.1:41234/orgtree?sslmode=disable";

#[derive(Default)]
struct Everything(Mutex<Vec<String>>);

impl TraceSink for Everything {
    fn event(&self, e: &TraceEvent<'_>) {
        // Debug renders every field of the event, so anything it carries shows.
        self.0.lock().unwrap().push(format!("{e:?}"));
    }
}

#[test]
fn url_parses_into_parts() {
    let c = PgConfig::from_url(URL).unwrap();
    assert_eq!((c.host.as_str(), c.port, c.role.as_str(), c.database.as_str()), ("127.0.0.1", 41234, "orgtree_runtime", "orgtree"));
}

#[test]
fn config_debug_redacts_the_password() {
    let c = PgConfig::from_url(URL).unwrap();
    let d = format!("{c:?}");
    assert!(!d.contains(PW), "{d}");
    assert!(d.contains("***"));
}

#[test]
fn the_connection_event_carries_no_password_or_url() {
    let c = PgConfig::from_url(URL).unwrap();
    let d = format!("{:?}", conn_opened(&c, "executor", Some(4242), Some(1)));
    assert!(!d.contains(PW), "{d}");
    assert!(!d.contains("postgresql://"), "{d}");
    // it does carry what the reconciliation needs
    for want in ["executor", "4242", "127.0.0.1", "41234", "orgtree_runtime", "orgtree"] {
        assert!(d.contains(want), "missing {want}: {d}");
    }
}

/// The emission path itself, through a real sink.
#[test]
fn factory_registration_never_emits_the_password() {
    let sink = Arc::new(Everything::default());
    let f = Factory::new(PgConfig::from_url(URL).unwrap(), "executor", Hooks::with_trace(sink.clone()));
    f.register_for_test(Some(4242), Some(1));
    let seen = sink.0.lock().unwrap().clone();
    assert_eq!(seen.len(), 1, "the control did not run: no event was emitted");
    assert!(!seen[0].contains(PW), "{}", seen[0]);
}

#[test]
fn parse_errors_do_not_echo_the_url() {
    for bad in [
        "postgresql://orgtree_runtime:9f3a1c77e0b24d5f8a6e@127.0.0.1/orgtree",
        "postgresql://orgtree_runtime:9f3a1c77e0b24d5f8a6e@127.0.0.1:notaport/orgtree",
        "mysql://orgtree_runtime:9f3a1c77e0b24d5f8a6e@127.0.0.1:1/orgtree",
    ] {
        let e = PgConfig::from_url(bad).unwrap_err();
        assert!(!e.contains(PW), "{e}");
    }
}
