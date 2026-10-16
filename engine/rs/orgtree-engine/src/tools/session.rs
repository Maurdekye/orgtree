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
}

#[logged]
pub async fn run(engine: &Arc<Engine>, caller: &Caller) -> Result<Done> {
    let view = super::control::ask_actor(engine, caller.org_id, caller.agent_id, AgentMsg::Session).await;
    if let Some(e) = view["error"].as_str() {
        crate::refuse!(Conflict, "{e}");
    }
    let root = engine.cfg.data_root.clone();
    let signed_in = tokio::task::spawn_blocking(move || signed_in(&root)).await.ok().flatten();
    Done::json(&answer(&Facts {
        windows: cfg!(windows),
        engine_session0: crate::runtime::codex::session0(),
        helper: engine.credential_bridge.can_host(),
        signed_in,
        this_turn: view["this_turn"].as_str().map(str::to_owned),
        next_turn: view["next_turn"].as_str().map(str::to_owned),
        held: view["held_by_background_work"].as_bool().unwrap_or(false),
    }))
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

#[logged]
fn answer(f: &Facts) -> Value {
    let moves = matches!((&f.this_turn, &f.next_turn), (Some(now), Some(next)) if now != next);
    json!({
        "signed_in": f.signed_in,
        "this_turn": f.this_turn,
        "next_turn": f.next_turn,
        "next_turn_moves": moves,
        "sign_in_helper": f.helper,
        "summary": summary(f, moves),
    })
}

#[logged]
fn summary(f: &Facts, moves: bool) -> String {
    if !f.windows {
        return "This is not Windows: there is no Session 0, and your CLI runs in the engine's own session.".into();
    }
    if !f.engine_session0 {
        return "Orgtree's engine runs in the user's signed-in session, so all your turns run there, with access to their desktop and apps.".into();
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
    if moves {
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
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[nolog]
    fn facts(signed_in: Option<bool>, helper: bool, this_turn: &str, next_turn: &str) -> Facts {
        Facts { windows: true, engine_session0: true, helper, signed_in,
            this_turn: Some(this_turn.into()), next_turn: Some(next_turn.into()), held: false }
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
}
