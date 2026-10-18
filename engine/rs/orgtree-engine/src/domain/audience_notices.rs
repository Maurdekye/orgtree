//! Presentation of existing effective grants, never admission or grant mutation.
use super::audiences::EffectiveGrant;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug)]
pub(crate) struct AudienceHolder {
    pub name: String,
    pub grants: Vec<EffectiveGrant>,
}
pub(crate) type AudienceSnapshot = BTreeMap<i64, AudienceHolder>;

#[nolog]
pub(crate) fn inherited_pairs(held: &[EffectiveGrant]) -> BTreeSet<(String, String)> {
    held.iter()
        .filter_map(|g| {
            g.source_project
                .as_ref()
                .map(|p| (g.grantor.clone(), p.clone()))
        })
        .collect()
}

#[nolog]
fn mention(name: &str) -> String {
    if name.starts_with('@') {
        name.into()
    } else {
        format!("@{name}")
    }
}

#[nolog]
pub(crate) fn remaining_route(target: &str, held: &[EffectiveGrant]) -> String {
    let target_name = mention(target);
    let sources = inherited_pairs(held);
    let projects: Vec<_> = sources
        .iter()
        .filter(|(t, _)| t == target)
        .map(|(_, p)| mention(p))
        .collect();
    if !projects.is_empty() {
        format!(
            "You still reach {target_name} through project {}. This audience remains usable.",
            projects.join(", ")
        )
    } else if held
        .iter()
        .any(|g| g.grantor == target && g.source_project.is_none())
    {
        format!("You still reach {target_name} through an explicit grant.")
    } else {
        format!("No project-inherited audience with {target_name} remains. Normal hierarchy reach still applies; otherwise use your superior or request an audience.")
    }
}

#[nolog]
pub(crate) fn revoke_body(target: &str, by: &str, held: &[EffectiveGrant]) -> String {
    format!(
        "Your explicit audience with {} was rescinded by {}. {}",
        mention(target),
        mention(by),
        remaining_route(target, held)
    )
}

#[nolog]
pub(crate) fn inheritance_messages(
    before: &AudienceSnapshot,
    after: &AudienceSnapshot,
) -> Vec<(i64, String, String)> {
    let mut messages = Vec::new();
    for (id, current) in after {
        let old = before
            .get(id)
            .map(|h| inherited_pairs(&h.grants))
            .unwrap_or_default();
        let new = inherited_pairs(&current.grants);
        for (target, project) in old.difference(&new) {
            messages.push((
                *id,
                current.name.clone(),
                format!(
                    "Your inherited audience with {} through project {} has ended. {}",
                    mention(target),
                    mention(project),
                    remaining_route(target, &current.grants)
                ),
            ));
        }
        for (target, project) in new.difference(&old) {
            let actions = if target == "@user" {
                " You may mail the user (to=user), ask the user, present documents, and use other user-audience gates, subject to your tool permissions."
            } else {
                " You may use this audience just as an explicit grant, subject to your tool permissions."
            };
            messages.push((*id,current.name.clone(),format!("You now hold an audience with {} through project {}.{} This is inherited access, not a personal grant; only direct members inherit.",mention(target),mention(project),actions)));
        }
    }
    messages
}

#[nolog]
pub(crate) fn self_audiences(held: &[EffectiveGrant]) -> String {
    let routes: BTreeSet<_> = held
        .iter()
        .map(|g| {
            format!(
                "{} ({})",
                mention(&g.grantor),
                g.source_project
                    .as_ref()
                    .map(|p| format!("through project {}", mention(p)))
                    .unwrap_or_else(|| "explicit".into())
            )
        })
        .collect();
    format!("Your effective audiences: {}. Explicit and project-inherited routes are usable; revoking a personal grant does not remove an inherited route. Normal hierarchy reach still applies.",if routes.is_empty(){"none".into()}else{routes.into_iter().collect::<Vec<_>>().join("; ")})
}

// Current active grants only, scoped to one organization; no historical scan or locks.
const SNAPSHOT_SQL:&str="SELECT a.id,a.name,e.grantor,e.source_project FROM ot.agents a LEFT JOIN ot.effective_audiences e ON e.org_id=a.org_id AND e.grantee=a.name WHERE a.org_id=$1 AND a.state='live' AND a.kind='agent' ORDER BY a.id,e.grantor,e.source_project";

#[logged]
pub(crate) async fn snapshot(
    client: &impl tokio_postgres::GenericClient,
    org_id: i64,
) -> anyhow::Result<AudienceSnapshot> {
    let mut out = AudienceSnapshot::new();
    for row in client.query(SNAPSHOT_SQL, &[&org_id]).await? {
        let holder = out.entry(row.get(0)).or_insert_with(|| AudienceHolder {
            name: row.get(1),
            grants: Vec::new(),
        });
        if let Some(grantor) = row.get::<_, Option<String>>(2) {
            holder.grants.push(EffectiveGrant {
                grantor,
                source_project: row.get(3),
            });
        }
    }
    Ok(out)
}

