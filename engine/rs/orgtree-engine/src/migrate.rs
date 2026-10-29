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
    ("0016_watchdog_slugs", include_str!("../migrations/0016_watchdog_slugs.sql")),
    ("0017_langserver_secrets", include_str!("../migrations/0017_langserver_secrets.sql")),
    ("0018_document_viewed", include_str!("../migrations/0018_document_viewed.sql")),
    ("0019_net_transfers", include_str!("../migrations/0019_net_transfers.sql")),
    ("0020_clear_legacy_limit_locks", include_str!("../migrations/0020_clear_legacy_limit_locks.sql")),
    ("0021_multi_replies", include_str!("../migrations/0021_multi_replies.sql")),
    ("0022_openrouter_numbered_keys", include_str!("../migrations/0022_openrouter_numbered_keys.sql")),
    ("0023_undo_history", include_str!("../migrations/0023_undo_history.sql")),
    ("0024_logo_undo", include_str!("../migrations/0024_logo_undo.sql")),
    ("0025_project_nodes", include_str!("../migrations/0025_project_nodes.sql")),
    ("0026_mail_tags", include_str!("../migrations/0026_mail_tags.sql")),
    ("0027_watchdog_schedule", include_str!("../migrations/0027_watchdog_schedule.sql")),
    ("0028_agy_thinking", include_str!("../migrations/0028_agy_thinking.sql")),
    ("0029_project_items_detach", include_str!("../migrations/0029_project_items_detach.sql")),
    ("0030_project_audiences", include_str!("../migrations/0030_project_audiences.sql")),
    ("0031_slot_leases", include_str!("../migrations/0031_slot_leases.sql")),
    ("0032_project_member_audiences", include_str!("../migrations/0032_project_member_audiences.sql")),
    ("0033_do_not_disturb", include_str!("../migrations/0033_do_not_disturb.sql")),
    ("0034_slot_queued_at", include_str!("../migrations/0034_slot_queued_at.sql")),
    ("0035_project_supervision", include_str!("../migrations/0035_project_supervision.sql")),
    ("0036_watchdog_secrets", include_str!("../migrations/0036_watchdog_secrets.sql")),
    ("0037_agent_reporting", include_str!("../migrations/0037_agent_reporting.sql")),
    ("0038_slot_history_paging", include_str!("../migrations/0038_slot_history_paging.sql")),
    ("0039_multi_slot_leases", include_str!("../migrations/0039_multi_slot_leases.sql")),
    ("0040_project_history", include_str!("../migrations/0040_project_history.sql")),
    ("0041_document_opening", include_str!("../migrations/0041_document_opening.sql")),
    ("0042_opencode_mail", include_str!("../migrations/0042_opencode_mail.sql")),
    ("0043_event_listeners_setting", include_str!("../migrations/0043_event_listeners_setting.sql")),
    ("0044_retired_pile_edges", include_str!("../migrations/0044_retired_pile_edges.sql")),
    ("0045_cheap_compact_default", include_str!("../migrations/0045_cheap_compact_default.sql")),
    ("0046_user_primitives", include_str!("../migrations/0046_user_primitives.sql")),
    ("0047_retired_picker", include_str!("../migrations/0047_retired_picker.sql")),
    ("0048_active_claim_holder", include_str!("../migrations/0048_active_claim_holder.sql")),
    ("0049_slot_capacity_digits", include_str!("../migrations/0049_slot_capacity_digits.sql")),
    ("0050_project_event_dispatch", include_str!("../migrations/0050_project_event_dispatch.sql")),
    ("0051_dead_letter_readers", include_str!("../migrations/0051_dead_letter_readers.sql")),
    ("0052_dnd_next_turn", include_str!("../migrations/0052_dnd_next_turn.sql")),
    ("0053_mention_navigation", include_str!("../migrations/0053_mention_navigation.sql")),
    ("0054_full_depth_superiors", include_str!("../migrations/0054_full_depth_superiors.sql")),
    ("0055_org_inbox_dnd", include_str!("../migrations/0055_org_inbox_dnd.sql")),
    ("0056_incomplete_response", include_str!("../migrations/0056_incomplete_response.sql")),
    ("0057_reminder_pages", include_str!("../migrations/0057_reminder_pages.sql")),
    ("0058_custom_apps", include_str!("../migrations/0058_custom_apps.sql")),
    ("0059_custom_panel_active", include_str!("../migrations/0059_custom_panel_active.sql")),
    ("0060_custom_app_permissions", include_str!("../migrations/0060_custom_app_permissions.sql")),
    ("0061_custom_apps_seen", include_str!("../migrations/0061_custom_apps_seen.sql")),
    ("0062_custom_app_event_declarations", include_str!("../migrations/0062_custom_app_event_declarations.sql")),
    ("0063_custom_app_event_delivery", include_str!("../migrations/0063_custom_app_event_delivery.sql")),

    ("0064_custom_app_file_access", include_str!("../migrations/0064_custom_app_file_access.sql")),
    ("0065_custom_app_file_modes", include_str!("../migrations/0065_custom_app_file_modes.sql")),
    ("0066_custom_app_origin_policy", include_str!("../migrations/0066_custom_app_origin_policy.sql")),
    ("0067_custom_panel_runtime", include_str!("../migrations/0067_custom_panel_runtime.sql")),
    ("0068_custom_app_links_and_screen_pins", include_str!("../migrations/0068_custom_app_links_and_screen_pins.sql")),
    ("0069_custom_panel_window_pins", include_str!("../migrations/0069_custom_panel_window_pins.sql")),
    ("0070_keep_panel_messages", include_str!("../migrations/0070_keep_panel_messages.sql")),
    ("0071_custom_panel_history", include_str!("../migrations/0071_custom_panel_history.sql")),
    ("0071a_restore_panel_messages", include_str!("../migrations/0071a_restore_panel_messages.sql")),
    ("0072_custom_app_internet_access", include_str!("../migrations/0072_custom_app_internet_access.sql")),
    ("0073_document_slugs", include_str!("../migrations/0073_document_slugs.sql")),
    ("0074_requested_document_slugs", include_str!("../migrations/0074_requested_document_slugs.sql")),
    ("0075_app_panel_slugs", include_str!("../migrations/0075_app_panel_slugs.sql")),
    ("0076_mention_recency", include_str!("../migrations/0076_mention_recency.sql")),
    ("0077_panel_event_bodies", include_str!("../migrations/0077_panel_event_bodies.sql")),
    ("0078_org_inbox_peer_recency", include_str!("../migrations/0078_org_inbox_peer_recency.sql")),
];

