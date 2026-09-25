//! A qualification HOST for the achieved-order comparator on a WS1 dev cluster.
//!
//! It runs WS2's REAL harness endpoint (`orgtree_store_service::harness`:
//! `HarnessState` as the executor's pause hook and control plan, served by
//! `harness::serve`) and WS2's real channel server (`server::serve`) in-process,
//! over an executor on this agent's disposable cluster, with the WS7
//! `Collector` as the trace sink. The Python harness
//! (`tools/p03/harness/service_channel.py`, driven by
//! `tools/p03/probes/order_live_check.py`) connects to both. The ARRIVED frames it
//! judges come from the executor's own pause points, and the releases it sends
//! go through WS2's hold logic. This file only PRODUCES a live service; every
//! verdict is the Python side's.
//!
//! The channel handler is test-only. WS2's service has no command verbs yet (WS3-WS5
//! add them), and its `finished` frame carries no records yet, so this host serves:
//! - `status.set` {status, serializable}: WS2's SetStatus shape (tests/pg.rs), with
//!   the binding's `op_tag`;
//! - `qual.reset` {run}: rebuild the schema, reseed, and start a fresh executor and
//!   `Collector` (stream `order-<run>`) for one order;
//! - `qual.trace_drain` / `qual.trace_end`: the collector's records (end = drain,
//!   then the stream's closing records);
//! - `qual.kill` {pid}: `pg_terminate_backend` (the harness-side kill of M1 §3);
//! - `qual.waits`: the server's lock-wait view (pg_blocking_pids);
//! - `qual.state`: the seeded agent's `runtime_state.version`, applied receipts and
//!   intents, read back through the admin connection;
//! - `qual.stop`: end the host.
//!
//! It writes `host.json` (ports and per-run tokens, loopback only) into
//! P03_WS7_OUT and removes it on stop. `#[ignore]`: run ONLY through the P03 run
//! lock, with P03_PG_ADMIN_URL / P03_PG_RUNTIME_URL from `devdb.cmd env`. A
//! missing variable PANICS. It rebuilds the `public` schema, so it refuses any
//! cluster whose data directory is not this agent's disposable one.
#![cfg(feature = "sink")]

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use orgtree_store::conn::{Factory, PgConfig};
use orgtree_store::hooks::Hooks;
use orgtree_store::{
    Binding, CmdError, Command, Decided, ExecConfig, Executor, Family, Isolation, KeyNamespace, OpIdentity,
    Principal, Refusal, Session, Tx, Uuid, Val,
};
use orgtree_store_service::harness::{self, HarnessState, PROTOCOL};
use orgtree_store_service::proto::{Handshake, Request};
use orgtree_store_service::server::{self, Handler};
use orgtree_store_trace::sink::Collector;
use serde_json::{json, Value};
use tokio::sync::{Mutex, Notify};

const OWN_CLUSTER: &str = "\\artifacts\\p03-db\\p02-contacts-opus55\\";
/// how long the host serves before giving up on a driver that never said stop
const HOST_LIFETIME: Duration = Duration::from_secs(600);

fn var(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set: this DB test did NOT run"))
}

fn org() -> Uuid {
    Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0000_0702)
}
fn agent() -> Uuid {
    Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0000_07a2)
}
fn incarnation() -> Uuid {
    Uuid::from_u128(0x7d)
}

// ---- the command: WS2's SetStatus (tests/pg.rs), READ COMMITTED or SERIALIZABLE

static STATUS: Family = Family { name: "status", isolation: Isolation::ReadCommitted, retry_unique: &[] };
static STATUS_SER: Family = Family { name: "status", isolation: Isolation::Serializable, retry_unique: &[] };
const ANCHOR: &str = "SELECT lifecycle, generation FROM authority_epoch WHERE org_id = $1 AND principal_id = $2 FOR SHARE";
const LOCK_OWN: &str = "SELECT version FROM runtime_state WHERE org_id = $1 AND principal_id = $2 FOR NO KEY UPDATE";
const UPDATE: &str = "UPDATE runtime_state SET busy = ($3 <> ''), version = version + 1, \
     updated_at = to_timestamp($4::double precision / 1000000) WHERE org_id = $1 AND principal_id = $2 RETURNING version";
