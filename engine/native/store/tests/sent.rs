//! The WS5 Sent interface over the fake session (no database): the derived
//! pair rule, source-only writes, grant effects and their bumps, the grant
//! prediction and its retry, route anchoring, validation refusals.
//!
//! The fake session does not model locking or isolation; these tests prove
//! the statement sequence and the decisions, not PostgreSQL behaviour. The
//! schedules (Q-AM1..5, Q-HM1..4) run DB-backed through the P03 run lock.

mod common;

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::Arc;

use common::*;
use orgtree_store::fake::FakeDb;
use orgtree_store::sent::{self, Destination, GrantEffect, MailClass, MailSource, Route, SendError, SendRequest};
use orgtree_store::{Binding, CmdError, Command, Decided, Family, Isolation, Outcome, Rows, Session, Tx, Uuid, Val};

static MAIL: Family = Family { name: "mail.source", isolation: Isolation::ReadCommitted, retry_unique: &[] };

/// A send command: optional agent addressing, then record_sent.
struct Send {
    req: SendRequest,
    /// Run address_agent(sender=agent(), recipient) first and use its grant.
    address: Option<Uuid>,
}

impl Command for Send {
    type Output = (Option<i64>, bool);
    fn family(&self) -> &'static Family {
        &MAIL
    }
    fn verb(&self) -> &'static str {
        "send"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &(Option<i64>, bool)) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, _b: &Binding) -> Result<Decided<(Option<i64>, bool)>, CmdError> {
        let mut req = self.req.clone();
        if let Some(r) = self.address {
            let org = tx.op().org;
            match sent::address_agent(tx, org, agent(), r, true).await {
                Ok(a) => req = req.with_grant(a.grant),
                Err(SendError::Refused(r)) => return Ok(Decided::Refused(r)),
                Err(e) => return Err(e.into()),
            }
        }
        match sent::record_sent(tx, &req).await {
            Ok(rec) => Ok(Decided::Applied((rec.pair_seq, rec.grant_inserted))),
            Err(SendError::Refused(r)) => Ok(Decided::Refused(r)),
            Err(e) => Err(e.into()),
        }
    }
}

fn bob() -> Uuid {
    Uuid::from_u128(0xb0b)
}
fn carol() -> Uuid {
    Uuid::from_u128(0xca401)
}
fn mbox() -> Uuid {
    Uuid::from_u128(0xb0b1)
}
fn to_bob() -> Destination {
    Destination::Resolved { principal: bob(), mailbox: mbox(), mailbox_incarnation: 1 }
}

fn msg(source: MailSource) -> SendRequest {
    SendRequest::message(source, to_bob(), Uuid::new_v4(), "message", "hello", "fp")
}

fn send(req: SendRequest) -> Send {
    Send { req, address: None }
}

fn uuid_param(db: &FakeDb, label: &str, idx: usize) -> Vec<Uuid> {
    db.log().into_iter().filter(|e| e.label == label).filter_map(|e| e.params.get(idx).and_then(Val::as_uuid)).collect()
}

// ---------------------------------------------------------------- the pair rule (lead ack A1 condition 2)

#[test]
fn pair_sequence_is_derived_for_every_source_class_and_destination() {
    let sources = [MailSource::Agent { principal: agent() }, MailSource::User, MailSource::System];
    let classes = [MailClass::Message, MailClass::Passive, MailClass::Notice];
    let dests = [to_bob(), Destination::UserMailbox { mailbox: mbox() }, Destination::External { handle: "@net:x".into() }];
    let mut checked = 0;
    for s in &sources {
        for c in classes {
            for d in &dests {
                let want = matches!(s, MailSource::Agent { .. } | MailSource::User)
                    && matches!(c, MailClass::Message | MailClass::Passive)
                    && !matches!(d, Destination::External { .. });
                assert_eq!(sent::pair_gated(s, c, d), want, "{s:?} {c:?} {d:?}");
                checked += 1;
            }
        }
    }
    assert_eq!(checked, 27);
    // and the constructors carry the class they name
    let id = Uuid::new_v4();
    assert_eq!(SendRequest::message(MailSource::User, to_bob(), id, "k", "b", "f").class(), MailClass::Message);
    assert_eq!(SendRequest::passive(MailSource::User, to_bob(), id, "k", "b", "f").class(), MailClass::Passive);
    assert_eq!(SendRequest::notice(MailSource::User, to_bob(), id, "k", "b", "f").class(), MailClass::Notice);
}

