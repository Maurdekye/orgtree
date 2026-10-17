//! Snapshot retention deals only in paths and ownership metadata, never skill text.
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use std::sync::{Arc, Weak, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use crate::engine::Engine;

const MAX_REFERENCES: usize = 10_000;
const MAX_ENTRIES: usize = 10_000;

#[derive(Default)]
pub struct References {
    pub paths: Vec<PathBuf>,
    pub uncertain: bool,
}

#[nolog]
fn session_references(session: Option<&str>, generation: i32, record: &Value) -> References {
    let Some(session) = session else { return References::default() };
    let valid = record["session"].as_str() == Some(session)
        && record["generation"].as_i64() == Some(i64::from(generation))
        && record["known"].as_bool() == Some(true);
    let paths = record["paths"].as_array().filter(|a| a.len() <= MAX_REFERENCES)
        .and_then(|a| a.iter().map(|p| p.as_str().map(PathBuf::from)).collect::<Option<Vec<_>>>());
    match (valid, paths) {
        (true, Some(paths)) => References { paths, uncertain: false },
        _ => References { paths: vec![], uncertain: true },
    }
}

#[nolog]
fn digest(name: &str) -> bool {
    name.len() == 64 && name.bytes().all(|c| c.is_ascii_hexdigit())
}

/// Resolve an existing ancestor too: a grant to a not-yet-created descendant
/// still protects its snapshot. Resolution errors make the sweep conservative.
#[nolog]
fn real_path(path: &Path) -> anyhow::Result<PathBuf> {
    anyhow::ensure!(path.is_absolute(), "relative snapshot reference");
    let mut tail = Vec::new();
    let mut p = path;
    loop {
        match std::fs::canonicalize(p) {
            Ok(mut real) => {
                for name in tail.iter().rev() { real.push(name); }
                return Ok(real);
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tail.push(p.file_name().ok_or_else(|| anyhow::anyhow!("unresolved snapshot reference"))?.to_os_string());
                p = p.parent().ok_or_else(|| anyhow::anyhow!("unresolved snapshot ancestor"))?;
            },
            Err(e) => return Err(e.into()),
        }
    }
}

#[nolog]
fn inside(path: &Path, root: &Path) -> bool {
    crate::domain::scope::path_within(&path.to_string_lossy(), &root.to_string_lossy())
}

#[nolog]
fn entries(root: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let paths = std::fs::read_dir(root)?.take(MAX_ENTRIES + 1)
        .map(|e| e.map(|e| e.path())).collect::<Result<Vec<_>, _>>()?;
    anyhow::ensure!(paths.len() <= MAX_ENTRIES, "too many shared skill entries; cleanup skipped");
    Ok(paths)
}

#[nolog]
fn tree_bytes(root: &Path) -> anyhow::Result<u64> {
    let mut pending = vec![root.to_owned()];
    let mut bytes = 0u64;
    let mut count = 0usize;
    while let Some(dir) = pending.pop() {
        for e in std::fs::read_dir(dir)? {
            let p = e?.path();
            super::reject_link(&p)?;
            let m = std::fs::symlink_metadata(&p)?;
            count += 1;
            anyhow::ensure!(count <= 1_000_000, "snapshot cleanup traversal limit");
            if m.is_dir() { pending.push(p); } else if m.is_file() { bytes += m.len(); }
        }
    }
    Ok(bytes)
}

#[nolog]
fn prune(data: &Path, current: &str, refs: &References, observed: SystemTime, now: SystemTime) -> anyhow::Result<()> {
    if refs.uncertain { return Ok(()) }
    let root = data.join("shared-skills");
    super::reject_link(&root)?;
    let real_root = std::fs::canonicalize(&root)?;
    let used = refs.paths.iter().map(|p| real_path(p)).collect::<anyhow::Result<Vec<_>>>()?;
    let mut snapshots = Vec::new();
    let mut stages = Vec::new();
    for path in entries(&root)? {
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        if !digest(&name) && !name.starts_with(".stage-") { continue }
        let inspect = || -> anyhow::Result<Option<SystemTime>> {
            super::reject_link(&path)?;
            if !path.is_dir() { return Ok(None) }
            super::reject_link(&path.join(".orgtree-skill.json"))?;
            if !super::owned(&path) { return Ok(None) }
            let actual = std::fs::canonicalize(&path)?;
            anyhow::ensure!(actual.parent() == Some(real_root.as_path()), "snapshot outside shared-skills");
            if name.starts_with(".stage-") { return Ok(Some(std::fs::metadata(&path)?.modified()?)) }
            let complete = path.join("complete.json");
            super::reject_link(&complete)?;
            let Some(meta) = super::super::plugins::json(&complete) else { return Ok(None) };
            if meta["digest"].as_str() != Some(name.as_str()) { return Ok(None) }
            Ok(Some(std::fs::metadata(complete)?.modified()?))
        };
        match inspect() {
            Ok(Some(at)) if name.starts_with(".stage-") => stages.push((path, name, at)),
            Ok(Some(at)) => snapshots.push((path, name, at)),
            Ok(None) => {},
            Err(e) => tracing::warn!(path = %path.display(), error = %e, "shared skill candidate retained"),
        }
    }
    // A failed/incomplete current materialization can never authorize cleanup.
    if !snapshots.iter().any(|(_, name, _)| name == current) { return Ok(()) }
    let previous = snapshots.iter().filter(|(_, name, _)| name != current).map(|(_, _, at)| *at).max();
    // Retain timestamp ties too; coarse filesystems cannot prove their order.
    let old = snapshots.into_iter().filter(|(_, name, at)| name != current && Some(*at) != previous);
    let abandoned = stages.into_iter().filter(|(_, _, at)| now.duration_since(*at).is_ok_and(|age| age > Duration::from_secs(3600)));
    for (path, name, at) in old.chain(abandoned) {
        if at >= observed { continue }
        let actual = std::fs::canonicalize(&path)?;
        if used.iter().any(|p| inside(p, &actual)) { continue }
        // A live materializer's stage carries its target digest. The process's
        // token protects that digest before any staging write starts.
        if name.starts_with(".stage-") {
            let marker = super::super::plugins::json(&path.join(".orgtree-skill.json"));
            if let Some(d) = marker.as_ref().and_then(|m| m["digest"].as_str()).filter(|d| digest(d)) {
                if used.iter().any(|p| inside(p, &real_root.join(d))) { continue }
            }
        }
        let remove = || -> anyhow::Result<u64> {
            let bytes = tree_bytes(&path)?;
            super::remove_owned(&root, &path)?;
            Ok(bytes)
        };
        match remove() {
            Ok(bytes) => tracing::info!(path = %path.display(), digest = %name, bytes, "removed unused shared skill snapshot"),
            Err(e) => tracing::warn!(path = %path.display(), error = %e, "shared skill cleanup skipped"),
        }
    }
    Ok(())
}

/// One owner serializes reference registration with cleanup; no cross-agent
/// mutex/file lock. Weak tokens expire without an unbounded release queue.
#[derive(Default)]
pub struct Retention {
    tx: OnceLock<mpsc::Sender<Message>>,
    queued: AtomicBool,
}

enum Message {
    Hold(Arc<References>, oneshot::Sender<()>),
    Sweep,
    #[cfg(test)]
    PruneFixture(String, oneshot::Sender<anyhow::Result<()>>),
}

pub struct Lease {
    refs: Arc<References>,
    previous_session: Option<String>,
    generation: i32,
}

#[nolog]
fn sender(engine: &Arc<Engine>) -> mpsc::Sender<Message> {
    engine.providers.skill_retention.tx.get_or_init(|| {
        let (tx, rx) = mpsc::channel(128);
        tokio::spawn(worker(Arc::downgrade(engine), rx));
        tx
    }).clone()
}

#[nolog]
pub async fn hold(engine: &Arc<Engine>, paths: Vec<PathBuf>, previous_session: Option<String>, generation: i32) -> anyhow::Result<Lease> {
    let refs = Arc::new(References { paths, uncertain: false });
    let (tx, rx) = oneshot::channel();
    sender(engine).send(Message::Hold(refs.clone(), tx)).await
        .map_err(|_| anyhow::anyhow!("snapshot reference owner stopped"))?;
    rx.await.map_err(|_| anyhow::anyhow!("snapshot reference registration stopped"))?;
    Ok(Lease { refs, previous_session, generation })
}

#[nolog]
pub fn schedule(engine: &Arc<Engine>) {
    if engine.providers.skill_retention.queued.swap(true, Ordering::AcqRel) { return }
    if sender(engine).try_send(Message::Sweep).is_err() {
        engine.providers.skill_retention.queued.store(false, Ordering::Release);
    }
}

#[nolog]
async fn worker(engine: Weak<Engine>, mut rx: mpsc::Receiver<Message>) {
    let mut live: Vec<Weak<References>> = Vec::new();
    while let Some(message) = rx.recv().await {
        let Some(engine) = engine.upgrade() else { break };
        if engine.is_stopping() { break }
        live.retain(|r| r.strong_count() != 0);
        match message {
            Message::Hold(reference, reply) => { live.push(Arc::downgrade(&reference)); let _ = reply.send(()); },
            Message::Sweep => {
                engine.providers.skill_retention.queued.store(false, Ordering::Release);
                // Taking strong copies before the DB read protects a CLI that
                // closes while that read is in progress, including its children.
                let held: Vec<_> = live.iter().filter_map(Weak::upgrade).collect();
                if let Err(e) = sweep(&engine, &held).await {
                    tracing::warn!(error = %e, "shared skill cleanup deferred");
                }
            },
            #[cfg(test)]
            Message::PruneFixture(current, reply) => {
                let held: Vec<_> = live.iter().filter_map(Weak::upgrade).collect();
                let refs = with_held(References::default(), &held);
                let _ = reply.send(prune(&engine.cfg.data_root, &current, &refs, SystemTime::now(), SystemTime::now()));
            },
        }
    }
}

#[nolog]
async fn managed_references(engine: &Engine) -> anyhow::Result<References> {
    let client = engine.db.get().await?;
    let rows = client.query(
        "SELECT a.session_id, a.generation, a.extra->'skill_snapshot', a.scope, a.scratch_dir, o.slug, a.name
           FROM ot.agents a JOIN ot.orgs o ON o.id=a.org_id WHERE a.state='live' ORDER BY a.id LIMIT 10001", &[]).await?;
    anyhow::ensure!(rows.len() <= MAX_REFERENCES, "managed skill reference limit exceeded");
    let mut refs = References::default();
    for row in rows {
        let session: Option<String> = row.get(0);
        let record: Option<Value> = row.get(2);
        let bound = session_references(session.as_deref(), row.get(1), &record.unwrap_or(Value::Null));
        refs.uncertain |= bound.uncertain;
        refs.paths.extend(bound.paths);
        let scope: Value = row.get(3);
        refs.paths.extend(crate::domain::scope::normalize(&scope)["add_dirs"].as_array().into_iter().flatten()
            .filter_map(|d| d["path"].as_str()).map(PathBuf::from));
        let scratch: Option<String> = row.get(4);
        refs.paths.push(scratch.map(PathBuf::from).unwrap_or_else(||
            engine.cfg.scratch_root(&row.get::<_, String>(5)).join(row.get::<_, String>(6))));
        anyhow::ensure!(refs.paths.len() <= MAX_REFERENCES, "managed skill path limit exceeded");
    }
    Ok(refs)
}

#[nolog]
async fn sweep(engine: &Arc<Engine>, held: &[Arc<References>]) -> anyhow::Result<()> {
    let registry = engine.providers.skills_registry();
    let data = engine.cfg.data_root.clone();
    let current = registry.digest.clone();
    let dest = data.clone();
    tokio::task::spawn_blocking(move || registry.materialize(&dest)).await??;
    let observed = SystemTime::now();
    let refs = with_held(managed_references(engine).await?, held);
    tokio::task::spawn_blocking(move || prune(&data, &current, &refs, observed, SystemTime::now())).await??;
    Ok(())
}

#[nolog]
fn with_held(mut refs: References, held: &[Arc<References>]) -> References {
    for r in held { refs.paths.extend(r.paths.iter().cloned()); refs.uncertain |= r.uncertain; }
    if refs.paths.len() > MAX_REFERENCES { refs.uncertain = true; }
    refs
}

/// Durable current-session paths survive idle eviction and engine restart.
/// An old session without a binding conservatively adopts every existing
/// snapshot once; a genuinely new session starts with only its own paths.
#[nolog]
pub async fn remember(engine: &Engine, id: i64, lease: &Lease, session: Option<&str>) {
    let Some(session) = session else { return };
    let result = async {
        let client = engine.db.get().await?;
        let row = client.query_opt("SELECT extra->'skill_snapshot' FROM ot.agents WHERE id=$1 AND generation=$2 AND session_id=$3",
            &[&id, &lease.generation, &session]).await?;
        let Some(row) = row else { return Ok::<(), anyhow::Error>(()) };
        let record: Option<Value> = row.get(0);
        let old = session_references(Some(session), lease.generation, &record.unwrap_or(Value::Null));
        let root = real_path(&engine.cfg.path("shared-skills"))?;
        let mut paths = lease.refs.paths.iter().map(|p| real_path(p)).collect::<anyhow::Result<Vec<_>>>()?
            .into_iter().filter(|p| inside(p, &root)).collect::<Vec<_>>();
        if !old.uncertain { paths.extend(old.paths); }
        else if lease.previous_session.as_deref() == Some(session) {
            paths.extend(entries(&root)?.into_iter().filter(|p| p.file_name().is_some_and(|n| digest(&n.to_string_lossy()))));
        }
        paths.sort(); paths.dedup();
        anyhow::ensure!(paths.len() <= MAX_REFERENCES, "session skill reference limit exceeded");
        let record = json!({"session":session,"generation":lease.generation,"paths":paths,"known":true});
        client.execute("UPDATE ot.agents SET extra=jsonb_set(extra,'{skill_snapshot}',$4) WHERE id=$1 AND generation=$2 AND session_id=$3",
            &[&id, &lease.generation, &session, &record]).await?;
        Ok(())
    }.await;
    if let Err(e) = result { tracing::warn!(agent=id, error=%e, "session skill references remain uncertain"); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use std::fs::{self, File, FileTimes};

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("orgtree-skills-prune-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(p.join("shared-skills")).unwrap();
            Self(p)
        }
        fn root(&self) -> PathBuf { self.0.join("shared-skills") }
        fn snapshot(&self, n: u8) -> PathBuf {
            let p = self.root().join(format!("{n:064x}"));
            fs::create_dir(&p).unwrap();
            fs::write(p.join(".orgtree-skill.json"), br#"{"owner":"orgtree-skills-v1"}"#).unwrap();
            fs::write(p.join("complete.json"), format!(r#"{{"digest":"{n:064x}"}}"#)).unwrap();
            fs::write(p.join("asset.txt"), "retain or remove the whole owned snapshot").unwrap();
            set_age(&p.join("complete.json"), 100 - u64::from(n));
            p
        }
        fn stage(&self, name: &str, age: u64, marker: bool) -> PathBuf {
            let p = self.root().join(format!(".stage-{name}"));
            fs::create_dir(&p).unwrap();
            if marker { fs::write(p.join(".orgtree-skill.json"), br#"{"owner":"orgtree-skills-v1"}"#).unwrap(); }
            set_age(&p, age);
            p
        }
        fn prune(&self, refs: References) {
            prune(&self.0, &format!("{:064x}", 4), &refs, SystemTime::now(), SystemTime::now()).unwrap();
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) { fs::remove_dir_all(&self.0).unwrap(); }
    }
    fn set_age(p: &Path, seconds: u64) {
        let f = if p.is_dir() {
            #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; fs::OpenOptions::new().access_mode(0x100).custom_flags(0x02000000).open(p).unwrap() }
            #[cfg(not(windows))] { File::open(p).unwrap() }
        } else { fs::OpenOptions::new().write(true).open(p).unwrap() };
        f.set_times(FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(seconds))).unwrap();
    }

    #[test]
    fn skills_prune_removes_old_and_keeps_current_previous() {
        let t = Temp::new();
        let old = t.snapshot(1);
        let second = t.snapshot(2);
        let previous = t.snapshot(3);
        let current = t.snapshot(4);
        t.prune(References::default());
        assert!(!old.exists(), "unreferenced old snapshot was not pruned");
        assert!(!second.exists());
        assert!(previous.join("asset.txt").is_file());
        assert!(current.join("asset.txt").is_file());
    }

    #[test]
    fn skills_prune_keeps_nested_grants_and_unknown_use() {
        let t = Temp::new();
        let used = t.snapshot(1);
        let unused = t.snapshot(2);
        t.snapshot(3); t.snapshot(4);
        t.prune(References { paths: vec![used.join("skills")], uncertain: true });
        assert!(used.exists() && unused.exists(), "unknown managed use must retain all candidates");
        t.prune(References { paths: vec![used.join("asset.txt")], uncertain: false });
        assert!(used.exists(), "a nested granted folder protects its snapshot");
        assert!(!unused.exists(), "one referenced snapshot must not suppress other cleanup");
    }

    #[test]
    fn skills_prune_stages_require_marker_and_one_hour() {
        let t = Temp::new(); t.snapshot(4);
        let abandoned = t.stage("old", 7200, true);
        let fresh = t.stage("fresh", 1, true);
        let foreign = t.stage("foreign", 7200, false);
        let unowned = t.snapshot(1);
        fs::remove_file(unowned.join(".orgtree-skill.json")).unwrap();
        let incomplete = t.root().join(format!("{:064x}", 9));
        fs::create_dir(&incomplete).unwrap();
        fs::write(incomplete.join(".orgtree-skill.json"), br#"{"owner":"orgtree-skills-v1"}"#).unwrap();
        t.prune(References::default());
        assert!(!abandoned.exists(), "abandoned owned staging directory was not pruned");
        assert!(fresh.exists() && foreign.exists() && unowned.exists() && incomplete.exists());
    }

    #[test]
    fn skills_prune_session_bindings_survive_idle_and_reject_stale_records() {
        use serde_json::json;
        let record = json!({"session":"thread-a","generation":2,"paths":["snapshot/old"],"known":true});
        let idle = session_references(Some("thread-a"), 2, &record);
        assert_eq!(idle.paths, vec![PathBuf::from("snapshot/old")]);
        assert!(!idle.uncertain);
        assert!(session_references(Some("thread-b"), 2, &record).uncertain);
        assert!(session_references(Some("thread-a"), 3, &record).uncertain);
        assert!(session_references(Some("legacy"), 1, &json!(null)).uncertain);
        assert!(!session_references(None, 1, &json!(null)).uncertain);
        assert!(session_references(Some("thread-a"), 2,
            &json!({"session":"thread-a","generation":2,"known":true,"paths":[42]})).uncertain);
    }

    #[tokio::test]
    async fn skills_prune_worker_preserves_process_token_until_drop() {
        let t = Temp::new();
        let old = t.snapshot(1); let unused = t.snapshot(2);
        t.snapshot(3); t.snapshot(4);
        let engine = Engine::for_tests(t.0.clone());
        let lease = hold(&engine, vec![old.join("asset.txt")], Some("session".into()), 1).await.unwrap();
        let sweep = || async {
            let (tx, rx) = oneshot::channel();
            sender(&engine).send(Message::PruneFixture(format!("{:064x}", 4), tx)).await.unwrap();
            rx.await.unwrap().unwrap();
        };
        sweep().await;
        assert!(old.exists(), "registered warm-process token must protect old snapshot");
        assert!(!unused.exists());
        drop(lease);
        sweep().await;
        assert!(!old.exists(), "dead tokens must not retain snapshots forever");
        engine.request_shutdown();
    }

    #[test]
    fn skills_prune_preserves_active_stage_and_requires_complete_current() {
        let t = Temp::new(); let old = t.snapshot(1); t.snapshot(3); t.snapshot(4);
        let stage = t.stage("busy", 7200, true);
        fs::write(stage.join(".orgtree-skill.json"), format!(r#"{{"owner":"orgtree-skills-v1","digest":"{:064x}"}}"#, 1)).unwrap();
        set_age(&stage, 7200);
        t.prune(References { paths: vec![old.clone()], uncertain: false });
        assert!(stage.exists() && old.exists());
        fs::remove_file(t.root().join(format!("{:064x}", 4)).join("complete.json")).unwrap();
        t.prune(References::default());
        assert!(stage.exists() && old.exists(), "failed current materialization cannot trigger cleanup");
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn skills_prune_rejects_snapshot_and_nested_links() {
        let t = Temp::new(); t.snapshot(3); t.snapshot(4);
        let nested = t.snapshot(1);
        let outside = t.0.join("outside"); fs::create_dir(&outside).unwrap();
        fs::write(outside.join("canary"), "untouched").unwrap();
        let link = t.root().join(format!("{:064x}", 2));
        let inner = nested.join("link");
        super::super::tests::directory_link(&outside, &link);
        super::super::tests::directory_link(&outside, &inner);
        t.prune(References::default());
        assert!(nested.exists() && link.exists());
        assert_eq!(fs::read_to_string(outside.join("canary")).unwrap(), "untouched");
        #[cfg(windows)] { fs::remove_dir(&link).unwrap(); fs::remove_dir(&inner).unwrap(); }
        #[cfg(unix)] { fs::remove_file(&link).unwrap(); fs::remove_file(&inner).unwrap(); }
    }
}
