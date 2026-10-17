//! Exercise the admission, balancing and fallback readers with conflicting
//! synthetic native/profile caches. No files, credentials or CLIs are used.
use super::*;
use crate::accounts::AccountInfo;
use crate::providers::catalog::GOOGLE;

fn profile(id: &str) -> AccountInfo {
    AccountInfo {
        id: id.into(), provider: GOOGLE.into(), kind: "managed".into(),
        label: String::new(), email: None, tint_ordinal: 0,
        auth: "authenticated".into(), config_dir: Some(format!("synthetic/{id}")),
        enabled: true, origin_org: None, marks: Default::default(), ord: 0,
        ambient: false, credential: 0, harness: None,
    }
}

fn reading(percent: u32, hours: i64) -> Value {
    json!({"available":true,"limits":[{
        "group":"gemini-5h", "percent":percent,
        "resets_at":iso(Utc::now() + chrono::Duration::hours(hours)),
    }]})
}

#[tokio::test]
async fn profile_capacity_does_not_inherit_native_exhaustion() {
    let engine = Engine::for_tests(PathBuf::from("synthetic-unused-agy-reading"));
    let account = profile("google-2");
    engine.usage.put("agy", &reading(100, 24));
    let own = reading(12, 5);
    engine.usage.put("agy:google-2", &own);

    assert!(at_limit(&engine, Some(&account), "flash").is_none());
    let balance = balance_reading(&engine, Some(&account), "flash").unwrap();
    assert_eq!(balance.used, Some(12.0));
    assert_eq!(balance.reset, own["limits"][0]["resets_at"].as_str().and_then(crate::util::parse_ts));
    assert!(has_room(&engine, Some(&account), "flash"));
    assert!(at_limit(&engine, None, "flash").is_some());
    assert!(!has_room(&engine, None, "flash"));
}

#[tokio::test]
async fn exhausted_profile_does_not_borrow_native_or_other_profile_capacity() {
    let engine = Engine::for_tests(PathBuf::from("synthetic-unused-agy-reading"));
    engine.usage.put("agy", &reading(4, 24));
    engine.usage.put("agy:google-2", &reading(100, 5));
    engine.usage.put("agy:google-3", &reading(26, 3));
    let exhausted = profile("google-2");
    let other = profile("google-3");

    assert!(at_limit(&engine, Some(&exhausted), "flash").is_some());
    assert_eq!(balance_reading(&engine, Some(&exhausted), "flash").unwrap().used, Some(100.0));
    assert!(!has_room(&engine, Some(&exhausted), "flash"));
    assert_eq!(balance_reading(&engine, Some(&other), "flash").unwrap().used, Some(26.0));
    assert!(has_room(&engine, Some(&other), "flash"));
    assert!(has_room(&engine, None, "flash"));
    assert_eq!(balance_reading(&engine, None, "flash").unwrap().used, Some(4.0));
}

#[tokio::test]
async fn missing_stale_or_failed_profile_reading_stays_unknown() {
    let engine = Engine::for_tests(PathBuf::from("synthetic-unused-agy-reading"));
    let account = profile("google-2");
    engine.usage.put("agy", &reading(8, 24));
    let unknown = || {
        assert!(reading_of(&engine, GOOGLE, Some(&account)).is_none());
        assert!(at_limit(&engine, Some(&account), "flash").is_none());
        assert!(balance_reading(&engine, Some(&account), "flash").is_none());
        assert!(!has_room(&engine, Some(&account), "flash"));
    };
    unknown();
    engine.usage.cache.pin().insert("agy:google-2".into(), Cached {
        at: Instant::now() - PEEK_MAX, data: reading(100, 5),
    });
    unknown();
    engine.usage.put("agy:google-2", &json!({"available":false,"error":"synthetic refusal"}));
    unknown();
}

#[tokio::test]
async fn native_aliases_keep_native_reading_and_api_keys_have_none() {
    let engine = Engine::for_tests(PathBuf::from("synthetic-unused-agy-reading"));
    engine.usage.put("agy", &reading(17, 24));
    engine.usage.put("agy:google-2", &reading(100, 5));
    let mut alias = profile("google-2");
    alias.ambient = true;
    assert_eq!(balance_reading(&engine, Some(&alias), "flash").unwrap().used, Some(17.0));
    alias.ambient = false;
    for folder in [None, Some(String::new()), Some("  ".into())] {
        alias.config_dir = folder;
        assert_eq!(balance_reading(&engine, Some(&alias), "flash").unwrap().used, Some(17.0));
    }
    alias.kind = "apikey".into();
    assert!(reading_of(&engine, GOOGLE, Some(&alias)).is_none());
    assert!(!has_room(&engine, Some(&alias), "flash"));
}

#[tokio::test]
async fn profile_reading_keeps_model_pool_selection() {
    let engine = Engine::for_tests(PathBuf::from("synthetic-unused-agy-reading"));
    let account = profile("google-2");
    engine.usage.put("agy", &reading(100, 24));
    let mut own = reading(11, 5);
    own["limits"].as_array_mut().unwrap().push(json!({
        "group":"3p-weekly", "percent":100,
        "resets_at":iso(Utc::now() + chrono::Duration::days(5)),
    }));
    engine.usage.put("agy:google-2", &own);
    assert!(at_limit(&engine, Some(&account), "flash").is_none());
    assert!(has_room(&engine, Some(&account), "flash"));
    assert_eq!(balance_reading(&engine, Some(&account), "flash").unwrap().used, Some(11.0));
    assert!(at_limit(&engine, Some(&account), "agy-opus").is_some());
    assert!(!has_room(&engine, Some(&account), "agy-opus"));
}
