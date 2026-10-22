//! orgtree_session: where the calling agent's turns run on this computer
//! (docket let-agents-query-machine-sign-in-state-and-which; the user,
//! 2026-10-16 11:01Z: "allow agents to query the current machine state:
//! whether its logged in, and whether their current turn is running on
//! session 0 or the logged in session (and whether or not their next turn
//! will change)"). Run on boot starts the engine in Windows Session 0, which
//! has no desktop; while the user is signed in, the sign-in helper starts each
//! agent's CLI in their session from its next turn (`runtime::session_host`).
//! Read-only and served to every agent, as orgtree_status is: the agent's own
//! actor says where its CLI runs and where its next turn's will (the choice it
//! makes when that turn starts), and Windows says whether the user is signed in.

use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};

use super::Done;
use crate::engine::Engine;
use crate::runtime::{AgentMsg, Caller};

const SESSION0: &str = "session0";
const SIGNED_IN: &str = "signed-in";

/// What the answer is made of.
#[derive(Debug, Clone, Default)]
struct Facts {
    /// only Windows has Session 0
    windows: bool,
    /// the engine itself runs in Session 0 (the boot task)
    engine_session0: bool,
    /// the sign-in helper is connected and starts CLIs in the user's session
    helper: bool,
    /// the engine's Windows user has a signed-in session; None: Windows
    /// could not say, or not Windows
    signed_in: Option<bool>,
    /// where the agent's CLI runs now (`session0` / `signed-in`); None: no CLI
    this_turn: Option<String>,
    /// where its next turn's CLI will run if that turn starts now
    next_turn: Option<String>,
    /// the next turn stays where this one runs because the CLI still holds
    /// background work
    held: bool,
    /// the Windows session its CLI runs in (0: Session 0); None: no CLI
    this_session: Option<u32>,
    /// the session its next turn's CLI will run in
    next_session: Option<u32>,
    /// its stored preference (`session_host::pref_value`: null = signed-in)
    preference: Value,
    /// the session it picked for its next turn, if any
    use_id: Option<u32>,
    /// Session 0 and the user's sessions where a sign-in helper runs
    sessions: Vec<Value>,
}

/// Read, and with `prefer` or `use` set, the caller's place among the
/// user's sessions (the user, 2026-10-16 12:12Z and 12:13Z: an agent lists
/// Session 0 and the sessions of the engine's own user where a sign-in
/// helper runs, prefers them by kind, and picks one on demand).
#[logged]
pub async fn run(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    use crate::runtime::session_host as sh;
    let pref = match args.get("prefer").filter(|v| !v.is_null()) {
        Some(v) => match sh::parse_pref(v) {
            Ok(p) => Some(p),
            Err(why) => crate::refuse!(Unprocessable, "{why}"),
        },
        None => None,
    };
    let session0 = crate::runtime::codex::session0();
    let own = sh::engine_session();
    let use_id = match args.get("use").filter(|v| !v.is_null()) {
        Some(v) => {
            let Some(id) = v.as_u64().and_then(|n| u32::try_from(n).ok()) else {
                crate::refuse!(Unprocessable, "use is a session id from sessions, or 0 for Session 0");
            };
            if let Some(why) = unplaceable(cfg!(windows), session0, own, id) {
                crate::refuse!(Conflict, "{why}");
            }
            // an engine outside Session 0 runs every turn in its own session
            let here = !session0 && id == own;
            if id != 0 && !here && !engine.credential_bridge.hosting().iter().any(|(s, _)| *s == id) {
                crate::refuse!(Unprocessable, "session {id} has no sign-in helper: pick one from sessions, or 0 for Session 0");
            }
            Some(id)
        }
        None => None,
    };
    if let Some(p) = &pref {
        save_pref(engine, caller, p).await?;
    }
    let view = super::control::ask_actor(engine, caller.org_id, caller.agent_id, |reply| AgentMsg::Session { pref: pref.clone(), use_id, reply }).await;
    if let Some(e) = view["error"].as_str() {
        crate::refuse!(Conflict, "{e}");
    }
    let root = engine.cfg.data_root.clone();
    let signed_in = tokio::task::spawn_blocking(move || signed_in(&root)).await.ok().flatten();
    let mut sessions = Vec::new();
    if session0 {
        let user = std::env::var("USERNAME").unwrap_or_default();
        sessions.push(json!({ "id": 0, "kind": "session0", "state": "active", "user": user }));
        sessions.extend(engine.credential_bridge.hosting().into_iter().map(|(id, _)| sh::describe(engine, id)));
    } else {
        sessions.push(sh::describe(engine, own));
    }
    let num = |k: &str| view[k].as_u64().and_then(|n| u32::try_from(n).ok());
    Done::json(&answer(&Facts {
        windows: cfg!(windows),
        engine_session0: session0,
        helper: engine.credential_bridge.can_host(),
        signed_in,
        this_turn: view["this_turn"].as_str().map(str::to_owned),
        next_turn: view["next_turn"].as_str().map(str::to_owned),
        held: view["held_by_background_work"].as_bool().unwrap_or(false),
        this_session: num("this_session"),
        next_session: num("next_session"),
        preference: view["preference"].clone(),
        use_id: num("use"),
        sessions,
    }))
}