const INTENT: &str = "INSERT INTO outgoing_intents (org_id, intent_id, kind, source_ref, dest_ref, due_at, created_at) \
     VALUES ($1, gen_random_uuid(), 'notify', $2, NULL, now(), now())";
const LABELS: &[&str] = &["status.anchor", "status.lock_own", "status.update", "status.intent"];

struct SetStatus {
    status: String,
    serializable: bool,
}

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
        let rows = tx
            .exec("status.update", UPDATE, &[Val::Uuid(b.op.org), Val::Uuid(id), Val::text(&self.status), Val::Int(now)])
            .await?;
        tx.exec("status.intent", INTENT, &[Val::Uuid(b.op.org), Val::Uuid(id)]).await?;
        Ok(Decided::Applied(rows.first().and_then(|r| r.first()).and_then(Val::as_int).unwrap_or(-1)))
    }
}

/// The handshake's points: the generic set plus every statement label of status.set.
fn points() -> Vec<String> {
    let mut out: Vec<String> = orgtree_store_service::handler::GENERIC_POINTS.iter().map(|p| format!("status.set.{p}")).collect();
    for l in LABELS {
        out.push(format!("status.set.stmt.{l}.before"));
        out.push(format!("status.set.stmt.{l}.after"));
    }
    out
}

/// status.set's declared contacts (the shape `tools/p03/probes/qc5_live_check.py` uses).
fn declared() -> Value {
    json!({"status.set": {"relations": {
        "authority_epoch": {"modes": ["read", "for_share"], "required": true},
        "runtime_state": {"modes": ["read", "for_no_key_update", "write"], "required": true},
        "outgoing_intents": {"modes": ["write"], "required": true},
        "operation_receipts": {"modes": ["read", "write"], "required": true}},
        "p01_contract": null, "source": "live_order.rs SetStatus (WS2 tests/pg.rs shape)"}})
}

async fn admin() -> tokio_postgres::Client {
    let (c, conn) = tokio_postgres::connect(&var("P03_PG_ADMIN_URL"), tokio_postgres::NoTls).await.expect("admin connect");
    tokio::spawn(async move {
        let _ = conn.await;
    });
    c
}

/// Rebuild the schema from the migrations and seed one org, agent, epoch and runtime row.
async fn reset(a: &tokio_postgres::Client) {
    let dir: String = a.query_one("SHOW data_directory", &[]).await.unwrap().get(0);
    assert!(
        dir.replace('/', "\\").to_ascii_lowercase().contains(&OWN_CLUSTER.to_ascii_lowercase()),
        "refusing to rebuild a cluster that is not this agent's disposable one: {dir}"
    );
    a.batch_execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;").await.unwrap();
    for m in orgtree_store_schema::MIGRATIONS {
        let sql = orgtree_store_schema::normalized(m.sql);
        a.batch_execute(&format!("BEGIN;\n{sql}\nCOMMIT;")).await.unwrap_or_else(|e| panic!("{}: {e:?}", m.file));
    }
    a.execute("INSERT INTO store_incarnation (database_id, incarnation) VALUES ($1, $2)", &[&Uuid::from_u128(0xdb), &incarnation()])
        .await
        .unwrap();
    a.batch_execute(&format!(
        "INSERT INTO organizations (org_id, slug, created_at) VALUES ('{o}', 'p03-ws7-order', now());
         INSERT INTO agents (org_id, principal_id, name, seat_id, tier, created_at) VALUES ('{o}', '{g}', 'ws7', gen_random_uuid(), 'opus', now());
         INSERT INTO authority_epoch (org_id, principal_id, lifecycle, generation) VALUES ('{o}', '{g}', 'live', 3);
         INSERT INTO runtime_state (org_id, principal_id, updated_at) VALUES ('{o}', '{g}', now());",
        o = org(),
        g = agent()
    ))
    .await
    .unwrap();
}

struct Run {
    ex: Arc<Executor<Factory>>,
    collector: Arc<Collector>,
}

struct Host {
    admin: tokio_postgres::Client,
    cfg: PgConfig,
    harness: Arc<HarnessState>,
    known: BTreeSet<String>,
    run: Mutex<Option<Run>>,
    stop: Arc<Notify>,
}

fn records(v: Vec<orgtree_store_trace::stream::Record>) -> Value {
    Value::Array(v.iter().map(|r| serde_json::from_str::<Value>(&r.to_json()).expect("a record is JSON")).collect())
}

