use super::{agy_auth::Failure, agy_models::ReadError, *};

fn engine() -> crate::engine::EngineRef {
    let engine = Engine::for_tests(std::path::PathBuf::new());
    identity(&engine, 1, Some("a@example.invalid"));
    engine.providers.state.rcu(|cur| {
        let mut st = State::clone(cur);
        st.agy.installed = true;
        st.agy.connected = true;
        st.agy_signed_out = Some(false);
        st
    });
    engine
}

fn confirmed(engine: &Engine) {
    apply_agy_model_read(engine, Ok(catalog(engine, vec!["gemini-4-argon-high".into(), "gemini-3.8-flash-high".into()])));
    assert!(agy_offered(engine, "argon"));
}

fn identity(engine: &Engine, stamp: u64, who: Option<&str>) {
    agy_auth::catalog_test_metadata(engine, Ok(Some(agy_auth::Stamp(stamp))));
    agy_auth::record_catalog_identity(engine, agy_auth::Stamp(stamp), who);
}

fn catalog(engine: &Engine, ids: Vec<String>) -> agy_models::Catalog {
    agy_models::Catalog { ids, identity: agy_auth::catalog_identity(engine) }
}

fn listed_in_payload(engine: &Engine) -> bool {
    let providers = payload(engine);
    providers["providers"].as_array().expect("providers array").iter()
        .find(|p| p["id"] == catalog::GOOGLE).expect("installed Google provider")["tiers"]
        .as_array().unwrap().iter().any(|t| t["tier"] == "argon")
}

fn preserves_confirmed(error: ReadError) {
    let engine = engine();
    confirmed(&engine);
    let before = engine.providers.state.load().agy_models.clone();
    apply_agy_model_read(&engine, Err(error));
    assert_eq!(engine.providers.state.load().agy_models, before);
    assert!(agy_offered(&engine, "argon"), "staffing/admission retains confirmed Argon");
    assert!(listed_in_payload(&engine), "the provider menu still lists Argon");
}

#[tokio::test]
async fn metadata_changed_during_check_preserves_confirmed_catalog() {
    // Live 2026-10-22: the guarded check returns Unavailable when credential
    // metadata changes mid-check. That is not a successful empty catalog.
    preserves_confirmed(ReadError::Auth(Failure::Unavailable));
}

#[tokio::test]
async fn timeout_preserves_confirmed_catalog() {
    preserves_confirmed(ReadError::Auth(Failure::Timeout));
}

#[tokio::test]
async fn output_limit_preserves_confirmed_catalog() {
    preserves_confirmed(ReadError::Auth(Failure::OutputLimit));
}

#[tokio::test]
async fn probe_io_failure_preserves_confirmed_catalog() {
    preserves_confirmed(ReadError::Io(std::io::Error::from(std::io::ErrorKind::PermissionDenied)));
}

#[tokio::test]
async fn unsuccessful_models_command_preserves_confirmed_catalog() {
    preserves_confirmed(ReadError::Exit(Some(1)));
}

#[tokio::test]
async fn first_failure_does_not_invent_a_catalog() {
    let engine = engine();
    apply_agy_model_read(&engine, Err(ReadError::Auth(Failure::Unavailable)));
    assert!(!agy_offered(&engine, "argon"));
    assert!(!listed_in_payload(&engine));
}

#[tokio::test]
async fn successful_omission_replaces_previous_catalog() {
    let engine = engine();
    confirmed(&engine);
    apply_agy_model_read(&engine, Ok(catalog(&engine, vec!["gemini-4-argon-preview".into(), "gemini-3.8-flash-high".into()])));
    assert!(!agy_offered(&engine, "argon"));
    assert!(!listed_in_payload(&engine));
    assert_eq!(engine.providers.state.load().agy_models.len(), 2);
    apply_agy_model_read(&engine, Err(ReadError::Auth(Failure::Unavailable)));
    assert!(!agy_offered(&engine, "argon"), "a later error cannot resurrect an omitted tier");
}

