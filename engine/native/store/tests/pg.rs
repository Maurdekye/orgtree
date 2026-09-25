//! Database-backed M1 exit checks (lead rulings §6): the base schema on
//! PostgreSQL, Q-C4's core cases and Q-RL1, on a WS1 disposable dev cluster.
//!
//! Every test is `#[ignore]`: run them ONLY through the P03 run lock, with
//! `--features qualification -- --ignored --test-threads=1`, and with
//! `P03_PG_ADMIN_URL` / `P03_PG_RUNTIME_URL` from `devdb.cmd env`. A missing
//! URL PANICS (a skipped DB test must never read as a pass). Each test
//! rebuilds the `public` schema, so it refuses unless the server's data
//! directory is under `artifacts\p03-db\p03-ws2-storecore` — this agent's
//! own disposable cluster.
#![cfg(feature = "qualification")]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use orgtree_store::conn::{Factory, PgConfig};
use orgtree_store::hooks::{BoxFuture, ControlPlan, EventKind, HookAction, Hooks, PausePoint, PauseHook, TraceEvent, TraceSink};
use orgtree_store::lookup::{LookupAnswer, LookupReq};
use orgtree_store::{
    Binding, CmdError, Command, Decided, ExecConfig, Executor, Family, Isolation, KeyNamespace, OpIdentity, Outcome,
    Principal, Refusal, Session, Tx, Uuid, Val,
};
use tokio::sync::{mpsc, Semaphore};

const OWN_CLUSTER: &str = "\\artifacts\\p03-db\\p03-ws2-storecore\\";

fn url(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set: this DB test did NOT run (use devdb.cmd env and p03-run.ps1)"))
}

fn org() -> Uuid {
    Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0000_0001)
}
fn agent() -> Uuid {
    Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0000_00a1)
}
fn incarnation() -> Uuid {
    Uuid::from_u128(0x1c)
}

/// Rebuild the schema from the migrations and seed one org and one agent.
async fn reset() {
    let (admin, conn) = tokio_postgres::connect(&url("P03_PG_ADMIN_URL"), tokio_postgres::NoTls).await.expect("admin connect");
    tokio::spawn(async move {
        let _ = conn.await;
    });
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
    admin
        .batch_execute(&format!(
            "INSERT INTO organizations (org_id, slug, created_at) VALUES ('{o}', 'p03-test', now());
             INSERT INTO agents (org_id, principal_id, name, seat_id, tier, created_at) VALUES ('{o}', '{a}', 'alpha', gen_random_uuid(), 'opus', now());
             INSERT INTO authority_epoch (org_id, principal_id, lifecycle, generation) VALUES ('{o}', '{a}', 'live', 3);
             INSERT INTO runtime_state (org_id, principal_id, updated_at) VALUES ('{o}', '{a}', now());",
            o = org(),
            a = agent()
        ))
        .await
        .unwrap();
}

async fn admin_count(sql: &str) -> i64 {
    let (admin, conn) = tokio_postgres::connect(&url("P03_PG_ADMIN_URL"), tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(async move {
        let _ = conn.await;
    });
    admin.query_one(sql, &[]).await.unwrap().get(0)
}

// ---- a real command: set the caller's status and record one causal intent

static STATUS: Family = Family { name: "status", isolation: Isolation::ReadCommitted, retry_unique: &[] };
static STATUS_SER: Family = Family { name: "status", isolation: Isolation::Serializable, retry_unique: &[] };

struct SetStatus {
    status: &'static str,
    serializable: bool,
}

const ANCHOR: &str = "SELECT lifecycle, generation FROM authority_epoch WHERE org_id = $1 AND principal_id = $2 FOR SHARE";
const LOCK_OWN: &str = "SELECT version FROM runtime_state WHERE org_id = $1 AND principal_id = $2 FOR NO KEY UPDATE";
const UPDATE: &str = "UPDATE runtime_state SET status = $3, version = version + 1, \
     updated_at = to_timestamp($4::double precision / 1000000) WHERE org_id = $1 AND principal_id = $2 RETURNING version";
const INTENT: &str = "INSERT INTO outgoing_intents (org_id, intent_id, kind, source_ref, dest_ref, due_at, created_at) \
     VALUES ($1, gen_random_uuid(), 'notify', $2, NULL, now(), now())";

impl Command for SetStatus {
    type Output = i64;
    fn family(&self) -> &'static Family {
        if self.serializable {
            &STATUS_SER
        } else {
            &STATUS
        }
    }
    fn verb(&self) -> &'static str {
        "set"
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        let Principal::Agent { id, .. } = b.principal else { return Err(CmdError::Defect("agent only".into())) };
        tx.exec("status.anchor", ANCHOR, &[Val::Uuid(b.op.org), Val::Uuid(id)]).await?;
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &i64) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<i64>, CmdError> {
        let Principal::Agent { id, .. } = b.principal else { return Ok(Decided::Refused(Refusal::new("x", "x"))) };
        tx.exec("status.lock_own", LOCK_OWN, &[Val::Uuid(b.op.org), Val::Uuid(id)]).await?;
        let now = tx.now().await?;
        let rows = tx.exec("status.update", UPDATE, &[Val::Uuid(b.op.org), Val::Uuid(id), Val::text(self.status), Val::Int(now)]).await?;
        tx.exec("status.intent", INTENT, &[Val::Uuid(b.op.org), Val::Uuid(id)]).await?;
        Ok(Decided::Applied(rows.first().and_then(|r| r.first()).and_then(Val::as_int).unwrap_or(-1)))
    }
}

