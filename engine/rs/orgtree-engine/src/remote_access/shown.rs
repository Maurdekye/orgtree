//! What a computer that was let in is shown of the owner
//! (docs/rust-engine/remote-org.md, "What a member is sent").
//!
//! Two rules, and one place that applies each:
//!
//! - **The owner's e-mail addresses are not shown.** Every JSON answer and
//!   every pushed frame a member is sent passes `hide`. A text that *is* one
//!   of the addresses this engine knows its accounts by is replaced (by the
//!   account's id, so a picker still tells accounts apart; a member called
//!   `email` becomes null). A text that merely contains an address is content
//!   of the organization and is left as it is.
//! - **An app-wide answer names nothing of another organization, and holds no
//!   address at all.** For those (`app_wide`), every member called `email` is
//!   nulled whatever it holds, a text that has the shape of an address is
//!   replaced whether this engine knows it or not, and the members that say
//!   where else an account is used are removed. One of them, `bound`, is a
//!   list every app reads: it is sent empty, with `bound_hidden: true`.
//!
//! This keeps addresses out of lists. It is not a wall: a computer that may
//! run the organization's agents on the hosting computer can learn whose
//! account they run under. The security notes say so.

use serde_json::Value;

use crate::engine::Engine;

/// Members of an app-wide answer that say where else something of the owner's is used.
const ELSEWHERE: &[&str] = &["bound", "origin_org", "host_identity"];
/// The member that lists the agents an account is used by, and the one a member is sent with it emptied.
const USES: &str = "bound";
const USES_HIDDEN: &str = "bound_hidden";
/// Members by which a row names the account it is about.
const ACCOUNT_KEYS: &[&str] = &["id", "account", "account_id", "value"];

/// The addresses this engine knows the owner's accounts by, each with what stands in for it.
#[derive(Default)]
pub struct Owner {
    emails: Vec<(String, String)>,
    accounts: Vec<String>,
}

#[nolog]
impl Owner {
    /// From the registered accounts, and from the sign-ins the provider CLIs report.
    pub fn of(engine: &Engine) -> Owner {
        let mut owner = Owner::default();
        let view = engine.accounts.view();
        for account in view.all() {
            owner.accounts.push(account.id.clone());
            if let Some(email) = account.email.as_deref() {
                owner.add(email, &account.id);
            }
        }
        let providers = engine.providers.state.load();
        for (name, status) in [("claude", &providers.claude), ("codex", &providers.codex), ("antigravity", &providers.agy), ("muse", &providers.muse)] {
            if let Some(email) = status.email.as_deref() {
                owner.add(email, name);
            }
        }
        owner
    }

    /// An owner known by these addresses (tests).
    #[cfg(test)]
    pub fn known(emails: &[(&str, &str)]) -> Owner {
        let mut owner = Owner::default();
        for (email, account) in emails {
            owner.accounts.push(account.to_string());
            owner.add(email, account);
        }
        owner
    }

    fn add(&mut self, email: &str, stand_in: &str) {
        let email = email.trim();
        // only what is an address: a label a CLI reported in its place is not
        if email.contains('@') && !email.contains(char::is_whitespace) && !self.emails.iter().any(|(known, _)| known.eq_ignore_ascii_case(email)) {
            self.emails.push((email.to_string(), stand_in.to_string()));
        }
    }

    /// Does the text hold one of the addresses, as it is written here? The quick question
    /// before a frame is parsed at all.
    pub fn occurs_in(&self, text: &str) -> bool {
        self.emails.iter().any(|(email, _)| text.contains(email.as_str()))
    }

    /// What stands in for `text` when it is one of the addresses.
    fn stand_in(&self, text: &str, near: Option<&str>) -> Option<String> {
        let text = text.trim();
        let (_, account) = self.emails.iter().find(|(email, _)| email.eq_ignore_ascii_case(text))?;
        Some(near.unwrap_or(account).to_string())
    }

    fn is_account(&self, id: &str) -> bool {
        self.accounts.iter().any(|account| account == id)
    }
}

