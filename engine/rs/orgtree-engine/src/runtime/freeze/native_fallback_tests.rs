//! Cache-only selector regression: no database, credential, CLI or network I/O.
use super::*;
use crate::accounts::{AccountInfo, Accounts};
use crate::providers::{catalog, State};

fn account(provider: &str, id: &str) -> AccountInfo {
    AccountInfo { id:id.into(), provider:provider.into(), kind:"managed".into(), label:String::new(),
        email:None, tint_ordinal:0, auth:"authenticated".into(), config_dir:Some(format!("synthetic/{id}")),
        enabled:true, origin_org:None, marks:Default::default(), ord:0, ambient:false, credential:0, harness:None }
}

fn reading(kinds: &[&str], percent: u32) -> Value {
    json!({"available":true,"limits":kinds.iter().map(|kind| json!({"kind":kind,"percent":percent,
        "resets_at":iso(Utc::now()+chrono::Duration::hours(2))})).collect::<Vec<_>>()})
}

fn fixture(provider: &str, data: &Value) -> Arc<Engine> {
    let mut e=Engine::for_tests("synthetic-unused-native-fallback".into());
    Arc::get_mut(&mut e).unwrap().accounts=Accounts::for_tests(vec![account(provider,"secondary")]);
    let mut state=State::default();
    state.claude.installed=true; state.claude.connected=true;
    state.codex.installed=true; state.codex.connected=true;
    e.providers.state.store(Arc::new(state));
    let key=if provider==catalog::CLAUDE { crate::usage::claude_key(None) } else { crate::usage::codex_key(None) };
    e.usage.put_for_tests(&key,data,Duration::ZERO);
    e
}

#[tokio::test]
async fn native_fallback_codex_without_ambient_registry_row() {
    let data=reading(&["weekly_all"],17);
    let e=fixture(catalog::OPENAI,&data);
    assert!(crate::usage::has_room(&e,None,"sol"),"weekly-only Codex control has affirmative room");
    let target=pick_fallback_with_native(&e,"sol",None,Some("secondary"),"native-red",true,std::future::ready(data)).await;
    assert_eq!(target.as_deref(),Some("openai/primary"),"native login must be considered without a registry row");
}

#[tokio::test]
async fn native_fallback_claude_requires_its_full_window_set() {
    for (kinds,tier,expected) in [
        (vec!["session","weekly_all"],"sonnet",true),
        (vec!["weekly_all"],"sonnet",false),
        (vec!["session","weekly_all"],"fable",false),
        (vec!["session","weekly_all","weekly_scoped"],"fable",true),
    ] {
        let mut data=reading(&kinds,20);
        for w in data["limits"].as_array_mut().unwrap() {
            if w["kind"]=="weekly_scoped" { w["model"]=json!("fable"); }
        }
        let e=fixture(catalog::CLAUDE,&data);
        let target=pick_fallback_with_native(&e,tier,None,Some("secondary"),"native-claude",true,std::future::ready(data)).await;
        assert_eq!(target.as_deref(),expected.then_some("claude/primary"),"{tier} {kinds:?}");
    }
}

#[tokio::test]
async fn native_fallback_activation_signin_and_reauth_gates_precede_io() {
    for gate in ["provider","subscription","installed","connected","reauth"] {
        let data=reading(&["weekly_all"],17);
        let mut e=fixture(catalog::OPENAI,&data);
        match gate {
            "provider" => Arc::get_mut(&mut e).unwrap().settings=crate::settings::AppSettings::new(json!({"providers":{"openai":false}})),
            "subscription" => Arc::get_mut(&mut e).unwrap().settings=crate::settings::AppSettings::new(json!({"subscription_inference":{"openai":false}})),
            "reauth" => e.usage.put_for_tests(&crate::usage::codex_key(None),&json!({"available":false,"reauth_required":true}),Duration::ZERO),
            _ => {
                let mut state=(*e.providers.state.load_full()).clone();
                if gate=="installed" { state.codex.installed=false; } else { state.codex.connected=false; }
                e.providers.state.store(Arc::new(state));
            }
        }
        let target=pick_fallback_with_native(&e,"sol",None,Some("secondary"),"native-gates",true,async { panic!("ineligible native login was probed") }).await;
        assert_eq!(target,None,"{gate}");
    }
}

#[tokio::test]
async fn native_fallback_honors_org_account_allowance() {
    let data=reading(&["weekly_all"],17);
    let e=fixture(catalog::OPENAI,&data);
    let org=format!("native-fallback-{}",uuid::Uuid::new_v4());
    crate::org_accounts::set(&org,["openai/primary".to_owned()].into_iter().collect());
    let target=pick_fallback_with_native(&e,"sol",None,Some("secondary"),&org,true,std::future::ready(data)).await;
    crate::org_accounts::set(&org,Default::default());
    assert_eq!(target,None);
}

#[tokio::test]
async fn native_fallback_never_returns_the_same_physical_login() {
    for current in [None,Some("primary"),Some("default"),Some("openai/primary"),Some("ambient"),Some("missing-folder")] {
        let data=reading(&["weekly_all"],17);
        let mut e=fixture(catalog::OPENAI,&data);
        let rows=match current {
            Some("ambient") => { let mut a=account(catalog::OPENAI,"ambient"); a.ambient=true; vec![a] },
            Some("missing-folder") => { let mut a=account(catalog::OPENAI,"missing-folder"); a.config_dir=None; vec![a] },
            _ => Vec::new(),
        };
        Arc::get_mut(&mut e).unwrap().accounts=Accounts::for_tests(rows);
        let target=pick_fallback_with_native(&e,"sol",None,current,"native-same",true,async { panic!("current native login was probed") }).await;
        assert_eq!(target,None,"{current:?}");
    }
}

