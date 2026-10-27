//! `GET /api/orgs/{slug}/mention-candidates`: the @ menu's bounded read
//! (domain/mention_candidates.rs). `kinds` is a comma list of item, doc, app
//! and panel (all four when omitted), `q` the typed text, `after` the
//! next_cursor of the page before, `limit` 1-50 (20). A read: it changes
//! nothing but the mention times it learns from new mail.
use std::sync::Arc;
use axum::{extract::{Path, Query, State}, Json};
use serde::Deserialize;
use serde_json::Value;
use crate::{domain::mention_candidates as mc, engine::Engine};
use super::{error::{ApiError, ApiResult}, orgs::org};

#[derive(Deserialize)]
pub struct Page {
    #[serde(default)] kinds: Option<String>,
    #[serde(default)] q: Option<String>,
    #[serde(default)] after: Option<String>,
    #[serde(default)] limit: Option<i64>,
}

#[nolog]
pub(crate) fn ask(q: &Page) -> Result<mc::Ask, ApiError> {
    let kinds: Vec<String> = match q.kinds.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        None => mc::KINDS.iter().map(|k| k.to_string()).collect(),
        Some(raw) => raw.split(',').map(|k| k.trim().to_string()).collect(),
    };
    if kinds.is_empty() || kinds.len() > mc::KINDS.len() || kinds.iter().any(|k| !mc::KINDS.contains(&k.as_str())) {
        return Err(ApiError::bad_request("kinds is a comma list of item, doc, app and panel"));
    }
    let text = q.q.as_deref().unwrap_or("");
    if text.len() > 200 { return Err(ApiError::bad_request("the typed text is limited to 200 bytes")); }
    let after = match q.after.as_deref() {
        None | Some("") => None,
        Some(raw) => Some(mc::Cursor::decode(raw).ok_or_else(|| ApiError::bad_request("invalid mention cursor"))?),
    };
    let limit = q.limit.unwrap_or(20);
    if !(1..=mc::LIMIT_MAX).contains(&limit) { return Err(ApiError::bad_request(format!("limit is 1-{}", mc::LIMIT_MAX))); }
    Ok(mc::Ask { kinds, words: mc::words(text), after, limit })
}

#[nolog]
pub async fn page(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Query(q): Query<Page>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let ask = ask(&q)?;
    let mut client = e.db.get().await?;
    mc::catch_up(&mut client).await?;
    Ok(Json(mc::page(&client, o.id, &ask).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn page(kinds: Option<&str>, q: Option<&str>, after: Option<&str>, limit: Option<i64>) -> Page {
        Page { kinds: kinds.map(str::to_owned), q: q.map(str::to_owned), after: after.map(str::to_owned), limit }
    }
    #[test]
    fn the_read_asks_known_kinds_bounded_text_a_valid_cursor_and_a_small_page() {
        let all = ask(&page(None, Some("Caption board"), None, None)).ok().unwrap();
        assert_eq!((all.kinds.len(), all.words.clone(), all.limit), (4, vec!["caption".to_string(), "board".into()], 20));
        assert_eq!(ask(&page(Some("doc, app"), None, None, Some(50))).ok().unwrap().kinds, vec!["doc", "app"]);
        for bad in [page(Some("agent"), None, None, None), page(Some("doc,"), None, None, None), page(None, Some(&"x".repeat(201)), None, None),
            page(None, None, Some("[1]"), None), page(None, None, None, Some(0)), page(None, None, None, Some(51))] {
            assert!(ask(&bad).is_err());
        }
        let cursor = mc::Cursor { at_ms: 5, label: "a".into(), kind: "doc".into(), id: "a".into() }.encode();
        assert!(ask(&page(None, None, Some(&cursor), None)).ok().unwrap().after.is_some());
    }
}