/// Has the whole text the shape of an e-mail address (`someone@host.tld`)? A mention
/// (`@lead`) and a hub address (`@net:...`) start with the sign and are not one.
#[nolog]
fn address_like(text: &str) -> bool {
    let text = text.trim();
    let mut parts = text.split('@');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(name), Some(host), None) => !name.is_empty() && !text.contains(char::is_whitespace) && host.contains('.') && !host.starts_with('.') && !host.ends_with('.'),
        _ => false,
    }
}

/// What stands in for a text of an app-wide answer that is an address this engine does not know.
const SOME_ACCOUNT: &str = "account";

/// Take out of `value` what a member is not shown (the module's two rules).
#[nolog]
pub fn hide(value: &mut Value, owner: &Owner, app_wide: bool) {
    walk(value, owner, app_wide, None);
}

#[nolog]
fn walk(value: &mut Value, owner: &Owner, app_wide: bool, near: Option<&str>) {
    match value {
        Value::Object(map) => {
            if app_wide {
                for key in ELSEWHERE {
                    // the list of an account's uses stays a list, empty, beside the word that it is not
                    // shown: an app made before 4.7.0 reads `bound.length` of every row and fails on a
                    // row without it (report 2026-11-24), and an empty list alone would say "unused"
                    if map.remove(*key).is_some() && *key == USES {
                        map.insert(USES.to_string(), Value::Array(Vec::new()));
                        map.insert(USES_HIDDEN.to_string(), Value::Bool(true));
                    }
                }
            }
            // the account a row is about stands in for its address, so two accounts stay two
            let here: Option<String> = ACCOUNT_KEYS.iter().find_map(|key| map.get(*key).and_then(Value::as_str)).filter(|id| owner.is_account(id)).map(str::to_string);
            let near = here.as_deref().or(near);
            for (key, member) in map.iter_mut() {
                match member {
                    Value::String(text) if key == "email" => {
                        if app_wide || owner.stand_in(text, None).is_some() {
                            *member = Value::Null;
                        }
                    }
                    Value::String(text) => {
                        if let Some(stand_in) = owner.stand_in(text, near) {
                            *member = Value::String(stand_in);
                        } else if app_wide && address_like(text) {
                            *member = Value::String(near.unwrap_or(SOME_ACCOUNT).to_string());
                        }
                    }
                    other => walk(other, owner, app_wide, near),
                }
            }
        }
        Value::Array(items) => {
            for item in items.iter_mut() {
                match item {
                    Value::String(text) => {
                        if let Some(stand_in) = owner.stand_in(text, near) {
                            *item = Value::String(stand_in);
                        } else if app_wide && address_like(text) {
                            *item = Value::String(near.unwrap_or(SOME_ACCOUNT).to_string());
                        }
                    }
                    other => walk(other, owner, app_wide, near),
                }
            }
        }
        _ => {}
    }
}

/// A JSON text as a member is sent it, or `None` when it goes as it is. An app-wide text is
/// always looked through; an organization's only when it holds one of the addresses.
#[nolog]
pub fn hide_text(text: &str, owner: &Owner, app_wide: bool) -> Option<String> {
    if !app_wide && !owner.occurs_in(text) {
        return None;
    }
    let mut value: Value = serde_json::from_str(text).ok()?;
    let before = value.clone();
    hide(&mut value, owner, app_wide);
    (value != before).then(|| value.to_string())
}

/// Is this path an app-wide one (anything that is not an organization's)?
#[nolog]
pub fn app_wide(path: &str) -> bool {
    crate::remote::routes::org_of(path).is_none()
}

