//! What a Claude login's own CLI says it may select: the `models` list in the
//! answer to the `initialize` control request the engine sends every Claude CLI
//! it starts (`runtime::claude`). It is the evidence a conditional Claude tier
//! (Mythos) is offered on, per login, never borrowed from another login
//! (USER 2026-11-19 m8c9e34510689 "only show it if mythos is provided by a
//! signed in claude account").
//!
//! MEASURED 2026-11-19 on Claude Code 2.1.321, by reading the installed CLI
//! (nothing was run): the answer's schema has `models`, rows of `value`,
//! `resolvedModel`, `supportedEffortLevels`, `supportsFastMode` and an optional
//! `disabled`, and `account` with `email` and `apiProvider`.
//! NOT MEASURED: the row a login that has Mythos returns (no login here has it).
//! KNOWN LIMIT: the CLI fetches its extra model rows in one start-up request
//! and skips it when nonessential traffic is off, as it is for every CLI the
//! engine starts (decision 53). The list a login reports under the engine is
//! therefore the copy that login cached the last time a CLI ran on it outside
//! the engine (its sign-in, or the user's own terminal).

use serde_json::Value;

use super::catalog;

/// One selectable model of a login's list.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    /// what the CLI takes as `--model` (an alias such as `opus`, or a full id)
    pub value: String,
    /// the wire id the value resolves to, when the CLI says
    pub resolved: Option<String>,
    /// the effort levels the CLI names for it; None when it names none
    pub efforts: Option<Vec<String>>,
    pub fast: Option<bool>,
}

/// One login's list, and the sign-in it was read under.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Models {
    pub rows: Vec<Row>,
    /// the email the CLI answered under, lowercased; memory-only, never logged
    pub identity: Option<String>,
}

/// A model id without the CLI's one-million-token marker (`[1m]`).
#[nolog]
pub fn base(id: &str) -> &str {
    let t = id.trim();
    match t.len().checked_sub(4) {
        Some(at) if t.is_char_boundary(at) && t[at..].eq_ignore_ascii_case("[1m]") => &t[..at],
        _ => t,
    }
}

/// The list in an `initialize` answer (the control response, or its inner
/// `response`). None when it carries no `models` array (an older CLI, an error
/// answer) or the CLI is not talking to Anthropic itself: nothing is then known.
/// Rows marked `disabled` are visible but not selectable, so they are left out.
#[nolog]
pub fn parse(answer: &Value) -> Option<Models> {
    let body = if answer.get("models").is_some() { answer } else { answer.get("response")? };
    let rows = body.get("models")?.as_array()?;
    if body.pointer("/account/apiProvider").and_then(Value::as_str).is_some_and(|p| p != "firstParty") {
        return None;
    }
    let rows = rows.iter()
        .filter(|r| r.get("disabled").and_then(Value::as_bool) != Some(true))
        .filter_map(|r| {
            let value = r.get("value")?.as_str()?.trim().to_string();
            if value.is_empty() {
                return None;
            }
            Some(Row {
                value,
                resolved: r.get("resolvedModel").and_then(Value::as_str).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
                efforts: r.get("supportedEffortLevels").and_then(Value::as_array)
                    .map(|l| l.iter().filter_map(Value::as_str).map(str::to_string).collect()),
                fast: r.get("supportsFastMode").and_then(Value::as_bool),
            })
        })
        .collect();
    let identity = body.pointer("/account/email").and_then(Value::as_str).map(|e| e.trim().to_ascii_lowercase()).filter(|e| !e.is_empty());
    Some(Models { rows, identity })
}

#[logged]
impl Models {
    /// The row that names exactly `model`: by its value or by the id it resolves
    /// to, the `[1m]` marker aside. No prefix, no label, no family name (the
    /// Argon ruling of 2026-10-01: exact id).
    #[nolog]
    pub fn row(&self, model: &str) -> Option<&Row> {
        let want = base(model);
        if want.is_empty() {
            return None;
        }
        self.rows.iter().find(|r| base(&r.value).eq_ignore_ascii_case(want)
            || r.resolved.as_deref().is_some_and(|m| base(m).eq_ignore_ascii_case(want)))
    }

    /// The row for a tier: the first of the tier's own model ids, newest
    /// first, that the list names exactly.
    #[nolog]
    pub fn tier_row(&self, t: &catalog::Tier) -> Option<&Row> {
        std::iter::once(t.model).chain(t.versions.iter().map(|(_, m)| *m)).find_map(|m| self.row(m))
    }