/// Keep the caller's preference in its own scope (absent for the default),
/// where Agent settings show it.
#[logged]
async fn save_pref(engine: &Arc<Engine>, caller: &Caller, p: &crate::runtime::session_host::Pref) -> Result<()> {
    let v = crate::runtime::session_host::pref_value(p);
    let client = engine.db.get().await?;
    client
        .execute(
            "UPDATE ot.agents SET scope = CASE WHEN $2::jsonb = 'null'::jsonb THEN scope - 'session'
                                               ELSE jsonb_set(scope, '{session}', $2) END,
                    row_version = row_version + 1
              WHERE id = $1",
            &[&caller.agent_id, &v],
        )
        .await?;
    drop(client);
    crate::changes::notify_id(engine, caller.org_id, vec![crate::changes::Change::Agent(caller.agent_id)]);
    Ok(())
}

/// Whether the engine's Windows user has a signed-in session (at the console,
/// remote or disconnected), read the way the core monitor reads it, so a
/// debug rig engine's stand-in applies too; None when Windows cannot say.
#[cfg(windows)]
#[logged]
fn signed_in(root: &Path) -> Option<bool> {
    let mut source = crate::core_process::Sessions::new();
    crate::core_state::sessions(root, &mut source).map(|found| !found.is_empty())
}

#[cfg(not(windows))]
#[logged]
fn signed_in(_root: &Path) -> Option<bool> {
    None
}

/// Why `use` cannot pick session `id`: an engine that runs in the user's
/// session `own` runs every turn there. Decision 93 made that the usual
/// place after a restart or update while the user is signed in; until the
/// user decides on placing turns elsewhere from there, the pick is refused
/// rather than kept and ignored (coordinator 2026-10-21 23:13Z).
#[logged]
fn unplaceable(windows: bool, engine_session0: bool, own: u32, id: u32) -> Option<String> {
    if !windows || engine_session0 || id == own {
        return None;
    }
    let what = if id == 0 { "Session 0".to_string() } else { format!("session {id}") };
    Some(format!(
        "Orgtree's engine runs in the user's Windows session {own}, so all your turns run there: {what} cannot be picked \
         while it does. Picks apply only while the engine runs in Session 0."
    ))
}

/// The one session an engine outside Session 0 runs every turn in (the only
/// one `sessions` lists then): its id and kind.
#[nolog]
fn own_session(f: &Facts) -> Option<(u32, &str)> {
    if f.engine_session0 {
        return None;
    }
    let s = f.sessions.first()?;
    Some((u32::try_from(s["id"].as_u64()?).ok()?, s["kind"].as_str().unwrap_or("console")))
}

/// Whether the stored preference is followed where the engine runs: from
/// Session 0 always, from an engine in the user's session only when it would
/// pick that session.
#[logged]
fn preference_followed(f: &Facts) -> bool {
    let Some((own, kind)) = own_session(f) else { return true };
    let Ok(pref) = crate::runtime::session_host::parse_pref(&f.preference) else { return true };
    crate::runtime::session_host::followed_in(own, kind, &pref)
}

/// The stored preference in words; None for the default.
#[nolog]
fn preference_words(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if s == SESSION0 => Some("Session 0".into()),
        Value::String(s) => Some(format!("a {s} session, then Session 0")),
        Value::Array(kinds) => {
            let kinds: Vec<&str> = kinds.iter().filter_map(Value::as_str).collect();
            Some(format!("{} sessions, in that order, then Session 0", kinds.join(", then ")))
        }
        _ => None,
    }
}

