//! Admission for the native user-session launcher. This is separate from the
//! desktop's registered membership: an automatic sign-in need not open a window.
use crate::{core_process::Identity, core_state::Snapshot};
use serde::Deserialize;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action { Begin, Cancel, Complete }

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Admission {
    pub generation: String,
    pub who: Identity,
    pub action: Action,
}

#[nolog]
pub fn admit(_state: &mut Snapshot, _request: &Admission, _now: i64, _stopped: bool, _native_peer: bool) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Snapshot, Admission) {
        let who = Identity { pid: 20, created: "200".into() };
        (Snapshot { generation:"a".repeat(32), engine:Identity {pid:10,created:"100".into()},
            host:None, desktop:None, helper:None, sessions:vec![], transition_until:0,
            transition_desktop:None, installing:false, completion_requested:false },
         Admission {generation:"a".repeat(32),who,action:Action::Begin})
    }
    #[test] fn native_signin_needs_no_desktop_membership() {
        let (mut s,r)=fixture(); assert!(admit(&mut s,&r,1000,false,true));
        assert_eq!(s.transition_until,181000); assert_eq!(s.transition_desktop,Some(r.who));
        assert!(s.installing); assert!(s.desktop.is_none());
    }
    #[test] fn stale_generation_cannot_interrupt_replacement() {
        let (mut s,mut r)=fixture();r.generation="b".repeat(32);
        assert!(!admit(&mut s,&r,1000,false,true)); assert_eq!(s.transition_until,0);
    }
    #[test] fn stop_or_foreign_image_refuses_without_mutation() {
        for (stopped,peer) in [(true,true),(false,false)] {
            let (mut s,r)=fixture();assert!(!admit(&mut s,&r,1000,stopped,peer));assert_eq!(s.transition_until,0);
        }
    }
    #[test] fn duplicate_or_competing_request_never_extends_deadline() {
        let (mut s,r)=fixture();assert!(admit(&mut s,&r,1000,false,true));let until=s.transition_until;
        assert!(!admit(&mut s,&r,1100,false,true));let mut other=r.clone();other.who.pid+=1;
        assert!(!admit(&mut s,&other,1200,false,true));assert_eq!(s.transition_until,until);
    }
    #[test] fn existing_desktop_transition_is_not_stolen() {
        let (mut s,r)=fixture();s.transition_until=2000;s.transition_desktop=Some(s.engine.clone());
        assert!(!admit(&mut s,&r,1000,false,true));assert_eq!(s.transition_until,2000);
    }
    #[test] fn cancellation_only_clears_its_own_live_admission() {
        let (mut s,mut r)=fixture();assert!(admit(&mut s,&r,1000,false,true));r.action=Action::Cancel;
        let mut wrong=r.clone();wrong.who.created="reused".into();assert!(!admit(&mut s,&wrong,1100,false,true));
        assert!(admit(&mut s,&r,1100,false,true));assert_eq!(s.transition_until,0);assert!(!s.installing);
    }
    #[test] fn completion_requires_the_replacement_host() {
        let (mut s,mut r)=fixture();assert!(admit(&mut s,&r,1000,false,true));r.action=Action::Complete;
        assert!(!admit(&mut s,&r,1100,false,true));s.host=Some(r.who.clone());
        assert!(admit(&mut s,&r,1100,false,true));assert_eq!(s.transition_until,0);assert!(s.transition_desktop.is_none());
    }
    #[test] fn expired_admission_cannot_be_completed_or_extended() {
        let (mut s,mut r)=fixture();assert!(admit(&mut s,&r,1000,false,true));s.host=Some(r.who.clone());
        for action in [Action::Complete,Action::Begin,Action::Cancel] {r.action=action;assert!(!admit(&mut s,&r,181001,false,true));}
        assert_eq!(s.transition_until,181000);
    }
}