#[tokio::test]
async fn successful_empty_catalog_is_authoritative() {
    let engine = engine();
    confirmed(&engine);
    apply_agy_model_read(&engine, Ok(catalog(&engine, vec![])));
    assert!(!agy_offered(&engine, "argon"));
    assert!(!listed_in_payload(&engine));
}

#[tokio::test]
async fn changed_principal_cannot_inherit_catalog_after_failed_read() {
    for failure in [Failure::Unavailable, Failure::Timeout] {
        let engine = engine();
        confirmed(&engine);
        identity(&engine, 2, Some("b@example.invalid"));
        assert!(engine.providers.state.load().agy_models.is_empty(), "auth observation invalidates A before any new catalog read");
        apply_agy_model_read(&engine, Err(ReadError::Auth(failure)));
        assert!(!agy_offered(&engine, "argon"));
        assert!(!listed_in_payload(&engine));
        assert!(engine.providers.state.load().agy_models.is_empty());
    }
}

#[tokio::test]
async fn unknown_principal_cannot_inherit_catalog() {
    let engine = engine();
    confirmed(&engine);
    identity(&engine, 2, None);
    apply_agy_model_read(&engine, Err(ReadError::Auth(Failure::Unavailable)));
    assert!(engine.providers.state.load().agy_models.is_empty());
    assert!(!listed_in_payload(&engine));
    apply_agy_model_read(&engine, Ok(catalog(&engine, vec!["gemini-4-argon-high".into()])));
    assert!(!agy_offered(&engine, "argon"), "even a catalog needs a named principal");
}

#[tokio::test]
async fn unseen_credential_change_blocks_cached_offers_before_recheck() {
    let engine = engine();
    confirmed(&engine);
    agy_auth::catalog_test_metadata(&engine, Ok(Some(agy_auth::Stamp(2))));
    assert!(!agy_offered(&engine, "argon"), "an unobserved A-to-B swap cannot use cached A IDs");
    assert!(!listed_in_payload(&engine));
    apply_agy_model_read(&engine, Err(ReadError::Auth(Failure::Unavailable)));
    assert!(engine.providers.state.load().agy_models.is_empty());
}

#[tokio::test]
async fn unreadable_or_absent_credentials_cannot_use_cached_offers() {
    for metadata in [Err(Failure::Unavailable), Ok(None)] {
        let engine = engine();
        confirmed(&engine);
        agy_auth::catalog_test_metadata(&engine, metadata);
        assert!(!agy_offered(&engine, "argon"));
        apply_agy_model_read(&engine, Err(ReadError::Auth(Failure::Unavailable)));
        assert!(engine.providers.state.load().agy_models.is_empty());
    }
}

#[tokio::test]
async fn late_success_cannot_relabel_a_catalog_under_a_replacement_login() {
    let engine = engine();
    let a_catalog = catalog(&engine, vec!["gemini-4-argon-high".into()]);
    identity(&engine, 2, Some("b@example.invalid"));
    apply_agy_model_read(&engine, Ok(a_catalog));
    assert!(!agy_offered(&engine, "argon"));
    assert!(engine.providers.state.load().agy_models.is_empty());
    confirmed(&engine);
    assert!(listed_in_payload(&engine), "B may establish its own later successful catalog");
}

#[tokio::test]
async fn same_principal_token_rotation_retains_catalog_after_one_identity_check() {
    use std::cell::Cell;
    let engine = engine();
    confirmed(&engine);
    agy_auth::catalog_test_metadata(&engine, Ok(Some(agy_auth::Stamp(2))));
    let calls = Cell::new(0);
    recheck_catalog_identity(&engine, || async {
        calls.set(calls.get() + 1);
        identity(&engine, 2, Some(" A@EXAMPLE.INVALID "));
        Ok(agy_auth::Stamp(2))
    }).await;
    assert_eq!(calls.get(), 1);
    apply_agy_model_read(&engine, Err(ReadError::Auth(Failure::Unavailable)));
    assert!(agy_offered(&engine, "argon"));
    assert!(listed_in_payload(&engine));
}