fn err(detail: impl std::fmt::Display) -> Value {
    json!({"error": "host", "detail": detail.to_string()})
}

impl Host {
    async fn current(&self) -> Option<(Arc<Executor<Factory>>, Arc<Collector>)> {
        self.run.lock().await.as_ref().map(|r| (r.ex.clone(), r.collector.clone()))
    }

    async fn reset_run(&self, run: &str) -> Value {
        let mut g = self.run.lock().await;
        *g = None; // the previous executor and its pool close before the schema is dropped
        tokio::time::sleep(Duration::from_millis(200)).await;
        reset(&self.admin).await;
        let stream = format!("order-{run}");
        let c = Arc::new(Collector::new(&stream, 1 << 16, run, self.known.clone()));
        let mut h = Hooks::with_trace(c.clone());
        h.pause = Some(self.harness.clone());
        h.controls = Some(self.harness.clone());
        let ex = Executor::new(
            Factory::new(self.cfg.clone(), "executor", h.clone()),
            4,
            Factory::new(self.cfg.clone(), "lookup", h.clone()),
            1,
            ExecConfig { max_attempts: 6, backoff_base: Duration::from_millis(1), backoff_cap: Duration::from_millis(5), ..ExecConfig::default() },
            h,
        );
        *g = Some(Run { ex: Arc::new(ex), collector: c });
        json!({"stream": stream})
    }

    async fn status_set(&self, req: &Request) -> Value {
        let Some((ex, _)) = self.current().await else { return err("no run: send qual.reset first") };
        let key = req.binding.key.clone().unwrap_or_else(|| Uuid::new_v4().simple().to_string());
        let b = Binding {
            principal: Principal::Agent { id: agent(), generation: 3 },
            acting: None,
            op: OpIdentity {
                org: org(),
                ns: KeyNamespace::Agent { principal: agent() },
                key: key.clone(),
                fingerprint: format!("fp-{key}"),
                fingerprint_codec: "legacy-1",
                caller_keyed: true,
            },
            db_incarnation: incarnation(),
            op_tag: req.binding.op_tag.clone(),
        };
        let cmd = SetStatus {
            status: req.args.get("status").and_then(Value::as_str).unwrap_or("x").to_string(),
            serializable: req.args.get("serializable").and_then(Value::as_bool).unwrap_or(false),
        };
        match ex.run(&cmd, &b).await {
            Ok(o) => json!({"outcome": o.name(), "op_key": key}),
            Err(e) => err(format!("{e:?}")),
        }
    }

    async fn waits(&self) -> Value {
        let rows = match self
            .admin
            .query(
                "SELECT w.pid, b.pid, l.relation::regclass::text, l.mode \
                 FROM pg_stat_activity w CROSS JOIN LATERAL unnest(pg_blocking_pids(w.pid)) AS b(pid) \
                 LEFT JOIN LATERAL (SELECT relation, mode FROM pg_locks WHERE pid = w.pid AND NOT granted LIMIT 1) l ON true",
                &[],
            )
            .await
        {
            Ok(r) => r,
            Err(e) => return err(e),
        };
        Value::Array(
            rows.iter()
                .map(|r| {
                    json!({"waiter_pid": r.get::<_, i32>(0), "holder_pid": r.get::<_, i32>(1),
                           "relation": r.get::<_, Option<String>>(2), "mode": r.get::<_, Option<String>>(3)})
                })
                .collect(),
        )
    }

    async fn state(&self) -> Value {
        let one = |sql: &'static str| async move { self.admin.query_one(sql, &[]).await.map(|r| r.get::<_, i64>(0)) };
        let version = self
            .admin
            .query_one("SELECT version FROM runtime_state WHERE principal_id = $1", &[&agent()])
            .await
            .map(|r| r.get::<_, i64>(0));
        match (
            version,
            one("SELECT count(*) FROM operation_receipts WHERE state = 'applied'").await,
            one("SELECT count(*) FROM outgoing_intents").await,
        ) {
            (Ok(v), Ok(r), Ok(i)) => json!({"version": v, "applied_receipts": r, "intents": i}),
            (v, r, i) => err(format!("{v:?} {r:?} {i:?}")),
        }
    }
}

