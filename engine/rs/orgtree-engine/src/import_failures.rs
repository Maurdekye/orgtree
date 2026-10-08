//! Organizations a first-start import could not copy. Every importer (2.x,
//! 3.0/3.1, 3.2) copies an org all or nothing: a failed org leaves nothing
//! behind, its source is never changed, and the import is retried at every
//! start. The failure is kept in `ot.kv` (`import_failures`, one record per
//! source org) until that org imports, and the app feed carries the list to
//! the org list, which shows one line per failed org: an org whose import
//! rolled back has no inbox of its own to tell the user in.

use anyhow::Result;
use serde_json::{json, Value};
use tokio_postgres::Client;

use crate::engine::Engine;
use crate::util::{gist, now_iso};

const KEY: &str = "import_failures";

/// The source table (or step) an org import was copying when it failed:
/// added as the outermost context of the org's error, named in the log and
/// in the user's line.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Section(pub &'static str);

impl std::fmt::Display for Section {
    #[nolog]
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

/// The table named by a failed org import's error, if any.
#[logged]
pub(crate) fn section_of(e: &anyhow::Error) -> Option<&'static str> {
    e.downcast_ref::<Section>().map(|s| s.0)
}

/// One record per source org: `source` is "2.x", "3.0/3.1" or "3.2".
#[logged]
fn org_key(source: &str, slug: &str) -> String {
    format!("{source}:{slug}")
}

/// Keep (or refresh) a failed org's record: first and latest attempt, how
/// many starts it has failed on, the table and the error.
#[logged]
pub(crate) async fn record(dst: &Client, source: &str, slug: &str, name: Option<&str>, e: &anyhow::Error) {
    let rec = json!({
        "source": source, "org": slug, "name": name.unwrap_or(slug), "table": section_of(e),
        "error": gist(&format!("{e:#}"), 300), "at": now_iso(),
    });
    let res = dst
        .execute(
            "INSERT INTO ot.kv (key, value) VALUES ($1, jsonb_build_object($2::text, $3::jsonb || '{\"tries\": 1}'::jsonb || jsonb_build_object('first_at', $3::jsonb->'at')))
             ON CONFLICT (key) DO UPDATE SET value = ot.kv.value || jsonb_build_object($2::text,
                 $3::jsonb || jsonb_build_object('tries', coalesce((ot.kv.value->$2::text->>'tries')::int, 0) + 1,
                                                 'first_at', coalesce(ot.kv.value->$2::text->'first_at', $3::jsonb->'at'))),
               updated_at = now()",
            &[&KEY, &org_key(source, slug), &rec],
        )
        .await;
    if let Err(err) = res {
        tracing::warn!(org = %slug, error = %format!("{err:#}"), "could not record the import failure");
    }
}

/// The org imported (or was already there): its record goes.
#[logged]
pub(crate) async fn clear(dst: &Client, source: &str, slug: &str) {
    let res = dst
        .execute(
            "UPDATE ot.kv SET value = value - $2::text, updated_at = now() WHERE key = $1 AND value ? $2::text",
            &[&KEY, &org_key(source, slug)],
        )
        .await;
    if let Err(err) = res {
        tracing::warn!(org = %slug, error = %format!("{err:#}"), "could not clear the import failure record");
    }
}

/// Every org imported: no record is left.
#[logged]
pub(crate) async fn clear_all(dst: &Client) -> Result<()> {
    dst.execute("DELETE FROM ot.kv WHERE key = $1", &[&KEY]).await?;
    Ok(())
}

/// Put the failed orgs in the app feed (`import_failures`, oldest first).
#[logged]
pub async fn publish(engine: &Engine) {
    let list = match engine.db.get().await {
        Ok(c) => match c.query_opt("SELECT value FROM ot.kv WHERE key = $1", &[&KEY]).await {
            Ok(Some(row)) => {
                let v: Value = row.get(0);
                let mut items: Vec<Value> = v.as_object().map(|m| m.values().cloned().collect()).unwrap_or_default();
                items.sort_by(|a, b| a["first_at"].as_str().cmp(&b["first_at"].as_str()));
                items
            }
            Ok(None) => Vec::new(),
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "could not read the import failures");
                return;
            }
        },
        Err(e) => {
            tracing::warn!(error = %format!("{e:#}"), "could not read the import failures");
            return;
        }
    };
    if !list.is_empty() {
        tracing::warn!(orgs = list.len(), "organizations still not imported (shown in the org list)");
    }
    engine.app.set_value(KEY, Value::Array(list));
}