fn key() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
    format!("{ms}-{}", &Uuid::new_v4().simple().to_string()[..24])
}

fn binding(k: &str) -> Binding {
    Binding {
        principal: Principal::Agent { id: agent(), generation: 3 },
        acting: None,
        op: OpIdentity { org: org(), ns: KeyNamespace::Agent { principal: agent() }, key: k.into(), fingerprint: "fp-status".into(), fingerprint_codec: "legacy-1", caller_keyed: true },
        db_incarnation: incarnation(),
        op_tag: None,
    }
}

fn lookup_req(k: &str) -> LookupReq {
    LookupReq {
        op: binding(k).op,
        caller: agent(),
        caller_generation: 3,
        key_incarnation: incarnation(),
        coverage: "document".into(),
        receipted: true,
        provable_absence: true,
    }
}

// ---- a scripted pause hook: per (op key, point) actions; holds report arrival

#[derive(Default)]
struct Script {
    actions: Mutex<HashMap<(String, String), HookAction>>,
    holds: Mutex<HashMap<(String, String), (mpsc::UnboundedSender<()>, Arc<Semaphore>)>>,
}

impl Script {
    fn act(&self, key: &str, point: &str, a: HookAction) {
        self.actions.lock().unwrap().insert((key.into(), point.into()), a);
    }
    /// Hold `key` at `point`: returns (arrived receiver, release semaphore).
    fn hold(&self, key: &str, point: &str) -> (mpsc::UnboundedReceiver<()>, Arc<Semaphore>) {
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

struct Arm(Vec<&'static str>);
impl ControlPlan for Arm {
    fn armed(&self, id: &str, _: &OpIdentity, _: Option<&str>) -> bool {
        self.0.contains(&id)
    }
}

#[derive(Default)]
struct Events(Mutex<Vec<String>>);
impl TraceSink for Events {
    fn event(&self, e: &TraceEvent<'_>) {
        let s = match &e.kind {
            EventKind::ControlExecuted { id } => format!("control_executed:{id}"),
            EventKind::Retry { reason, sqlstate, .. } => format!("retry:{reason}:{}", sqlstate.unwrap_or("-")),
            EventKind::Statement { label, sqlstate: Some(s), .. } => format!("stmt_err:{label}:{s}"),
            EventKind::XactStats { tables } => format!("xact_stats:{}", tables.len()),
            EventKind::XactLocks { locks } => {
                let mut g = self.0.lock().unwrap();
                for l in locks.iter() {
                    g.push(format!("xact_lock:{}:{}", l.relname, l.mode));
                }
                return;
            }
            _ => return,
        };
        self.0.lock().unwrap().push(s);
    }
}
impl Events {
    fn has(&self, s: &str) -> bool {
        self.0.lock().unwrap().iter().any(|e| e == s)
    }
    fn any(&self, prefix: &str) -> bool {
        self.0.lock().unwrap().iter().any(|e| e.starts_with(prefix))
    }
}

fn executor(script: Arc<Script>, controls: Vec<&'static str>) -> (Executor<Factory>, Arc<Events>) {
    let cfg = PgConfig::from_url(&url("P03_PG_RUNTIME_URL")).unwrap();
    let ev = Arc::new(Events::default());
    let mut h = Hooks::with_trace(ev.clone());
    h.pause = Some(script);
    h.controls = Some(Arc::new(Arm(controls)));
    let ex = Executor::new(
        Factory::new(cfg.clone(), "executor", h.clone()),
        4,
        Factory::new(cfg, "lookup", h.clone()),
        2,
        ExecConfig { max_attempts: 6, backoff_base: Duration::from_millis(1), backoff_cap: Duration::from_millis(5), lock_timeout_ms: None },
        h,
    );
    (ex, ev)
}

async fn arrive(rx: &mut mpsc::UnboundedReceiver<()>) {
    tokio::time::timeout(Duration::from_secs(20), rx.recv()).await.expect("planned point never reached: interleaving not achieved");
}

// ================================================================ schema

#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn schema_applies_and_grants_bite() {
    reset().await;
    assert_eq!(admin_count("SELECT count(*) FROM pg_tables WHERE schemaname = 'public'").await, 39);
    let (rt, conn) = tokio_postgres::connect(&url("P03_PG_RUNTIME_URL"), tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(async move {
        let _ = conn.await;
    });
    // runtime is DML-only and receipts are retained: DELETE is refused
    let e = rt.execute("DELETE FROM operation_receipts", &[]).await.unwrap_err();
    assert_eq!(e.as_db_error().unwrap().code().code(), "42501");
    let e = rt.execute("INSERT INTO store_incarnation (database_id, incarnation) VALUES (gen_random_uuid(), gen_random_uuid())", &[]).await.unwrap_err();
    assert_eq!(e.as_db_error().unwrap().code().code(), "42501");
    let e = rt.batch_execute("CREATE TABLE sneaky (x int)").await.unwrap_err();
    assert_eq!(e.as_db_error().unwrap().code().code(), "42501");
    // the claimed-at-commit trigger refuses a committed 'claimed' receipt
    rt.batch_execute("BEGIN").await.unwrap();
    rt.execute(
        "INSERT INTO operation_receipts (org_id, ns_kind, ns_id, op_key, receipt_id, state, family, verb, fingerprint, principal_kind, db_incarnation, created_at) \
         VALUES ($1, 'agent', $2, 'k-trigger', gen_random_uuid(), 'claimed', 'status', 'set', 'fp', 'agent', $3, now())",
        &[&org(), &agent(), &incarnation()],
    )
    .await
    .unwrap();
    let e = rt.batch_execute("COMMIT").await.unwrap_err();
    assert_eq!(e.as_db_error().unwrap().code().code(), "OT001");
    assert_eq!(admin_count("SELECT count(*) FROM operation_receipts").await, 0);
}

// ================================================================ Q-C4 core

/// Injected 40001, 40P01 and allowlisted 23505 at every executor step, each
/// on its own key: one outcome, one version bump, one intent, one receipt.
#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_c4_injected_failures_at_every_step_end_in_one_outcome() {
    reset().await;
    let points = ["after_anchor", "after_claim", "stmt.status.lock_own.after", "stmt.status.update.after", "stmt.status.intent.after", "before_commit"];
    let mut runs = 0;
    for code in ["40001", "40P01", "23505"] {
        for point in points {
            let script = Arc::new(Script::default());
            let (ex, ev) = executor(script.clone(), vec![]);
            let k = key();
            script.act(&k, point, HookAction::FailNext(code.into()));
            let before = admin_count("SELECT version FROM runtime_state").await;
            let intents = admin_count("SELECT count(*) FROM outgoing_intents").await;
            let o = if code == "23505" {
                // FailNext carries no constraint name: a nameless 23505 is a
                // defect and must fail fast, never loop.
                let r = ex.run(&SetStatus { status: "busy", serializable: false }, &binding(&k)).await;
                assert!(r.is_err(), "{code} at {point}: nameless 23505 must fail fast, got {r:?}");
                assert_eq!(admin_count("SELECT version FROM runtime_state").await, before, "{code} at {point}");
                runs += 1;
                continue;
            } else {
                ex.run(&SetStatus { status: "busy", serializable: false }, &binding(&k)).await.unwrap()
            };
            assert!(matches!(o, Outcome::Applied(_)), "{code} at {point}: {o:?}");
            assert!(ev.any(&format!("retry:")), "{code} at {point}: the fault never fired");
            assert_eq!(admin_count("SELECT version FROM runtime_state").await, before + 1, "{code} at {point}: exactly one bump");
            assert_eq!(admin_count("SELECT count(*) FROM outgoing_intents").await, intents + 1, "{code} at {point}: exactly one intent");
            assert_eq!(
                admin_count(&format!("SELECT count(*) FROM operation_receipts WHERE op_key = '{k}' AND state = 'applied'")).await,
                1,
                "{code} at {point}"
            );
            runs += 1;
        }
    }
    assert_eq!(runs, 18);
}

/// A real deadlock (40P01) and a real serialization failure (40001) from
/// PostgreSQL, forced by holding two operations at their points.
#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_c4_real_serialization_failure_retries_to_one_outcome() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, ev) = executor(script.clone(), vec![]);
    let ex = Arc::new(ex);
    let (k1, k2) = (key(), key());
    // Both SERIALIZABLE, both read the row (anchor) before either writes; the
    // first writer commits while the second holds a stale snapshot.
    let (mut a1, r1) = script.hold(&k1, "after_claim");
    let (mut a2, r2) = script.hold(&k2, "after_claim");
    let e1 = ex.clone();
    let k1c = k1.clone();
    let t1 = tokio::spawn(async move { e1.run(&SetStatus { status: "one", serializable: true }, &binding(&k1c)).await });
    let e2 = ex.clone();
    let k2c = k2.clone();
    let t2 = tokio::spawn(async move { e2.run(&SetStatus { status: "two", serializable: true }, &binding(&k2c)).await });
    arrive(&mut a1).await;
    arrive(&mut a2).await;
    r1.add_permits(1);
    let o1 = t1.await.unwrap().unwrap();
    r2.add_permits(1);
    let o2 = t2.await.unwrap().unwrap();
    assert!(matches!(o1, Outcome::Applied(_)), "{o1:?}");
    assert!(matches!(o2, Outcome::Applied(_)), "{o2:?}");
    assert!(ev.has("retry:serialization_failure:40001"), "no real 40001 occurred: interleaving not achieved; events {:?}", ev.0.lock().unwrap());
    assert_eq!(admin_count("SELECT version FROM runtime_state").await, 2);
    assert_eq!(admin_count("SELECT count(*) FROM operation_receipts WHERE state = 'applied'").await, 2);
}

/// E7: a concurrent duplicate blocks on the uncommitted claim, then replays.
#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_c4_concurrent_same_key_waits_on_the_claim_then_replays() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, _) = executor(script.clone(), vec![]);
    let ex = Arc::new(ex);
    let k = key();
    let (mut arrived, release) = script.hold(&k, "after_claim");
    let e1 = ex.clone();
    let kc = k.clone();
    let first = tokio::spawn(async move { e1.run(&SetStatus { status: "x", serializable: false }, &binding(&kc)).await });
    arrive(&mut arrived).await;
    let e2 = ex.clone();
    let kc = k.clone();
    let second = tokio::spawn(async move { e2.run(&SetStatus { status: "x", serializable: false }, &binding(&kc)).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!second.is_finished(), "the duplicate must WAIT on the uncommitted claim");
    release.add_permits(1);
    let o1 = first.await.unwrap().unwrap();
    let o2 = second.await.unwrap().unwrap();
    assert_eq!(o1, Outcome::Applied(1));
    assert_eq!(o2, Outcome::Replayed(1));
    assert_eq!(admin_count("SELECT version FROM runtime_state").await, 1);
}

/// A connection dropped before COMMIT: the server rolls back, the executor
/// retries on a fresh connection with the same key.
#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_c4_dropped_connection_before_commit_retries_once() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, ev) = executor(script.clone(), vec![]);
    let k = key();
    script.act(&k, "before_commit", HookAction::DropConn);
    let o = ex.run(&SetStatus { status: "x", serializable: false }, &binding(&k)).await.unwrap();
    assert!(matches!(o, Outcome::Applied(_)), "{o:?}");
    assert!(ev.has("retry:connection_lost:-"));
    assert_eq!(admin_count("SELECT version FROM runtime_state").await, 1);
    assert_eq!(admin_count("SELECT count(*) FROM outgoing_intents").await, 1);
}

