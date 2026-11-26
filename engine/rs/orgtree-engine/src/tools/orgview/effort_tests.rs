//! A seat's effort is readable (USER 2026-11-26 15:31:03Z m99820c62f071 "Fix for next alpha (rec.)", after
//! org primordial-engine's report mb98994481ebf: hire/rehire/retool/staff set `effort` but state_inspect and the
//! chart never showed it): state_inspect gives the effective level and its source, the chart a compact level.

use super::*;

fn names(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn an_explicit_level_is_the_seats_own() {
    let v = effort_view(&json!({"effort": "medium"}), &json!({"default_effort": "max"}), Some(names(catalog::EFFORTS).as_slice()), None);
    assert_eq!(v, json!({"level": "medium", "source": "explicit"}));
}

#[test]
fn without_its_own_level_a_seat_takes_the_org_default_then_the_built_in_one() {
    let all = names(catalog::EFFORTS);
    assert_eq!(effort_view(&json!({}), &json!({"default_effort": "low"}), Some(all.as_slice()), None),
        json!({"level": "low", "source": "org default"}));
    assert_eq!(effort_view(&json!({"effort": ""}), &json!({"default_effort": ""}), Some(all.as_slice()), None),
        json!({"level": catalog::DEFAULT_EFFORT, "source": "built-in default"}));
    // a stored level no harness names reads as the built-in default, never the org's (catalog::effective_effort)
    assert_eq!(effort_view(&json!({"effort": "turbo"}), &json!({"default_effort": "low"}), Some(all.as_slice()), None),
        json!({"level": catalog::DEFAULT_EFFORT, "source": "built-in default"}));
}

#[test]
fn a_model_without_an_effort_setting_says_so() {
    assert_eq!(effort_view(&json!({"effort": "high"}), &json!({}), Some(&[][..]), None),
        json!({"level": null, "source": "unsupported"}));
}

#[test]
fn a_level_the_model_does_not_name_shows_what_its_turns_are_sent() {
    let v = effort_view(&json!({"effort": "max"}), &json!({}), Some(names(&["low", "medium", "high", "xhigh"]).as_slice()), None);
    assert_eq!(v, json!({"level": "max", "source": "explicit", "sent_as": "xhigh"}));
    // levels not known yet: nothing to map against
    assert_eq!(effort_view(&json!({"effort": "max"}), &json!({}), None, None), json!({"level": "max", "source": "explicit"}));
}

#[test]
fn a_change_waiting_for_the_running_turn_is_shown_as_pending() {
    let live = json!({"effort_current": "high", "pending_effort": "low"});
    let v = effort_view(&json!({"effort": "low"}), &json!({}), Some(names(catalog::EFFORTS).as_slice()), Some(&live));
    assert_eq!(v, json!({"level": "low", "source": "explicit", "pending": {"running": "high", "next": "low"}}));
    // an idle seat (the actor publishes neither) or one already on its level: no pending entry
    let idle = json!({"effort_current": null, "pending_effort": null});
    assert_eq!(effort_view(&json!({"effort": "low"}), &json!({}), None, Some(&idle)), json!({"level": "low", "source": "explicit"}));
}

fn row(tier: &str, effort: Option<&str>, project: bool) -> Row {
    Row {
        id: 1, name: "n".into(), parent: None, title: String::new(), tier: tier.into(), state: "live".into(),
        status: Value::Null, grant: 4.0, seat: 4.0, halted: false, frozen: false, busy: false, team_charter: None,
        hold: 0.0, project, waiting: 0, peer_mail: false, audiences: Vec::new(), effort: effort.map(str::to_string),
    }
}

#[test]
fn the_chart_line_shows_the_effective_effort_next_to_the_tier() {
    assert!(line(&row("opus", Some("medium"), false), false).contains(" · opus (medium) · grant 4"), "{}", line(&row("opus", Some("medium"), false), false));
    // unsupported or unknown: the tier alone, as before
    assert!(line(&row("local", None, false), false).contains(" · local · grant 4"));
    // a project runs no turns and shows none
    assert!(!line(&row("opus", Some("medium"), true), false).contains("medium"));
}

#[test]
fn the_chart_effort_is_the_effective_level_or_none_when_unsupported() {
    assert_eq!(chart_effort(&json!({"effort": "xhigh"}), &json!({}), Some(names(catalog::EFFORTS).as_slice())), Some("xhigh".to_string()));
    assert_eq!(chart_effort(&json!({}), &json!({"default_effort": "low"}), None), Some("low".to_string()));
    assert_eq!(chart_effort(&json!({"effort": "high"}), &json!({}), Some(&[][..])), None);
}