#[logged]
pub(crate) async fn self_held(
    client: &impl tokio_postgres::GenericClient,
    org_id: i64,
    name: &str,
) -> anyhow::Result<Vec<EffectiveGrant>> {
    Ok(client.query("SELECT DISTINCT grantor,source_project FROM ot.effective_audiences WHERE org_id=$1 AND grantee=$2 ORDER BY grantor,source_project",&[&org_id,&name]).await?.iter().map(|r|EffectiveGrant{grantor:r.get(0),source_project:r.get(1)}).collect())
}

/// Called in the same transaction as the topology/grant change. Rollback/retry
/// rolls notices back too; the caller publishes mailbox changes after commit.
#[logged]
pub(crate) async fn record_delta_tx(
    client: &impl tokio_postgres::GenericClient,
    org_id: i64,
    before: &AudienceSnapshot,
    after: &AudienceSnapshot,
) -> anyhow::Result<Vec<i64>> {
    let mut recipients = BTreeSet::new();
    for (id, name, body) in inheritance_messages(before, after) {
        super::audiences::decision_notice_tx(client, org_id, &name, &body, true, None).await?;
        recipients.insert(id);
    }
    Ok(recipients.into_iter().collect())
}

#[nolog]
pub(crate) fn topology_changes_audiences(op: &str) -> bool {
    matches!(
        op,
        "hire"
            | "rehire"
            | "create_project"
            | "retire"
            | "rescind"
            | "dissolve"
            | "delete"
            | "move"
            | "moves"
            | "rename"
            | "configure_project"
            | "swap"
            | "self_subjugate"
    )
}