impl Handler for Host {
    fn handshake(&self) -> Handshake {
        Handshake {
            protocol: orgtree_store_service::proto::PROTOCOL.into(),
            qualification: orgtree_store::hooks::QUALIFICATION,
            build_sha: "live_order.rs".into(),
            verbs: ["status.set", "qual.reset", "qual.trace_drain", "qual.trace_end", "qual.kill", "qual.waits", "qual.state", "qual.stop"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            points: points(),
            controls: orgtree_store_service::handler::CONTROLS.iter().map(|s| s.to_string()).collect(),
        }
    }

    async fn handle(&self, req: Request) -> Value {
        match req.verb.as_str() {
            "status.set" => self.status_set(&req).await,
            "qual.reset" => self.reset_run(req.args.get("run").and_then(Value::as_str).unwrap_or("run")).await,
            "qual.trace_drain" => match self.current().await {
                Some((_, c)) => json!({"records": records(c.drain())}),
                None => err("no run"),
            },
            "qual.trace_end" => match self.current().await {
                Some((_, c)) => {
                    let mut r = c.drain();
                    r.extend(c.end(true));
                    json!({"records": records(r), "stream": c.stream().name()})
                }
                None => err("no run"),
            },
            "qual.kill" => {
                // harness-side kill_backend (M1 §3): the pid an arrived frame reported
                let Some(pid) = req.args.get("pid").and_then(Value::as_i64).and_then(|p| i32::try_from(p).ok()) else {
                    return err("qual.kill needs an integer pid");
                };
                match self.admin.query_one("SELECT pg_terminate_backend($1)", &[&pid]).await {
                    Ok(r) => json!({"terminated": r.get::<_, bool>(0), "pid": pid}),
                    Err(e) => err(e),
                }
            }
            "qual.waits" => json!({"waits": self.waits().await}),
            "qual.state" => self.state().await,
            "qual.stop" => {
                self.stop.notify_one();
                json!({"stopping": true})
            }
            other => json!({"error": "unknown_verb", "verb": other}),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1, driven by order_live_check.py"]
async fn order_host() {
    let out = PathBuf::from(var("P03_WS7_OUT"));
    std::fs::create_dir_all(&out).unwrap();
    let a = admin().await;
    reset(&a).await;
    let known: BTreeSet<String> = a
        .query("SELECT tablename::text FROM pg_tables WHERE schemaname = 'public'", &[])
        .await
        .unwrap()
        .iter()
        .map(|r| r.get::<_, String>(0))
        .collect();
    assert!(known.contains("runtime_state") && known.contains("operation_receipts"), "{known:?}");
    let stop = Arc::new(Notify::new());
    let harness_state = HarnessState::new();
    let host = Arc::new(Host {
        admin: a,
        cfg: PgConfig::from_url(&var("P03_PG_RUNTIME_URL")).unwrap(),
        harness: harness_state.clone(),
        known,
        run: Mutex::new(None),
        stop: stop.clone(),
    });

    let main_l = server::bind_loopback().await.unwrap();
    let harness_l = server::bind_loopback().await.unwrap();
    let (port, harness_port) = (main_l.local_addr().unwrap().port(), harness_l.local_addr().unwrap().port());
    let (token, harness_token) = (server::new_token(), server::new_token());
    let hs = json!({"type": "handshake", "protocol": PROTOCOL, "qualification": true, "build_sha": "live_order.rs",
                    "points": points(), "controls": orgtree_store_service::handler::CONTROLS, "declared": declared()});
    tokio::spawn(server::serve(main_l, Arc::new(token.clone()), host.clone()));
    tokio::spawn(harness::serve(harness_l, Arc::new(harness_token.clone()), harness_state, hs));

    let desc = out.join("host.json");
    let body = json!({"port": port, "token": token, "harness_port": harness_port, "harness_token": harness_token,
                      "org": org(), "principal": agent(), "generation": 3, "pid": std::process::id()});
    std::fs::write(&desc, serde_json::to_vec_pretty(&body).unwrap()).unwrap();
    eprintln!("live_order host: serving (channel {port}, harness {harness_port})");
    let stopped = tokio::time::timeout(HOST_LIFETIME, stop.notified()).await.is_ok();
    let _ = std::fs::remove_file(&desc);
    *host.run.lock().await = None;
    assert!(stopped, "the driver never sent qual.stop within {HOST_LIFETIME:?}");
}
