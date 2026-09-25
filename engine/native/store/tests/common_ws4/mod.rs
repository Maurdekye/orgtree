#![allow(dead_code)]
//! Shared fixture for WS4's database-backed tests (`ws4_*_pg.rs`): the schema
//! reset on THIS agent's disposable cluster, a small organization with
//! funding, an executor on the runtime role with a pause hook that holds by
//! point name (reads mint their own operation key), armed controls, a trace
//! recorder, and admin-side probes.
//!
//! Every DB test is `#[ignore]` and runs ONLY through the P03 run lock
//! (`artifacts\machine-test-run\p03-run.ps1` → `artifacts\run-pg.ps1`). A
//! missing URL PANICS: a skipped DB test must never read as a pass.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use orgtree_store::conn::{Factory, PgConfig};
use orgtree_store::hooks::{BoxFuture, ControlPlan, EventKind, HookAction, Hooks, PauseHook, PausePoint, TraceEvent, TraceSink};
use orgtree_store::{Binding, CmdError, Command, Decided, ExecConfig, Executor, Family, Isolation, KeyNamespace, OpIdentity, Principal, Refusal, Session, Tx, Uuid};
use tokio::sync::{mpsc, Semaphore};

const OWN_CLUSTER: &str = "\\artifacts\\p03-db\\p03-ws4-rcfamilies\\";

pub fn url(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set: this DB test did NOT run (use run-pg.ps1 through p03-run.ps1)"))
}

pub fn org() -> Uuid {
    Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0000_4004)
}
fn agent_id(n: u128) -> Uuid {
    Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0004_a000 + n)
}
/// alpha: top level, grant 100
pub fn a() -> Uuid {
    agent_id(1)
}
/// bravo: child of alpha, grant 20
pub fn b() -> Uuid {
    agent_id(2)
}
/// charlie: child of bravo, grant 5
pub fn c() -> Uuid {
    agent_id(3)
}
/// delta: child of alpha, grant 10
pub fn d() -> Uuid {
    agent_id(4)
}
/// echo: top level, grant 50
pub fn e() -> Uuid {
    agent_id(5)
}
pub fn name_of(x: Uuid) -> &'static str {
    match x {
        _ if x == a() => "alpha",
        _ if x == b() => "bravo",
        _ if x == c() => "charlie",
        _ if x == d() => "delta",
        _ if x == e() => "echo",
        _ => "?",
    }
}
pub fn mb(agent: Uuid) -> Uuid {
    Uuid::from_u128(agent.as_u128() + 0x100)
}
pub fn user_mb() -> Uuid {
    Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0004_b0b0)
}
pub fn incarnation() -> Uuid {
    Uuid::from_u128(0x4c)
}
pub fn new_id() -> Uuid {
    Uuid::new_v4()
}

/// Seat price per tier, in hundredths (catalog version 1): opus 3.00.
pub const OPUS_CENTI: i64 = 300;

async fn admin() -> tokio_postgres::Client {
    let (admin, conn) = tokio_postgres::connect(&url("P03_PG_ADMIN_URL"), tokio_postgres::NoTls).await.expect("admin connect");
    tokio::spawn(async move {
        let _ = conn.await;
    });
    admin
}

