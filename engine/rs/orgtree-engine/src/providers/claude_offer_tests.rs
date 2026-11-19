//! Claude Mythos is offered only by a signed-in Claude login whose own CLI lists it (USER 2026-11-19
//! m4f7e7e8c6694, m8c9e34510689). In-memory state only: no database, no CLI, no credential, no network.

use std::sync::Arc;

use serde_json::{json, Value};

use super::*;
use crate::accounts::{AccountInfo, Accounts};

const MYTHOS: &str = "claude-mythos-5-2";

fn login(id: &str, auth: &str, email: Option<&str>) -> AccountInfo {
    AccountInfo { id: id.into(), provider: catalog::CLAUDE.into(), kind: "subscription".into(), label: String::new(),
        email: email.map(str::to_string), tint_ordinal: 0, auth: auth.into(), config_dir: None, enabled: true,
        origin_org: None, marks: Default::default(), ord: 0, ambient: false, credential: 0, harness: None }
}

/// An engine whose own Claude sign-in is `own` (signed in or not), with these registered logins.
fn engine(own: bool, rows: Vec<AccountInfo>) -> (Arc<Engine>, String) {
    let mut e = Engine::for_tests("synthetic-unused-claude-mythos".into());
    Arc::get_mut(&mut e).unwrap().accounts = Accounts::for_tests(rows);
    // the test binary is merely an existing file for "installed"; it is never started
    let cli = CliStatus { installed: true, connected: own, path: Some(std::env::current_exe().unwrap()),
        email: own.then(|| "owner@example.com".to_string()), ..Default::default() };
    e.providers.state.store(Arc::new(State { claude: cli, probed: true, ..Default::default() }));
    (e, format!("mythos-{}", uuid::Uuid::new_v4()))
}

fn accounts(e: &mut Arc<Engine>, rows: Vec<AccountInfo>) {
    Arc::get_mut(e).unwrap().accounts = Accounts::for_tests(rows);
}

/// What a CLI answers `initialize` with: these selectable ids, under this sign-in.
fn answer(ids: &[&str], email: Option<&str>) -> Value {
    let models: Vec<Value> = ids.iter().map(|id| json!({ "value": id, "displayName": id, "description": "" })).collect();
    json!({ "subtype": "success", "request_id": "ot_1", "response": { "commands": [], "models": models,
        "account": { "email": email, "apiProvider": "firstParty" } } })
}

const USUAL: [&str; 4] = ["default", "fable", "opus", "claude-haiku-5-5"];

fn with_mythos() -> Vec<&'static str> {
    USUAL.iter().copied().chain([MYTHOS]).collect()
}

fn payload_row(e: &Engine) -> Option<Value> {
    let all = payload(e);
    let claude = all["providers"].as_array().unwrap().iter().find(|p| p["id"] == catalog::CLAUDE).expect("Claude is installed").clone();
    let tiers: Vec<&str> = claude["tiers"].as_array().unwrap().iter().filter_map(|t| t["tier"].as_str()).collect();
    assert_eq!(tiers.iter().filter(|t| **t != "mythos").copied().collect::<Vec<_>>(), ["fable", "opus", "sonnet", "haiku"], "the four are always listed");
    claude["tiers"].as_array().unwrap().iter().find(|t| t["tier"] == "mythos").cloned()
}

fn staffing_row(e: &Engine, org: &str) -> Option<Value> {
    crate::domain::staffing::options(e, org)["tiers"].as_array().unwrap().iter().find(|t| t["tier"] == "mythos").cloned()
}

fn ids(row: &Value, key: &str) -> Vec<String> {
    row[key].as_array().unwrap().iter().map(|a| a.get("id").unwrap_or(a).as_str().unwrap().to_string()).collect()
}

/// Plan test 1. Nothing read, a list that does not name it, and a list not read yet: no window shows Mythos.
#[test]
fn mythos_is_hidden_while_no_login_provides_it() {
    let (e, org) = engine(true, vec![login("claude-2", "authenticated", Some("two@example.com"))]);
    let hidden = |e: &Engine, when: &str| {
        assert_eq!(payload_row(e), None, "payload, {when}");
        assert_eq!(staffing_row(e, &org), None, "staffing, {when}");
        assert!(!claude_somewhere(e, "mythos"), "{when}");
        assert_eq!(crate::org_accounts::best_allowed(e, &org, "mythos"), None, "{when}");
    };
    // the empty store: nothing is known, and unknown is hidden
    hidden(&e, "nothing read");
    assert!(matches!(claude_offer(&e, None, "mythos"), ClaudeOffer::Unknown(_)));
    assert!(matches!(claude_offer(&e, e.accounts.view().get("claude-2"), "mythos"), ClaudeOffer::Unknown(_)));
    // lists that do not name it
    claude_login_seen(&e, CLAUDE_OWN, &answer(&USUAL, Some("owner@example.com")));
    hidden(&e, "the own sign-in read, the account not yet");
    assert!(matches!(claude_offer(&e, None, "mythos"), ClaudeOffer::NotOffered(_)));
    claude_login_seen(&e, "claude-2", &answer(&USUAL, Some("two@example.com")));
    hidden(&e, "both read, neither names it");
    // an answer with no list teaches nothing and takes nothing away
    claude_login_seen(&e, "claude-2", &json!({ "subtype": "error", "error": "no" }));
    assert!(matches!(claude_offer(&e, e.accounts.view().get("claude-2"), "mythos"), ClaudeOffer::NotOffered(_)));
    // the other Claude tiers were never conditional
    for tier in ["fable", "opus", "sonnet", "haiku"] {
        assert!(claude_somewhere(&e, tier) && claude_offered(&e, tier), "{tier}");
        assert!(crate::domain::staffing::options(&e, &org)["tiers"].as_array().unwrap().iter().any(|t| t["tier"] == tier), "{tier}");
    }
}