#[tokio::test]
async fn failed_identity_recheck_is_bounded_and_clears_unverified_catalog() {
    use std::cell::Cell;
    let engine = engine();
    confirmed(&engine);
    agy_auth::catalog_test_metadata(&engine, Ok(Some(agy_auth::Stamp(2))));
    let calls = Cell::new(0);
    let known = recheck_catalog_identity(&engine, || async {
        calls.set(calls.get() + 1);
        Err(Failure::Unavailable)
    }).await;
    assert_eq!(calls.get(), 1);
    assert!(known.is_none());
    apply_agy_model_read(&engine, Err(ReadError::Auth(Failure::Unavailable)));
    assert!(engine.providers.state.load().agy_models.is_empty());
}

#[tokio::test]
async fn current_identity_does_not_add_a_silent_check() {
    use std::cell::Cell;
    let engine = engine();
    confirmed(&engine);
    let calls = Cell::new(0);
    let known = recheck_catalog_identity(&engine, || async {
        calls.set(calls.get() + 1);
        Err(Failure::Unavailable)
    }).await;
    assert!(known.is_some());
    assert_eq!(calls.get(), 0);
}

#[tokio::test]
async fn late_old_catalog_preserves_a_new_principals_confirmed_catalog() {
    let engine = engine();
    let old = catalog(&engine, vec!["gemini-4-argon-high".into()]);
    identity(&engine, 2, Some("b@example.invalid"));
    let ids = vec!["gemini-4-barium-high".to_string()];
    apply_agy_model_read(&engine, Ok(catalog(&engine, ids.clone())));
    apply_agy_model_read(&engine, Ok(old));
    assert_eq!(engine.providers.state.load().agy_models, ids);
    assert!(!agy_offered(&engine, "argon"));
    assert!(!listed_in_payload(&engine));
}

#[tokio::test]
async fn catalog_attempt_reuse_is_bound_to_the_checked_principal() {
    let engine = engine();
    let a = agy_auth::catalog_identity(&engine).map(|i| i.principal);
    let recent = Some((std::time::Instant::now(), a));
    assert!(agy_models_reusable(recent, a));
    identity(&engine, 2, Some("a@example.invalid"));
    assert!(agy_models_reusable(recent, agy_auth::catalog_identity(&engine).map(|i| i.principal)));
    assert!(!agy_models_reusable(recent, None));
    identity(&engine, 3, Some("b@example.invalid"));
    assert!(!agy_models_reusable(recent, agy_auth::catalog_identity(&engine).map(|i| i.principal)));
    assert!(!agy_models_reusable(Some((std::time::Instant::now() - AGY_MODELS_REUSE, a)), a));
}

#[tokio::test]
async fn a_sign_in_to_another_login_makes_one_catalog_read_due() {
    // Live 2026-10-27: the sign-in moved to another account, its old list was
    // cleared, and nothing read the new login's list until a model choice
    // opened (USER m4db0526e54f1 "it should recheck when the account changes").
    let engine = engine();
    confirmed(&engine);
    assert!(!agy_models_recheck_due(&engine), "the checked login has its own list");
    identity(&engine, 2, Some("b@example.invalid"));
    assert!(!agy_offered(&engine, "argon"), "263dc18: B never uses A's list");
    assert!(agy_models_recheck_due(&engine), "B's own list is read with no model choice opened");
    assert!(!agy_models_recheck_due(&engine), "once per checked login: never a poll");
    confirmed(&engine);
    assert!(!agy_models_recheck_due(&engine), "B's own list arrived");
    identity(&engine, 3, Some("a@example.invalid"));
    assert!(agy_models_recheck_due(&engine), "signing back in as A reads A's list again");
}

#[tokio::test]
async fn token_rotation_unnamed_and_signed_out_logins_make_no_catalog_read_due() {
    let engine = engine();
    confirmed(&engine);
    identity(&engine, 2, Some(" A@EXAMPLE.INVALID "));
    assert!(agy_offered(&engine, "argon"), "control: a same-login rotation keeps the list");
    assert!(!agy_models_recheck_due(&engine), "a token rotation is not a sign-in change");
    identity(&engine, 3, None);
    assert!(!agy_models_recheck_due(&engine), "an unnamed login has no list to read for");
    agy_auth::catalog_test_metadata(&engine, Ok(None));
    assert!(!agy_models_recheck_due(&engine), "signed out");
}

