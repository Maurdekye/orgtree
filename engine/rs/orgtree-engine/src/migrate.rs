//! Embedded schema migrations, applied in order at start, one transaction
//! each. An applied migration whose text changed is refused (drift).

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use tokio_postgres::Client;

const MIGRATIONS: &[(&str, &str)] = &[
    ("0001_init", include_str!("../migrations/0001_init.sql")),
    ("0002_turn_sent", include_str!("../migrations/0002_turn_sent.sql")),
    ("0003_net", include_str!("../migrations/0003_net.sql")),
    ("0004_tool_images", include_str!("../migrations/0004_tool_images.sql")),
    ("0005_no_done_status", include_str!("../migrations/0005_no_done_status.sql")),
    ("0006_document_bundles", include_str!("../migrations/0006_document_bundles.sql")),
    ("0007_account_references", include_str!("../migrations/0007_account_references.sql")),
    ("0008_usage_history", include_str!("../migrations/0008_usage_history.sql")),
    ("0009_tool_inputs", include_str!("../migrations/0009_tool_inputs.sql")),
    ("0010_mail_receipts", include_str!("../migrations/0010_mail_receipts.sql")),
    ("0011_notification_attention", include_str!("../migrations/0011_notification_attention.sql")),
    ("0012_account_origin_and_mark_audit", include_str!("../migrations/0012_account_origin_and_mark_audit.sql")),
    ("0013_hub_mail_parity", include_str!("../migrations/0013_hub_mail_parity.sql")),
    ("0014_org_inbox_reply_to", include_str!("../migrations/0014_org_inbox_reply_to.sql")),
    ("0015_mail_conversation", include_str!("../migrations/0015_mail_conversation.sql")),
];

#[logged]
fn checksum(sql: &str) -> String {
    // line endings normalised so a CRLF checkout hashes like an LF one
    let normalised = sql.replace("\r\n", "\n");
    hex::encode(Sha256::digest(normalised.as_bytes()))
}

#[logged]
pub async fn run(client: &mut Client, progress: &dyn Fn(&str)) -> Result<()> {
    client
        .batch_execute(
            "CREATE TABLE IF NOT EXISTS public.ot_migrations (
               name text PRIMARY KEY,
               checksum text NOT NULL,
               applied_at timestamptz NOT NULL DEFAULT now())",
        )
        .await?;
    for (name, sql) in MIGRATIONS {
        let sum = checksum(sql);
        let row = client
            .query_opt("SELECT checksum FROM public.ot_migrations WHERE name = $1", &[name])
            .await?;
        match row {
            Some(r) => {
                let have: String = r.get(0);
                if have != sum {
                    bail!("migration {name} changed after it was applied (checksum drift)");
                }
            }
            None => {
                progress(&format!("database-migrate {name}"));
                let tx = client.transaction().await?;
                tx.batch_execute(sql).await.with_context(|| format!("migration {name} failed"))?;
                tx.execute(
                    "INSERT INTO public.ot_migrations (name, checksum) VALUES ($1, $2)",
                    &[name, &sum],
                )
                .await?;
                tx.commit().await?;
            }
        }
    }
    Ok(())
}