/// Plan test 2. One registered login's list names it: the payload lists the tier and says where, staffing
/// offers it, and a hire that names no account lands on that login.
#[test]
fn mythos_is_shown_when_a_signed_in_login_provides_it() {
    let (e, org) = engine(true, vec![login("claude-2", "authenticated", Some("two@example.com"))]);
    claude_login_seen(&e, CLAUDE_OWN, &answer(&USUAL, Some("owner@example.com")));
    claude_login_seen(&e, "claude-2", &answer(&with_mythos(), Some("two@example.com")));
    let row = payload_row(&e).expect("listed");
    assert_eq!((row["provider"].as_str(), row["seat"].as_f64(), row["letter"].as_str(), row["model"].as_str()),
        (Some("claude"), Some(8.0), Some("M"), Some(MYTHOS)));
    assert_eq!(row["display_name"], json!("Claude Mythos 5.2"));
    assert_eq!((row["conditional"].as_bool(), row["own"].as_bool(), ids(&row, "logins")), (Some(true), Some(false), vec!["claude-2".to_string()]));
    assert_eq!(row["fast_mode"], json!(true), "as Fable 5.2 (inferred from the CLI naming the two ids together)");
    // staffing: offered, on that login only; a hire that names no account does not take the own sign-in
    let staff = staffing_row(&e, &org).expect("staffing offers it");
    assert_eq!((staff["seat"].as_f64(), staff["provider"].as_str()), (Some(8.0), Some("claude")));
    assert_eq!(ids(&staff, "accounts"), ["claude-2"]);
    assert_eq!((staff["default_ok"].as_bool(), staff["native_ok"].as_bool()), (Some(false), Some(false)));
    assert_eq!(staff["by_room"], json!(["claude-2"]));
    assert_eq!(staff["efforts"], json!(["low", "medium", "high", "xhigh", "max"]));
    assert_eq!(crate::org_accounts::best_allowed(&e, &org, "mythos").as_deref(), Some("claude-2"), "where the hire lands");
    // the own sign-in gains it too: now a plain hire can take it
    claude_login_seen(&e, CLAUDE_OWN, &answer(&with_mythos(), Some("owner@example.com")));
    let row = payload_row(&e).expect("listed");
    assert_eq!((row["own"].as_bool(), ids(&row, "logins")), (Some(true), vec!["claude-2".to_string()]));
    let staff = staffing_row(&e, &org).expect("staffing offers it");
    assert_eq!((staff["default_ok"].as_bool(), staff["native_ok"].as_bool()), (Some(true), Some(true)));
    assert!(staff["by_room"].as_array().unwrap().contains(&json!("claude/primary")));
}

