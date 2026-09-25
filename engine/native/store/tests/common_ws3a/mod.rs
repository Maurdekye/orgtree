#![allow(dead_code)]
//! WS3a's database-backed test fixture (`ws3a_*_pg.rs`): the schema reset on
//! THIS agent's disposable cluster, a small funded organization, an executor
//! on the runtime role with a pause hook that holds by full point name,
//! armed controls, a trace recorder, admin-side probes and a conservation
//! check. The hook/trace/executor/binding scaffolding below the "hooks" line
//! is WS4's `common_ws4` shape, copied into this test crate (test
//! scaffolding only, no family logic).
//!
//! Every DB test is `#[ignore]` and runs ONLY through the P03 run lock
//! (`artifacts\machine-test-run\p03-run.ps1` -> `artifacts\run-pg.ps1`). A
//! missing URL PANICS: a skipped DB test must never read as a pass.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use orgtree_store::conn::{Factory, PgConfig};
use orgtree_store::hooks::{BoxFuture, ControlPlan, EventKind, HookAction, Hooks, PauseHook, PausePoint, TraceEvent, TraceSink};
use orgtree_store::{Binding, ExecConfig, Executor, KeyNamespace, OpIdentity, Principal, Uuid};
use tokio::sync::{mpsc, Semaphore};

const OWN_CLUSTER: &str = "\\artifacts\\p03-db\\p03-ws3a-staffing\\";

pub fn url(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set: this DB test did NOT run (use run-pg.ps1 through p03-run.ps1)"))
}

pub fn org() -> Uuid {
    Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0003_a003)
}
fn agent_id(n: u128) -> Uuid {
    Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_003a_a000 + n)
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
pub fn mb(agent: Uuid) -> Uuid {
    Uuid::from_u128(agent.as_u128() + 0x100)
}
pub fn user_mb() -> Uuid {
    Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_003a_b0b0)
}
pub fn incarnation() -> Uuid {
    Uuid::from_u128(0x3a)
}
pub fn operator() -> Uuid {
    Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_003a_0e0e)
}

/// Seat price per tier, hundredths (catalog version 1).
pub const OPUS_CENTI: i64 = 300;
pub const SONNET_CENTI: i64 = 100;

/// The full tool grant every fixture seat holds.
pub const ALL_TOOLS: &str = r#"{"bash": true, "web": true, "edit": true, "subagents": true, "mcp": ["*"]}"#;
pub const WORK_DIR: &str = r#"[{"path": "C:\\work", "mode": "rw"}]"#;

async fn admin() -> tokio_postgres::Client {
    let (admin, conn) = tokio_postgres::connect(&url("P03_PG_ADMIN_URL"), tokio_postgres::NoTls).await.expect("admin connect");
    tokio::spawn(async move {
        let _ = conn.await;
    });
    admin
}