#[tokio::test]
async fn native_fallback_unknown_stale_full_and_invalid_room_are_refused() {
    for case in ["missing","stale","unavailable","full","unknown-percent","past-reset"] {
        let mut data=reading(&["weekly_all"],17);
        match case {
            "missing" => data["limits"]=json!([]),
            "unavailable" => data["available"]=json!(false),
            "full" => data["limits"][0]["percent"]=json!(100),
            "unknown-percent" => data["limits"][0]["percent"]=Value::Null,
            "past-reset" => data["limits"][0]["resets_at"]=json!(iso(Utc::now()-chrono::Duration::seconds(1))),
            _ => {},
        }
        let e=fixture(catalog::OPENAI,&data);
        if case=="stale" { e.usage.put_for_tests(&crate::usage::codex_key(None),&data,Duration::from_secs(900)); }
        let target=pick_fallback_with_native(&e,"sol",None,Some("secondary"),"native-room",true,std::future::ready(data)).await;
        assert_eq!(target,None,"{case}");
    }
    // An entirely absent cache is unknown even if a reader incorrectly returns
    // available=true without recording any actual window evidence.
    let e=fixture(catalog::OPENAI,&json!({"available":false}));
    let target=pick_fallback_with_native(&e,"sol",None,Some("secondary"),"native-no-evidence",true,
        std::future::ready(json!({"available":true}))).await;
    assert_eq!(target,None);
}

#[tokio::test]
async fn native_fallback_registered_subscription_stays_first() {
    let data=reading(&["weekly_all"],17);
    let mut e=fixture(catalog::OPENAI,&data);
    let other=account(catalog::OPENAI,"other");
    e.usage.put_for_tests(&crate::usage::codex_key(other.config_dir.as_deref()),&data,Duration::ZERO);
    Arc::get_mut(&mut e).unwrap().accounts=Accounts::for_tests(vec![account(catalog::OPENAI,"secondary"),other]);
    let target=pick_fallback_with_native(&e,"sol",None,Some("secondary"),"native-order",true,async { panic!("native read preceded eligible subscription") }).await;
    assert_eq!(target.as_deref(),Some("other"));
}

#[tokio::test]
async fn native_fallback_precedes_paid_keys_and_respects_move_kind_and_billing_optin() {
    for (native_room,own_login,paid,expected) in [
        (true,true,true,Some("openai/primary")),
        (false,true,true,Some("paid")),
        (false,true,false,None),
        (true,false,true,Some("paid")),
        (true,false,false,None),
    ] {
        let data=if native_room { reading(&["weekly_all"],17) } else { json!({"available":false}) };
        let mut e=fixture(catalog::OPENAI,&data);
        let mut key=account(catalog::OPENAI,"paid"); key.kind="apikey".into(); key.config_dir=None;
        let editable=Arc::get_mut(&mut e).unwrap();
        editable.accounts=Accounts::for_tests(vec![account(catalog::OPENAI,"secondary"),key]);
        editable.settings=crate::settings::AppSettings::new(json!({"apikey_fallback":{"openai":paid}}));
        let target=pick_fallback_with_native(&e,"sol",None,Some("secondary"),"native-billing",own_login,std::future::ready(data)).await;
        assert_eq!(target.as_deref(),expected);
    }
}

#[tokio::test]
async fn native_fallback_cannot_bypass_native_alias_marks_or_full_windows() {
    for marked in [true,false] {
        let data=reading(&["weekly_all"],17);
        let mut e=fixture(catalog::OPENAI,&data);
        let mut alias=account(catalog::OPENAI,"native-alias"); alias.ambient=true;
        if marked { alias.marks.insert("all".into(),(Utc::now()+chrono::Duration::hours(1),"synthetic".into())); }
        e.usage.put_for_tests(&crate::usage::codex_key(alias.config_dir.as_deref()),&reading(&["weekly_all"],100),Duration::ZERO);
        Arc::get_mut(&mut e).unwrap().accounts=Accounts::for_tests(vec![account(catalog::OPENAI,"secondary"),alias]);
        let target=pick_fallback_with_native(&e,"sol",None,Some("secondary"),"native-alias-limit",true,async { panic!("limited alias bypassed") }).await;
        assert_eq!(target,None);
    }
}

#[tokio::test]
async fn native_fallback_timeout_never_uses_prior_room() {
    let data=reading(&["weekly_all"],17);
    let e=fixture(catalog::OPENAI,&data);
    let target=pick_fallback_with_native(&e,"sol",None,Some("secondary"),"native-timeout",true,std::future::pending()).await;
    assert_eq!(target,None);
}

#[tokio::test]
async fn native_fallback_rechecks_auth_and_quota_after_the_read() {
    for changed in [json!({"available":false,"reauth_required":true}),reading(&["weekly_all"],100)] {
        let data=reading(&["weekly_all"],17);
        let e=fixture(catalog::OPENAI,&data);
        let target=pick_fallback_with_native(&e,"sol",None,Some("secondary"),"native-read-race",true,async {
            e.usage.put_for_tests(&crate::usage::codex_key(None),&changed,Duration::ZERO);
            data
        }).await;
        assert_eq!(target,None);
    }
}