/// Plan test 3. The login that provided it signs out: hidden again, and signing in again starts from "not read".
#[test]
fn mythos_is_hidden_again_when_that_login_signs_out() {
    let (mut e, org) = engine(false, vec![login("claude-2", "authenticated", Some("two@example.com"))]);
    claude_login_seen(&e, "claude-2", &answer(&with_mythos(), Some("two@example.com")));
    assert!(payload_row(&e).is_some() && staffing_row(&e, &org).is_some(), "control: shown");
    for auth in ["signed_out", "unauthenticated"] {
        accounts(&mut e, vec![login("claude-2", auth, Some("two@example.com"))]);
        assert_eq!(payload_row(&e), None, "{auth}");
        assert_eq!(staffing_row(&e, &org), None, "{auth}");
        let ClaudeOffer::NotOffered(why) = claude_offer(&e, e.accounts.view().get("claude-2"), "mythos") else { panic!("{auth}") };
        assert_eq!(why, "the Claude account claude-2 is not signed in");
    }
    // a switched-off login shows nothing either
    let mut off = login("claude-2", "authenticated", Some("two@example.com"));
    off.enabled = false;
    accounts(&mut e, vec![off]);
    assert_eq!(payload_row(&e), None, "switched off");
    // the sign-out is seen: the list goes, so the same login signed in again is unknown until a CLI starts on it
    accounts(&mut e, vec![login("claude-2", "signed_out", Some("two@example.com"))]);
    claude_logins_prune(&e);
    accounts(&mut e, vec![login("claude-2", "authenticated", Some("two@example.com"))]);
    assert!(matches!(claude_offer(&e, e.accounts.view().get("claude-2"), "mythos"), ClaudeOffer::Unknown(_)));
    assert_eq!(payload_row(&e), None, "signed in again, not read yet");
    // the engine's own sign-in the same way
    let (e, org) = engine(true, vec![]);
    claude_login_seen(&e, CLAUDE_OWN, &answer(&with_mythos(), Some("owner@example.com")));
    assert!(payload_row(&e).is_some_and(|r| r["own"] == true) && staffing_row(&e, &org).is_some(), "control: shown");
    let mut st = State::clone(&e.providers.state.load());
    st.claude.connected = false;
    st.claude.email = None;
    e.providers.state.store(Arc::new(st));
    assert_eq!(payload_row(&e), None, "the own sign-in signed out");
    assert!(matches!(claude_offer(&e, None, "mythos"), ClaudeOffer::NotOffered(_)));
    claude_logins_prune(&e);
    let mut st = State::clone(&e.providers.state.load());
    st.claude.connected = true;
    e.providers.state.store(Arc::new(st));
    assert!(matches!(claude_offer(&e, None, "mythos"), ClaudeOffer::Unknown(_)), "signed in again: not read yet");
}

/// Plan test 5. Two logins, one with Mythos: the other is never eligible, by hire or by account fallback.
#[test]
fn a_login_without_mythos_is_never_eligible_for_it() {
    let (e, org) = engine(true, vec![login("claude-2", "authenticated", None), login("claude-3", "authenticated", None),
        login("claude-4", "authenticated", None)]);
    claude_login_seen(&e, CLAUDE_OWN, &answer(&USUAL, None));
    claude_login_seen(&e, "claude-2", &answer(&with_mythos(), None));
    claude_login_seen(&e, "claude-3", &answer(&USUAL, None));
    // claude-4 was never read
    let staff = staffing_row(&e, &org).expect("offered by claude-2");
    assert_eq!(ids(&staff, "accounts"), ["claude-2"], "the hire's accounts");
    assert_eq!(crate::org_accounts::best_allowed(&e, &org, "mythos").as_deref(), Some("claude-2"));
    assert_eq!(claude_logins_offering(&e, "mythos"), ["claude-2"]);
    // continuation and account fallback ask the target login itself
    assert!(crate::runtime::freeze::admits(&e, &org, "mythos", None, "claude-2").is_ok());
    let no = |account: &str| crate::runtime::freeze::admits(&e, &org, "mythos", None, account).expect_err(account).to_string();
    assert!(no("claude-3").contains("the Claude account claude-3 does not offer Claude Mythos 5.2"), "{}", no("claude-3"));
    assert!(no("claude-4").contains("has not been read yet"), "{}", no("claude-4"));
    assert!(no("claude/primary").contains("the signed-in Claude account does not offer Claude Mythos 5.2"), "{}", no("claude/primary"));
    // a pinned older version is the same tier: still only where the list names the tier
    assert!(crate::runtime::freeze::admits(&e, &org, "mythos", Some("5.1"), "claude-3").is_err());
    // every other Claude tier moves as before
    for account in ["claude-2", "claude-3", "claude-4", "claude/primary"] {
        assert!(crate::runtime::freeze::admits(&e, &org, "opus", None, account).is_ok(), "{account}");
    }
    // each registered login is asked by its own list: another's is never borrowed
    let view = e.accounts.view();
    assert!(matches!(claude_offer(&e, view.get("claude-2"), "mythos"), ClaudeOffer::Offered(_)));
    assert!(matches!(claude_offer(&e, view.get("claude-3"), "mythos"), ClaudeOffer::NotOffered(_)));
    assert!(matches!(claude_offer(&e, view.get("claude-4"), "mythos"), ClaudeOffer::Unknown(_)));
}