/// Q-C4 control: a retry that re-mints the identity duplicates the write when
/// the first attempt's outcome was lost — here, an attempt dropped AFTER its
/// commit reached the server is simulated by committing, then failing the
/// next statement of the same run: the control re-mints and writes again.
#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_c4_control_remint_identity_runs_twice_on_retry() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, ev) = executor(script.clone(), vec!["Q-C4.remint_identity"]);
    let k = key();
    // fail AFTER the intent insert: the attempt rolls back; a correct retry
    // reuses the key, the control re-mints it
    script.act(&k, "stmt.status.intent.after", HookAction::FailNext("40001".into()));
    let o = ex.run(&SetStatus { status: "x", serializable: false }, &binding(&k)).await.unwrap();
    assert!(ev.has("control_executed:Q-C4.remint_identity"), "control did not record that it ran");
    assert!(matches!(o, Outcome::Applied(_)));
    assert_eq!(admin_count(&format!("SELECT count(*) FROM operation_receipts WHERE op_key = '{k}'")).await, 0, "the committed receipt is NOT under the caller's key");
    // the caller's retry with its original key now executes AGAIN
    let o2 = ex.run(&SetStatus { status: "x", serializable: false }, &binding(&k)).await.unwrap();
    assert!(matches!(o2, Outcome::Applied(_)), "the unsafe control lets the same call apply twice: {o2:?}");
    assert_eq!(admin_count("SELECT version FROM runtime_state").await, 2, "duplicate write");
}

