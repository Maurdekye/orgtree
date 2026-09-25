#![allow(dead_code)]
//! Shared fixture for WS5's database-backed tests (mail_pg.rs,
//! mail_sched_pg.rs): the schema reset on THIS agent's disposable cluster,
//! a small org, an executor on the runtime role with a scripted pause hook
//! and armed controls, and admin-side probes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use orgtree_store::conn::{Factory, PgConfig};
use orgtree_store::hooks::{BoxFuture, ControlPlan, EventKind, HookAction, Hooks, PauseHook, PausePoint, TraceEvent, TraceSink};
pub use orgtree_store::mail::doors::{AgentSend, Target};
use orgtree_store::mail::mailbox;
pub use orgtree_store::sent::{Destination, MailSource, SendRequest};
use orgtree_store::sent::{self, SendError};
use orgtree_store::{Binding, CmdError, Command, Decided, ExecConfig, Executor, Family, Isolation, KeyNamespace, OpIdentity, Principal, Session, Tx, Uuid};
use tokio::sync::{mpsc, Semaphore};

const OWN_CLUSTER: &str = "\\artifacts\\p03-db\\p03-ws5-mail\\";

pub fn url(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set: this DB test did NOT run (use devdb.cmd env and p03-run.ps1)"))
}

pub fn org() -> Uuid {
    Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0000_5001)
}
fn agent_id(n: u128) -> Uuid {
    Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0000_a000 + n)
}
/// alpha: top level
pub fn a() -> Uuid {
    agent_id(1)
}
/// bravo: child of alpha
pub fn b() -> Uuid {
    agent_id(2)
}
/// charlie: child of bravo
pub fn c() -> Uuid {
    agent_id(3)
}
/// delta: child of alpha (sibling of bravo)
pub fn d() -> Uuid {
    agent_id(4)
}
/// echo: top level
pub fn e() -> Uuid {
    agent_id(5)
}
pub fn mb(agent: Uuid) -> Uuid {
    Uuid::from_u128(agent.as_u128() + 0x100)
}
pub fn user_mb() -> Uuid {
    Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0000_b0b0)
}
pub fn incarnation() -> Uuid {
    Uuid::from_u128(0x1c)
}
pub fn dest_of(agent: Uuid) -> Destination {
    Destination::Resolved { principal: agent, mailbox: mb(agent), mailbox_incarnation: 1 }
}
pub fn new_id() -> Uuid {
    Uuid::new_v4()
}

async fn admin() -> tokio_postgres::Client {
    let (admin, conn) = tokio_postgres::connect(&url("P03_PG_ADMIN_URL"), tokio_postgres::NoTls).await.expect("admin connect");
    tokio::spawn(async move {
        let _ = conn.await;
    });
    admin
}

/// Rebuild the schema from every migration and seed the fixture org.
pub async fn reset() {
    let admin = admin().await;
    let dir: String = admin.query_one("SHOW data_directory", &[]).await.unwrap().get(0);
    assert!(
        dir.replace('/', "\\").to_ascii_lowercase().contains(&OWN_CLUSTER.to_ascii_lowercase()),
        "refusing to rebuild a cluster that is not this agent's disposable one: {dir}"
    );
    admin.batch_execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;").await.unwrap();
    for m in orgtree_store_schema::MIGRATIONS {
        let sql = orgtree_store_schema::normalized(m.sql);
        admin.batch_execute(&format!("BEGIN;\n{sql}\nCOMMIT;")).await.unwrap_or_else(|e| panic!("{}: {e:?}", m.file));
    }
    admin
        .execute("INSERT INTO store_incarnation (database_id, incarnation) VALUES ($1, $2)", &[&Uuid::from_u128(0xdb), &incarnation()])
        .await
        .unwrap();
    let o = org();
    let mut sql = format!(
        "INSERT INTO organizations (org_id, slug, created_at) VALUES ('{o}', 'p03-ws5', now());
         INSERT INTO org_controls (org_id, family, value) VALUES
           ('{o}', 'killswitch', '{{}}'), ('{o}', 'extern_holders', '{{\"multi_holder\": false}}'),
           ('{o}', 'restriction_epoch', '{{}}'), ('{o}', 'kiosk', '{{}}');
         INSERT INTO mailboxes (org_id, mailbox_id, owner_kind, owner_id, incarnation, state) VALUES ('{o}', '{u}', 'user', NULL, 1, 'open');",
        u = user_mb()
    );
    for (id, name, parent) in [(a(), "alpha", None), (b(), "bravo", Some(a())), (c(), "charlie", Some(b())), (d(), "delta", Some(a())), (e(), "echo", None)] {
        let p = parent.map(|p| format!("'{p}'")).unwrap_or_else(|| "NULL".into());
        sql.push_str(&format!(
            "INSERT INTO agents (org_id, principal_id, name, seat_id, tier, created_at) VALUES ('{o}', '{id}', '{name}', gen_random_uuid(), 'opus', now());
             INSERT INTO agent_names (org_id, name, principal_id, kind) VALUES ('{o}', '{name}', '{id}', 'active');
             INSERT INTO authority_epoch (org_id, principal_id, lifecycle, generation) VALUES ('{o}', '{id}', 'live', 1);
             INSERT INTO topology_edges (org_id, principal_id, parent_id) VALUES ('{o}', '{id}', {p});
             INSERT INTO runtime_state (org_id, principal_id, updated_at) VALUES ('{o}', '{id}', now());
             INSERT INTO mailboxes (org_id, mailbox_id, owner_kind, owner_id, incarnation, state) VALUES ('{o}', '{m}', 'agent', '{id}', 1, 'open');",
            m = mb(id)
        ));
    }
    admin.batch_execute(&sql).await.unwrap();
}

