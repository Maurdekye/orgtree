use super::fable_pip::{is_fable_weekly, pip_percent};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

fn now() -> DateTime<Utc> { DateTime::from_timestamp(1_900_000_000, 0).unwrap() }
fn later() -> String { crate::util::iso(now() + chrono::Duration::days(3)) }
fn row(weekly: Value, fable: Value) -> Value {
    json!({"account":"claude-5","provider":"claude","available":true,"freshness":"fresh","observed_at":crate::util::iso(now()),
        "windows":[
            {"kind":"weekly_all","group":"all","model":null,"used_percent":weekly,"resets_at":later()},
            {"kind":"weekly_scoped","group":"fable","model":"Claude Fable 5.2","used_percent":fable,"resets_at":later()}]})
}

#[test]
fn pip_formula_vectors() {
    for (f, pip) in [(0.0, 50.0), (52.0, 76.0), (53.0, 76.5), (99.0, 99.5)] {
        let got = pip_percent(&row(json!(60.0), json!(f)), now()).unwrap_or_else(|| panic!("f={f} has a pip"));
        assert_eq!(got.pip, pip, "f={f}");
        assert_eq!((got.weekly, got.fable), (60.0, f));
    }
    assert!(pip_percent(&row(json!(60.0), json!(100.0)), now()).is_none(), "Fable at 100% leaves no pip");
    assert!(pip_percent(&row(json!(60.0), Value::Null), now()).is_none());
    assert!(pip_percent(&row(json!(60.0), json!(-1.0)), now()).is_none());
    let mut nan = row(json!(60.0), json!(1.0));
    nan["windows"][1]["used_percent"] = Value::Null; // JSON has no NaN: a non-number is the same unknown
    assert!(pip_percent(&nan, now()).is_none());
}

#[test]
fn fable_window_matching_is_the_renderers_word_boundary_rule() {
    let w = |model: &str| json!({"kind":"weekly_scoped","model":model});
    for ok in ["Fable", "Claude Fable 5.2", "fable"] { assert!(is_fable_weekly("claude", &w(ok)), "{ok}"); }
    for no in ["fablex", "Opus", "unfabled"] { assert!(!is_fable_weekly("claude", &w(no)), "{no}"); }
    assert!(!is_fable_weekly("openai", &w("Fable")), "only Claude has Fable");
    assert!(!is_fable_weekly("claude", &json!({"kind":"weekly_all","model":"Fable"})), "only the scoped window");
}

#[test]
fn unknown_readings_have_no_pip() {
    let mut no_weekly = row(json!(60.0), json!(52.0));
    no_weekly["windows"].as_array_mut().unwrap().remove(0);
    assert!(pip_percent(&no_weekly, now()).is_none(), "missing weekly_all");
    let mut no_fable = row(json!(60.0), json!(52.0));
    no_fable["windows"].as_array_mut().unwrap().remove(1);
    assert!(pip_percent(&no_fable, now()).is_none(), "missing Fable window");
    let mut stale = row(json!(60.0), json!(52.0));
    stale["freshness"] = json!("stale");
    assert!(pip_percent(&stale, now()).is_none());
    let mut down = row(json!(60.0), json!(52.0));
    down["available"] = json!(false);
    assert!(pip_percent(&down, now()).is_none());
    for i in 0..2 {
        let mut expired = row(json!(60.0), json!(52.0));
        expired["windows"][i]["resets_at"] = json!(crate::util::iso(now()));
        assert!(pip_percent(&expired, now()).is_none(), "window {i} expired");
    }
    assert!(pip_percent(&row(json!(60.0), json!(52.0)), now()).is_some(), "control: the same row with nothing wrong has a pip");
}