// ---- an ambiguous COMMIT: a loopback proxy forwards the client's COMMIT to
// the server, then cuts both sockets before the server's reply returns.

struct CutAfterCommit {
    port: u16,
    armed: Arc<std::sync::atomic::AtomicBool>,
    cuts: Arc<std::sync::atomic::AtomicUsize>,
}

async fn proxy(upstream_port: u16) -> CutAfterCommit {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = l.local_addr().unwrap().port();
    let armed = Arc::new(AtomicBool::new(false));
    let cuts = Arc::new(AtomicUsize::new(0));
    let (a2, c2) = (armed.clone(), cuts.clone());
    tokio::spawn(async move {
        loop {
            let Ok((client, _)) = l.accept().await else { return };
            let (armed, cuts) = (a2.clone(), c2.clone());
            tokio::spawn(async move {
                let Ok(server) = tokio::net::TcpStream::connect(("127.0.0.1", upstream_port)).await else { return };
                let (mut cr, mut cw) = client.into_split();
                let (mut sr, mut sw) = server.into_split();
                let cut = Arc::new(tokio::sync::Notify::new());
                let cut2 = cut.clone();
                let up = tokio::spawn(async move {
                    let mut buf = vec![0u8; 16384];
                    loop {
                        let n = match cr.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => n,
                        };
                        if sw.write_all(&buf[..n]).await.is_err() {
                            return;
                        }
                        // a simple-protocol COMMIT: 'Q' ... "COMMIT\0"
                        if armed.load(Ordering::SeqCst) && buf[..n].windows(7).any(|w| w == b"COMMIT\0") {
                            armed.store(false, Ordering::SeqCst);
                            cuts.fetch_add(1, Ordering::SeqCst);
                            let _ = sw.flush().await;
                            cut2.notify_one();
                            return;
                        }
                    }
                });
                let mut buf = vec![0u8; 16384];
                loop {
                    tokio::select! {
                        _ = cut.notified() => { break; }
                        r = sr.read(&mut buf) => match r {
                            Ok(0) | Err(_) => break,
                            Ok(n) => if cw.write_all(&buf[..n]).await.is_err() { break },
                        },
                    }
                }
                up.abort();
                // dropping cw closes the client side without relaying the reply
            });
        }
    });
    CutAfterCommit { port, armed, cuts }
}