#[cfg(test)]
mod project_user_contact_tests;
#[cfg(test)]
mod document_slug_tests;
#[cfg(test)]
mod app_slug_tests;
#[cfg(test)]
mod mention_recency_tests;
#[cfg(test)]
mod fire_body_tests;
#[cfg(test)]
mod panel_message_tests;

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

#[cfg(test)]
mod numbered_keys_tests {
    /// Every OpenRouter key alike (user 2026-10-14): migration 0022 is
    /// registered, a no-op without the old row, and carries every reference.
    /// User 2026-10-26 md6edfebc1975 and mcbcd7b3cb6c0: panel History keeps only
    /// fired events and starts/stops, the old lifecycle rows are deleted on
    /// upgrade, and agent-to-app messages are kept apart from History.
    #[test]
    fn custom_apps_panel_history_migration_is_registered_and_complete() {
        let (_, sql) = super::MIGRATIONS.iter().find(|(n, _)| n.ends_with("_custom_panel_history")).expect("registered");
        for part in ["ADD COLUMN kind", "'panel.opened'", "'panel.created'", "'panel.changed'", "'panel.duplicated'", "'state.changed'",
                     "kind='message'", "'event.fired'", "'panel.started'", "'panel.stopped'"] {
            assert!(sql.contains(part), "the panel history migration does not carry {part}");
        }
    }
    #[test]
    fn openrouter_numbered_keys_migration_is_registered_guarded_and_complete() {
        let (_, sql) = super::MIGRATIONS.iter().find(|(n, _)| *n == "0022_openrouter_numbered_keys").expect("registered");
        assert!(sql.contains("IF NOT EXISTS (SELECT 1 FROM ot.accounts WHERE id = 'openrouter-key') THEN"));
        for part in ["ot.account_secrets", "ot.agents SET account", "pending_account", "pending_switch", "ot.turns",
                     "ot.usage_history", "ot.account_mark_audit", "ot.account_marks", "ot.account_spend",
                     "default_account", "disabled_accounts", "app_settings", "ot.removed_accounts"] {
            assert!(sql.contains(part), "migration 0022 does not carry {part}");
        }
    }
}