#[tokio::test]
async fn pair_sequence_is_assigned_only_to_pair_gated_sends() {
    let cases: Vec<(SendRequest, bool)> = vec![
        (msg(MailSource::Agent { principal: agent() }), true),
        (msg(MailSource::User), true),
        (msg(MailSource::System), false),
        (SendRequest::passive(MailSource::Agent { principal: agent() }, to_bob(), Uuid::new_v4(), "participation", "b", "f"), true),
        (SendRequest::notice(MailSource::Agent { principal: agent() }, to_bob(), Uuid::new_v4(), "context.deep_reach", "b", "f"), false),
        (SendRequest::notice(MailSource::User, to_bob(), Uuid::new_v4(), "context.deep_reach", "b", "f"), false),
    ];
    for (i, (req, paired)) in cases.into_iter().enumerate() {
        let db = FakeDb::new();
        db.respond("sent.pair_seq", |_| Ok(Rows::one(vec![Val::Int(4)])));
        let (ex, _) = exec(&db);
        let class = req.class();
        let o = ex.run(&send(req), &binding(&format!("p{i}"), "fp")).await.unwrap();
        assert_eq!(o, Outcome::Applied((if paired { Some(4) } else { None }, false)), "case {i}");
        assert_eq!(db.count("sent.pair_seq"), paired as usize, "case {i}");
        // the class is written with the Sent row (param 16)
        let log = db.log();
        let ins = log.iter().find(|e| e.label == "sent.insert").unwrap();
        assert_eq!(ins.params[15], Val::text(class.name()), "case {i}");
        assert_eq!(ins.params[9], Val::opt_int(if paired { Some(4) } else { None }), "case {i}");
    }
}

// ---------------------------------------------------------------- source-only writes

#[tokio::test]
async fn a_send_writes_source_rows_only_and_hints_after_commit() {
    let db = FakeDb::new();
    db.respond("sent.pair_seq", |_| Ok(Rows::one(vec![Val::Int(1)])));
    let (ex, trace) = exec(&db);
    let o = ex.run(&send(msg(MailSource::Agent { principal: agent() })), &binding("s1", "fp")).await.unwrap();
    assert_eq!(o, Outcome::Applied((Some(1), false)));
    let labels = db.labels();
    assert!(labels.contains(&"sent.insert".to_string()));
    assert!(labels.contains(&"sent.intent".to_string()));
    assert!(!labels.iter().any(|l| l.contains("mailbox") || l.contains("unsafe")), "the source never touches the receiver: {labels:?}");
    assert!(!trace.has("stmt:sent.insert:stub"), "the real Sent path is no longer marked stub");
    // the intent names the captured destination mailbox
    assert_eq!(uuid_param(&db, "sent.intent", 3), vec![mbox()]);
}