/// The answer to a member's request, as the member is sent it: a JSON body passes `hide`.
/// Anything else (a file, a stream, an upgrade) goes as it is.
#[nolog]
pub async fn answer(engine: &Engine, path: &str, response: axum::response::Response) -> axum::response::Response {
    use axum::http::header::{CONTENT_LENGTH, CONTENT_TYPE};
    let json = response.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|ct| ct.starts_with("application/json"));
    if !json || response.status() == axum::http::StatusCode::SWITCHING_PROTOCOLS {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap_or_default();
    let shown = std::str::from_utf8(&bytes).ok().and_then(|text| hide_text(text, &Owner::of(engine), app_wide(path)));
    match shown {
        Some(text) => {
            parts.headers.remove(CONTENT_LENGTH);
            axum::response::Response::from_parts(parts, axum::body::Body::from(text))
        }
        None => axum::response::Response::from_parts(parts, axum::body::Body::from(bytes)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn owner() -> Owner {
        Owner::known(&[("sam@example.com", "claude-1"), ("sam@example.com", "openai-1"), ("other@example.org", "claude-2")])
    }

    #[test]
    fn an_address_that_is_the_whole_text_is_replaced_and_one_inside_a_text_is_content() {
        let mut org = json!({
            "accounts": [{ "id": "openai-1", "label": "sam@example.com", "email": "sam@example.com" },
                         { "value": "claude-2", "label": " Other@Example.org ", "email": "other@example.org", "nested": { "label": "other@example.org" } },
                         { "id": "key-9", "label": "not an account of the owner's", "email": "someone@else.example" }],
            "labels": ["sam@example.com", "plain"],
            "transcript": "write to sam@example.com about it",
            "mail": { "from": "@user", "body": "sam@example.com" },
        });
        hide(&mut org, &owner(), false);
        assert_eq!(org["accounts"][0], json!({ "id": "openai-1", "label": "openai-1", "email": null }), "the row's own account stands in");
        assert_eq!(org["accounts"][1], json!({ "value": "claude-2", "label": "claude-2", "email": null, "nested": { "label": "claude-2" } }));
        assert_eq!(org["accounts"][2]["email"], "someone@else.example", "an address that is not the owner's is the organization's own data");
        assert_eq!(org["labels"], json!(["claude-1", "plain"]), "with no account near, the first account of that address");
        assert_eq!(org["transcript"], "write to sam@example.com about it", "content is not rewritten");
        assert_eq!(org["mail"]["body"], "claude-1", "a text that is nothing but the address is");
    }

    #[test]
    fn an_app_wide_answer_holds_no_email_member_and_nothing_of_where_else_an_account_is_used() {
        let mut list = json!({
            "accounts": [{ "id": "claude-1", "identity": { "email": "sam@example.com" }, "label": "sam@example.com", "origin_org": "secret-org",
                           "bound": [{ "org": "secret-org", "agent": "lead" }] }],
            "host_identity": { "claude": { "email": "unknown-to-the-list@example.net" } },
            "providers": { "claude": { "email": "unknown-to-the-list@example.net", "connected": true } },
        });
        hide(&mut list, &owner(), true);
        let text = list.to_string();
        assert!(!text.contains('@') && !text.contains("secret-org") && !text.contains("lead"), "{text}");
        // an address this engine does not know is still not shown by an app-wide answer; a mention is no address
        let mut more = json!({ "rows": [{ "id": "claude-1", "label": "new.sign-in@example.net" }, { "label": "someone@example.net" }, { "label": "@lead" },
                               { "label": "@net:hub.example" }, { "label": "two words@example.net" }, { "label": "a@b" }], "names": ["x@y.zz"] });
        hide(&mut more, &owner(), true);
        assert_eq!(more, json!({ "rows": [{ "id": "claude-1", "label": "claude-1" }, { "label": "account" }, { "label": "@lead" },
                               { "label": "@net:hub.example" }, { "label": "two words@example.net" }, { "label": "a@b" }], "names": ["account"] }));
        // the list of where an account is used stays a list, empty, and the row says it is not shown:
        // an app that expects the member (4.6.x reads `bound.length` of every row) is not broken by its absence
        assert_eq!(list["accounts"][0], json!({ "id": "claude-1", "identity": { "email": null }, "label": "claude-1", "bound": [], "bound_hidden": true }));
        assert!(list.get("host_identity").is_none());
        // a row that named no use gains no such member, and one that is no list is not kept as it was
        let mut rows = json!({ "accounts": [{ "id": "claude-1" }, { "id": "claude-2", "bound": "secret-org" }] });
        hide(&mut rows, &owner(), true);
        assert_eq!(rows, json!({ "accounts": [{ "id": "claude-1" }, { "id": "claude-2", "bound": [], "bound_hidden": true }] }));
        // an organization's own answer is not an app-wide one: its members stay
        let mut own = json!({ "bound": [{ "org": "galaxy" }] });
        hide(&mut own, &owner(), false);
        assert_eq!(own, json!({ "bound": [{ "org": "galaxy" }] }));
        assert_eq!(list["providers"]["claude"], json!({ "email": null, "connected": true }));
    }

    #[test]
    fn a_text_goes_as_it_is_unless_it_holds_an_address() {
        let owner = owner();
        assert!(hide_text(r#"{"type":"tool","text":"nothing here"}"#, &owner, false).is_none(), "not parsed at all");
        assert!(hide_text(r#"{"text":"about sam@example.com, in a sentence"}"#, &owner, false).is_none(), "parsed, and left");
        assert_eq!(hide_text(r#"{"label":"sam@example.com"}"#, &owner, false).as_deref(), Some(r#"{"label":"claude-1"}"#));
        assert_eq!(hide_text(r#"{"email":"x@y.z"}"#, &owner, true).as_deref(), Some(r#"{"email":null}"#));
        assert!(hide_text("not json sam@example.com", &owner, false).is_none());
        assert!(app_wide("/api/accounts") && app_wide("/api/app/records") && !app_wide("/api/orgs/galaxy/staffing-options"));
        // a label a CLI reports where an address would be is not taken for one
        let mut odd = Owner::default();
        odd.add("Signed in", "claude");
        odd.add("two words@example.com", "claude");
        assert!(odd.emails.is_empty());
    }

    async fn body_of(response: axum::response::Response) -> (Option<String>, String) {
        let length = response.headers().get(axum::http::header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).map(str::to_string);
        (length, String::from_utf8(axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec()).unwrap())
    }

    #[tokio::test]
    async fn an_answer_passes_the_filter_when_it_is_json_and_goes_as_it_is_otherwise() {
        use axum::response::IntoResponse;
        let root = std::env::temp_dir().join(format!("orgtree-shown-{}", uuid::Uuid::new_v4()));
        let engine = Engine::for_tests(root);
        crate::providers::set_agy_email(&engine, "sam@example.com");
        let json = || axum::Json(json!({ "accounts": [{ "id": "a", "label": "sam@example.com", "email": "x@y.zz", "bound": [1] }], "note": "ask sam@example.com" })).into_response();
        // an app-wide answer: no address at all, nothing of where else
        let (length, body) = body_of(answer(&engine, "/api/accounts", json()).await).await;
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), json!({ "accounts": [{ "id": "a", "label": "antigravity", "email": null }], "note": "ask sam@example.com" }));
        assert!(length.as_ref().is_none_or(|length| *length == body.len().to_string()), "the length is the new body's: {length:?}");
        // an organization's answer: the owner's address where it is the whole text, and nothing else
        let (_, body) = body_of(answer(&engine, "/api/orgs/galaxy/staffing-options", json()).await).await;
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap(),
            json!({ "accounts": [{ "id": "a", "label": "antigravity", "email": "x@y.zz", "bound": [1] }], "note": "ask sam@example.com" }));
        // an answer that holds nothing to hide is not rewritten: byte for byte
        let plain = r#"{ "kept":   "as written" }"#;
        let response = ([(axum::http::header::CONTENT_TYPE, "application/json")], plain).into_response();
        assert_eq!(body_of(answer(&engine, "/api/orgs/galaxy/records", response).await).await.1, plain);
        // what is not JSON goes as it is, an address in it too
        let file = ([(axum::http::header::CONTENT_TYPE, "text/plain")], "sam@example.com").into_response();
        assert_eq!(body_of(answer(&engine, "/api/orgs/galaxy/nodes/1/file", file).await).await.1, "sam@example.com");
    }
}
