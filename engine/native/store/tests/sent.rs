//! The M1 Sent stub over the fake session: source rows only, pair_seq for
//! paired sources, the P1 bump only when the grant was inserted, every
//! statement traced `stub: true`.

mod common;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use common::*;
use orgtree_store::fake::FakeDb;
use orgtree_store::sent::{self, Destination, GrantEffect, MailSource, SendError, SendRequest, SentRecord};
use orgtree_store::{Binding, CmdError, Command, Decided, Family, Isolation, Outcome, Rows, Session, Tx, Uuid, Val};

static MAIL: Family = Family { name: "mail.source", isolation: Isolation::ReadCommitted, retry_unique: &[] };

struct Send(SendRequest);

impl Command for Send {
    type Output = Option<i64>;
    fn family(&self) -> &'static Family {
        &MAIL
    }
    fn verb(&self) -> &'static str {
        "send"
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        if let GrantEffect::ReplyGrant { grantee, .. } = self.0.grant {
            let org = tx.op().org;
            sent::lock_grantee_for_grant(tx, org, grantee).await?;
        }
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &Option<i64>) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, _b: &Binding) -> Result<Decided<Option<i64>>, CmdError> {
        match sent::record_sent(tx, &self.0).await {
            Ok(SentRecord { pair_seq, .. }) => Ok(Decided::Applied(pair_seq)),
            Err(SendError::Refused(r)) => Ok(Decided::Refused(r)),
            Err(e) => Err(e.into()),
        }
    }
}

fn req(source: MailSource, grant: GrantEffect) -> SendRequest {
    SendRequest {
        source,
        dest: Destination::Resolved { principal: Uuid::from_u128(0xb0b), mailbox: Uuid::from_u128(0xb0b1), mailbox_incarnation: 1 },
        original_message_id: Uuid::new_v4(),
        kind: "message".into(),
        body: "hello".into(),
        urgent: false,
        fingerprint: "fp".into(),
        grant,
    }
}

#[tokio::test]
async fn a_paired_send_writes_source_rows_only_and_is_traced_as_stub() {
    let db = FakeDb::new();
    db.respond("sent.pair_seq", |_| Ok(Rows::one(vec![Val::Int(4)])));
    let (ex, trace) = exec(&db);
    let o = ex.run(&Send(req(MailSource::Agent { principal: agent() }, GrantEffect::None)), &binding("s1", "fp")).await.unwrap();
    assert_eq!(o, Outcome::Applied(Some(4)));
    let labels = db.labels();
    assert!(labels.contains(&"sent.insert".to_string()));
    assert!(labels.contains(&"sent.intent".to_string()));
    assert!(!labels.iter().any(|l| l.starts_with("sent.grant") || l.starts_with("sent.bump")));
    assert!(!labels.iter().any(|l| l.contains("mailbox")), "the source never touches the receiver: {labels:?}");
    assert!(trace.has("stmt:sent.insert:stub"));
    assert!(trace.has("stmt:sent.intent:stub"));
    assert!(!trace.has("stmt:receipt.claim:stub"), "only the stub's own statements are marked");
}

#[tokio::test]
async fn system_mail_has_no_pair_sequence() {
    let db = FakeDb::new();
    let (ex, _) = exec(&db);
    let o = ex.run(&Send(req(MailSource::System, GrantEffect::None)), &binding("s2", "fp")).await.unwrap();
    assert_eq!(o, Outcome::Applied(None));
    assert_eq!(db.count("sent.pair_seq"), 0);
}

#[tokio::test]
async fn reply_grant_bumps_the_epoch_only_when_inserted() {
    for inserted in [true, false] {
        let db = FakeDb::new();
        db.respond("sent.pair_seq", |_| Ok(Rows::one(vec![Val::Int(1)])));
        db.respond("sent.grant", move |_| Ok(if inserted { Rows::one(vec![Val::Int(1)]) } else { Rows::empty() }));
        let (ex, _) = exec(&db);
        let g = GrantEffect::ReplyGrant { grantee: Uuid::from_u128(0xb0b), target: agent() };
        ex.run(&Send(req(MailSource::Agent { principal: agent() }, g)), &binding("s3", "fp")).await.unwrap();
        assert_eq!(db.count("sent.bump_audience"), inserted as usize, "inserted={inserted}");
        // N4 lock order: the grantee lock comes in the anchor, before the claim
        let labels = db.labels();
        let pos = |l: &str| labels.iter().position(|x| x == l).unwrap();
        assert!(pos("sent.lock_grantee") < pos("receipt.claim"));
    }
}

#[tokio::test]
async fn unsupported_grant_kinds_are_refused_by_the_stub() {
    let db = FakeDb::new();
    let (ex, _) = exec(&db);
    let o = ex.run(&Send(req(MailSource::User, GrantEffect::Extern)), &binding("s4", "fp")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "unimplemented"));
    assert!(db.receipts().is_empty());
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
    let n = Arc::new(std::sync::atomic::AtomicI64::new(0));
    let n2 = n.clone();
    db.respond("sent.pair_seq", move |_| Ok(Rows::one(vec![Val::Int(n2.fetch_add(1, Ordering::SeqCst) + 1)])));
    let (ex, trace) = exec(&db);
    let o = ex.run(&Send(req(MailSource::Agent { principal: agent() }, GrantEffect::None)), &binding("s5", "fp")).await.unwrap();
    assert_eq!(o, Outcome::Applied(Some(2)));
    assert!(trace.has("retry:unique_violation_allowlisted"));
    assert!(!first.load(Ordering::SeqCst));
}