/// Rebuild the schema from every migration and seed the fixture org:
/// alpha(100) -> {bravo(20) -> charlie(5), delta(10)}; echo(50). Every seat
/// is opus (3.00), holds every tool and C:\work rw, visibility full,
/// acceptEdits. Capacity rows hold each payer's live child aggregate.
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
        .execute("INSERT INTO store_incarnation (database_id, incarnation) VALUES ($1, $2)", &[&Uuid::from_u128(0xdb3a), &incarnation()])
        .await
        .unwrap();
    let o = org();
    let mut sql = format!(
        "INSERT INTO organizations (org_id, slug, created_at) VALUES ('{o}', 'p03-ws3a', now());
         INSERT INTO org_controls (org_id, family, value) VALUES
           ('{o}', 'killswitch', '{{}}'), ('{o}', 'extern_holders', '{{\"multi_holder\": false}}'),
           ('{o}', 'restriction_epoch', '{{}}'), ('{o}', 'kiosk', '{{}}'), ('{o}', 'caps', '{{}}'),
           ('{o}', 'cascade', '{{}}'), ('{o}', 'defaults', '{{\"permission_mode\": \"acceptEdits\"}}'), ('{o}', 'directories', '{{}}');
         INSERT INTO mailboxes (org_id, mailbox_id, owner_kind, owner_id, incarnation, state) VALUES ('{o}', '{u}', 'user', NULL, 1, 'open');
         INSERT INTO catalog_current (org_id, catalog_version) VALUES ('{o}', 1);
         INSERT INTO price_catalog (org_id, catalog_version, tier, seat_centi) VALUES ('{o}', 1, 'opus', {OPUS_CENTI}), ('{o}', 1, 'sonnet', {SONNET_CENTI});",
        u = user_mb()
    );
    for (i, (id, name, parent, grant, depth)) in [
        (a(), "alpha", None, 10_000, 0),
        (b(), "bravo", Some(a()), 2_000, 1),
        (c(), "charlie", Some(b()), 500, 2),
        (d(), "delta", Some(a()), 1_000, 1),
        (e(), "echo", None, 5_000, 0),
    ]
    .into_iter()
    .enumerate()
    {
        let p = parent.map(|p| format!("'{p}'")).unwrap_or_else(|| "NULL".into());
        sql.push_str(&format!(
            "INSERT INTO agents (org_id, principal_id, name, seat_id, tier, created_at) VALUES ('{o}', '{id}', '{name}', gen_random_uuid(), 'opus', now() + interval '{i} second');
             INSERT INTO agent_names (org_id, name, principal_id, kind) VALUES ('{o}', '{name}', '{id}', 'active');
             INSERT INTO authority_epoch (org_id, principal_id, lifecycle, generation) VALUES ('{o}', '{id}', 'live', 1);
             INSERT INTO topology_edges (org_id, principal_id, parent_id, ord) VALUES ('{o}', '{id}', {p}, {i});
             INSERT INTO scope_rows (org_id, principal_id, depth, tools, folders, visibility, permission_mode) VALUES ('{o}', '{id}', {depth}, '{ALL_TOOLS}', '{WORK_DIR}', 'full', 'acceptEdits');
             INSERT INTO runtime_state (org_id, principal_id, updated_at) VALUES ('{o}', '{id}', now());
             INSERT INTO status_rows (org_id, principal_id) VALUES ('{o}', '{id}');
             INSERT INTO seat_config (org_id, principal_id, tier) VALUES ('{o}', '{id}', 'opus');
             INSERT INTO issuer_capacity (org_id, principal_id) VALUES ('{o}', '{id}');
             INSERT INTO funding_edges (org_id, child_id, issuer_id, tier, grant_centi) VALUES ('{o}', '{id}', {p}, 'opus', {grant});
             INSERT INTO mailboxes (org_id, mailbox_id, owner_kind, owner_id, incarnation, state) VALUES ('{o}', '{m}', 'agent', '{id}', 1, 'open');",
            m = mb(id)
        ));
    }
    sql.push_str(&format!(
        "UPDATE issuer_capacity ic SET child_grants_centi = s.g, child_seats = jsonb_build_object('opus', s.n)
           FROM (SELECT issuer_id, sum(grant_centi)::bigint AS g, count(*) AS n FROM funding_edges WHERE org_id = '{o}' AND issuer_id IS NOT NULL GROUP BY issuer_id) s
          WHERE ic.org_id = '{o}' AND ic.principal_id = s.issuer_id;"
    ));
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

pub async fn texts(sql: &str) -> Vec<String> {
    admin().await.query(sql, &[]).await.unwrap_or_else(|e| panic!("{sql}: {e:?}")).iter().map(|r| r.get(0)).collect()
}

pub async fn grant_of(x: Uuid) -> i64 {
    count(&format!("SELECT grant_centi FROM funding_edges WHERE child_id = '{x}'")).await
}

pub async fn children_of(x: Uuid) -> i64 {
    count(&format!("SELECT count(*) FROM topology_edges WHERE org_id = '{}' AND parent_id = '{x}'", org())).await
}