#[cfg(test)]
mod audience_notice_tests {
    use super::*;
    use serde_json::json;
    fn grant(target: &str, project: Option<&str>) -> EffectiveGrant {
        EffectiveGrant {
            grantor: target.into(),
            source_project: project.map(str::to_owned),
        }
    }
    fn snapshot(grants: Vec<EffectiveGrant>) -> AudienceSnapshot {
        BTreeMap::from([(
            7,
            AudienceHolder {
                name: "member".into(),
                grants,
            },
        )])
    }
    #[test]
    fn explicit_revoke_explains_remaining_project_user_route() {
        let body = revoke_body("@user", "@user", &[grant("@user", Some("team"))]);
        assert!(body.contains("explicit"));
        assert!(body.contains("still reach @user through project @team"));
    }
    #[test]
    fn final_revoke_explicitly_says_inherited_access_is_gone() {
        assert!(revoke_body("@user", "@user", &[]).contains("No project-inherited audience"));
    }
    #[test]
    fn typed_revoke_does_not_overwrite_remaining_project_access() {
        let ev = crate::events::audience_changed(
            "synthetic",
            "member",
            1,
            "rescinded",
            "@user",
            "@user",
            Some("team"),
        )
        .unwrap();
        let text = crate::runtime::event_text::render_agent(&ev).unwrap();
        assert!(text.contains("still reach @user through project @team"));
        assert!(!text.contains("fall back"));
    }
    #[test]
    fn project_grant_or_join_tells_member_once_with_usable_user_route() {
        let after = snapshot(vec![
            grant("@user", Some("team")),
            grant("@user", Some("team")),
        ]);
        let messages = inheritance_messages(&snapshot(vec![]), &after);
        assert_eq!(messages.len(), 1);
        assert_eq!((messages[0].0, messages[0].1.as_str()), (7, "member"));
        assert!(messages[0].2.contains("through project @team"));
        assert!(messages[0].2.contains("to=user"));
    }
    #[test]
    fn project_revoke_or_leave_tells_member_that_inherited_route_ended() {
        let before = snapshot(vec![grant("@user", Some("team"))]);
        let messages = inheritance_messages(&before, &snapshot(vec![]));
        assert_eq!(messages.len(), 1);
        assert!(messages[0].2.contains("through project @team has ended"));
        assert!(messages[0].2.contains("No project-inherited audience"));
    }
    #[test]
    fn ending_inheritance_preserves_explicit_route_in_notice() {
        let before = snapshot(vec![grant("expert", None), grant("expert", Some("team"))]);
        let after = snapshot(vec![grant("expert", None)]);
        let messages = inheritance_messages(&before, &after);
        assert_eq!(messages.len(), 1);
        assert!(messages[0]
            .2
            .contains("still reach @expert through an explicit grant"));
    }
    #[test]
    fn project_switch_names_both_the_ended_and_new_source() {
        let messages = inheritance_messages(
            &snapshot(vec![grant("expert", Some("old"))]),
            &snapshot(vec![grant("expert", Some("new"))]),
        );
        assert_eq!(messages.len(), 2);
        assert!(messages
            .iter()
            .any(|m| m.2.contains("project @old has ended")));
        assert!(messages
            .iter()
            .any(|m| m.2.contains("through project @new")));
    }
    #[test]
    fn self_visibility_lists_both_sources_and_deduplicates() {
        let text = self_audiences(&[
            grant("@user", Some("team")),
            grant("expert", None),
            grant("@user", Some("team")),
        ]);
        assert!(text.contains("@user (through project @team)"));
        assert!(text.contains("@expert (explicit)"));
        assert_eq!(text.matches("project @team").count(), 1);
    }
    #[test]
    fn unchanged_routes_do_not_repeat_notices() {
        let state = snapshot(vec![grant("@user", Some("team"))]);
        assert!(inheritance_messages(&state, &state).is_empty());
    }
    #[test]
    fn explicit_grant_change_alone_is_not_an_inheritance_change() {
        assert!(
            inheritance_messages(&snapshot(vec![]), &snapshot(vec![grant("expert", None)]))
                .is_empty()
        );
    }
    #[test]
    fn no_notice_is_addressed_to_a_retired_member() {
        assert!(inheritance_messages(
            &snapshot(vec![grant("@user", Some("team"))]),
            &BTreeMap::new()
        )
        .is_empty());
    }
    #[test]
    fn duplicate_sources_have_one_semantic_identity() {
        assert_eq!(
            inherited_pairs(&[grant("@user", Some("team")), grant("@user", Some("team"))]).len(),
            1
        );
    }
    #[test]
    fn event_fixture_still_uses_the_existing_optional_source_field() {
        let event = crate::events::audience_changed(
            "synthetic",
            "member",
            1,
            "rescinded",
            "@user",
            "@user",
            Some("team"),
        )
        .unwrap();
        assert_eq!(event["other"], json!("team"));
    }
    #[test]
    fn legacy_revoke_does_not_claim_unknown_inheritance_is_lost() {
        let event = crate::events::audience_changed(
            "synthetic",
            "member",
            1,
            "rescinded",
            "@user",
            "@user",
            None,
        )
        .unwrap();
        let text = crate::runtime::event_text::render_agent(&event).unwrap();
        assert!(text.contains("check Your effective audiences"));
        assert!(!text.contains("fall back") && !text.contains("No project-inherited"));
    }
    #[test]
    fn known_final_revoke_says_inherited_access_is_gone_in_typed_text() {
        let event = crate::events::audience_changed(
            "synthetic",
            "member",
            1,
            "rescinded",
            "@user",
            "@user",
            Some(""),
        )
        .unwrap();
        assert!(crate::runtime::event_text::render_agent(&event)
            .unwrap()
            .contains("No project-inherited audience remains"));
    }
    #[test]
    fn topology_aliases_and_undo_paths_use_the_shared_notice_boundary() {
        for op in [
            "hire",
            "rehire",
            "move",
            "moves",
            "create_project",
            "retire",
            "rescind",
            "delete",
            "dissolve",
            "swap",
            "self_subjugate",
            "rename",
            "configure_project",
        ] {
            assert!(topology_changes_audiences(op), "{op}");
        }
        assert!(!topology_changes_audiences("set_description"));
    }
    #[test]
    fn snapshot_sql_keeps_empty_live_agents_and_excludes_nested_relay_history() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("ATTACH DATABASE ':memory:' AS ot;
            CREATE TABLE ot.agents(id INTEGER PRIMARY KEY,org_id INTEGER,name TEXT,parent_id INTEGER,kind TEXT,state TEXT);
            CREATE TABLE ot.audiences(id INTEGER PRIMARY KEY,org_id INTEGER,grantee TEXT,grantor TEXT,granted_at TEXT,reason TEXT,revoked_at TEXT,paused BOOLEAN DEFAULT false);
            INSERT INTO ot.agents VALUES(1,1,'team',NULL,'project','live'),(7,1,'member',1,'agent','live'),(8,1,'nested',1,'project','live'),(9,1,'deep',8,'agent','live'),(10,1,'dead',1,'agent','archived'),(11,2,'outside',NULL,'agent','live');
            INSERT INTO ot.audiences(id,org_id,grantee,grantor) VALUES(1,1,'team','@user');").unwrap();
        let view = include_str!("../../migrations/0032_project_member_audiences.sql")
            .replace("CREATE OR REPLACE VIEW", "CREATE VIEW")
            .replace("NULL::text", "NULL");
        db.execute_batch(&view).unwrap();
        let mut statement = db.prepare(SNAPSHOT_SQL).unwrap();
        let rows: Vec<_> = statement
            .query_map([1], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                (7, Some("@user".into()), Some("team".into())),
                (9, None, None)
            ]
        );
        db.execute("UPDATE ot.audiences SET revoked_at='now'", [])
            .unwrap();
        let rows: Vec<_> = statement
            .query_map([1], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(2)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows, vec![(7, None), (9, None)]);
    }
}