/// Rebuild the schema from every migration and seed the fixture org:
/// alpha(100) → {bravo(20) → charlie(5), delta(10)}; echo(50). Every seat is
/// opus (3.00). Capacity rows hold each payer's live child aggregate.
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
        .execute("INSERT INTO store_incarnation (database_id, incarnation) VALUES ($1, $2)", &[&Uuid::from_u128(0xdb4), &incarnation()])
        .await
        .unwrap();
    let o = org();
    let mut sql = format!(
        "INSERT INTO organizations (org_id, slug, created_at) VALUES ('{o}', 'p03-ws4', now());
         INSERT INTO org_controls (org_id, family, value) VALUES
           ('{o}', 'killswitch', '{{}}'), ('{o}', 'extern_holders', '{{\"multi_holder\": false}}'),
           ('{o}', 'restriction_epoch', '{{}}'), ('{o}', 'kiosk', '{{}}'), ('{o}', 'caps', '{{}}'),
           ('{o}', 'cascade', '{{}}'), ('{o}', 'defaults', '{{}}'), ('{o}', 'directories', '{{}}');
         INSERT INTO mailboxes (org_id, mailbox_id, owner_kind, owner_id, incarnation, state) VALUES ('{o}', '{u}', 'user', NULL, 1, 'open');
         INSERT INTO catalog_current (org_id, catalog_version) VALUES ('{o}', 1);
         INSERT INTO price_catalog (org_id, catalog_version, tier, seat_centi) VALUES ('{o}', 1, 'opus', {OPUS_CENTI}), ('{o}', 1, 'sonnet', 100);",
        u = user_mb()
    );
    for (id, name, parent, grant) in [
        (a(), "alpha", None, 10_000),
        (b(), "bravo", Some(a()), 2_000),
        (c(), "charlie", Some(b()), 500),
        (d(), "delta", Some(a()), 1_000),
        (e(), "echo", None, 5_000),
    ] {
        let p = parent.map(|p| format!("'{p}'")).unwrap_or_else(|| "NULL".into());
        sql.push_str(&format!(
            "INSERT INTO agents (org_id, principal_id, name, seat_id, tier, created_at) VALUES ('{o}', '{id}', '{name}', gen_random_uuid(), 'opus', now());
             INSERT INTO agent_names (org_id, name, principal_id, kind) VALUES ('{o}', '{name}', '{id}', 'active');
             INSERT INTO authority_epoch (org_id, principal_id, lifecycle, generation) VALUES ('{o}', '{id}', 'live', 1);
             INSERT INTO topology_edges (org_id, principal_id, parent_id) VALUES ('{o}', '{id}', {p});
             INSERT INTO scope_rows (org_id, principal_id, depth, visibility, permission_mode) VALUES ('{o}', '{id}', 0, 'team', 'default');
             INSERT INTO runtime_state (org_id, principal_id, updated_at) VALUES ('{o}', '{id}', now());
             INSERT INTO status_rows (org_id, principal_id) VALUES ('{o}', '{id}');
             INSERT INTO issuer_capacity (org_id, principal_id) VALUES ('{o}', '{id}');
             INSERT INTO funding_edges (org_id, child_id, issuer_id, tier, grant_centi) VALUES ('{o}', '{id}', {p}, 'opus', {grant});
             INSERT INTO mailboxes (org_id, mailbox_id, owner_kind, owner_id, incarnation, state) VALUES ('{o}', '{m}', 'agent', '{id}', 1, 'open');",
            m = mb(id)
        ));
    }
    // capacity aggregates = live children (grant sum, seats per tier)
    sql.push_str(&format!(
        "UPDATE issuer_capacity ic SET child_grants_centi = s.g, child_seats = jsonb_build_object('opus', s.n)
           FROM (SELECT issuer_id, sum(grant_centi)::bigint AS g, count(*) AS n FROM funding_edges WHERE org_id = '{o}' AND issuer_id IS NOT NULL GROUP BY issuer_id) s
          WHERE ic.org_id = '{o}' AND ic.principal_id = s.issuer_id;"
    ));
    admin.batch_execute(&sql).await.unwrap();
}