/// Plan test 6. A list read under another sign-in is not used.
#[test]
fn a_list_read_under_another_sign_in_is_not_used() {
    let (mut e, org) = engine(true, vec![login("claude-2", "authenticated", Some("two@example.com"))]);
    claude_login_seen(&e, "claude-2", &answer(&with_mythos(), Some("Two@Example.com")));
    assert!(payload_row(&e).is_some(), "control: the same sign-in, case aside");
    // the folder now holds another account's sign-in
    accounts(&mut e, vec![login("claude-2", "authenticated", Some("someone-else@example.com"))]);
    let ClaudeOffer::Unknown(why) = claude_offer(&e, e.accounts.view().get("claude-2"), "mythos") else { panic!("not unknown") };
    assert!(why.contains("read under another sign-in"), "{why}");
    assert_eq!(payload_row(&e), None);
    assert_eq!(staffing_row(&e, &org), None);
    claude_logins_prune(&e);
    accounts(&mut e, vec![login("claude-2", "authenticated", Some("two@example.com"))]);
    assert!(matches!(claude_offer(&e, e.accounts.view().get("claude-2"), "mythos"), ClaudeOffer::Unknown(_)), "the old list is gone");
    // the own sign-in: the list was read for the owner, and another account is signed in now
    let (e, _) = engine(true, vec![]);
    claude_login_seen(&e, CLAUDE_OWN, &answer(&with_mythos(), Some("owner@example.com")));
    assert!(claude_offered(&e, "mythos"));
    let mut st = State::clone(&e.providers.state.load());
    st.claude.email = Some("another@example.com".into());
    e.providers.state.store(Arc::new(st));
    assert!(matches!(claude_offer(&e, None, "mythos"), ClaudeOffer::Unknown(_)));
    assert_eq!(payload_row(&e), None);
}

/// A login's list is kept under the login the CLI ran on; a row pointing at the engine's own sign-in is that sign-in.
#[test]
fn a_list_belongs_to_the_login_its_cli_ran_on() {
    let two = login("claude-2", "authenticated", None);
    assert_eq!(claude_login_key(Some(&two)), "claude-2");
    assert_eq!(claude_login_key(None), CLAUDE_OWN);
    let mut ambient = login("claude-1", "authenticated", None);
    ambient.ambient = true;
    assert_eq!(claude_login_key(Some(&ambient)), CLAUDE_OWN);
    let (e, _) = engine(true, vec![ambient.clone()]);
    claude_login_seen(&e, &claude_login_key(Some(&ambient)), &answer(&with_mythos(), None));
    assert!(claude_offered(&e, "mythos"));
    assert!(matches!(claude_offer(&e, Some(&ambient), "mythos"), ClaudeOffer::Offered(_)));
    assert!(claude_logins_offering(&e, "mythos").is_empty(), "it is the own sign-in, not a second login");
}

/// The levels a Mythos seat may take are the ones its login's row names; a row that names none takes Claude Code's set.
#[test]
fn mythos_takes_the_effort_levels_its_login_names() {
    let two = login("claude-2", "authenticated", None);
    let (e, _) = engine(true, vec![two.clone()]);
    let mut limited = answer(&[MYTHOS], None);
    limited["response"]["models"][0]["supportedEffortLevels"] = json!(["high", "low", "medium"]);
    claude_login_seen(&e, "claude-2", &limited);
    assert_eq!(effort_names_on(&e, "mythos", None, Some(&two)), Some(vec!["low".to_string(), "medium".into(), "high".into()]));
    assert!(check_effort_on(&e, "mythos", None, Some(&two), "medium").is_ok());
    assert!(check_effort_on(&e, "mythos", None, Some(&two), "max").is_err());
    claude_login_seen(&e, CLAUDE_OWN, &answer(&[MYTHOS], None));
    assert_eq!(effort_names_on(&e, "mythos", None, None).map(|l| l.len()), Some(5), "no levels named: low to max");
    assert_eq!(effort_names_on(&e, "fable", None, Some(&two)).map(|l| l.len()), Some(5), "other tiers as before");
}

/// Question 2 (USER 2026-11-19 m434ffd1cf05f): Mythos spends the session and weekly windows, a model window that
/// names it, and Fable's model window. Fable and the lower tiers are as before.
#[test]
fn mythos_spends_fables_weekly_window_too() {
    let w = |kind: &str, model: Option<&str>| json!({ "kind": kind, "model": model });
    let spends = |tier: &str, w: &Value| crate::usage::spends(catalog::CLAUDE, tier, w);
    for kind in ["session", "weekly_all"] {
        assert!(spends("mythos", &w(kind, None)), "{kind}");
    }
    assert!(spends("mythos", &w("weekly_scoped", Some("Claude Fable 5.2"))));
    assert!(spends("mythos", &w("weekly_scoped", Some("Mythos"))));
    assert!(!spends("mythos", &w("weekly_scoped", Some("Opus"))));
    assert!(!spends("mythos", &w("weekly_scoped", None)));
    assert!(spends("fable", &w("weekly_scoped", Some("Fable"))) && !spends("fable", &w("weekly_scoped", Some("Mythos"))));
    assert!(!spends("opus", &w("weekly_scoped", Some("Fable"))) && !spends("opus", &w("weekly_scoped", Some("Mythos"))));
}