#[tokio::test]
async fn an_outside_send_writes_a_transport_intent_not_a_mailbox_intent() {
    let db = FakeDb::new();
    db.respond("sent.holders_lock", |_| Ok(Rows::one(vec![Val::Json(serde_json::json!({"multi_holder": true}))])));
    db.respond("sent.extern_held", |_| Ok(Rows::one(vec![Val::Int(1)])));
    let (ex, _) = exec(&db);
    let req = SendRequest::message(MailSource::Agent { principal: agent() }, Destination::External { handle: "@net:peer".into() }, Uuid::new_v4(), "message", "hi", "fp")
        .with_grant(GrantEffect::Extern);
    let o = ex.run(&send(req), &binding("x1", "fp")).await.unwrap();
    assert_eq!(o, Outcome::Applied((None, false)));
    assert_eq!(db.count("sent.transport"), 1);
    assert_eq!(db.count("sent.intent"), 0);
    assert_eq!(db.count("sent.pair_seq"), 0);
    assert_eq!(db.count("sent.grant"), 0, "an existing holder grants nothing");
}

// ---------------------------------------------------------------- grants

#[tokio::test]
async fn reply_grant_is_anchored_on_the_sender_and_bumps_only_when_inserted() {
    for inserted in [true, false] {
        let db = FakeDb::new();
        db.respond("sent.pair_seq", |_| Ok(Rows::one(vec![Val::Int(1)])));
        db.respond("sent.grant", move |_| Ok(if inserted { Rows::one(vec![Val::Uuid(bob())]) } else { Rows::empty() }));
        let (ex, _) = exec(&db);
        let req = msg(MailSource::Agent { principal: agent() }).with_grant(GrantEffect::ReplyGrant { grantee: bob(), target: agent() });
        let o = ex.run(&send(req), &binding("g1", "fp")).await.unwrap();
        assert_eq!(o, Outcome::Applied((Some(1), inserted)));
        assert_eq!(db.count("sent.bump_audience"), inserted as usize, "inserted={inserted}");
        let log = db.log();
        let g = log.iter().find(|e| e.label == "sent.grant").unwrap();
        assert_eq!(g.params[1], Val::Uuid(bob()), "grantee = recipient");
        assert_eq!(g.params[2], Val::text("agent"));
        assert_eq!(g.params[3], Val::Uuid(agent()), "target = sender");
        assert_eq!(g.params[4], Val::Uuid(agent()), "anchor = sender (P1 sweep)");
        if inserted {
            assert_eq!(uuid_param(&db, "sent.bump_audience", 1), vec![bob()], "the GRANTEE's epoch row is bumped");
        }
    }
}

#[tokio::test]
async fn first_contact_user_audience_is_a_user_target_grant() {
    let db = FakeDb::new();
    db.respond("sent.pair_seq", |_| Ok(Rows::one(vec![Val::Int(1)])));
    db.respond("sent.grant", |_| Ok(Rows::one(vec![Val::Uuid(bob())])));
    let (ex, _) = exec(&db);
    let req = msg(MailSource::User).with_grant(GrantEffect::FirstContactUser { node: bob() });
    ex.run(&send(req), &binding("u1", "fp")).await.unwrap();
    let log = db.log();
    let g = log.iter().find(|e| e.label == "sent.grant").unwrap();
    assert_eq!((g.params[1].clone(), g.params[2].clone(), g.params[3].clone()), (Val::Uuid(bob()), Val::text("user"), Val::Uuid(Uuid::nil())));
    assert_eq!(db.count("sent.bump_audience"), 1);
}

