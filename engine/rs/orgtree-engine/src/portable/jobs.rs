//! The exports, imports and duplicates that are running or have just ended
//! (docs/rust-engine/agent-export.md, "Jobs").
//!
//! An export or an import can take minutes and move gigabytes, so neither a
//! window nor an agent waits on one request for it: each is a job with an id,
//! whose progress and result are read until it ends. The user's own files (an
//! export waiting to be saved, an import being read) lie in a folder of the
//! engine's, `exports`, under the job's id; they are removed with the job,
//! a day after it ended at the latest, and at the next start whatever is
//! left of them.
//!
//! The jobs themselves are only in memory: a job that was running when the
//! engine stopped is gone, and what its import had already created stays,
//! held, to be told by its nodes' `extra.ported.parts`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, LazyLock, Mutex};

use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use super::{export, import};
use crate::engine::Engine;

/// How a job stands.
pub enum State {
    Running,
    /// An export of the user's that found secrets and stripped none: the file is there, and is
    /// handed out once the user has seen what was found (USER 2026-11-23 10:43Z).
    Confirm(Value),
    Done(Value),
    Failed { why: String, refused: bool },
}

pub struct Job {
    pub id: String,
    pub org: i64,
    /// `export`, `import` or `duplicate`.
    pub kind: &'static str,
    /// `user`, or the agent's name.
    pub by: String,
    pub started: DateTime<Utc>,
    /// The job's own file in the engine's folder, when it has one.
    pub file: Option<PathBuf>,
    /// The name the file has for whoever saves it.
    pub name: String,
    pub export: Arc<export::Progress>,
    pub import: Arc<import::Progress>,
    state: Mutex<(State, Option<DateTime<Utc>>)>,
    /// Told when the job ends.
    done: tokio::sync::Notify,
}

static JOBS: LazyLock<Mutex<HashMap<String, Arc<Job>>>> = LazyLock::new(Default::default);

/// How long an ended job and its file are kept.
const KEEP_HOURS: i64 = 24;

/// The engine's folder for the files of jobs.
#[nolog]
pub fn folder(engine: &Engine) -> PathBuf {
    engine.cfg.path("exports")
}

#[nolog]
fn jobs() -> std::sync::MutexGuard<'static, HashMap<String, Arc<Job>>> {
    JOBS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A new job. With `staged`, it gets a file of its own in the engine's folder, named `name`.
#[nolog]
pub fn start(engine: &Engine, org: i64, kind: &'static str, by: &str, name: &str, staged: bool) -> std::io::Result<Arc<Job>> {
    sweep(engine);
    let id = crate::util::uid("x");
    let file = if staged {
        let own = folder(engine).join(&id);
        std::fs::create_dir_all(&own)?;
        Some(own.join("file.zip"))
    } else {
        None
    };
    let job = Arc::new(Job { id: id.clone(), org, kind, by: by.to_string(), started: Utc::now(), file, name: name.to_string(), export: Default::default(),
                             import: Default::default(), state: Mutex::new((State::Running, None)), done: tokio::sync::Notify::new() });
    jobs().insert(id, job.clone());
    Ok(job)
}

/// The job `id` of organization `org`, when there is one.
#[nolog]
pub fn get(org: i64, id: &str) -> Option<Arc<Job>> {
    jobs().get(id).filter(|job| job.org == org).cloned()
}

/// Forget a job and take its file away.
#[nolog]
pub fn remove(engine: &Engine, job: &Job) {
    job.export.cancel.store(true, Ordering::Relaxed);
    jobs().remove(&job.id);
    let own = folder(engine).join(&job.id);
    if own.starts_with(folder(engine)) && job.id.starts_with('x') {
        let _ = std::fs::remove_dir_all(own);
    }
}

