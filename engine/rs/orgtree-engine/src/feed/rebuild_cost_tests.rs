use super::*;
fn tree() -> HashMap<i64, Value> {
    [(1,json!({"name":"boss","parent_id":null})),(2,json!({"name":"project","parent_id":1})),
     (3,json!({"name":"member","parent_id":2})),(4,json!({"name":"peer","parent_id":1}))].into()
}
#[test]
fn metadata_does_not_rebuild_unrelated_descendants_but_scope_changes_do() {
    let live=tree();let roots=HashSet::from([1]);
    assert_eq!(rebuild_set(&live,&roots,&HashSet::new()),roots);
    assert_eq!(rebuild_set(&live,&roots,&roots),HashSet::from([1,2,3,4]));
    assert_eq!(rebuild_set(&live,&HashSet::from([2]),&HashSet::from([2])),HashSet::from([2,3]));
    assert!(rebuild_set(&live,&HashSet::from([99]),&HashSet::from([99])).is_empty());
}
#[test]
fn audience_refresh_only_rebuilds_identities_whose_routes_changed() {
    use crate::domain::audiences::{EffectiveAudiences,EffectiveGrant};
    let before=EffectiveAudiences::from([("member".into(),vec![EffectiveGrant{grantor:"@user".into(),source_project:Some("project".into())}])]);
    assert!(changed_audience_roots(&tree(),&before,&before).is_empty());
    assert_eq!(changed_audience_roots(&tree(),&before,&EffectiveAudiences::new()),HashSet::from([3]));
    assert_eq!(changed_audience_roots(&tree(),&EffectiveAudiences::new(),&before),HashSet::from([3]));
}
#[test]
fn mailbox_and_history_bodies_belong_only_to_their_exact_window() {
    assert!(!window_wanted(&Key::Mailbox(1),&[]));
    assert!(!window_wanted(&Key::Mailbox(1),&[Window::Mailbox(2),Window::History(1)]));
    assert!(window_wanted(&Key::Mailbox(1),&[Window::Mailbox(1)]));
    assert!(window_wanted(&Key::History(1),&[Window::History(1)]));
    assert!(!window_wanted(&Key::History(1),&[Window::Mailbox(1)]));
}