#[tokio::test]
async fn single_holder_extern_replaces_every_other_holder_under_the_holder_lock() {
    let db = FakeDb::new();
    let old = Uuid::from_u128(0x01d);
    db.respond("sent.holders_lock", |_| Ok(Rows::one(vec![Val::Json(serde_json::json!({"multi_holder": false}))])));
    db.respond("sent.extern_top", |_| Ok(Rows::one(vec![Val::Null])));
    db.respond("sent.extern_holders", move |_| Ok(Rows::one(vec![Val::Uuid(old)])));
    db.respond("restrict.epoch_share", |_| Ok(Rows::one(vec![Val::Int(3)])));
    db.respond("sent.grant", |_| Ok(Rows::one(vec![Val::Uuid(agent())])));
    db.respond("sent.recipient_mailbox", |_| Ok(Rows::one(vec![Val::Uuid(Uuid::from_u128(0x01db)), Val::Int(1)])));
    let (ex, _) = exec(&db);
    let req = SendRequest::message(MailSource::Agent { principal: agent() }, Destination::External { handle: "@org:acme".into() }, Uuid::new_v4(), "message", "hi", "fp")
        .with_grant(GrantEffect::Extern);
    let o = ex.run(&send(req), &binding("x2", "fp")).await.unwrap();
    assert_eq!(o, Outcome::Applied((None, true)));
    let labels = db.labels();
    let pos = |l: &str| labels.iter().position(|x| x == l).unwrap_or_else(|| panic!("no {l} in {labels:?}"));
    assert!(pos("sent.holders_lock") < pos("sent.extern_revoke"), "the holder-set row is locked before any holder changes");
    assert_eq!(uuid_param(&db, "sent.extern_revoke", 1), vec![old]);
    assert_eq!(uuid_param(&db, "sent.bump_audience", 1), vec![old, agent()], "old holder's and the new holder's epochs are bumped");
    assert_eq!(db.count("restrict.insert"), 1, "the replaced holder's authority narrows (r7 C5)");
    assert_eq!(db.count("sent.holders_bump"), 1);
    // the replaced holder is told, by a system notice (no pair sequence)
    assert_eq!(db.count("sent.insert"), 2);
    assert_eq!(db.count("sent.pair_seq"), 0);
}

#[tokio::test]
async fn a_non_top_level_agent_without_extern_is_refused_and_nothing_commits() {
    let db = FakeDb::new();
    db.respond("sent.holders_lock", |_| Ok(Rows::one(vec![Val::Json(serde_json::json!({}))])));
    db.respond("sent.extern_top", |_| Ok(Rows::one(vec![Val::Uuid(bob())])));
    let (ex, _) = exec(&db);
    let req = SendRequest::message(MailSource::Agent { principal: agent() }, Destination::External { handle: "@org:acme".into() }, Uuid::new_v4(), "message", "hi", "fp")
        .with_grant(GrantEffect::Extern);
    let o = ex.run(&send(req), &binding("x3", "fp")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "not_extern_holder"), "{o:?}");
    assert!(db.receipts().is_empty(), "a refusal commits nothing, not even the receipt (E-D5)");
    assert_eq!(db.count("sent.insert"), 0);
}

// ---------------------------------------------------------------- addressing: prediction, anchors, retry

/// Topology: agent() is the root; bob is its child; carol is bob's child.
fn topology(db: &FakeDb) {
    let edges = move |p: &[Val]| {
        let n = p[1].as_uuid().unwrap();
        Ok(if n == agent() {
            Rows::one(vec![Val::Null])
        } else if n == bob() {
            Rows::one(vec![Val::Uuid(agent())])
        } else if n == carol() {
            Rows::one(vec![Val::Uuid(bob())])
        } else {
            Rows::empty()
        })
    };
    db.respond("sent.plan_edge", edges);
    db.respond("sent.anchor_edge", edges);
    db.respond("sent.recipient_epoch_share", |_| Ok(Rows::one(vec![Val::text("live")])));
    db.respond("sent.recipient_epoch_grant", |_| Ok(Rows::one(vec![Val::text("live")])));
    db.respond("sent.recipient_mailbox", |_| Ok(Rows::one(vec![Val::Uuid(mbox()), Val::Int(1)])));
    db.respond("sent.pair_seq", |_| Ok(Rows::one(vec![Val::Int(1)])));
    db.respond("sent.grant", |_| Ok(Rows::one(vec![Val::Uuid(carol())])));
}

fn to_carol() -> SendRequest {
    SendRequest::message(MailSource::Agent { principal: agent() }, Destination::Resolved { principal: carol(), mailbox: mbox(), mailbox_incarnation: 1 }, Uuid::new_v4(), "message", "hi", "fp")
}