#[tokio::test]
async fn a_failed_read_for_a_new_login_waits_for_its_next_credential() {
    let engine = engine();
    confirmed(&engine);
    identity(&engine, 2, Some("b@example.invalid"));
    assert!(agy_models_recheck_due(&engine));
    apply_agy_model_read(&engine, Err(ReadError::Auth(Failure::Timeout)));
    assert!(!agy_offered(&engine, "argon"));
    assert!(!agy_models_recheck_due(&engine), "a failed automatic read is not retried in a loop");
    identity(&engine, 3, Some("b@example.invalid"));
    assert!(agy_models_recheck_due(&engine), "B's next credential gets one more read");
}

#[tokio::test]
async fn auth_refusals_clear_and_later_errors_do_not_resurrect_catalog() {
    for failure in [Failure::SignedOut, Failure::NotIsolated] {
        let engine = engine();
        confirmed(&engine);
        apply_agy_model_read(&engine, Err(ReadError::Auth(failure)));
        assert!(engine.providers.state.load().agy_models.is_empty());
        assert!(!listed_in_payload(&engine));
        apply_agy_model_read(&engine, Err(ReadError::Auth(Failure::Unavailable)));
        assert!(!agy_offered(&engine, "argon"));
        confirmed(&engine);
        assert!(listed_in_payload(&engine), "a later successful catalog may restore Argon");
    }
}

type Inbox = tokio::sync::mpsc::UnboundedReceiver<crate::runtime::Envelope>;

/// A stand-in agent: the registry entry every running agent has.
fn listener(engine: &Engine) -> Inbox {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    engine.agents.map.pin().insert(4242, std::sync::Arc::new(crate::runtime::AgentHandle {
        id: 4242, org_id: 1, tx,
        view: arc_swap::ArcSwap::from_pointee(serde_json::Value::Null),
        helpers: arc_swap::ArcSwap::from_pointee(serde_json::json!({"count":0,"items":[],"truncated":false})),
    }));
    rx
}

fn restarts(rx: &mut Inbox) -> Vec<agy_auth::Stamp> {
    let mut out = Vec::new();
    while let Ok(e) = rx.try_recv() {
        if let crate::runtime::AgentMsg::AgyLoginChanged(stamp) = e.msg { out.push(stamp); }
    }
    out
}

#[tokio::test]
async fn a_sign_in_to_another_account_replaces_processes_on_the_old_login() {
    // Live 2026-10-27: warm agy seats launched as A saved A back over the
    // user's sign-in as B 6.5 minutes later (USER mb2fa30fd31fd "Yes, restart them").
    let engine = engine();
    let mut rx = listener(&engine);
    identity(&engine, 2, Some(" A@EXAMPLE.INVALID "));
    assert!(restarts(&mut rx).is_empty(), "a token rotation keeps every process");
    identity(&engine, 3, Some("b@example.invalid"));
    assert_eq!(restarts(&mut rx), vec![agy_auth::Stamp(3)], "B: replace what was launched before stamp 3");
    identity(&engine, 4, None);
    agy_auth::catalog_test_metadata(&engine, Ok(None));
    agy_auth::record_catalog_identity(&engine, agy_auth::Stamp(0), None);
    assert!(restarts(&mut rx).is_empty(), "unnamed and signed-out answers replace nothing");
    identity(&engine, 5, Some("a@example.invalid"));
    assert_eq!(restarts(&mut rx), vec![agy_auth::Stamp(5)], "back to A after an unnamed gap is a change too");
}

#[tokio::test]
async fn the_first_checked_login_replaces_nothing() {
    let engine = Engine::for_tests(std::path::PathBuf::new());
    let mut rx = listener(&engine);
    identity(&engine, 1, Some("a@example.invalid"));
    assert!(restarts(&mut rx).is_empty());
}