    /// Whether the list was read under `email` (case aside). Unknown on either
    /// side does not contradict.
    #[nolog]
    pub fn read_under(&self, email: Option<&str>) -> bool {
        match (&self.identity, email.map(str::trim).filter(|e| !e.is_empty())) {
            (Some(mine), Some(theirs)) => mine.eq_ignore_ascii_case(theirs),
            _ => true,
        }
    }
}

/// Why a turn must end because the CLI is serving another model than the conditional Claude model it was
/// started with, or None. Claude Code can move a session whose model the account is refused to that tier's
/// default by itself ("[model-access] now using ... as its tier's default", a string in CLI 2.1.321), so a
/// Mythos seat's turn could run on another model unnoticed; the pin is asserted, not assumed, as an
/// Antigravity seat's is. Only a conditional Claude model is judged. The `[1m]` marker and a dated snapshot of
/// the same id (`-YYYYMMDD`) are the model asked for; an empty report says nothing.
#[nolog]
pub fn substituted(asked: &str, served: &str) -> Option<String> {
    let (asked, served) = (base(asked), base(served));
    if served.is_empty() || !catalog::TIERS.iter().any(|t| t.provider == catalog::CLAUDE && t.conditional && catalog::runs_model(t.tier, asked)) {
        return None;
    }
    let dated = |rest: &str| rest.len() == 9 && rest.starts_with('-') && rest[1..].bytes().all(|b| b.is_ascii_digit());
    let same = served.eq_ignore_ascii_case(asked)
        || served.get(..asked.len()).is_some_and(|head| head.eq_ignore_ascii_case(asked)) && dated(&served[asked.len()..]);
    (!same).then(|| format!("model pin refused: Claude Code is serving {served}, not {asked}. This sign-in may no longer offer {asked};         choose another model for this agent, or sign in with an account that offers it"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn answer(models: Value) -> Value {
        json!({ "subtype": "success", "request_id": "ot_1", "response": {
            "commands": [], "models": models, "account": { "email": "Someone@Example.com", "apiProvider": "firstParty" } } })
    }

    fn mythos() -> &'static catalog::Tier {
        catalog::tier("mythos").expect("mythos")
    }

    /// The schema's fields, as the CLI names them, and the sign-in the list was read under.
    #[test]
    fn the_initialize_answer_gives_the_selectable_rows() {
        let m = parse(&answer(json!([
            { "value": "default", "resolvedModel": "claude-opus-5-5", "displayName": "Default", "description": "" },
            { "value": "fable", "resolvedModel": "claude-fable-5-2", "displayName": "Fable", "description": "",
              "supportsEffort": true, "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"], "supportsFastMode": true },
            { "value": "claude-haiku-5-5", "displayName": "Haiku", "description": "" },
            { "value": "claude-opus-4-8", "displayName": "Opus 4.8", "description": "", "disabled": true },
            { "displayName": "no value" }, { "value": "" },
        ]))).expect("a models array");
        assert_eq!(m.rows.iter().map(|r| r.value.as_str()).collect::<Vec<_>>(), ["default", "fable", "claude-haiku-5-5"]);
        assert_eq!(m.rows[1].resolved.as_deref(), Some("claude-fable-5-2"));
        assert_eq!(m.rows[1].efforts.as_deref().map(<[String]>::len), Some(5));
        assert_eq!((m.rows[1].fast, m.rows[2].fast, &m.rows[2].efforts), (Some(true), None, &None));
        assert_eq!(m.identity.as_deref(), Some("someone@example.com"));
        assert!(m.row("claude-fable-5-2").is_some() && m.row("claude-haiku-5-5").is_some());
        assert!(m.row("claude-opus-4-8").is_none(), "a disabled row is not selectable");
        // the inner response alone reads the same
        assert_eq!(parse(&answer(json!([]))["response"]), Some(Models { rows: vec![], identity: Some("someone@example.com".into()) }));
    }

    /// No list is no knowledge: an older CLI, an error answer, or a CLI pointed at another provider.
    #[test]
    fn an_answer_without_a_list_is_unknown() {
        assert_eq!(parse(&json!({ "subtype": "success", "response": { "commands": [] } })), None);
        assert_eq!(parse(&json!({ "subtype": "error", "error": "no" })), None);
        assert_eq!(parse(&json!({ "response": { "models": "nope" } })), None);
        let mut gateway = answer(json!([{ "value": "claude-mythos-5-2" }]));
        gateway["response"]["account"]["apiProvider"] = json!("gateway");
        assert_eq!(parse(&gateway), None, "another provider's list is not this login's");
    }

    /// Plan test 4: the exact id only. A longer id, a label or the family name offers nothing; the `[1m]` form does.
    #[test]
    fn mythos_is_matched_by_its_exact_id_only() {
        let listed = |rows: Value| parse(&answer(rows)).unwrap().tier_row(mythos()).is_some();
        assert!(listed(json!([{ "value": "claude-mythos-5-2" }])));
        assert!(listed(json!([{ "value": "claude-mythos-5-2[1m]" }])));
        assert!(listed(json!([{ "value": "Claude-Mythos-5-2[1M]" }])));
        assert!(listed(json!([{ "value": "default", "resolvedModel": "claude-mythos-5-2" }])));
        assert!(listed(json!([{ "value": "best", "resolvedModel": "claude-mythos-5-2[1m]" }])));
        // an older version's exact id is the tier's own id too
        assert!(listed(json!([{ "value": "claude-mythos-5-1" }])));
        assert!(listed(json!([{ "value": "claude-mythos-5" }])));
        for other in ["claude-mythos-5-2-foo", "claude-mythos-5-20", "claude-mythos", "mythos", "Mythos", "Claude Mythos 5.2",
                      "claude-mythos-preview", "claude-fable-5-2", "us.anthropic.claude-mythos-5-2", "claude-mythos-5-2[2m]"] {
            assert!(!listed(json!([{ "value": other }])), "{other}");
        }
        assert!(!listed(json!([{ "value": "fable", "resolvedModel": "claude-fable-5-2", "displayName": "Mythos",
                                 "description": "claude-mythos-5-2" }])), "a label is not an id");
        assert!(!listed(json!([])));
        // the newest listed id is the row taken
        let both = parse(&answer(json!([{ "value": "claude-mythos-5-1" }, { "value": "claude-mythos-5-2", "supportsFastMode": true }]))).unwrap();
        assert_eq!(both.tier_row(mythos()).map(|r| r.value.as_str()), Some("claude-mythos-5-2"));
    }

    #[test]
    fn the_marker_is_the_only_thing_set_aside() {
        assert_eq!(base("claude-mythos-5-2[1m]"), "claude-mythos-5-2");
        assert_eq!(base(" claude-mythos-5-2[1M] "), "claude-mythos-5-2");
        assert_eq!(base("claude-mythos-5-2"), "claude-mythos-5-2");
        assert_eq!(base("[1m]"), "");
        assert_eq!(base("é"), "é");
    }

    /// Plan test 9: a Mythos turn that reports another model ends with the reason; other tiers are never judged.
    #[test]
    fn a_mythos_turn_served_by_another_model_is_refused() {
        let why = substituted("claude-mythos-5-2", "claude-fable-5-2").expect("another model");
        assert!(why.contains("serving claude-fable-5-2, not claude-mythos-5-2"), "{why}");
        assert!(substituted("claude-mythos-5-2[1m]", "claude-opus-5-5[1m]").is_some());
        assert!(substituted("claude-mythos-5-1", "claude-mythos-5-2").is_some(), "another version is another model");
        assert!(substituted("claude-mythos-5-2", "claude-mythos-5-20").is_some());
        // the model asked for, in the forms the CLI may report it
        for served in ["claude-mythos-5-2", "claude-mythos-5-2[1m]", "Claude-Mythos-5-2", "claude-mythos-5-2-20261101", ""] {
            assert_eq!(substituted("claude-mythos-5-2", served), None, "{served}");
        }
        assert_eq!(substituted("claude-mythos-5-2[1m]", "claude-mythos-5-2"), None);
        // only a conditional Claude model is judged: every other seat is as before
        assert_eq!(substituted("claude-fable-5-2", "claude-opus-5-5"), None);
        assert_eq!(substituted("anthropic/claude-sonnet-5", "claude-sonnet-5-5"), None);
        assert_eq!(substituted("", "claude-opus-5-5"), None);
    }

    /// Plan test 6: a list is used only for the sign-in it was read under.
    #[test]
    fn a_list_knows_the_sign_in_it_was_read_under() {
        let m = parse(&answer(json!([]))).unwrap();
        assert!(m.read_under(Some("someone@example.com")) && m.read_under(Some("SOMEONE@example.com ")));
        assert!(!m.read_under(Some("other@example.com")));
        assert!(m.read_under(None) && m.read_under(Some("")), "an unknown login email does not contradict");
        assert!(Models::default().read_under(Some("other@example.com")), "nor does a list with no email");
    }
}