pub async fn admin_exec(sql: &str) {
    admin().await.batch_execute(sql).await.unwrap_or_else(|e| panic!("{sql}: {e:?}"));
}

pub async fn count(sql: &str) -> i64 {
    admin().await.query_one(sql, &[]).await.unwrap_or_else(|e| panic!("{sql}: {e:?}")).get(0)
}

pub async fn text(sql: &str) -> String {
    admin().await.query_one(sql, &[]).await.unwrap_or_else(|e| panic!("{sql}: {e:?}")).get(0)
}

pub async fn uuid_of(sql: &str) -> Uuid {
    admin().await.query_one(sql, &[]).await.unwrap_or_else(|e| panic!("{sql}: {e:?}")).get(0)
}

// ---------------------------------------------------------------- executor, hooks

#[derive(Default)]
pub struct Script {
    actions: Mutex<HashMap<(String, String), HookAction>>,
    holds: Mutex<HashMap<(String, String), (mpsc::UnboundedSender<()>, Arc<Semaphore>)>>,
}

impl Script {
    pub fn act(&self, key: &str, point: &str, a: HookAction) {
        self.actions.lock().unwrap().insert((key.into(), point.into()), a);
    }
    /// Hold operation `key` at `point` (the part after `<family>.<verb>.`):
    /// returns (arrived receiver, release semaphore).
    pub fn hold(&self, key: &str, point: &str) -> (mpsc::UnboundedReceiver<()>, Arc<Semaphore>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let sem = Arc::new(Semaphore::new(0));
        self.holds.lock().unwrap().insert((key.into(), point.into()), (tx, sem.clone()));
        (rx, sem)
    }
}

impl PauseHook for Script {
    fn at<'a>(&'a self, p: &'a PausePoint<'a>) -> BoxFuture<'a, HookAction> {
        let point = p.name.rsplit_once(&format!("{}.{}.", p.family, p.verb)).map(|x| x.1.to_string()).unwrap_or_default();
        let k = (p.op.key.clone(), point);
        let action = self.actions.lock().unwrap().remove(&k);
        let hold = self.holds.lock().unwrap().remove(&k);
        Box::pin(async move {
            if let Some((arrived, sem)) = hold {
                let _ = arrived.send(());
                let _ = sem.acquire().await.map(|p| p.forget());
            }
            action.unwrap_or(HookAction::Continue)
        })
    }
}

