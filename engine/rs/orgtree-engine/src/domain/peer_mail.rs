//! Direct-sibling mail policy. The stored setting belongs to this node only.
use anyhow::Result;
use serde_json::Value;

#[derive(Clone, Copy)]
pub struct Relation {
    pub from: i64, pub to: i64,
    pub from_parent: Option<i64>, pub to_parent: Option<i64>,
    pub from_superior: Option<i64>, pub to_superior: Option<i64>,
    pub ancestor: bool, pub enabled: bool,
}

#[nolog]
pub fn enabled(scope: &Value) -> bool { scope["peer_mail"].as_bool().unwrap_or(true) }

#[nolog]
pub fn with_setting(scope: &Value, on: bool) -> Value {
    let mut next = scope.clone();
    next["peer_mail"] = Value::Bool(on);
    next
}


/// Reach outside the command chain stays conditional on a directional audience.
#[nolog]
pub fn check(r: Relation, audience: bool, parent_name: &str) -> Result<()> {
    if r.from == r.to { crate::refuse!(BadRequest, "you cannot write to yourself"); }
    if r.ancestor || r.from_superior == Some(r.to) { return Ok(()); }
    let restricted = r.from_parent.is_some() && r.from_parent == r.to_parent && !r.enabled;
    if restricted && !audience {
        crate::refuse!(Forbidden, "{} has turned OFF \"Subordinates may message each other\"; direct siblings need an audience to send mail. Ask with orgtree_audience; your superior may grant one", parent_name);
    }
    if r.from_superior == r.to_superior || audience { return Ok(()); }
    crate::refuse!(Forbidden, "you may write to your superior, your reports and their reports, reachable peers, and agents that granted you an audience; ask for an audience with orgtree_audience")
}

/// A manager may connect two direct tree siblings that both report to it,
/// including siblings directly under a transparent project it owns.
#[nolog]
pub fn delegate(actor: i64, from_parent: Option<i64>, to_parent: Option<i64>,
    from_superior: Option<i64>, to_superior: Option<i64>) -> bool {
    from_parent.is_some() && from_parent == to_parent
        && from_superior == Some(actor) && to_superior == Some(actor)
}

/// Delivered in the live turn envelope, so a toggle is visible without a
/// provider restart or a cached static-prompt policy becoming stale.
#[nolog]
pub fn describe(parent: Option<&str>, on: bool) -> String {
    match parent {
        Some(parent) if !on => format!("Peer mail under {parent}: OFF (Subordinates may message each other). You need a directional audience to mail another direct child of {parent}. You may still request one; your nearest agent superior may grant it. Superior and subordinate reach is unchanged."),
        Some(parent) => format!("Peer mail under {parent}: ON (Subordinates may message each other)."),
        None => "Peer mail at the top level: ON (no parent setting).".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn siblings() -> Relation { Relation {from:2,to:3,from_parent:Some(1),to_parent:Some(1),
        from_superior:Some(1),to_superior:Some(1),ancestor:false,enabled:false} }

    #[test]
    fn off_refuses_sibling_mail_and_names_setting() {
        let result=check(siblings(),false,"committee");
        assert!(result.is_err(),"OFF must refuse ordinary peer mail of every kind");
        let message=result.unwrap_err().to_string();
        assert!(message.contains("Subordinates may message each other") && message.contains("committee"));
    }
    #[test]
    fn directional_audience_allows_only_its_grantee_direction() {
        assert!(check(siblings(),true,"committee").is_ok());
        let r=siblings();let reverse=Relation {from:r.to,to:r.from,..r};
        assert!(check(reverse,false,"committee").is_err());
    }
    #[test]
    fn superior_and_descendants_are_unaffected() {
        let r=siblings();
        assert!(check(Relation {to:1,to_parent:None,to_superior:None,..r},false,"committee").is_ok());
        assert!(check(Relation {ancestor:true,to:4,to_parent:Some(3),to_superior:Some(3),..r},false,"committee").is_ok());
    }
    #[test]
    fn project_children_are_restricted_by_actual_project_parent() {
        assert!(check(Relation {from_parent:Some(100),to_parent:Some(100),..siblings()},false,"project-p").is_err());
    }
    #[test]
    fn cross_project_reporting_peers_and_top_level_peers_keep_reach() {
        assert!(check(Relation {from_parent:Some(100),to_parent:Some(200),..siblings()},false,"project-p").is_ok());
        assert!(check(Relation {from_parent:None,to_parent:None,from_superior:None,to_superior:None,..siblings()},false,"user").is_ok());
    }
    #[test]
    fn unset_is_on_and_new_parent_setting_is_used() {
        assert!(enabled(&json!({})));assert!(enabled(&json!({"peer_mail":true})));
        assert!(!enabled(&json!({"peer_mail":false})));
        assert!(check(Relation {enabled:enabled(&json!({})),..siblings()},false,"new-manager").is_ok());
    }
    #[test]
    fn own_subordinate_setting_does_not_change_peers_at_another_level() {
        assert!(check(Relation {enabled:true,..siblings()},false,"manager-on").is_ok());
        assert!(!enabled(&json!({"peer_mail":false})),"that child may separately restrict its own reports");
    }
    #[test]
    fn superior_may_delegate_between_only_its_direct_reporting_siblings() {
        assert!(delegate(1,Some(1),Some(1),Some(1),Some(1)));
        assert!(delegate(1,Some(100),Some(100),Some(1),Some(1)),"project children report to agent1");
        assert!(!delegate(9,Some(1),Some(1),Some(1),Some(1)));
        assert!(!delegate(1,Some(100),Some(200),Some(1),Some(1)));
        assert!(!delegate(1,None,None,None,None));
    }
    #[test]
    fn transparent_project_setting_cannot_raise_ancestor_permissions() {
        let project = super::super::scope::transparent();
        let off = with_setting(&project,false);
        assert!(super::super::scope::is_transparent(&off));
        assert_eq!(off.as_object().unwrap().len(),2,"setting does not inject default tool/folder grants");
        assert!(!enabled(&off));
        assert!(enabled(&json!({})),"each child has its own default, not its parent's policy");
    }
    #[test]
    fn live_policy_description_explains_directional_audiences_and_default() {
        let off=describe(Some("project-p"),false);
        assert!(off.contains("OFF") && off.contains("project-p") && off.contains("directional audience"));
        assert!(describe(None,true).contains("ON"));
    }

}