/// A read service's incarnation row (WS2: registrations reference
/// `service_incarnations`), then its registration for the fixture org.
pub async fn register_read_service(x: &Ex, service: Uuid) {
    admin_exec(&format!(
        "INSERT INTO service_incarnations (incarnation_id, kind, db_incarnation, liveness_pid, liveness_backend_start, started_at) \
         VALUES ('{service}', 'read-service', '{}', pg_backend_pid(), now(), now()) ON CONFLICT DO NOTHING",
        incarnation()
    ))
    .await;
    x.ex.register_read_service(org(), service).await.unwrap();
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

pub async fn opt_text(sql: &str) -> Option<String> {
    admin().await.query_one(sql, &[]).await.unwrap_or_else(|e| panic!("{sql}: {e:?}")).get(0)
}

pub async fn uuid_of(sql: &str) -> Option<Uuid> {
    admin().await.query_one(sql, &[]).await.unwrap_or_else(|e| panic!("{sql}: {e:?}")).get(0)
}

// ---------------------------------------------------------------- hooks

/// Holds and actions keyed by the FULL point name `<family>.<verb>.<point>`
/// and optionally an operation key (None = the first operation to arrive).
#[derive(Default)]
pub struct Script {
    actions: Mutex<HashMap<(Option<String>, String), HookAction>>,
    holds: Mutex<HashMap<(Option<String>, String), (mpsc::UnboundedSender<u32>, Arc<Semaphore>)>>,
}

pub struct Held {
    pub arrived: mpsc::UnboundedReceiver<u32>,
    pub release: Arc<Semaphore>,
}

impl Held {
    /// Wait for the planned point; its absence fails the run.
    pub async fn arrive(&mut self) -> u32 {
        tokio::time::timeout(Duration::from_secs(20), self.arrived.recv())
            .await
            .expect("planned point never reached: interleaving not achieved")
            .expect("hold channel closed")
    }
    pub fn go(&self) {
        self.release.add_permits(1);
    }
}

impl Script {
    pub fn act(&self, key: Option<&str>, point: &str, a: HookAction) {
        self.actions.lock().unwrap().insert((key.map(str::to_string), point.into()), a);
    }
    pub fn hold(&self, key: Option<&str>, point: &str) -> Held {
        let (tx, rx) = mpsc::unbounded_channel();
        let sem = Arc::new(Semaphore::new(0));
        self.holds.lock().unwrap().insert((key.map(str::to_string), point.into()), (tx, sem.clone()));
        Held { arrived: rx, release: sem }
    }
}

impl PauseHook for Script {
    fn at<'a>(&'a self, p: &'a PausePoint<'a>) -> BoxFuture<'a, HookAction> {
        let keyed = (Some(p.op.key.clone()), p.name.to_string());
        let any = (None, p.name.to_string());
        let action = {
            let mut g = self.actions.lock().unwrap();
            g.remove(&keyed).or_else(|| g.remove(&any))
        };
        let hold = {
            let mut g = self.holds.lock().unwrap();
            g.remove(&keyed).or_else(|| g.remove(&any))
        };
        let attempt = p.attempt;
        Box::pin(async move {
            if let Some((arrived, sem)) = hold {
                let _ = arrived.send(attempt);
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

/// A compact trace: control executions, retries, statement errors, commits
/// and outcomes, each with its operation key, in emission order.
#[derive(Default)]
pub struct Events(pub Mutex<Vec<String>>, pub Mutex<HashMap<String, usize>>);
impl TraceSink for Events {
    fn event(&self, e: &TraceEvent<'_>) {
        if let EventKind::Statement { label, rows, sqlstate: None, .. } = &e.kind {
            let mut m = self.1.lock().unwrap();
            *m.entry(label.to_string()).or_default() += rows;
            *m.entry("*".to_string()).or_default() += rows;
        }
        let key = e.op.map(|o| o.key.clone()).unwrap_or_default();
        let s = match &e.kind {
            EventKind::ControlExecuted { id } => format!("control_executed:{id}"),
            EventKind::Retry { reason, sqlstate, constraint } => format!("retry:{}.{}:{key}:{reason}:{}:{}", e.family, e.verb, sqlstate.unwrap_or("-"), constraint.unwrap_or("-")),
            EventKind::Statement { label, sqlstate: Some(s), .. } => format!("stmt_err:{label}:{s}"),
            EventKind::Statement { label, sqlstate: None, .. } => format!("stmt:{label}:{key}"),
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
    pub fn pos(&self, s: &str) -> Option<usize> {
        self.0.lock().unwrap().iter().position(|e| e == s)
    }
    /// Rows returned so far by statements with this label.
    pub fn rows_of(&self, label: &str) -> usize {
        self.1.lock().unwrap().get(label).copied().unwrap_or(0)
    }
    /// Rows returned so far by every statement.
    pub fn rows_total(&self) -> usize {
        self.rows_of("*")
    }
    pub fn dump(&self) -> String {
        self.0.lock().unwrap().join("\n")
    }
}

pub struct Ex {
    pub ex: Executor<Factory>,
    pub ev: Arc<Events>,
    pub script: Arc<Script>,
}

pub fn executor(controls: Vec<&'static str>) -> Ex {
    executor_pool(controls, 8)
}

/// An executor whose command pool has `pool` connections (schedules with
/// more concurrent holders than the default pool).
pub fn executor_pool(controls: Vec<&'static str>, pool: usize) -> Ex {
    let cfg = PgConfig::from_url(&url("P03_PG_RUNTIME_URL")).unwrap();
    let ev = Arc::new(Events::default());
    let script = Arc::new(Script::default());
    let mut h = Hooks::with_trace(ev.clone());
    h.pause = Some(script.clone());
    h.controls = Some(Arc::new(Arm(controls)));
    let ex = Executor::new(
        Factory::new(cfg.clone(), "executor", h.clone()),
        pool,
        Factory::new(cfg, "lookup", h.clone()),
        2,
        ExecConfig { max_attempts: 8, backoff_base: Duration::from_millis(1), backoff_cap: Duration::from_millis(5), lock_timeout_ms: Some(10_000), statement_timeout_ms: None, idle_in_transaction_timeout_ms: None },
        h,
    );
    Ex { ex, ev, script }
}

// ---------------------------------------------------------------- bindings

pub fn agent_binding(agent: Uuid, key: &str) -> Binding {
    Binding {
        principal: Principal::Agent { id: agent, generation: 1 },
        acting: None,
        op: OpIdentity { org: org(), ns: KeyNamespace::Agent { principal: agent }, key: key.into(), fingerprint: format!("fp-{key}"), fingerprint_codec: "legacy-1", caller_keyed: true },
        db_incarnation: incarnation(),
        op_tag: None,
    }
}

pub fn user_binding(key: &str) -> Binding {
    Binding {
        principal: Principal::User,
        acting: None,
        op: OpIdentity { org: org(), ns: KeyNamespace::Minted, key: key.into(), fingerprint: format!("fp-{key}"), fingerprint_codec: "none", caller_keyed: false },
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

// ---------------------------------------------------------------- schedule-grade racing writers
//
// Stand-ins for WS3's island writers, with the real SQL and the real lock set
// of the rows WS4's schedules race (SLICE-VERBS C; every result that depends
// on them says "schedule-grade").

static ISLAND: Family = Family { name: "sg.island", isolation: Isolation::Serializable, retry_unique: &[] };
static OUTSIDE: Family = Family { name: "sg.outside", isolation: Isolation::ReadCommitted, retry_unique: &[] };

pub enum Racer {
    /// A move of `node` under `new_parent` (SERIALIZABLE; updates the moved
    /// node's edge row, as r7 C3 requires).
    Move { node: Uuid, new_parent: Option<Uuid> },
    /// A retire of `node`: its authority-epoch row FOR NO KEY UPDATE, then
    /// archived (SERIALIZABLE; P7 moots pending requests).
    Retire { node: Uuid },
    /// A halt of `node` (READ COMMITTED; updates the authority-epoch row).
    Halt { node: Uuid },
    /// A rehire of archived `node` (SERIALIZABLE; lifecycle back to live).
    Rehire { node: Uuid },
    /// A visibility narrowing of `node` (READ COMMITTED retool; records its
    /// restriction, r7 C5 step 6).
    Narrow { node: Uuid, visibility: &'static str },
    /// A PURE charter edit (Q-CR r2 N5; WS3's retool with only `charter` /
    /// `team_charter`): one new version row and the head, nothing else.
    CharterEdit { node: Uuid, kind: &'static str, body: &'static str },
    /// `mark_unrecoverable` of `node` (SERIALIZABLE; moots nothing).
    MarkUnrecoverable { node: Uuid },
    /// A hire of a new seat under `parent` (None = top level), SERIALIZABLE,
    /// with the island side of C2a P2: the payer's capacity row
    /// `FOR NO KEY UPDATE` BEFORE computing `free` from its aggregate, then
    /// updated; at the top level the kiosk pool row last (E8). No bubbling:
    /// the payer must fund the seat and grant itself.
    Hire { id: Uuid, name: &'static str, parent: Option<Uuid>, tier: &'static str, grant_centi: i64 },
}

impl Command for Racer {
    type Output = ();
    fn family(&self) -> &'static Family {
        match self {
            Racer::Halt { .. } | Racer::Narrow { .. } | Racer::CharterEdit { .. } => &OUTSIDE,
            _ => &ISLAND,
        }
    }
    fn verb(&self) -> &'static str {
        match self {
            Racer::Move { .. } => "move",
            Racer::Retire { .. } => "retire",
            Racer::Halt { .. } => "halt",
            Racer::Rehire { .. } => "rehire",
            Racer::Narrow { .. } => "narrow",
            Racer::CharterEdit { .. } => "charter_edit",
            Racer::MarkUnrecoverable { .. } => "mark_unrecoverable",
            Racer::Hire { .. } => "hire",
        }
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &()) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<()>, CmdError> {
        use orgtree_store::Val;
        let org = b.op.org;
        match self {
            Racer::Move { node, new_parent } => {
                tx.exec("sg.move.edge", "UPDATE topology_edges SET parent_id = $3, version = version + 1 WHERE org_id = $1 AND principal_id = $2", &[Val::Uuid(org), Val::Uuid(*node), Val::opt_uuid(*new_parent)]).await?;
                orgtree_store::restrict::record(tx, org, "move").await?;
            }
            Racer::Retire { node } => {
                let r = tx.exec("sg.retire.lock_epoch", "SELECT lifecycle FROM authority_epoch WHERE org_id = $1 AND principal_id = $2 FOR NO KEY UPDATE", &[Val::Uuid(org), Val::Uuid(*node)]).await?;
                if r.first().and_then(|r| r.first()).and_then(Val::as_text) != Some("live") {
                    return Ok(Decided::Refused(Refusal::new("not_live", "already archived")));
                }
                tx.exec("sg.retire.archive", "UPDATE authority_epoch SET lifecycle = 'archived', version = version + 1 WHERE org_id = $1 AND principal_id = $2", &[Val::Uuid(org), Val::Uuid(*node)]).await?;
                orgtree_store::restrict::record(tx, org, "retire").await?;
                tx.exec("sg.retire.moot", "UPDATE request_batches SET state = 'moot' WHERE org_id = $1 AND asker_id = $2 AND state = 'pending'", &[Val::Uuid(org), Val::Uuid(*node)]).await?;
                // P2: archiving frees seat and grant from the payer's obligations.
                let f = tx
                    .exec(
                        "sg.retire.edge",
                        "SELECT issuer_id, grant_centi, (SELECT tier FROM agents WHERE org_id = $1 AND principal_id = $2) FROM funding_edges WHERE org_id = $1 AND child_id = $2",
                        &[Val::Uuid(org), Val::Uuid(*node)],
                    )
                    .await?;
                if let Some(r) = f.first() {
                    if let (Some(p), Some(gc), Some(t)) = (r.first().and_then(Val::as_uuid), r.get(1).and_then(Val::as_int), r.get(2).and_then(|v| v.as_text().map(str::to_string))) {
                        tx.exec("sg.retire.lock_capacity", "SELECT 1 FROM issuer_capacity WHERE org_id = $1 AND principal_id = $2 FOR NO KEY UPDATE", &[Val::Uuid(org), Val::Uuid(p)]).await?;
                        tx.exec(
                            "sg.retire.free",
                            "UPDATE issuer_capacity SET child_grants_centi = child_grants_centi - $3, \
                             child_seats = jsonb_set(child_seats, ARRAY[$4::text], to_jsonb(coalesce((child_seats->>$4::text)::bigint, 0) - 1)), version = version + 1 \
                             WHERE org_id = $1 AND principal_id = $2",
                            &[Val::Uuid(org), Val::Uuid(p), Val::Int(gc), Val::text(t)],
                        )
                        .await?;
                    }
                }
            }
            Racer::Rehire { node } => {
                tx.exec("sg.rehire.lock_epoch", "SELECT 1 FROM authority_epoch WHERE org_id = $1 AND principal_id = $2 FOR NO KEY UPDATE", &[Val::Uuid(org), Val::Uuid(*node)]).await?;
                tx.exec("sg.rehire.epoch", "UPDATE authority_epoch SET lifecycle = 'live', generation = generation + 1, version = version + 1 WHERE org_id = $1 AND principal_id = $2", &[Val::Uuid(org), Val::Uuid(*node)]).await?;
                orgtree_store::restrict::record(tx, org, "rehire").await?;
            }
            Racer::CharterEdit { node, kind, body } => {
                let v = tx
                    .exec("sg.charter.next", "SELECT coalesce(max(version), 0) + 1 FROM charter_versions WHERE org_id = $1 AND principal_id = $2 AND charter_kind = $3", &[Val::Uuid(org), Val::Uuid(*node), Val::text(*kind)])
                    .await?
                    .first()
                    .and_then(|r| r.first())
                    .and_then(Val::as_int)
                    .unwrap_or(1);
                tx.exec(
                    "sg.charter.version",
                    "INSERT INTO charter_versions (org_id, principal_id, charter_kind, version, body, body_sha256, saved_at) VALUES ($1, $2, $3, $4, $5, md5($5), clock_timestamp())",
                    &[Val::Uuid(org), Val::Uuid(*node), Val::text(*kind), Val::Int(v), Val::text(*body)],
                )
                .await?;
                tx.exec(
                    "sg.charter.head",
                    "INSERT INTO charter_heads (org_id, principal_id, charter_kind, current_version) VALUES ($1, $2, $3, $4)                      ON CONFLICT ON CONSTRAINT charter_heads_pk DO UPDATE SET current_version = EXCLUDED.current_version",
                    &[Val::Uuid(org), Val::Uuid(*node), Val::text(*kind), Val::Int(v)],
                )
                .await?;
            }
            Racer::Narrow { node, visibility } => {
                tx.exec("sg.narrow.lock", "SELECT 1 FROM scope_rows WHERE org_id = $1 AND principal_id = $2 FOR NO KEY UPDATE", &[Val::Uuid(org), Val::Uuid(*node)]).await?;
                tx.exec("sg.narrow.scope", "UPDATE scope_rows SET visibility = $3, version = version + 1 WHERE org_id = $1 AND principal_id = $2", &[Val::Uuid(org), Val::Uuid(*node), Val::text(*visibility)]).await?;
                orgtree_store::restrict::record(tx, org, "narrow").await?;
            }
            Racer::MarkUnrecoverable { node } => {
                tx.exec("sg.mark.lock_epoch", "SELECT 1 FROM authority_epoch WHERE org_id = $1 AND principal_id = $2 FOR NO KEY UPDATE", &[Val::Uuid(org), Val::Uuid(*node)]).await?;
                tx.exec("sg.mark.epoch", "UPDATE authority_epoch SET lifecycle = 'unrecoverable', version = version + 1 WHERE org_id = $1 AND principal_id = $2", &[Val::Uuid(org), Val::Uuid(*node)]).await?;
            }
            Racer::Hire { id, name, parent, tier, grant_centi } => {
                tx.exec("sg.hire.catalog", "SELECT catalog_version FROM catalog_current WHERE org_id = $1 FOR SHARE", &[Val::Uuid(org)]).await?;
                let price = tx
                    .exec(
                        "sg.hire.price",
                        "SELECT p.seat_centi FROM price_catalog p JOIN catalog_current c ON c.org_id = p.org_id AND c.catalog_version = p.catalog_version WHERE p.org_id = $1 AND p.tier = $2",
                        &[Val::Uuid(org), Val::text(*tier)],
                    )
                    .await?
                    .first()
                    .and_then(|r| r.first())
                    .and_then(Val::as_int)
                    .unwrap_or(0);
                let need = price + grant_centi;
                match parent {
                    Some(p) => {
                        tx.exec("sg.hire.lock_capacity", "SELECT 1 FROM issuer_capacity WHERE org_id = $1 AND principal_id = $2 FOR NO KEY UPDATE", &[Val::Uuid(org), Val::Uuid(*p)]).await?;
                        tx.pause("after_capacity_lock").await?;
                        let r = tx
                            .exec(
                                "sg.hire.free",
                                "SELECT f.grant_centi - c.child_grants_centi - coalesce((SELECT sum((s.value)::bigint * pc.seat_centi) FROM jsonb_each_text(c.child_seats) s \
                                   JOIN catalog_current cc ON cc.org_id = c.org_id JOIN price_catalog pc ON pc.org_id = c.org_id AND pc.catalog_version = cc.catalog_version AND pc.tier = s.key), 0)::bigint \
                                 FROM issuer_capacity c JOIN funding_edges f ON f.org_id = c.org_id AND f.child_id = c.principal_id WHERE c.org_id = $1 AND c.principal_id = $2",
                                &[Val::Uuid(org), Val::Uuid(*p)],
                            )
                            .await?;
                        let free = r.first().and_then(|r| r.first()).and_then(Val::as_int).unwrap_or(0);
                        if free < need {
                            return Ok(Decided::Refused(Refusal::new("chain_short", format!("free {free} < need {need}"))));
                        }
                        tx.exec(
                            "sg.hire.capacity",
                            "UPDATE issuer_capacity SET child_grants_centi = child_grants_centi + $3, \
                             child_seats = jsonb_set(child_seats, ARRAY[$4::text], to_jsonb(coalesce((child_seats->>$4::text)::bigint, 0) + 1)), version = version + 1 \
                             WHERE org_id = $1 AND principal_id = $2",
                            &[Val::Uuid(org), Val::Uuid(*p), Val::Int(*grant_centi), Val::text(*tier)],
                        )
                        .await?;
                    }
                    None => {
                        let k = tx.exec("sg.hire.kiosk", "SELECT pool_centi FROM kiosk_pool WHERE org_id = $1 FOR NO KEY UPDATE", &[Val::Uuid(org)]).await?;
                        if let Some(r) = k.first() {
                            let pool = r.first().and_then(Val::as_int).unwrap_or(0);
                            let held = tx
                                .exec(
                                    "sg.hire.kiosk_held",
                                    "SELECT k.top_grants_centi + coalesce((SELECT sum((s.value)::bigint * pc.seat_centi) FROM jsonb_each_text(k.top_seats) s \
                                       JOIN catalog_current cc ON cc.org_id = k.org_id JOIN price_catalog pc ON pc.org_id = k.org_id AND pc.catalog_version = cc.catalog_version AND pc.tier = s.key), 0)::bigint \
                                     FROM kiosk_pool k WHERE k.org_id = $1",
                                    &[Val::Uuid(org)],
                                )
                                .await?
                                .first()
                                .and_then(|r| r.first())
                                .and_then(Val::as_int)
                                .unwrap_or(0);
                            if held + need > pool {
                                return Ok(Decided::Refused(Refusal::new("kiosk_cap", "kiosk credit cap")));
                            }
                            tx.exec(
                                "sg.hire.kiosk_update",
                                "UPDATE kiosk_pool SET top_grants_centi = top_grants_centi + $2, \
                                 top_seats = jsonb_set(top_seats, ARRAY[$3::text], to_jsonb(coalesce((top_seats->>$3::text)::bigint, 0) + 1)), version = version + 1 WHERE org_id = $1",
                                &[Val::Uuid(org), Val::Int(*grant_centi), Val::text(*tier)],
                            )
                            .await?;
                        }
                    }
                }
                tx.exec(
                    "sg.hire.insert",
                    "WITH a AS (INSERT INTO agents (org_id, principal_id, name, seat_id, tier, created_at) VALUES ($1, $2, $3, gen_random_uuid(), $4, clock_timestamp()) RETURNING 1), \
                     n AS (INSERT INTO agent_names (org_id, name, principal_id, kind) SELECT $1, $3, $2, 'active' FROM a RETURNING 1), \
                     e AS (INSERT INTO authority_epoch (org_id, principal_id, lifecycle, generation) SELECT $1, $2, 'live', 1 FROM a RETURNING 1), \
                     t AS (INSERT INTO topology_edges (org_id, principal_id, parent_id) SELECT $1, $2, $5 FROM a RETURNING 1), \
                     f AS (INSERT INTO funding_edges (org_id, child_id, issuer_id, tier, grant_centi) SELECT $1, $2, $5, $4, $6 FROM a RETURNING 1), \
                     c AS (INSERT INTO issuer_capacity (org_id, principal_id) SELECT $1, $2 FROM a RETURNING 1) \
                     SELECT count(*) FROM a",
                    &[Val::Uuid(org), Val::Uuid(*id), Val::text(*name), Val::text(*tier), Val::opt_uuid(*parent), Val::Int(*grant_centi)],
                )
                .await?;
            }

            Racer::Halt { node } => {
                tx.exec("sg.halt.epoch", "UPDATE authority_epoch SET halted = true, version = version + 1 WHERE org_id = $1 AND principal_id = $2", &[Val::Uuid(org), Val::Uuid(*node)]).await?;
            }
        }
        Ok(Decided::Applied(()))
    }
}

/// Run `f` while `h` holds its operation (after the planned point is
/// reached), keep holding for `hold_ms`, then release. Returns `f`'s output
/// and whether `f` finished BEFORE the release — i.e. did not wait on the
/// held transaction. Nothing is cancelled: a waiting `f` completes after the
/// release, so no connection is dropped mid-transaction.
pub async fn while_held<F: std::future::Future>(h: &mut Held, hold_ms: u64, f: F) -> (F::Output, bool) {
    use std::sync::atomic::{AtomicBool, Ordering};
    h.arrive().await;
    let released = AtomicBool::new(false);
    let run = async {
        let o = f.await;
        (o, !released.load(Ordering::SeqCst))
    };
    let rel = async {
        tokio::time::sleep(Duration::from_millis(hold_ms)).await;
        released.store(true, Ordering::SeqCst);
        h.go();
    };
    let (out, ()) = tokio::join!(run, rel);
    out
}

// ---------------------------------------------------------------- funding invariants (v6 I12)

/// Every payer's conservation and aggregate facts, from the committed state:
/// violations as readable strings (empty = conservation holds everywhere).
/// For each node P: live children's grants plus priced seats never exceed
/// P's grant (no negative `free`); P's capacity row equals its live
/// children's grant sum and per-tier seat counts; no grant is fractional.
pub async fn funding_violations() -> Vec<String> {
    let c = admin().await;
    let rows = c
        .query(
            "SELECT a.name, f.grant_centi, ic.child_grants_centi, ic.child_seats,
                    coalesce((SELECT sum(cf.grant_centi) FROM topology_edges ct JOIN authority_epoch ce ON ce.org_id = ct.org_id AND ce.principal_id = ct.principal_id
                              JOIN funding_edges cf ON cf.org_id = ct.org_id AND cf.child_id = ct.principal_id
                              WHERE ct.org_id = a.org_id AND ct.parent_id = a.principal_id AND ce.lifecycle <> 'archived'), 0)::bigint AS kid_grants,
                    coalesce((SELECT sum(p.seat_centi) FROM topology_edges ct JOIN authority_epoch ce ON ce.org_id = ct.org_id AND ce.principal_id = ct.principal_id
                              JOIN agents ca ON ca.org_id = ct.org_id AND ca.principal_id = ct.principal_id
                              JOIN catalog_current cc ON cc.org_id = ct.org_id JOIN price_catalog p ON p.org_id = ct.org_id AND p.catalog_version = cc.catalog_version AND p.tier = ca.tier
                              WHERE ct.org_id = a.org_id AND ct.parent_id = a.principal_id AND ce.lifecycle <> 'archived'), 0)::bigint AS kid_seats,
                    coalesce((SELECT jsonb_object_agg(tier, n) FROM (SELECT ca.tier, count(*) AS n FROM topology_edges ct JOIN authority_epoch ce ON ce.org_id = ct.org_id AND ce.principal_id = ct.principal_id
                              JOIN agents ca ON ca.org_id = ct.org_id AND ca.principal_id = ct.principal_id
                              WHERE ct.org_id = a.org_id AND ct.parent_id = a.principal_id AND ce.lifecycle <> 'archived' GROUP BY ca.tier) x), '{}'::jsonb) AS kid_tiers
             FROM agents a JOIN funding_edges f ON f.org_id = a.org_id AND f.child_id = a.principal_id
             JOIN issuer_capacity ic ON ic.org_id = a.org_id AND ic.principal_id = a.principal_id ORDER BY a.name",
            &[],
        )
        .await
        .unwrap();
    let mut out = Vec::new();
    for r in rows {
        let name: String = r.get(0);
        let grant: i64 = r.get(1);
        let agg: i64 = r.get(2);
        let seats: serde_json::Value = r.get(3);
        let kid_grants: i64 = r.get(4);
        let kid_seats: i64 = r.get(5);
        let kid_tiers: serde_json::Value = r.get(6);
        if grant % 100 != 0 {
            out.push(format!("{name}: fractional grant {grant}"));
        }
        if kid_grants + kid_seats > grant {
            out.push(format!("{name}: obligations {} exceed grant {grant} (free {})", kid_grants + kid_seats, grant - kid_grants - kid_seats));
        }
        if agg != kid_grants {
            out.push(format!("{name}: capacity aggregate {agg} != live children's grants {kid_grants}"));
        }
        let norm = |v: &serde_json::Value| -> std::collections::BTreeMap<String, i64> {
            v.as_object().map(|m| m.iter().filter_map(|(k, x)| x.as_i64().filter(|n| *n != 0).map(|n| (k.clone(), n))).collect()).unwrap_or_default()
        };
        if norm(&seats) != norm(&kid_tiers) {
            out.push(format!("{name}: capacity seats {seats} != live children {kid_tiers}"));
        }
    }
    out
}

pub async fn grant_of(x: Uuid) -> i64 {
    count(&format!("SELECT grant_centi FROM funding_edges WHERE child_id = '{x}'")).await
}