fn executor_via(port: u16, controls: Vec<&'static str>) -> (Executor<Factory>, Arc<Events>) {
    let mut cfg = PgConfig::from_url(&url("P03_PG_RUNTIME_URL")).unwrap();
    cfg.port = port;
    let ev = Arc::new(Events::default());
    let mut h = Hooks::with_trace(ev.clone());
    h.pause = Some(Arc::new(Script::default()));
    h.controls = Some(Arc::new(Arm(controls)));
    let ex = Executor::new(
        Factory::new(cfg.clone(), "executor", h.clone()),
        2,
        Factory::new(cfg, "lookup", h.clone()),
        1,
        ExecConfig { max_attempts: 6, backoff_base: Duration::from_millis(1), backoff_cap: Duration::from_millis(5), lock_timeout_ms: None },
        h,
    );
    (ex, ev)
}

/// Q-C4: the connection dies DURING COMMIT (the server received it). The
/// executor resolves the unknown outcome by re-claiming the SAME key: it
/// finds the committed receipt and replays. One write, not two.
#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_c4_connection_lost_during_commit_resolves_by_same_key() {
    reset().await;
    let real = PgConfig::from_url(&url("P03_PG_RUNTIME_URL")).unwrap().port;
    let p = proxy(real).await;
    let (ex, _ev) = executor_via(p.port, vec![]);
    p.armed.store(true, std::sync::atomic::Ordering::SeqCst);
    let o = ex.run(&SetStatus { status: "x", serializable: false }, &binding(&key())).await.unwrap();
    assert_eq!(p.cuts.load(std::sync::atomic::Ordering::SeqCst), 1, "the COMMIT was never cut: the ambiguous case did not happen");
    assert_eq!(o, Outcome::Replayed(1), "resolved by the same key to the committed outcome");
    assert_eq!(admin_count("SELECT version FROM runtime_state").await, 1);
    assert_eq!(admin_count("SELECT count(*) FROM outgoing_intents").await, 1);
}

