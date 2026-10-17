use super::*;

#[test]
fn muse_identity_preserves_quota_age_and_existing_auth_evidence() {
    let usage = Usage::default();
    let key = muse_key(None);
    let observed = Utc::now() - chrono::Duration::hours(2);
    let data = json!({"available":true, "observed_at":iso(observed),
        "limits":[{"group":"weekly", "percent":73}], "reauth_required":true});
    assert!(usage.put_muse_observed(&key, &data, observed, false));
    let cached_at = usage.cache.pin().get(&key).unwrap().at;
    let auth_at = Instant::now() - Duration::from_secs(120);
    usage.auth.pin().insert(key.clone(), AuthEvidence { at: auth_at, required: Some(true) });

    usage.muse_identity(&key, Some("synthetic@example.invalid"));

    let mut expected = data;
    expected["email"] = json!("synthetic@example.invalid");
    expected["label"] = expected["email"].clone();
    let cache = usage.cache.pin();
    let updated = cache.get(&key).unwrap();
    assert_eq!(updated.at, cached_at);
    assert_eq!(updated.data, expected);
    let auth = usage.auth.pin();
    let evidence = auth.get(&key).unwrap();
    assert_eq!(evidence.at, auth_at);
    assert_eq!(evidence.required, Some(true));
}

#[test]
fn muse_identity_clears_unknown_email_without_creating_quota_or_auth() {
    let usage = Usage::default();
    let key = muse_key(None);
    usage.muse_identity(&key, Some("synthetic@example.invalid"));
    assert!(usage.cached(&key).is_none());
    assert!(usage.auth.pin().get(&key).is_none());

    let observed = Utc::now() - chrono::Duration::hours(2);
    let data = json!({"available":true, "observed_at":iso(observed),
        "limits":[{"group":"weekly", "percent":73}]});
    assert!(usage.put_muse_observed(&key, &data, observed, false));
    let cached_at = usage.cache.pin().get(&key).unwrap().at;
    for missing in [None, Some("")] {
        usage.muse_identity(&key, Some("synthetic@example.invalid"));
        usage.muse_identity(&key, missing);
        let cache = usage.cache.pin();
        let updated = cache.get(&key).unwrap();
        assert_eq!(updated.at, cached_at);
        assert!(updated.data["email"].is_null());
        assert_eq!(updated.data["label"], "signed-in account");
        assert_eq!(updated.data["limits"], data["limits"]);
        assert_eq!(updated.data["observed_at"], data["observed_at"]);
        assert!(usage.auth.pin().get(&key).is_none());
    }
}