#[tokio::test]
async fn a_send_to_a_child_locks_the_recipient_for_share_and_grants_nothing() {
    let db = FakeDb::new();
    topology(&db);
    let (ex, _) = exec(&db);
    let req = SendRequest::message(MailSource::Agent { principal: agent() }, to_bob(), Uuid::new_v4(), "message", "hi", "fp");
    let o = ex.run(&Send { req, address: Some(bob()) }, &binding("a1", "fp")).await.unwrap();
    assert_eq!(o, Outcome::Applied((Some(1), false)));
    assert_eq!(db.count("sent.recipient_epoch_share"), 1);
    assert_eq!(db.count("sent.recipient_epoch_grant"), 0, "no grant possible: never the exclusive lock (Q-AM1)");
    assert_eq!(db.count("sent.grant"), 0);
    assert_eq!(uuid_param(&db, "sent.anchor_edge", 1), vec![bob()], "a child route anchors the recipient's edge");
}

#[tokio::test]
async fn a_deep_send_locks_the_grantee_before_the_route_and_inserts_the_reply_grant() {
    let db = FakeDb::new();
    topology(&db);
    let (ex, _) = exec(&db);
    let o = ex.run(&Send { req: to_carol(), address: Some(carol()) }, &binding("a2", "fp")).await.unwrap();
    assert_eq!(o, Outcome::Applied((Some(1), true)));
    let labels = db.labels();
    let pos = |l: &str| labels.iter().position(|x| x == l).unwrap_or_else(|| panic!("no {l} in {labels:?}"));
    assert!(pos("sent.recipient_epoch_grant") < pos("sent.anchor_edge"), "C4: the grantee's exclusive lock (step 3) precedes the route anchors (step 4)");
    assert_eq!(db.count("sent.recipient_epoch_share"), 0, "never a share lock later upgraded");
    // the whole chain is anchored leaf upward
    assert_eq!(uuid_param(&db, "sent.anchor_edge", 1), vec![carol(), bob()]);
    assert_eq!(db.count("sent.bump_audience"), 1);
}

#[tokio::test]
async fn a_stale_prediction_retries_the_attempt_with_its_true_cause() {
    let db = FakeDb::new();
    topology(&db);
    // the plan sees the reply grant (so predicts no grant and takes FOR SHARE);
    // the re-check after the anchors finds it revoked. The retry plans afresh.
    let plans = Arc::new(AtomicUsize::new(0));
    let p2 = plans.clone();
    db.respond("sent.plan_reply_grant", move |_| Ok(if p2.fetch_add(1, Ordering::SeqCst) == 0 { Rows::one(vec![Val::Int(1)]) } else { Rows::empty() }));
    let (ex, trace) = exec(&db);
    let o = ex.run(&Send { req: to_carol(), address: Some(carol()) }, &binding("a3", "fp")).await.unwrap();
    assert_eq!(o, Outcome::Applied((Some(1), true)));
    assert!(trace.has("retry:sent.prediction_stale"), "the retry is traced with its true cause");
    assert_eq!(plans.load(Ordering::SeqCst), 2);
    assert_eq!(db.count("sent.recipient_epoch_share"), 1, "attempt 1: share lock");
    assert_eq!(db.count("sent.recipient_epoch_grant"), 1, "attempt 2: the grant lock up front");
    assert_eq!(claim_keys(&db), vec!["a3".to_string(), "a3".to_string()], "same identity on the retry");
    assert_eq!(db.count("sent.insert"), 1, "attempt 1 retried before writing anything");
    assert_eq!(db.commits(), 1, "only the second attempt committed");
}