/// Funding conservation over the committed state (v6 I12, r7 P2): every
/// capacity row equals its live children's aggregate (grant sum and seat
/// count per tier), no live node's free is negative, no grant is
/// fractional. Empty = conserved.
pub async fn funding_violations() -> Vec<String> {
    let o = org();
    let mut v = texts(&format!(
        "WITH live AS (SELECT f.issuer_id, f.tier, f.grant_centi FROM funding_edges f JOIN authority_epoch e ON e.org_id = f.org_id AND e.principal_id = f.child_id
                        WHERE f.org_id = '{o}' AND e.lifecycle <> 'archived' AND f.issuer_id IS NOT NULL),
              g AS (SELECT issuer_id, sum(grant_centi)::bigint AS g FROM live GROUP BY issuer_id),
              s AS (SELECT issuer_id, jsonb_object_agg(tier, n) AS seats FROM (SELECT issuer_id, tier, count(*) AS n FROM live GROUP BY issuer_id, tier) t GROUP BY issuer_id)
         SELECT 'capacity of ' || a.name || ' holds ' || ic.child_grants_centi || ' ' || ic.child_seats::text || ' but children are ' || coalesce(g.g, 0) || ' ' || coalesce(s.seats, '{{}}'::jsonb)::text
           FROM issuer_capacity ic JOIN agents a ON a.org_id = ic.org_id AND a.principal_id = ic.principal_id
           LEFT JOIN g ON g.issuer_id = ic.principal_id LEFT JOIN s ON s.issuer_id = ic.principal_id
          WHERE ic.org_id = '{o}' AND (ic.child_grants_centi <> coalesce(g.g, 0)
                OR (SELECT coalesce(jsonb_object_agg(k, v), '{{}}'::jsonb) FROM jsonb_each(ic.child_seats) AS x(k, v) WHERE v::text <> '0')
                   <> coalesce(s.seats, '{{}}'::jsonb))"
    ))
    .await;
    v.extend(
        texts(&format!(
            "SELECT 'free of ' || a.name || ' is ' || (f.grant_centi - ic.child_grants_centi - coalesce((SELECT sum((s.value)::bigint * pc.seat_centi) FROM jsonb_each_text(ic.child_seats) s JOIN price_catalog pc ON pc.org_id = ic.org_id AND pc.catalog_version = 1 AND pc.tier = s.key), 0))
               FROM issuer_capacity ic JOIN funding_edges f ON f.org_id = ic.org_id AND f.child_id = ic.principal_id
               JOIN agents a ON a.org_id = ic.org_id AND a.principal_id = ic.principal_id
               JOIN authority_epoch e ON e.org_id = ic.org_id AND e.principal_id = ic.principal_id AND e.lifecycle <> 'archived'
              WHERE ic.org_id = '{o}' AND f.grant_centi - ic.child_grants_centi - coalesce((SELECT sum((s.value)::bigint * pc.seat_centi) FROM jsonb_each_text(ic.child_seats) s JOIN price_catalog pc ON pc.org_id = ic.org_id AND pc.catalog_version = 1 AND pc.tier = s.key), 0) < 0"
        ))
        .await,
    );
    v.extend(texts(&format!("SELECT 'fractional grant ' || child_id::text FROM funding_edges WHERE org_id = '{o}' AND grant_centi % 100 <> 0")).await);
    // a capacity row's aggregate against the SEATS actually under it, even
    // when the aggregate was never updated (the Q-ST2/Q-C8 control shape):
    // live child funding computed from the children themselves.
    v.extend(
        texts(&format!(
            "SELECT 'children of ' || a.name || ' cost ' || sum(fc.grant_centi + pc.seat_centi) || ' > grant ' || f.grant_centi
               FROM funding_edges f JOIN agents a ON a.org_id = f.org_id AND a.principal_id = f.child_id
               JOIN funding_edges fc ON fc.org_id = f.org_id AND fc.issuer_id = f.child_id
               JOIN authority_epoch ec ON ec.org_id = fc.org_id AND ec.principal_id = fc.child_id AND ec.lifecycle <> 'archived'
               JOIN price_catalog pc ON pc.org_id = fc.org_id AND pc.catalog_version = 1 AND pc.tier = fc.tier
              WHERE f.org_id = '{o}' GROUP BY a.name, f.grant_centi HAVING sum(fc.grant_centi + pc.seat_centi) > f.grant_centi"
        ))
        .await,
    );
    v
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


pub fn operator_binding(acting: Option<Uuid>, key: Option<&str>) -> Binding {
    let (ns, k, keyed) = match key {
        Some(k) => (KeyNamespace::Operator { operator: operator() }, k.to_string(), true),
        None => (KeyNamespace::Minted, Uuid::new_v4().to_string(), false),
    };
    Binding {
        principal: Principal::Operator { id: operator() },
        acting,
        op: OpIdentity { org: org(), ns, key: k.clone(), fingerprint: format!("fp-{k}"), fingerprint_codec: "legacy-1", caller_keyed: keyed },
        db_incarnation: incarnation(),
        op_tag: None,
    }
}

/// Is the task still running after `ms` (i.e. waiting)?
pub async fn still_waiting<T>(h: &tokio::task::JoinHandle<T>, ms: u64) -> bool {
    tokio::time::sleep(Duration::from_millis(ms)).await;
    !h.is_finished()
}

impl Events {
    /// Position of the first commit of the operation with this key.
    pub fn commit_pos(&self, key: &str) -> Option<usize> {
        self.0.lock().unwrap().iter().position(|e| e.starts_with("commit:") && e.ends_with(&format!(":{key}")))
    }
    /// The achieved commit order of these keys (each key's first commit).
    pub fn achieved(&self, keys: &[&str]) -> Vec<String> {
        let mut v: Vec<(usize, String)> = keys.iter().filter_map(|k| self.commit_pos(k).map(|p| (p, k.to_string()))).collect();
        v.sort();
        v.into_iter().map(|x| x.1).collect()
    }
}