/// Ended jobs older than a day go, with their files; and so does every folder here that no
/// job owns: what a stopped engine left behind.
#[nolog]
pub fn sweep(engine: &Engine) {
    let day = chrono::Duration::hours(KEEP_HOURS);
    // ended a day ago, or a file sent up a day ago that nobody imported
    let old: Vec<Arc<Job>> = jobs()
        .values()
        .filter(|job| job.ended().is_some_and(|at| Utc::now() - at > day) || (job.kind == "import" && job.running() && job.import.total.load(Ordering::Relaxed) == 0 && Utc::now() - job.started > day))
        .cloned()
        .collect();
    for job in old {
        remove(engine, &job);
    }
    let known: Vec<String> = jobs().keys().cloned().collect();
    if let Ok(read) = std::fs::read_dir(folder(engine)) {
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('x') && !known.contains(&name) && entry.path().is_dir() {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}

#[nolog]
impl Job {
    fn ended(&self) -> Option<DateTime<Utc>> {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).1
    }

    /// The job has ended, well or not.
    pub fn end(&self, result: anyhow::Result<Value>, confirm: bool) {
        let state = match result {
            Ok(value) if confirm => State::Confirm(value),
            Ok(value) => State::Done(value),
            Err(error) => State::Failed { refused: error.downcast_ref::<crate::domain::UserError>().is_some(), why: format!("{error:#}") },
        };
        *self.state.lock().unwrap_or_else(|p| p.into_inner()) = (state, Some(Utc::now()));
        self.done.notify_waiters();
    }

    /// Wait until the job has ended, `most` at the longest.
    pub async fn wait(&self, most: std::time::Duration) {
        let ended = self.done.notified();
        tokio::pin!(ended);
        // listening before looking: an end between the two is not missed
        ended.as_mut().enable();
        if self.running() {
            let _ = tokio::time::timeout(most, ended).await;
        }
    }

    /// The user has seen what an export found: its file may be handed out.
    pub fn confirm(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        match std::mem::replace(&mut state.0, State::Running) {
            State::Confirm(value) => {
                state.0 = State::Done(value);
                true
            }
            other => {
                state.0 = other;
                false
            }
        }
    }

    /// Whether its file may be read by whoever asked for it.
    pub fn ready(&self) -> bool {
        matches!(self.state.lock().unwrap_or_else(|p| p.into_inner()).0, State::Done(_))
    }

    pub fn running(&self) -> bool {
        matches!(self.state.lock().unwrap_or_else(|p| p.into_inner()).0, State::Running)
    }

    /// What whoever watches the job is told.
    pub fn status(&self) -> Value {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let mut out = json!({ "id": self.id, "kind": self.kind, "by": self.by, "started": crate::util::iso(self.started), "name": self.name });
        if self.kind == "export" {
            out["step"] = json!(**self.export.step.load());
            out["nodes"] = json!(self.export.nodes.load(Ordering::Relaxed));
            out["total"] = json!(self.export.total.load(Ordering::Relaxed));
            out["bytes"] = json!(self.export.bytes.load(Ordering::Relaxed));
        } else {
            out["step"] = json!(**self.import.step.load());
            out["nodes"] = json!(self.import.nodes.load(Ordering::Relaxed));
            out["total"] = json!(self.import.total.load(Ordering::Relaxed));
            out["bytes"] = json!(self.import.bytes.load(Ordering::Relaxed));
            out["bytes_total"] = json!(self.import.bytes_total.load(Ordering::Relaxed));
        }
        match &state.0 {
            State::Running => out["state"] = json!("running"),
            State::Confirm(value) => {
                out["state"] = json!("confirm");
                out["result"] = value.clone();
            }
            State::Done(value) => {
                out["state"] = json!("done");
                out["result"] = value.clone();
            }
            State::Failed { why, refused } => {
                out["state"] = json!("failed");
                out["error"] = json!(why);
                out["refused"] = json!(refused);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_job_is_its_organizations_own_and_its_file_goes_with_it() {
        let root = std::env::temp_dir().join(format!("orgtree-export-jobs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let engine = Engine::for_tests(root.clone());
        let job = start(&engine, 7, "export", "user", "lead.zip", true).unwrap();
        let file = job.file.clone().unwrap();
        assert!(file.starts_with(folder(&engine)) && file.parent().unwrap().is_dir());
        std::fs::write(&file, b"zip").unwrap();
        assert!(get(7, &job.id).is_some() && get(8, &job.id).is_none() && get(7, "x-none").is_none());
        // running, then held for the user's confirmation, then ready
        assert_eq!(job.status()["state"], "running");
        assert!(job.running() && !job.ready() && !job.confirm());
        job.end(Ok(json!({ "detected": 2 })), true);
        assert_eq!((job.status()["state"].clone(), job.status()["result"]["detected"].clone()), (json!("confirm"), json!(2)));
        assert!(!job.ready() && job.confirm() && job.ready() && !job.confirm());
        assert_eq!(job.status()["state"], "done");
        // what a stopped engine left behind goes at the next job; a live job's folder stays
        let stray = folder(&engine).join("x00000000dead");
        std::fs::create_dir_all(&stray).unwrap();
        let failed = start(&engine, 7, "import", "lead", "in.zip", false).unwrap();
        assert!(!stray.exists() && file.exists() && failed.file.is_none());
        failed.end(Err(crate::domain::user_err(crate::domain::UserError::Conflict, "no room")), false);
        assert_eq!((failed.status()["state"].clone(), failed.status()["refused"].clone()), (json!("failed"), json!(true)));
        assert!(failed.status()["error"].as_str().unwrap().contains("no room"));
        remove(&engine, &job);
        remove(&engine, &failed);
        assert!(!file.exists() && get(7, &job.id).is_none());
        assert!(root.file_name().unwrap().to_string_lossy().starts_with("orgtree-export-jobs-"));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