#[tokio::test]
async fn a_route_changed_under_the_anchor_retries() {
    let db = FakeDb::new();
    topology(&db);
    // the first anchor of carol's edge sees a new parent (a concurrent move)
    let first = Arc::new(AtomicBool::new(true));
    let f2 = first.clone();
    db.respond("sent.anchor_edge", move |p: &[Val]| {
        let n = p[1].as_uuid().unwrap();
        if n == carol() && f2.swap(false, Ordering::SeqCst) {
            return Ok(Rows::one(vec![Val::Uuid(Uuid::from_u128(0x0e11))]));
        }
        Ok(if n == carol() { Rows::one(vec![Val::Uuid(bob())]) } else { Rows::one(vec![Val::Uuid(agent())]) })
    });
    let (ex, trace) = exec(&db);
    let o = ex.run(&Send { req: to_carol(), address: Some(carol()) }, &binding("a4", "fp")).await.unwrap();
    assert_eq!(o, Outcome::Applied((Some(1), true)));
    assert!(trace.has("retry:sent.route_changed"));
}

#[tokio::test]
async fn an_unaddressable_recipient_is_refused_before_any_write() {
    let db = FakeDb::new();
    topology(&db);
    let stranger = Uuid::from_u128(0x5);
    db.respond("sent.plan_edge", move |p: &[Val]| {
        let n = p[1].as_uuid().unwrap();
        Ok(if n == agent() { Rows::one(vec![Val::Uuid(bob())]) } else if n == stranger { Rows::one(vec![Val::Uuid(carol())]) } else { Rows::one(vec![Val::Null]) })
    });
    let (ex, _) = exec(&db);
    let req = SendRequest::message(MailSource::Agent { principal: agent() }, Destination::Resolved { principal: stranger, mailbox: mbox(), mailbox_incarnation: 1 }, Uuid::new_v4(), "message", "hi", "fp");
    let o = ex.run(&Send { req, address: Some(stranger) }, &binding("a5", "fp")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "not_addressable"), "{o:?}");
    assert_eq!(db.count("sent.insert"), 0);
    assert!(db.receipts().is_empty());
}

#[tokio::test]
async fn plan_route_names_each_route() {
    let db = FakeDb::new();
    topology(&db);
    // parent: bob -> agent ; sibling needs another child of agent
    let dave = Uuid::from_u128(0xda7e);
    db.respond("sent.plan_edge", move |p: &[Val]| {
        let n = p[1].as_uuid().unwrap();
        Ok(if n == agent() {
            Rows::one(vec![Val::Null])
        } else if n == bob() || n == dave {
            Rows::one(vec![Val::Uuid(agent())])
        } else if n == carol() {
            Rows::one(vec![Val::Uuid(bob())])
        } else {
            Rows::empty()
        })
    });
    struct Plan(Uuid, Uuid, Arc<std::sync::Mutex<Vec<Route>>>);
    impl Command for Plan {
        type Output = ();
        fn family(&self) -> &'static Family {
            &MAIL
        }
        fn verb(&self) -> &'static str {
            "plan"
        }
        async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
            Ok(())
        }
        async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &()) -> Result<bool, CmdError> {
            Ok(true)
        }
        async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, _b: &Binding) -> Result<Decided<()>, CmdError> {
            let org = tx.op().org;
            let p = sent::plan_route(tx, org, self.0, sent::To::Agent(self.1)).await.map_err(CmdError::from)?;
            self.2.lock().unwrap().push(p.route);
            Ok(Decided::Applied(()))
        }
    }
    let got = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (ex, _) = exec(&db);
    let n = AtomicI64::new(0);
    for (s, r) in [(agent(), agent()), (bob(), agent()), (agent(), bob()), (agent(), carol()), (bob(), dave)] {
        let k = format!("r{}", n.fetch_add(1, Ordering::SeqCst));
        ex.run(&Plan(s, r, got.clone()), &binding(&k, "fp")).await.unwrap();
    }
    assert_eq!(*got.lock().unwrap(), vec![Route::SelfSend, Route::Parent, Route::Child, Route::DeepDescendant, Route::Sibling]);
}

