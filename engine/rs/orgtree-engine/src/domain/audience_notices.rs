//! Presentation of existing effective grants, never admission or grant mutation.
use std::collections::{BTreeMap, BTreeSet};
use super::audiences::EffectiveGrant;

#[derive(Clone, Debug)]
pub(crate) struct AudienceHolder {
    pub name: String,
    pub grants: Vec<EffectiveGrant>,
}
pub(crate) type AudienceSnapshot = BTreeMap<i64, AudienceHolder>;

#[nolog]
pub(crate) fn inherited_pairs(held: &[EffectiveGrant]) -> BTreeSet<(String, String)> {
    held.iter().filter_map(|g| g.source_project.as_ref().map(|p| (g.grantor.clone(), p.clone()))).collect()
}

// Red checkpoint: preserve today's presentation until focused red is measured.
#[nolog]
pub(crate) fn revoke_body(target: &str, by: &str, _held: &[EffectiveGrant]) -> String {
    format!("Your audience with {target} was rescinded by {by}.")
}

#[nolog]
pub(crate) fn inheritance_messages(_before: &AudienceSnapshot, _after: &AudienceSnapshot) -> Vec<(i64, String, String)> {
    Vec::new()
}

#[nolog]
pub(crate) fn self_audiences(_held: &[EffectiveGrant]) -> String { String::new() }

#[cfg(test)]
mod audience_notice_tests {
    use super::*;
    use serde_json::json;
    fn grant(target: &str, project: Option<&str>) -> EffectiveGrant {
        EffectiveGrant { grantor: target.into(), source_project: project.map(str::to_owned) }
    }
    fn snapshot(grants: Vec<EffectiveGrant>) -> AudienceSnapshot {
        BTreeMap::from([(7, AudienceHolder {name:"member".into(),grants})])
    }
    #[test]
    fn explicit_revoke_explains_remaining_project_user_route() {
        let body = revoke_body("@user", "@user", &[grant("@user", Some("team"))]);
        assert!(body.contains("explicit"));
        assert!(body.contains("still reach @user through project @team"));
    }
    #[test]
    fn final_revoke_explicitly_says_inherited_access_is_gone() {
        assert!(revoke_body("@user","@user",&[]).contains("No project-inherited audience"));
    }
    #[test]
    fn typed_revoke_does_not_overwrite_remaining_project_access() {
        let ev=crate::events::audience_changed("synthetic","member",1,"rescinded","@user","@user",Some("team")).unwrap();
        let text=crate::runtime::event_text::render_agent(&ev).unwrap();
        assert!(text.contains("still reach @user through project @team"));
        assert!(!text.contains("fall back"));
    }
    #[test]
    fn project_grant_or_join_tells_member_once_with_usable_user_route() {
        let after=snapshot(vec![grant("@user",Some("team")),grant("@user",Some("team"))]);
        let messages=inheritance_messages(&snapshot(vec![]),&after);
        assert_eq!(messages.len(),1);
        assert_eq!((messages[0].0,messages[0].1.as_str()),(7,"member"));
        assert!(messages[0].2.contains("through project @team"));
        assert!(messages[0].2.contains("to=user"));
    }
    #[test]
    fn project_revoke_or_leave_tells_member_that_inherited_route_ended() {
        let before=snapshot(vec![grant("@user",Some("team"))]);
        let messages=inheritance_messages(&before,&snapshot(vec![]));
        assert_eq!(messages.len(),1);
        assert!(messages[0].2.contains("through project @team has ended"));
        assert!(messages[0].2.contains("No project-inherited audience"));
    }
    #[test]
    fn ending_inheritance_preserves_explicit_route_in_notice() {
        let before=snapshot(vec![grant("expert",None),grant("expert",Some("team"))]);
        let after=snapshot(vec![grant("expert",None)]);
        let messages=inheritance_messages(&before,&after);
        assert_eq!(messages.len(),1);
        assert!(messages[0].2.contains("still reach @expert through an explicit grant"));
    }
    #[test]
    fn project_switch_names_both_the_ended_and_new_source() {
        let messages=inheritance_messages(&snapshot(vec![grant("expert",Some("old"))]),&snapshot(vec![grant("expert",Some("new"))]));
        assert_eq!(messages.len(),2);
        assert!(messages.iter().any(|m|m.2.contains("project @old has ended")));
        assert!(messages.iter().any(|m|m.2.contains("through project @new")));
    }
    #[test]
    fn self_visibility_lists_both_sources_and_deduplicates() {
        let text=self_audiences(&[grant("@user",Some("team")),grant("expert",None),grant("@user",Some("team"))]);
        assert!(text.contains("@user (through project @team)"));
        assert!(text.contains("@expert (explicit)"));
        assert_eq!(text.matches("project @team").count(),1);
    }
    #[test]
    fn unchanged_routes_do_not_repeat_notices() {
        let state=snapshot(vec![grant("@user",Some("team"))]);
        assert!(inheritance_messages(&state,&state).is_empty());
    }
    #[test]
    fn explicit_grant_change_alone_is_not_an_inheritance_change() {
        assert!(inheritance_messages(&snapshot(vec![]),&snapshot(vec![grant("expert",None)])).is_empty());
    }
    #[test]
    fn no_notice_is_addressed_to_a_retired_member() {
        assert!(inheritance_messages(&snapshot(vec![grant("@user",Some("team"))]),&BTreeMap::new()).is_empty());
    }
    #[test]
    fn duplicate_sources_have_one_semantic_identity() {
        assert_eq!(inherited_pairs(&[grant("@user",Some("team")),grant("@user",Some("team"))]).len(),1);
    }
    #[test]
    fn event_fixture_still_uses_the_existing_optional_source_field() {
        let event=crate::events::audience_changed("synthetic","member",1,"rescinded","@user","@user",Some("team")).unwrap();
        assert_eq!(event["other"],json!("team"));
    }
}