/// Q-C4 unsafe control on the same schedule: re-minting the identity on the
/// retry after an ambiguous COMMIT applies the write twice.
#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_c4_control_remint_after_lost_commit_duplicates() {
    reset().await;
    let real = PgConfig::from_url(&url("P03_PG_RUNTIME_URL")).unwrap().port;
    let p = proxy(real).await;
    let (ex, ev) = executor_via(p.port, vec!["Q-C4.remint_identity"]);
    p.armed.store(true, std::sync::atomic::Ordering::SeqCst);
    let o = ex.run(&SetStatus { status: "x", serializable: false }, &binding(&key())).await.unwrap();
    assert_eq!(p.cuts.load(std::sync::atomic::Ordering::SeqCst), 1, "the COMMIT was never cut");
    assert!(ev.has("control_executed:Q-C4.remint_identity"), "control did not record that it ran");
    assert!(matches!(o, Outcome::Applied(_)), "{o:?}");
    assert_eq!(admin_count("SELECT version FROM runtime_state").await, 2, "the unsafe control must produce the duplicate");
}

// ================================================================ Q-RL1

/// (a) the original claims first: the lookup's fence WAITS on the claim, then
/// reports `applied`.
#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_rl1_a_original_first_lookup_waits_then_applied() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, _) = executor(script.clone(), vec![]);
    let ex = Arc::new(ex);
    let k = key();
    let (mut arrived, release) = script.hold(&k, "after_claim");
    let e1 = ex.clone();
    let kc = k.clone();
    let original = tokio::spawn(async move { e1.run(&SetStatus { status: "x", serializable: false }, &binding(&kc)).await });
    arrive(&mut arrived).await;
    let (mut at_fence, fence_go) = script.hold(&k, "before_fence");
    let e2 = ex.clone();
    let kc = k.clone();
    let lookup = tokio::spawn(async move { e2.lookup(&lookup_req(&kc)).await });
    arrive(&mut at_fence).await;
    fence_go.add_permits(1);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!lookup.is_finished(), "the fence must WAIT on the uncommitted original claim");
    release.add_permits(1);
    assert_eq!(original.await.unwrap().unwrap(), Outcome::Applied(1));
    let a = lookup.await.unwrap().unwrap();
    assert!(matches!(a, LookupAnswer::Applied { .. }), "{a:?}");
}