// ---------------------------------------------------------------- validation (refusals before effects)

#[tokio::test]
async fn invalid_sends_are_refused_and_commit_nothing() {
    let cases: Vec<(SendRequest, &str)> = vec![
        (msg(MailSource::Agent { principal: agent() }).with_urgent("now"), "urgent_not_user"),
        (SendRequest::message(MailSource::Agent { principal: agent() }, Destination::UserMailbox { mailbox: mbox() }, Uuid::new_v4(), "m", "b", "f").with_urgent("  "), "urgent_reason_blank"),
        (msg(MailSource::Agent { principal: agent() }).with_grant(GrantEffect::ReplyGrant { grantee: carol(), target: agent() }), "invalid_send"),
        (msg(MailSource::User).with_grant(GrantEffect::Extern), "invalid_send"),
        (SendRequest::message(MailSource::Agent { principal: agent() }, Destination::External { handle: "@net:x".into() }, Uuid::new_v4(), "m", "b", "f"), "invalid_send"),
    ];
    for (i, (req, code)) in cases.into_iter().enumerate() {
        let db = FakeDb::new();
        let (ex, _) = exec(&db);
        let o = ex.run(&send(req), &binding(&format!("v{i}"), "fp")).await.unwrap();
        assert!(matches!(o, Outcome::Refused(ref r) if r.code == code), "case {i}: {o:?}");
        assert_eq!(db.count("sent.insert"), 0, "case {i}");
        assert!(db.receipts().is_empty(), "case {i}");
    }
}

#[tokio::test]
async fn a_pair_sequence_collision_retries_and_takes_the_next_number() {
    let db = FakeDb::new();
    let first = Arc::new(AtomicBool::new(true));
    let f2 = first.clone();
    db.respond("sent.insert", move |_| {
        if f2.swap(false, Ordering::SeqCst) {
            Err(orgtree_store::DbError::unique("mail_sent_pair_seq"))
        } else {
            Ok(Rows::empty())
        }
    });
    let n = Arc::new(AtomicI64::new(0));
    let n2 = n.clone();
    db.respond("sent.pair_seq", move |_| Ok(Rows::one(vec![Val::Int(n2.fetch_add(1, Ordering::SeqCst) + 1)])));
    let (ex, trace) = exec(&db);
    let o = ex.run(&send(msg(MailSource::Agent { principal: agent() })), &binding("s5", "fp")).await.unwrap();
    assert_eq!(o, Outcome::Applied((Some(2), false)));
    assert!(trace.has("retry:unique_violation_allowlisted"));
}

#[tokio::test]
async fn a_retraction_is_an_intent_never_a_mailbox_write() {
    struct Retract;
    impl Command for Retract {
        type Output = bool;
        fn family(&self) -> &'static Family {
            &MAIL
        }
        fn verb(&self) -> &'static str {
            "retract"
        }
        async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
            Ok(())
        }
        async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &bool) -> Result<bool, CmdError> {
            Ok(true)
        }
        async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, _b: &Binding) -> Result<Decided<bool>, CmdError> {
            Ok(Decided::Applied(sent::record_retraction(tx, mbox(), Uuid::from_u128(0x77)).await.map_err(CmdError::from)?))
        }
    }
    let db = FakeDb::new();
    db.respond("sent.retract", |_| Ok(Rows::one(vec![Val::Uuid(Uuid::new_v4())])));
    let (ex, _) = exec(&db);
    assert_eq!(ex.run(&Retract, &binding("rt", "fp")).await.unwrap(), Outcome::Applied(true));
    let labels = db.labels();
    assert!(!labels.iter().any(|l| l.starts_with("mailbox.")), "{labels:?}");
    assert_eq!(uuid_param(&db, "sent.retract", 2), vec![Uuid::from_u128(0x77)]);
    assert_eq!(uuid_param(&db, "sent.retract", 3), vec![mbox()]);
}
