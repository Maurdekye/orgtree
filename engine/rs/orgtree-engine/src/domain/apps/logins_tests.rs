//! Piece 3 (saved logins; spec section 4, tests 13 and 15): validation, sealing, attaching, redaction.
use super::*;
use serde_json::json;

fn key() -> crate::mqtt::seal::Key {
    let dir = std::env::temp_dir().join(format!("orgtree-app-logins-{}", crate::util::random_hex(6)));
    crate::mqtt::seal::load_or_create(&dir).unwrap()
}

#[test]
fn a_login_is_a_bearer_token_or_one_allowed_header_with_a_clean_bounded_value() {
    let bearer = validate("bearer", None, "tok-123").unwrap();
    assert_eq!(bearer.header(), ("Authorization".into(), "Bearer tok-123".into()));
    let header = validate("header", Some("X-Api-Key"), "k-1").unwrap();
    assert_eq!(header.header(), ("X-Api-Key".into(), "k-1".into()));
    for (kind, name, value) in [
        ("bearer", None, ""),
        ("bearer", None, "line\r\nbreak"),
        ("bearer", None, "nul\0"),
        ("bearer", Some("X"), "tok"),
        ("header", None, "tok"),
        ("header", Some("Cookie"), "a=b"),
        ("header", Some("cookie"), "a=b"),
        ("header", Some("Host"), "x"),
        ("header", Some("User-Agent"), "x"),
        ("header", Some("Content-Length"), "1"),
        ("header", Some("Bad Name"), "x"),
        ("header", Some(""), "x"),
        ("basic", None, "x"),
    ] {
        assert!(validate(kind, name, value).is_err(), "{kind} {name:?} {value:?}");
    }
    assert!(validate("bearer", None, &"a".repeat(VALUE_MAX)).is_ok());
    assert!(validate("bearer", None, &"a".repeat(VALUE_MAX + 1)).is_err(), "at most 8 KiB");
}

#[test]
fn attaching_replaces_a_same_named_app_header_in_any_case() {
    let login = validate("bearer", None, "engine-token").unwrap();
    let mut headers = vec![
        ("authorization".to_string(), "Bearer app-chose-this".to_string()),
        ("Accept".to_string(), "application/json".to_string()),
        ("AUTHORIZATION".to_string(), "Bearer and-this".to_string()),
    ];
    login.apply(&mut headers);
    assert_eq!(headers.iter().filter(|(n, _)| n.eq_ignore_ascii_case("authorization")).count(), 1);
    assert!(headers.contains(&("Authorization".into(), "Bearer engine-token".into())));
    assert!(headers.contains(&("Accept".into(), "application/json".into())));
    let custom = validate("header", Some("X-Api-Key"), "k").unwrap();
    let mut headers = vec![("x-api-key".to_string(), "mine".to_string())];
    custom.apply(&mut headers);
    assert_eq!(headers, vec![("X-Api-Key".to_string(), "k".to_string())]);
}

#[test]
fn a_login_never_prints_its_value() {
    let login = validate("bearer", None, "S3CRET-CANARY").unwrap();
    assert!(!format!("{login:?}").contains("S3CRET-CANARY"));
    let header = validate("header", Some("X-Api-Key"), "S3CRET-CANARY").unwrap();
    assert!(!format!("{header:?}").contains("S3CRET-CANARY"));
    // What the desktop is told after a save: site, kind, time. Never the value or a header name.
    let shown = shown("100.101.102.103:8642", "bearer", "2026-11-11T00:00:00Z");
    assert_eq!(shown, json!({"site":"100.101.102.103:8642","kind":"bearer","set_at":"2026-11-11T00:00:00Z"}));
}

#[test]
fn a_sealed_login_opens_only_for_its_own_org_app_and_site() {
    let key = key();
    let login = validate("header", Some("X-Api-Key"), "S3CRET-CANARY").unwrap();
    let sealed = seal(&key, 1, "viewer", "nas:8642", &login).unwrap();
    assert!(!sealed.windows(13).any(|w| w == b"S3CRET-CANARY"), "no plaintext at rest");
    assert!(!sealed.windows(9).any(|w| w == b"X-Api-Key"), "the header name is sealed too");
    assert!(open(&key, 1, "viewer", "nas:8642", &sealed).unwrap() == login);
    for (org, app, site) in [(2, "viewer", "nas:8642"), (1, "other", "nas:8642"), (1, "viewer", "nas:9999")] {
        assert!(open(&key, org, app, site, &sealed).is_err(), "{org} {app} {site}");
    }
    let mut bent = sealed.clone();
    *bent.last_mut().unwrap() ^= 1;
    assert!(open(&key, 1, "viewer", "nas:8642", &bent).is_err());
}

#[test]
fn a_login_can_be_saved_only_for_an_exact_declared_site_with_an_allow_row() {
    let app = |rows: Value| json!({"capabilities":["net.fetch"],"sites":["nas:8642","*.example.org","*","api.example.com"],"site_permissions":rows});
    assert!(site_allows_login(&app(json!({"nas:8642":{"value":"allow-private","addresses":["10.0.0.1"]}})), "nas:8642"));
    assert!(site_allows_login(&app(json!({"api.example.com":"allow"})), "api.example.com"));
    for (rows, site) in [
        (json!({"nas:8642":"ask"}), "nas:8642"),
        (json!({"nas:8642":"deny"}), "nas:8642"),
        (json!({}), "nas:8642"),
        (json!({"*":"allow"}), "*"),
        (json!({"*.example.org":"allow"}), "*.example.org"),
        (json!({"a.example.org":"allow"}), "a.example.org"),
    ] {
        assert!(!site_allows_login(&app(rows.clone()), site), "{rows} {site}");
    }
}
