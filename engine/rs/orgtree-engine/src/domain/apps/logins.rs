//! Saved logins for apps (USER 2026-11-11 m27cc41f6b6d1; spec section 4). One login per app and exact site: a
//! bearer token or one header. The engine seals it (AES-256-GCM, the watchdog-credentials key, an AAD that names
//! org, app and site), attaches it to that site's requests and relays, and never shows it to app code, agents,
//! panel state, exports, history, logs or any desktop response after the save. The desktop learns only
//! `{site, kind, set_at}`.
use anyhow::Result;
use serde_json::{json, Value};

/// A value is at most 8 KiB with no control characters (spec 4.1).
pub const VALUE_MAX: usize = 8 * 1024;
const AAD_PREFIX: &str = "orgtree-app-credentials-v1:";

#[derive(Clone, PartialEq, Eq)]
pub enum Kind {
    Bearer,
    Header,
}
impl Kind {
    #[nolog]
    pub fn as_str(&self) -> &'static str {
        match self {
            Kind::Bearer => "bearer",
            Kind::Header => "header",
        }
    }
}
/// The secret itself. Debug and Display never print it.
#[derive(Clone, PartialEq, Eq)]
pub struct Login {
    pub kind: Kind,
    /// The header name, for `Kind::Header`.
    pub name: Option<String>,
    pub value: String,
}
impl std::fmt::Debug for Login {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Login({}, *****)", self.kind.as_str())
    }
}

/// Check what the user typed. A header name must be a plain token that apps may set (`header_forbidden` also
/// refuses Cookie, Host, User-Agent and the hop-by-hop set).
#[nolog]
pub fn validate(kind: &str, name: Option<&str>, value: &str) -> Result<Login> {
    let kind = match kind {
        "bearer" => Kind::Bearer,
        "header" => Kind::Header,
        _ => crate::refuse!(BadRequest, "a saved login is a bearer token or one header"),
    };
    if value.is_empty() || value.len() > VALUE_MAX || value.chars().any(char::is_control) {
        crate::refuse!(BadRequest, "a saved login value is 1 to 8192 characters without control characters");
    }
    let name = match (&kind, name) {
        (Kind::Bearer, None) => None,
        (Kind::Bearer, Some(_)) => crate::refuse!(BadRequest, "a bearer token has no header name"),
        (Kind::Header, Some(n)) => {
            if n.is_empty()
                || n.len() > 128
                || !n.chars().all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c))
            {
                crate::refuse!(BadRequest, "invalid saved login header name");
            }
            if super::net::header_forbidden(n) {
                crate::refuse!(Forbidden, "a saved login may not use the {n} header");
            }
            Some(n.to_owned())
        }
        (Kind::Header, None) => crate::refuse!(BadRequest, "a header login needs a header name"),
    };
    Ok(Login { kind, name, value: value.to_owned() })
}

impl Login {
    /// The one header the engine attaches.
    #[nolog]
    pub fn header(&self) -> (String, String) {
        match self.kind {
            Kind::Bearer => ("Authorization".into(), format!("Bearer {}", self.value)),
            Kind::Header => (self.name.clone().unwrap_or_default(), self.value.clone()),
        }
    }
    /// Set on a request, replacing any header of the same name the app set (case-insensitive).
    #[nolog]
    pub fn apply(&self, headers: &mut Vec<(String, String)>) {
        let (name, value) = self.header();
        headers.retain(|(n, _)| !n.eq_ignore_ascii_case(&name));
        headers.push((name, value));
    }
    #[nolog]
    fn plain(&self) -> Vec<u8> {
        json!({"kind":self.kind.as_str(),"name":self.name,"value":self.value}).to_string().into_bytes()
    }
    #[nolog]
    fn from_plain(bytes: &[u8]) -> Result<Login> {
        let v: Value = serde_json::from_slice(bytes)?;
        validate(v["kind"].as_str().unwrap_or_default(), v["name"].as_str(), v["value"].as_str().unwrap_or_default())
    }
}

/// What a sealed login is bound to: a row moved to another app or site does not open.
#[nolog]
pub fn aad(org: i64, app: &str, site: &str) -> Vec<u8> {
    format!("{AAD_PREFIX}{org}:{app}:{site}").into_bytes()
}
#[nolog]
pub fn seal(key: &crate::mqtt::seal::Key, org: i64, app: &str, site: &str, login: &Login) -> Result<Vec<u8>> {
    crate::mqtt::seal::seal_with_aad(key, &aad(org, app, site), &login.plain())
        .map_err(|e| crate::domain::user_err(crate::domain::UserError::Unprocessable, format!("the saved login cannot be stored: {e}")))
}
#[nolog]
pub fn open(key: &crate::mqtt::seal::Key, org: i64, app: &str, site: &str, sealed: &[u8]) -> Result<Login> {
    let plain = crate::mqtt::seal::unseal_with_aad(key, &aad(org, app, site), sealed)
        .map_err(|e| crate::domain::user_err(crate::domain::UserError::Unprocessable, e))?;
    Login::from_plain(&plain)
}
/// The only form the desktop ever sees (spec 4.2).
#[nolog]
pub fn shown(site: &str, kind: &str, set_at: &str) -> Value {
    json!({"site":site,"kind":kind,"set_at":set_at})
}
/// Whether a stored row lets a login be saved or used: the exact site has an Allow or a private-network Allow.
#[nolog]
pub fn site_allows_login(app: &Value, site: &str) -> bool {
    matches!(super::policy::row_value(&app["site_permissions"][site]), Some("allow" | "allow-private"))
        && super::policy::private_row_ok(app, site).is_ok()
}

#[cfg(test)]
#[path = "logins_tests.rs"]
mod tests;