#[logged]
fn answer(f: &Facts) -> Value {
    let moves = matches!((f.this_session, f.next_session), (Some(now), Some(next)) if now != next)
        || matches!((&f.this_turn, &f.next_turn), (Some(now), Some(next)) if now != next);
    json!({
        "signed_in": f.signed_in,
        "this_turn": f.this_turn,
        "this_session": f.this_session,
        "next_turn": f.next_turn,
        "next_session": f.next_session,
        "next_turn_moves": moves,
        "sign_in_helper": f.helper,
        "preference": if f.preference.is_null() { json!(SIGNED_IN) } else { f.preference.clone() },
        "preference_followed": preference_followed(f),
        "use": f.use_id,
        "sessions": f.sessions,
        "summary": summary(f, moves),
    })
}

#[logged]
fn summary(f: &Facts, moves: bool) -> String {
    if !f.windows {
        return "This is not Windows: there is no Session 0, and your CLI runs in the engine's own session.".into();
    }
    if !f.engine_session0 {
        let mut out = String::from("Orgtree's engine runs in the user's signed-in session, so all your turns run there, with access to their desktop and apps.");
        if !preference_followed(f) {
            if let Some(words) = preference_words(&f.preference) {
                out.push_str(&format!(" You prefer {words}, which is not followed: preferences apply only while Orgtree's engine runs in Session 0."));
            }
        }
        let own = own_session(f).map(|(id, _)| id);
        match f.use_id {
            Some(id) if Some(id) != own => {
                let what = if id == 0 { "Session 0".to_string() } else { format!("the user's session {id}") };
                out.push_str(&format!(" Your pick of {what} for your next turn is not followed: picks apply only while Orgtree's engine runs in Session 0."));
            }
            Some(id) => out.push_str(&format!(" You picked the user's session {id} for your next turn.")),
            None => {}
        }
        return out;
    }
    let mut out = String::from(match f.signed_in {
        Some(true) => "The user is signed in to this computer.",
        Some(false) => "No user is signed in to this computer.",
        None => "Windows could not say whether the user is signed in.",
    });
    out.push(' ');
    out.push_str(match f.this_turn.as_deref() {
        Some(SIGNED_IN) => "This turn runs in the user's signed-in session, with access to their desktop and apps.",
        Some(_) => "This turn runs in Windows Session 0, which has no desktop: you cannot see or use the user's desktop and apps.",
        None => "No CLI runs for you right now.",
    });
    out.push(' ');
    let next = |place: Option<&str>| if place == Some(SIGNED_IN) { "the user's signed-in session" } else { "Session 0" };
    if moves && f.this_turn.as_deref() == Some(SIGNED_IN) && f.next_turn.as_deref() == Some(SIGNED_IN) {
        out.push_str(&format!("Your next turn moves to the user's session {}.", f.next_session.unwrap_or(0)));
    } else if moves {
        out.push_str(&format!("Your next turn moves to {}.", next(f.next_turn.as_deref())));
    } else if f.held {
        out.push_str(&format!("Your next turn stays in {}: your CLI still runs background work, so it moves at a later turn.", next(f.next_turn.as_deref())));
    } else if f.this_turn.is_some() {
        out.push_str("Your next turn runs there too.");
    } else {
        let place = f.next_turn.as_deref().unwrap_or(if f.helper { SIGNED_IN } else { SESSION0 });
        out.push_str(&format!("Your next turn will run in {}.", next(Some(place))));
    }
    if f.signed_in == Some(true) && !f.helper {
        out.push_str(" Orgtree's sign-in helper is not connected, so turns start in Session 0.");
    }
    if let Some(words) = preference_words(&f.preference) {
        out.push_str(&format!(" You prefer {words}."));
    }
    match f.use_id {
        Some(0) => out.push_str(" You picked Session 0 for your next turn."),
        Some(id) => out.push_str(&format!(" You picked the user's session {id} for your next turn.")),
        None => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[nolog]
    fn facts(signed_in: Option<bool>, helper: bool, this_turn: &str, next_turn: &str) -> Facts {
        Facts { windows: true, engine_session0: true, helper, signed_in,
            this_turn: Some(this_turn.into()), next_turn: Some(next_turn.into()), held: false, ..Default::default() }
    }

    /// The user, 2026-10-16 12:12Z and 12:13Z: the list of sessions, the
    /// stored preference, an on-demand pick, and a move between two of the
    /// user's sessions.
    #[test]
    fn it_lists_sessions_reports_the_preference_and_a_move_between_two_sessions() {
        let mut f = facts(Some(true), true, SIGNED_IN, SIGNED_IN);
        f.this_session = Some(1);
        f.next_session = Some(3);
        f.preference = json!(["remote", "console"]);
        f.use_id = Some(3);
        f.sessions = vec![json!({ "id": 0 }), json!({ "id": 1 }), json!({ "id": 3 })];
        let out = answer(&f);
        assert_eq!(out["next_turn_moves"], true);
        assert_eq!(out["preference"], json!(["remote", "console"]));
        assert_eq!(out["sessions"].as_array().map(Vec::len), Some(3));
        let s = out["summary"].as_str().unwrap();
        assert!(s.contains("moves to the user's session 3") && s.contains("You prefer remote, then console sessions")
            && s.contains("You picked the user's session 3"), "{s}");
        assert_eq!(answer(&facts(Some(true), true, SIGNED_IN, SIGNED_IN))["preference"], "signed-in");
    }

    /// The three states the docket names, plus a sign-out under a turn.
    #[test]
    fn it_answers_the_three_facts_in_each_state() {
        let out = answer(&facts(Some(false), false, SESSION0, SESSION0));
        assert_eq!((&out["signed_in"], &out["this_turn"], &out["next_turn"], &out["next_turn_moves"]),
            (&json!(false), &json!("session0"), &json!("session0"), &json!(false)));
        assert!(out["summary"].as_str().unwrap().starts_with("No user is signed in"), "{out}");

        let out = answer(&facts(Some(true), true, SESSION0, SIGNED_IN));
        assert_eq!((&out["signed_in"], &out["this_turn"], &out["next_turn"], &out["next_turn_moves"]),
            (&json!(true), &json!("session0"), &json!("signed-in"), &json!(true)));
        assert!(out["summary"].as_str().unwrap().contains("Your next turn moves to the user's signed-in session."), "{out}");

        let out = answer(&facts(Some(true), true, SIGNED_IN, SIGNED_IN));
        assert_eq!((&out["this_turn"], &out["next_turn"], &out["next_turn_moves"]), (&json!("signed-in"), &json!("signed-in"), &json!(false)));
        assert!(out["summary"].as_str().unwrap().contains("Your next turn runs there too."), "{out}");

        let out = answer(&facts(Some(false), false, SIGNED_IN, SESSION0));
        assert_eq!(out["next_turn_moves"], true);
        assert!(out["summary"].as_str().unwrap().contains("Your next turn moves to Session 0."), "{out}");
    }

    #[test]
    fn it_says_why_a_turn_stays_or_cannot_move() {
        let mut f = facts(Some(true), true, SESSION0, SESSION0);
        f.held = true;
        let out = answer(&f);
        assert_eq!(out["next_turn_moves"], false);
        assert!(out["summary"].as_str().unwrap().contains("stays in Session 0: your CLI still runs background work"), "{out}");

        let out = answer(&facts(Some(true), false, SESSION0, SESSION0));
        assert_eq!(out["sign_in_helper"], false);
        assert!(out["summary"].as_str().unwrap().ends_with("Orgtree's sign-in helper is not connected, so turns start in Session 0."), "{out}");

        let mut f = facts(None, false, SESSION0, SESSION0);
        f.this_turn = None;
        let out = answer(&f);
        assert_eq!((&out["signed_in"], &out["this_turn"], &out["next_turn_moves"]), (&Value::Null, &Value::Null, &json!(false)));
        assert!(out["summary"].as_str().unwrap().contains("No CLI runs for you right now. Your next turn will run in Session 0."), "{out}");
    }

    #[test]
    fn an_engine_outside_session0_runs_every_turn_in_the_signed_in_session() {
        let mut f = facts(Some(true), false, SIGNED_IN, SIGNED_IN);
        f.engine_session0 = false;
        let out = answer(&f);
        assert_eq!(out["next_turn_moves"], false);
        assert!(out["summary"].as_str().unwrap().starts_with("Orgtree's engine runs in the user's signed-in session"), "{out}");
        f.windows = false;
        assert!(answer(&f)["summary"].as_str().unwrap().starts_with("This is not Windows"));
    }

    /// Decision 93 runs the engine in the user's session after a restart or
    /// update while they are signed in. From there every turn runs in that
    /// one session, so a stored Session 0 or remote preference, or a pick of
    /// Session 0, is not followed, and the answer says so instead of
    /// reporting it as in force (Lane B review 2026-10-21; coordinator 23:13Z).
    #[test]
    fn an_engine_in_the_users_session_says_which_choices_it_cannot_follow() {
        let in_session = |pref: Value| {
            let mut f = facts(Some(true), true, SIGNED_IN, SIGNED_IN);
            f.engine_session0 = false;
            f.this_session = Some(1);
            f.next_session = Some(1);
            f.sessions = vec![json!({ "id": 1, "kind": "console", "state": "active", "user": "someone" })];
            f.preference = pref;
            f
        };
        for pref in [json!("session0"), json!("remote")] {
            let out = answer(&in_session(pref.clone()));
            assert_eq!(out["preference_followed"], false, "{pref}: {out}");
            let s = out["summary"].as_str().unwrap();
            assert!(s.contains("is not followed") && s.contains("only while Orgtree's engine runs in Session 0"), "{pref}: {s}");
        }
        for pref in [Value::Null, json!("console"), json!(["remote", "console"])] {
            let out = answer(&in_session(pref.clone()));
            assert_eq!(out["preference_followed"], true, "{pref}: {out}");
            assert!(!out["summary"].as_str().unwrap().contains("not followed"), "{pref}: {out}");
        }
        let mut f = in_session(Value::Null);
        f.use_id = Some(0);
        let s = answer(&f)["summary"].as_str().unwrap().to_string();
        assert!(s.contains("Session 0") && s.contains("is not followed"), "{s}");
        // from Session 0 every choice applies as before
        let mut f = facts(Some(true), true, SESSION0, SESSION0);
        f.preference = json!("session0");
        assert_eq!(answer(&f)["preference_followed"], true);
    }

    /// While the engine runs in the user's session 1, `use` may name only
    /// that session: Session 0 and another session are refused with the
    /// reason, before anything is stored. From Session 0, and outside
    /// Windows, nothing changes.
    #[test]
    fn a_pick_the_engine_cannot_follow_is_refused() {
        let why = unplaceable(true, false, 1, 0).expect("a pick of Session 0 from session 1 is refused");
        assert!(why.contains("Windows session 1") && why.contains("Session 0 cannot be picked"), "{why}");
        assert!(unplaceable(true, false, 1, 7).is_some_and(|w| w.contains("session 7 cannot be picked")));
        assert_eq!(unplaceable(true, false, 1, 1), None, "its own session is where every turn runs anyway");
        assert_eq!(unplaceable(true, true, 0, 0), None);
        assert_eq!(unplaceable(true, true, 0, 7), None);
        assert_eq!(unplaceable(false, false, 0, 3), None);
        let mut f = facts(Some(true), true, SIGNED_IN, SIGNED_IN);
        f.engine_session0 = false;
        f.sessions = vec![json!({ "id": 1, "kind": "console" })];
        f.use_id = Some(1);
        let s = answer(&f)["summary"].as_str().unwrap().to_string();
        assert!(s.ends_with("You picked the user's session 1 for your next turn.") && !s.contains("not followed"), "{s}");
    }
}

#[cfg(test)]
mod card_tests {
    /// The user, 2026-10-16 12:12Z and 12:13Z: an agent sets its preference
    /// over the user's sessions (`prefer`) and picks one on demand (`use`).
    #[test]
    fn the_card_offers_prefer_and_use() {
        let card = crate::tools::defs::list().into_iter().find(|t| t["name"] == "orgtree_session").expect("no orgtree_session card");
        let props = &card["inputSchema"]["properties"];
        assert!(props["prefer"].is_object() && props["use"]["type"] == "integer", "{card}");
        assert_eq!(card["inputSchema"]["required"], serde_json::json!([]));
    }
}