/// (b) the lookup fences first: `not_applied`, and the original is refused
/// with nothing done.
#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_rl1_b_fence_first_original_refused() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, _) = executor(script.clone(), vec![]);
    let k = key();
    assert_eq!(ex.lookup(&lookup_req(&k)).await.unwrap(), LookupAnswer::NotApplied);
    assert_eq!(ex.run(&SetStatus { status: "x", serializable: false }, &binding(&k)).await.unwrap(), Outcome::Fenced);
    assert_eq!(admin_count("SELECT version FROM runtime_state").await, 0);
    assert_eq!(admin_count("SELECT count(*) FROM outgoing_intents").await, 0);
}

/// (c) the original's attempt fails with 40001 while the lookup waits; the
/// fence then wins, and the original's retry is refused with nothing done.
#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_rl1_c_original_fails_then_fence_wins() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, _) = executor(script.clone(), vec![]);
    let ex = Arc::new(ex);
    let k = key();
    let (mut arrived, release) = script.hold(&k, "after_claim");
    script.act(&k, "stmt.status.update.after", HookAction::FailNext("40001".into()));
    let e1 = ex.clone();
    let kc = k.clone();
    let original = tokio::spawn(async move { e1.run(&SetStatus { status: "x", serializable: false }, &binding(&kc)).await });
    arrive(&mut arrived).await;
    let e2 = ex.clone();
    let kc = k.clone();
    let lookup = tokio::spawn(async move { e2.lookup(&lookup_req(&kc)).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!lookup.is_finished(), "the fence must wait on the claim");
    release.add_permits(1);
    assert_eq!(lookup.await.unwrap().unwrap(), LookupAnswer::NotApplied);
    assert_eq!(original.await.unwrap().unwrap(), Outcome::Fenced);
    assert_eq!(admin_count("SELECT version FROM runtime_state").await, 0);
}

/// Q-RL1 unsafe control: the original writes its receipt only at the end, and
/// the lookup fences in a transaction separate from its check. With the
/// original committing between them, the caller is told `not_applied` for a
/// call that applied.
#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_rl1_control_late_receipt_and_separate_fence_lies() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, ev) = executor(script.clone(), vec!["Q-RL1.late_receipt_separate_fence"]);
    let ex = Arc::new(ex);
    let k = key();
    let (mut at_fence, fence_go) = script.hold(&k, "before_fence");
    let e2 = ex.clone();
    let kc = k.clone();
    let lookup = tokio::spawn(async move { e2.lookup(&lookup_req(&kc)).await });
    arrive(&mut at_fence).await;
    // the check has committed; the original now runs to completion
    let o = ex.run(&SetStatus { status: "x", serializable: false }, &binding(&k)).await.unwrap();
    assert!(matches!(o, Outcome::Applied(_)), "{o:?}");
    fence_go.add_permits(1);
    let a = lookup.await.unwrap().unwrap();
    assert!(ev.has("control_executed:Q-RL1.late_receipt_separate_fence"), "control did not record that it ran");
    assert_eq!(a, LookupAnswer::NotApplied, "the unsafe control must produce the lie");
    assert_eq!(admin_count(&format!("SELECT count(*) FROM operation_receipts WHERE op_key = '{k}' AND state = 'applied'")).await, 1, "yet it applied");
}

/// Qualification builds run the provisional server-side relation check.
#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn xact_stats_reports_the_relations_the_attempt_touched() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, ev) = executor(script, vec![]);
    ex.run(&SetStatus { status: "x", serializable: false }, &binding(&key())).await.unwrap();
    assert!(ev.0.lock().unwrap().iter().any(|e| e.starts_with("xact_stats:") && e != "xact_stats:0"), "{:?}", ev.0.lock().unwrap());
    // the anchor's FOR SHARE shows as a RowShareLock on authority_epoch; the
    // writes show RowExclusiveLock; no index relation is listed
    assert!(ev.has("xact_lock:authority_epoch:RowShareLock"), "{:?}", ev.0.lock().unwrap());
    assert!(ev.has("xact_lock:runtime_state:RowExclusiveLock"), "{:?}", ev.0.lock().unwrap());
    assert!(!ev.0.lock().unwrap().iter().any(|e| e.starts_with("xact_lock:") && e.contains("_pk")), "{:?}", ev.0.lock().unwrap());
}