pub struct Arm(pub Vec<&'static str>);
impl ControlPlan for Arm {
    fn armed(&self, id: &str, _: &OpIdentity, _: Option<&str>) -> bool {
        self.0.contains(&id)
    }
}

#[derive(Default)]
pub struct Events(pub Mutex<Vec<String>>);
impl TraceSink for Events {
    fn event(&self, e: &TraceEvent<'_>) {
        let key = e.op.map(|o| o.key.clone()).unwrap_or_default();
        let s = match &e.kind {
            EventKind::ControlExecuted { id } => format!("control_executed:{id}"),
            EventKind::Retry { reason, sqlstate, .. } => format!("retry:{reason}:{}", sqlstate.unwrap_or("-")),
            EventKind::Statement { label, sqlstate: Some(s), .. } => format!("stmt_err:{label}:{s}"),
            EventKind::Commit { .. } => format!("commit:{}.{}:{key}", e.family, e.verb),
            EventKind::Outcome { outcome } => format!("outcome:{}.{}:{key}:{outcome}", e.family, e.verb),
            _ => return,
        };
        self.0.lock().unwrap().push(s);
    }
}
impl Events {
    pub fn has(&self, s: &str) -> bool {
        self.0.lock().unwrap().iter().any(|e| e == s)
    }
    pub fn any(&self, prefix: &str) -> bool {
        self.0.lock().unwrap().iter().any(|e| e.starts_with(prefix))
    }
    pub fn count_prefix(&self, prefix: &str) -> usize {
        self.0.lock().unwrap().iter().filter(|e| e.starts_with(prefix)).count()
    }
    /// Index of the first event with this exact text (commit order probes).
    pub fn pos(&self, s: &str) -> Option<usize> {
        self.0.lock().unwrap().iter().position(|e| e == s)
    }
}

pub fn executor_with(script: Arc<Script>, controls: Vec<&'static str>) -> (Executor<Factory>, Arc<Events>) {
    let cfg = PgConfig::from_url(&url("P03_PG_RUNTIME_URL")).unwrap();
    let ev = Arc::new(Events::default());
    let mut h = Hooks::with_trace(ev.clone());
    h.pause = Some(script);
    h.controls = Some(Arc::new(Arm(controls)));
    let ex = Executor::new(
        Factory::new(cfg.clone(), "executor", h.clone()),
        6,
        Factory::new(cfg, "lookup", h.clone()),
        2,
        ExecConfig { max_attempts: 8, backoff_base: Duration::from_millis(1), backoff_cap: Duration::from_millis(5), lock_timeout_ms: Some(10_000) },
        h,
    );
    (ex, ev)
}

pub fn executor(controls: Vec<&'static str>) -> (Executor<Factory>, Arc<Events>) {
    executor_with(Arc::new(Script::default()), controls)
}

pub async fn arrive(rx: &mut mpsc::UnboundedReceiver<()>) {
    tokio::time::timeout(Duration::from_secs(20), rx.recv()).await.expect("planned point never reached: interleaving not achieved");
}

// ---------------------------------------------------------------- commands

pub fn agent_binding(agent: Uuid, key: &str, fp: &str) -> Binding {
    Binding {
        principal: Principal::Agent { id: agent, generation: 1 },
        acting: None,
        op: OpIdentity { org: org(), ns: KeyNamespace::Agent { principal: agent }, key: key.into(), fingerprint: fp.into(), fingerprint_codec: "legacy-1", caller_keyed: true },
        db_incarnation: incarnation(),
        op_tag: None,
    }
}

pub fn system_binding(key: &str) -> Binding {
    Binding {
        principal: Principal::System,
        acting: None,
        op: OpIdentity { org: org(), ns: KeyNamespace::Minted, key: key.into(), fingerprint: "sys".into(), fingerprint_codec: "none", caller_keyed: false },
        db_incarnation: incarnation(),
        op_tag: None,
    }
}

pub fn agent_send(target: Target, message_id: Uuid, class: orgtree_store::sent::MailClass) -> AgentSend {
    AgentSend { target, message_id, class, kind: "message".into(), body: "hello".into(), urgent_reason: None, reply_grant: true }
}

static SYS: Family = Family { name: "test.system", isolation: Isolation::ReadCommitted, retry_unique: &[] };

/// A SYSTEM notice (the docket's notice to a previous owner, a deep-reach
/// notice): no caller anchor, no pair sequence.
pub struct SystemNotice(pub SendRequest);

pub fn system_notice(dest: Destination, id: Uuid, kind: &str) -> SystemNotice {
    SystemNotice(SendRequest::notice(MailSource::System, dest, id, kind, format!("notice {kind}"), format!("fp-{id}")))
}

impl Command for SystemNotice {
    type Output = ();
    fn family(&self) -> &'static Family {
        &SYS
    }
    fn verb(&self) -> &'static str {
        "notice"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &()) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, _b: &Binding) -> Result<Decided<()>, CmdError> {
        match sent::record_sent(tx, &self.0).await {
            Ok(_) => Ok(Decided::Applied(())),
            Err(SendError::Refused(r)) => Ok(Decided::Refused(r)),
            Err(e) => Err(e.into()),
        }
    }
}

static ISLAND: Family = Family { name: "test.island", isolation: Isolation::Serializable, retry_unique: &[] };

/// Schedule-grade island stand-ins that call WS5's P8 helpers the way WS3's
/// writers will (SERIALIZABLE): rehire's drive, delete's close, the fold.
pub enum Island {
    Drive(Uuid),
    Close(Uuid),
    Fold(Uuid),
}

impl Island {
    pub fn drive(a: Uuid) -> Island {
        Island::Drive(a)
    }
    pub fn close(a: Uuid) -> Island {
        Island::Close(a)
    }
    pub fn fold(a: Uuid) -> Island {
        Island::Fold(a)
    }
}

impl Command for Island {
    type Output = i64;
    fn family(&self) -> &'static Family {
        &ISLAND
    }
    fn verb(&self) -> &'static str {
        match self {
            Island::Drive(_) => "rehire",
            Island::Close(_) => "delete",
            Island::Fold(_) => "fold",
        }
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &i64) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<i64>, CmdError> {
        let org = b.op.org;
        Ok(Decided::Applied(match self {
            Island::Drive(a) => mailbox::drive_pending(tx, org, *a).await?.len() as i64,
            Island::Close(a) => mailbox::close_mailbox(tx, org, *a).await? as i64,
            Island::Fold(a) => mailbox::fold_notices(tx, org, *a).await?.folded as i64,
        }))
    }
}
