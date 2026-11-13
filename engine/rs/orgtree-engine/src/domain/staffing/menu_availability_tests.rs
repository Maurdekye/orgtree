use super::*;
use crate::accounts::{AccountInfo, Accounts};
use crate::providers::{CliStatus, State, MuseDiscovery, muse_models::{MuseProbe, MuseCatalog, MuseModel}};

const SAMPLES: [(&str, &str); 6] = [("claude", "opus"), ("openai", "sol"), ("google", "argon"),
    ("muse", "wonder"), ("openrouter", "or-fixture"), ("langserver", "ls-fixture-model")];

fn account(provider: &str, id: &str) -> AccountInfo {
    AccountInfo { id: id.into(), provider: provider.into(), kind: "apikey".into(), label: "fixture".into(),
        email: None, tint_ordinal: 0, auth: "signed_out".into(), config_dir: None, enabled: true,
        origin_org: None, marks: Default::default(), ord: 0, ambient: false, credential: 0,
        harness: Some("opencode".into()) }
}

// Only in-memory state: no database, provider process, credential or network read.
fn fixture() -> (Arc<Engine>, String) {
    let mut e = Engine::for_tests("synthetic-unused-menu-availability".into());
    let engine = Arc::get_mut(&mut e).unwrap();
    engine.settings = crate::settings::AppSettings::new(json!({
        "openrouter": {"key_set": true}, "language_servers": {"servers": {"fixture": {
            "id": "fixture", "harness": "opencode", "enabled": true, "models": {
                "model": {"id": "model", "tier": "ls-fixture-model", "offered": true}}}}}
    }));
    engine.accounts = Accounts::for_tests(vec![account("openrouter", "openrouter-1")]);
    // The test binary is merely an existing file for installed(); it is never launched.
    let cli = CliStatus { installed: true, connected: false, path: Some(std::env::current_exe().unwrap()), ..Default::default() };
    let mut st = State { claude: cli.clone(), codex: cli.clone(), agy: cli.clone(), muse: cli.clone(),
        opencode: cli, probed: true, ..Default::default() };
    st.openrouter.push(("or-fixture".into(), 1.0, "fixture/model".into(), "fixture".into(), "".into(), "F".into(), "fixture".into()));
    st.muse_probe = Some(MuseDiscovery { at: Utc::now(), probe: MuseProbe {
        catalog: Some(MuseCatalog { source: "providerCatalog".into(), models: vec![MuseModel {
            id: catalog::model_for("wonder", None), is_default: true, variants: vec!["high".into()],
            default_effort: None, context: None, output: None, account_row: true }] }), ..Default::default() } });
    e.providers.state.store(Arc::new(st));
    // every Gemini tier is conditional or legacy since Flash went legacy (2026-11-13): the fixture's agy lists Argon
    crate::providers::list_agy_models_for_tests(&e, &["gemini-4-argon"]);
    (e, format!("menu-{}", uuid::Uuid::new_v4()))
}
fn offers(e: &Engine, org: &str, tier: &str) -> bool {
    runnable_tiers(e, org).iter().any(|o| o.tier == tier)
}

macro_rules! off_case { ($name:ident, $provider:literal, $tier:literal) => {
    #[test] fn $name() {
        let (e, org) = fixture();
        assert!(offers(&e, &org, $tier), "positive control");
        let lanes = crate::org_accounts::lanes(&e, &org);
        crate::org_accounts::set(&org, lanes.iter().filter(|l| l["provider"] == $provider)
            .map(|l| l["id"].as_str().unwrap().to_string()).collect());
        let hidden = !offers(&e, &org, $tier);
        crate::org_accounts::set(&org, Default::default());
        assert!(hidden, "Quick staff request offers must honor org-disabled accounts");
        for (_, tier) in SAMPLES { assert!(offers(&e, &org, tier), "restored {tier}"); }
    }
}; }
off_case!(claude_org_off, "claude", "opus");
off_case!(codex_org_off, "openai", "sol");
off_case!(agy_org_off, "google", "argon");
off_case!(muse_org_off, "muse", "wonder");
off_case!(openrouter_org_off, "openrouter", "or-fixture");
off_case!(langserver_org_off, "langserver", "ls-fixture-model");

#[test] fn secondary_enabled_lane_preserves_signed_out_request_choices() {
    for (provider, tier) in SAMPLES.into_iter().take(4) {
        let (mut e, org) = fixture();
        Arc::get_mut(&mut e).unwrap().accounts = Accounts::for_tests(vec![account(provider, "secondary")]);
        crate::org_accounts::set(&org, [crate::org_accounts::primary(provider)].into_iter().collect());
        assert!(offers(&e, &org, tier), "secondary {provider}");
        let mut disabled = account(provider, "secondary"); disabled.enabled = false;
        Arc::get_mut(&mut e).unwrap().accounts = Accounts::for_tests(vec![disabled]);
        let hidden = !offers(&e, &org, tier);
        crate::org_accounts::set(&org, Default::default());
        assert!(hidden, "org allowance cannot override an app-disabled account: {provider}");
    }
}

/// Flash is legacy (user 2026-11-13 "Now"): staffing offers it to nobody, while a template that names it as a
/// fallback can still place it (`legacy_option`), and nothing else comes back that way.
#[test] fn legacy_flash_is_not_offered_but_stays_placeable_for_templates() {
    let (e, org) = fixture();
    assert!(!offers(&e, &org, "flash"), "Flash left the staffing options");
    assert!(!options(&e, &org)["tiers"].as_array().unwrap().iter().any(|t| t["tier"] == "flash" || t["tier"] == "pro"));
    let flash = legacy_option(&e, &org, "flash").expect("an installed, enabled Antigravity can still run Flash");
    assert_eq!((flash["tier"].as_str(), flash["seat"].as_f64(), flash["provider"].as_str()), (Some("flash"), Some(1.0), Some("google")));
    for never in ["pro", "gpt-reserve", "argon", "opus", "hydrogen", "nonsense"] {
        assert!(legacy_option(&e, &org, never).is_none(), "{never}");
    }
    let mut st = (*e.providers.state.load_full()).clone(); st.agy.installed = false;
    e.providers.state.store(Arc::new(st));
    assert!(legacy_option(&e, &org, "flash").is_none(), "no Antigravity, no Flash");
}

#[test] fn absent_native_harnesses_are_not_offered() {
    let (e, org) = fixture();
    let mut st = (*e.providers.state.load_full()).clone();
    st.claude.installed = false; st.codex.installed = false; st.agy.installed = false; st.muse.installed = false;
    e.providers.state.store(Arc::new(st));
    for (_, tier) in SAMPLES.into_iter().take(4) { assert!(!offers(&e, &org, tier), "{tier}"); }
}

#[test] fn routed_models_need_an_installed_harness_in_requests_and_discovery() {
    let (e, org) = fixture();
    let mut st = (*e.providers.state.load_full()).clone(); st.opencode.installed = false;
    e.providers.state.store(Arc::new(st));
    assert!(!offers(&e, &org, "or-fixture"), "a stored key alone cannot run a model");
    assert!(!offers(&e, &org, "ls-fixture-model"));
    let payload = crate::providers::payload(&e);
    let providers = payload["providers"].as_array().unwrap();
    let or = providers.iter().find(|p| p["id"] == "openrouter").unwrap();
    assert_eq!(or["status"]["installed"], false);
    let ls = providers.iter().find(|p| p["id"] == "langserver").unwrap();
    assert!(ls["tiers"].as_array().unwrap().is_empty());
}
