//! Who a user action came through (docs/rust-engine/remote-org.md, "Several
//! people on one organization").
//!
//! Every connected desktop acts as the user. The engine that runs an
//! organization still knows which computer an action came through: the request
//! guard (`http::guard`) resolves the origin once, from the token that
//! authenticated the request, and runs the request inside `scope`. The places
//! that record a user action read it with `via`.
//!
//! Nothing reads an origin from a header or a body, so a page or a relayed
//! request cannot claim to be someone else. An origin has the user's authority
//! like every other: the name tells people apart and grants nothing.
//!
//! A user action recorded outside a request (another task, an import) has no
//! origin. That is "unknown", and it is shown as before this existed.

use std::future::Future;

use serde_json::{json, Value};

/// The origin id of the desktop this engine belongs to (the desktop token).
pub const LOCAL: &str = "local";
/// The origin id of a standalone engine's startup token.
pub const STARTUP: &str = "startup";
/// What the startup token is called where a name is shown.
pub const STARTUP_NAME: &str = "Startup token";
/// The longest label, in characters.
pub const LABEL_MAX: usize = 40;

/// Where a user action came through.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Origin {
    /// A client token's id, `local` or `startup`. Client ids are UUIDs, so the
    /// two words are never a client's.
    pub id: String,
    /// What other people see: the label as it is at this moment.
    pub name: String,
    /// The client token's name, when it says more than the label does
    /// ("Orgtree desktop (PC2)" beside the label "Sam").
    pub on: Option<String>,
}

#[logged]
impl Origin {
    /// This engine's own desktop, under the name it shows to others.
    #[nolog]
    pub fn local(name: &str) -> Origin {
        Origin { id: LOCAL.into(), name: name.into(), on: None }
    }

    /// A standalone engine's startup token.
    #[nolog]
    pub fn startup() -> Origin {
        Origin { id: STARTUP.into(), name: STARTUP_NAME.into(), on: None }
    }

    /// A named client token: `label` is what it chose to be called, if anything.
    #[nolog]
    pub fn client(id: &str, client_name: &str, label: Option<&str>) -> Origin {
        let name = label.map(str::to_string).unwrap_or_else(|| default_label(client_name));
        let on = (name != client_name).then(|| client_name.to_string());
        Origin { id: id.into(), name, on }
    }

    /// The origin as it is stored beside a record (`via`) and sent to windows:
    /// `{"id", "name"}` and `"on"` when there is one. The name is the label as
    /// it was then, so history stays readable after a rename or a revocation.
    #[nolog]
    pub fn json(&self) -> Value {
        let mut value = json!({ "id": self.id, "name": self.name });
        if let Some(on) = &self.on {
            value["on"] = json!(on);
        }
        value
    }
}

tokio::task_local! { static ORIGIN: Origin; }

/// Run `work` as a request that came through `origin`; `None` runs it as it is.
#[nolog]
pub async fn scope<F: Future>(origin: Option<Origin>, work: F) -> F::Output {
    match origin {
        Some(origin) => ORIGIN.scope(origin, work).await,
        None => work.await,
    }
}

/// The origin of the request this task serves, if it serves one.
#[nolog]
pub fn current() -> Option<Origin> {
    ORIGIN.try_with(Clone::clone).ok()
}

/// What a record of a user action stores as `via`: the current origin, or
/// nothing when the action came through no request.
#[nolog]
pub fn via() -> Option<Value> {
    ORIGIN.try_with(Origin::json).ok()
}

/// A label as it may be stored: trimmed, 1 to `LABEL_MAX` characters, no
/// control characters. `None` when `text` is not one.
#[nolog]
pub fn label(text: &str) -> Option<String> {
    let text = text.trim();
    let length = text.chars().count();
    (length >= 1 && length <= LABEL_MAX && !text.chars().any(char::is_control)).then(|| text.to_string())
}

/// What a client is called before anyone chose a label: the computer out of
/// "Orgtree desktop (<computer>)", else the client's own name, cut to a label's length.
#[nolog]
pub fn default_label(client_name: &str) -> String {
    let computer = client_name.strip_prefix("Orgtree desktop (").and_then(|rest| rest.strip_suffix(')')).map(str::trim).filter(|c| !c.is_empty());
    let cut: String = computer.unwrap_or(client_name.trim()).chars().take(LABEL_MAX).collect();
    cut.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_label_is_one_to_forty_printable_characters() {
        assert_eq!(label("  Sam "), Some("Sam".into()));
        assert_eq!(label(&"x".repeat(40)), Some("x".repeat(40)));
        assert_eq!(label(&"é".repeat(40)), Some("é".repeat(40)), "characters, not bytes");
        assert_eq!(label(&"x".repeat(41)), None);
        assert_eq!(label("   "), None);
        assert_eq!(label("a\nb"), None);
        assert_eq!(label("a\u{7}b"), None);
    }

    #[test]
    fn a_client_without_a_label_goes_by_its_computer_or_its_name() {
        assert_eq!(default_label("Orgtree desktop (PC2)"), "PC2");
        assert_eq!(default_label("Orgtree desktop ( )"), "Orgtree desktop ( )");
        assert_eq!(default_label("curl on the build box"), "curl on the build box");
        assert_eq!(default_label(&"n".repeat(100)).chars().count(), LABEL_MAX);
    }

    #[test]
    fn an_origin_says_where_it_is_from_only_when_that_adds_something() {
        let named = Origin::client("c-1", "Orgtree desktop (PC2)", Some("Sam"));
        assert_eq!(named.json(), json!({ "id": "c-1", "name": "Sam", "on": "Orgtree desktop (PC2)" }));
        let unnamed = Origin::client("c-2", "Orgtree desktop (PC2)", None);
        assert_eq!(unnamed.json(), json!({ "id": "c-2", "name": "PC2", "on": "Orgtree desktop (PC2)" }));
        let plain = Origin::client("c-3", "laptop", None);
        assert_eq!(plain.json(), json!({ "id": "c-3", "name": "laptop" }));
        assert_eq!(Origin::local("PC1").json(), json!({ "id": "local", "name": "PC1" }));
        assert_eq!(Origin::startup().json(), json!({ "id": "startup", "name": "Startup token" }));
    }

    #[tokio::test]
    async fn the_origin_is_the_one_of_the_request_this_task_serves() {
        assert_eq!(current(), None);
        assert_eq!(via(), None, "outside a request nothing is claimed");
        let sam = Origin::client("c-1", "Orgtree desktop (PC2)", Some("Sam"));
        let seen = scope(Some(sam.clone()), async {
            // a nested request-less scope leaves the origin alone
            let inner = scope(None, async { current() }).await;
            (current(), via(), inner)
        })
        .await;
        assert_eq!(seen.0, Some(sam.clone()));
        assert_eq!(seen.1, Some(sam.json()));
        assert_eq!(seen.2, Some(sam.clone()));
        // another task does not inherit it: what it records has no origin
        let other = scope(Some(sam), async { tokio::spawn(async { current() }).await.unwrap() }).await;
        assert_eq!(other, None);
        assert_eq!(current(), None);
    }
}
