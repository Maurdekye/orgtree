//! What an agent gives back when it cannot run, loses a turn or leaves a
//! project (docket frozen-agents-keep-their-project-slot-leases-unt; user
//! 2026-10-27 16:14Z-16:18Z). An agent's holdings in a project are its slot
//! leases (`domain/slots.rs`) and the un-acked mail jobs of an ack-mode queue
//! (`domain/projects.rs`). They are taken back AT ONCE, with no grace period,
//! when the holder
//!
//! - is retired, halted or frozen (a usage limit, a provider refusal that
//!   freezes, no allowed account): the state-derived pass, `slots::check` and
//!   `projects::release_stale`, run by `projects::recheck_holder`;
//! - moves out of the project (it no longer reaches it): `after_move`, which also
//!   removes the mover's WAITING slot claim from the project's line and pauses its
//!   queue listener there (user 2026-10-27 18:01Z m603e6114476e, "Drop both");
//! - has a turn that dies: `release_after_death`.
//!
//! A manual interrupt (`orgtree_interrupt`, the desk's stop, Stop all), an
//! engine restart (`runtime::recover` wakes the cut turn and gives nothing
//! back; user 2026-10-27 22:04:54Z ma9d6ca993753, "also make engine restarts
//! not free slots") and an agent ending its own turn are NOT deaths: those keep today's rule, the
//! project's Ack timeout and reminders (`slots::idle_timeouts`,
//! `projects::ack_timeouts`) on the working checkup. The checkup never reaches
//! a frozen, halted or mid-turn holder, which is why those had to be released
//! on the spot (a frozen holder kept two build slots for 16 minutes).
//!
//! Released leases go to the next waiter in the normal FIFO order (`slots::grant`);
//! released jobs go back to the front of the queue under the existing
//! attempt/dead-letter rules (`projects::reclaim_in`). The holder gets one
//! passive System notice naming what was released, so it takes a new slot (or
//! waits for its job) before continuing. A frozen or halted holder reads it at
//! the turn that releases the hold. A move sends ONE notice per holder for all of
//! it (lease, job, claim, listener), collected in a batch (`BATCH`).

use std::{cell::RefCell, collections::HashMap, sync::Arc};

use anyhow::Result;

use crate::changes::{self, Change};
use crate::domain::{projects, slots};
use crate::engine::Engine;

#[cfg(test)]
mod db_tests;

/// A lease that was taken back, as the holder's notice names it.
#[derive(Debug, Clone, Default)]
pub struct GivenLease {
    pub project: String,
    pub lease: String,
    pub slots: i32,
}

/// An un-acked job that went back to its queue, as the holder's notice names it.
#[derive(Debug, Clone, Default)]
pub struct GivenJob {
    pub project: String,
    /// the mail as the holder saw it (the copy it was handed)
    pub job: String,
    /// it had used its last attempt: it went to the project's dead letters
    pub dead: bool,
}

/// A claim that stood in a project's slot line and was removed from it, as the
/// holder's notice names it (an agent that moved out of the project).
#[derive(Debug, Clone, Default)]
pub struct GivenClaim {
    pub project: String,
    pub claim: String,
}

/// A project queue listener that was paused, as the holder's notice names it
/// (an agent that moved out of the project).
#[derive(Debug, Clone, Default)]
pub struct GivenListener {
    pub project: String,
    pub listener: String,
}

/// Everything one release took back from one holder.
#[derive(Debug, Clone, Default)]
pub struct Given {
    pub leases: Vec<GivenLease>,
    pub jobs: Vec<GivenJob>,
    pub claims: Vec<GivenClaim>,
    pub listeners: Vec<GivenListener>,
}

impl Given {
    #[nolog]
    pub fn is_empty(&self) -> bool {
        self.leases.is_empty() && self.jobs.is_empty() && self.claims.is_empty() && self.listeners.is_empty()
    }

    /// Add what `other` took back to this.
    #[nolog]
    fn merge(&mut self, other: Given) {
        self.leases.extend(other.leases);
        self.jobs.extend(other.jobs);
        self.claims.extend(other.claims);
        self.listeners.extend(other.listeners);
    }
}

/// How a turn ended, for the one question holdings ask of it: did it die?
#[derive(Debug, Clone, Copy, Default)]
pub struct Ending<'a> {
    /// a manual interrupt (`orgtree_interrupt`, the desk's stop, Stop all, a halt)
    pub interrupted: bool,
    /// a context-compaction turn, not the agent's own work
    pub compact: bool,
    /// the user's Windows session ended and took the CLI with it
    pub session_ended: bool,
    /// the turn's error: the idle or time watchdog, the CLI exiting, a provider or harness failure
    pub error: Option<&'a str>,
    /// a usage-limit refusal
    pub limited: bool,
    /// the agent was frozen at the end of this turn
    pub frozen: bool,
    /// ... and that freeze is the short retry of a request-rate 429 (a usage limit it is not)
    pub rate_limited: bool,
}

/// Why an agent's holdings were taken back for a dead turn: what the lease
/// history records, the third-person reason a job's record keeps (and a dead
/// letter names), and what the holder is told.
#[derive(Debug, Clone)]
pub struct Death {
    pub how: &'static str,
    pub why: String,
    pub because: String,
}

/// Did this turn die? `None` for one that did not: it finished, the agent ended
/// it deliberately (also asking for a restart), it was interrupted by hand, or
/// it was a compaction.
#[nolog]
pub fn died(end: &Ending) -> Option<Death> {
    if end.interrupted || end.compact {
        return None;
    }
    if end.rate_limited && !end.limited {
        return Some(Death { how: HOW_FROZEN,
                            why: "its turn was stopped by the provider's request-rate limit (HTTP 429) and it was frozen for a short retry".into(),
                            because: "your turn was stopped by the provider's request-rate limit (HTTP 429) and you were frozen for a short retry".into() });
    }
    if end.limited || end.frozen {
        return Some(Death { how: HOW_FROZEN, why: "its turn was stopped by a usage limit and it was frozen".into(),
                            because: "your turn was stopped by a usage limit and you were frozen".into() });
    }
    if end.session_ended {
        return Some(Death { how: HOW_DIED, why: "the user's Windows session ended during its turn".into(),
                            because: "the user's Windows session ended during your turn and took your CLI with it".into() });
    }
    end.error.map(|e| Death { how: HOW_DIED, why: format!("its turn ended abnormally ({})", gist(e)),
                              because: format!("your turn ended abnormally ({})", gist(e)) })
}

/// What the lease history records for a lease taken back because its holder
/// was frozen, or because its turn died.
pub const HOW_FROZEN: &str = "frozen";
pub const HOW_DIED: &str = "turn ended abnormally";
/// ... because the holder moved out of the project.
pub const HOW_MOVED_OUT: &str = "moved out of the project";
/// What a waiting slot claim records (`reason`) when its owner moved out of the project.
const CLAIM_REASON: &str = "removed from the line: its owner moved out of the project";
/// What a queue listener records (`paused_why`) when its owner moved out of the project.
const LISTENER_WHY: &str = "its owner moved out of the project; resume it when it should listen again";

/// A short, single-line form of an error text for a notice.
#[nolog]
fn gist(text: &str) -> String {
    let one: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut cut: String = one.chars().take(160).collect();
    if one.chars().count() > 160 {
        cut.push('…');
    }
    cut
}

/// A reclaim's third-person reason ("was halted", "moved out of the project")
/// as the second-person clause a notice to the holder reads.
#[nolog]
pub fn you(why: &str) -> String {
    match why.strip_prefix("was ") {
        Some(rest) => format!("you were {rest}"),
        None => format!("you {why}"),
    }
}

/// The notice a holder reads at its next turn: what was released and what to do.
#[nolog]
pub fn notice_body(because: &str, given: &Given) -> String {
    let mut out = format!("Orgtree took back what you held in projects because {because}.");
    if !given.leases.is_empty() {
        out.push_str("\n\nConcurrency slot leases released (their slots are free again and the project's FIFO line was checked):");
        for l in &given.leases {
            out.push_str(&format!("\n- {} of project {} (lease {})", slots::quantity(l.slots), l.project, l.lease));
        }
    }
    if !given.jobs.is_empty() {
        out.push_str("\n\nProject mail jobs sent back to the front of the queue:");
        for j in &given.jobs {
            let job = if j.job.is_empty() { "a job".to_string() } else { format!("mail {}", j.job) };
            out.push_str(&format!("\n- {job} of project {}{}", j.project,
                if j.dead { " (its last attempt: it went to the project's dead letters)" } else { "" }));
        }
        out.push_str("\nStop working on them: an ack of a released job is refused. The queue hands out a job again by its normal rules.");
    }
    if !given.claims.is_empty() {
        out.push_str("\n\nWaiting concurrency slot claims removed from the FIFO line:");
        for c in &given.claims {
            out.push_str(&format!("\n- claim {} on project {}", c.claim, c.project));
        }
    }
    if !given.listeners.is_empty() {
        out.push_str("\n\nProject queue listeners paused:");
        for l in &given.listeners {
            out.push_str(&format!("\n- listener {} on project {}", l.listener, l.project));
        }
        out.push_str("\nA paused listener is handed no mail, and moving back does not resume it: when you reach the project again and want its mail, resume it with orgtree_watchdog action=resume id=<the listener's id>.");
    }
    if !given.leases.is_empty() {
        out.push_str("\n\nIf you still need a slot, take a new one with a slot watchdog before you continue the work it covered.");
    } else if !given.claims.is_empty() {
        out.push_str("\n\nYour place in the line is gone: if you still need a slot, claim again with a slot watchdog once you reach the project.");
    }
    out
}

/// What one holder lost during a batched pass: who, why (each distinct reason once), what.
type Told = Vec<(String, Vec<String>, Given)>;

tokio::task_local! {
    /// While a move's pass runs, [`tell`] collects here instead of sending, so a
    /// holder that lost a lease, a job, a claim and a listener reads ONE notice.
    static BATCH: RefCell<Told>;
}

/// Tell a holder what was released, as a passive System notice: it rides the
/// holder's next turn and wakes nobody. A failure is logged, never raised: the
/// release itself has already committed. Inside a move's pass (`after_move`) it
/// only collects: that pass sends one notice per holder when it ends.
#[logged]
pub async fn tell(engine: &Arc<Engine>, org_id: i64, to: &str, because: &str, given: &Given) {
    if given.is_empty() {
        return;
    }
    let collected = BATCH.try_with(|batch| {
        let mut batch = batch.borrow_mut();
        let at = match batch.iter().position(|t| t.0 == to) {
            Some(at) => at,
            None => {
                batch.push((to.to_string(), Vec::new(), Given::default()));
                batch.len() - 1
            }
        };
        if !batch[at].1.iter().any(|b| b == because) {
            batch[at].1.push(because.to_string());
        }
        batch[at].2.merge(given.clone());
    });
    if collected.is_err() {
        slots::notify(engine, org_id, to, &notice_body(because, given)).await;
    }
}

/// Give back everything `agent` holds in projects, because its turn died.
/// Ends every slot lease it holds and returns every un-acked job it holds to
/// its queue, one short transaction per project in project-id order (the
/// project row first, as `slots::grant` and the hand-out take it), then runs
/// each touched project's line and queue and tells the holder. Returns what
/// was taken back.
#[logged]
pub async fn release_after_death(engine: &Arc<Engine>, org_id: i64, agent: i64, name: &str, death: &Death) -> Result<Given> {
    let counted = crate::runtime::reminders::switches(engine).checkups;
    let mut given = Given::default();
    let mut after = 0_i64;
    loop {
        let held: Vec<i64> = {
            let client = engine.db.get().await?;
            client
                .query(
                    &format!("SELECT project_id FROM (
                                SELECT project_id FROM ot.slot_leases WHERE org_id = $1 AND holder_agent_id = $2 AND ended_at IS NULL
                                UNION SELECT m.recipient_agent_id FROM ot.mail m
                                 WHERE m.org_id = $1 AND (m.extra->'claimed'->>'by_id')::bigint = $2 AND {}
                              ) held WHERE project_id > $3 ORDER BY project_id LIMIT 64", projects::OUTSTANDING),
                    &[&org_id, &agent, &after],
                )
                .await?
                .iter()
                .map(|r| r.get(0))
                .collect()
        };
        for &project in &held {
            after = project;
            if let Err(e) = release_in(engine, org_id, project, agent, name, death, counted, &mut given).await {
                tracing::warn!(project, agent = name, error = %format!("{e:#}"), "taking back a holder's project holdings failed");
            }
        }
        if held.len() < 64 {
            break;
        }
    }
    tell(engine, org_id, name, &death.because, &given).await;
    Ok(given)
}

/// One project's share of [`release_after_death`]: the transaction, then the
/// work that follows its commit.
#[logged]
#[allow(clippy::too_many_arguments)]
async fn release_in(engine: &Arc<Engine>, org_id: i64, project: i64, agent: i64, name: &str, death: &Death,
                    counted: bool, given: &mut Given) -> Result<()> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let Some(p) = tx.query_opt("SELECT name FROM ot.agents WHERE id = $1 AND kind = 'project' FOR NO KEY UPDATE", &[&project]).await? else {
        return Ok(());
    };
    let pname: String = p.get(0);
    let mut leases = Vec::new();
    let rows = tx
        .query("SELECT id, uid, slot_count FROM ot.slot_leases WHERE project_id = $1 AND holder_agent_id = $2 AND ended_at IS NULL ORDER BY id",
               &[&project, &agent])
        .await?;
    for r in &rows {
        if slots::end(&*tx, r.get(0), death.how, "orgtree").await? {
            leases.push(GivenLease { project: pname.clone(), lease: r.get(1), slots: r.get(2) });
        }
    }
    let mut taken = Vec::new();
    let jobs = tx
        .query(
            &format!("SELECT m.id, m.extra->'claimed'->>'copy' FROM ot.mail m
                       WHERE m.recipient_agent_id = $1 AND (m.extra->'claimed'->>'by_id')::bigint = $2 AND {}
                       ORDER BY m.id LIMIT 200", projects::OUTSTANDING),
            &[&project, &agent],
        )
        .await?;
    for j in &jobs {
        let copy: Option<String> = j.get(1);
        if let Some(t) = projects::reclaim_in(&*tx, org_id, project, j.get(0), agent, name, &death.why, "released", projects::ENDING_DIED, counted, copy.as_deref()).await? {
            taken.push(t);
        }
    }
    tx.commit().await?;
    drop(client);
    given.leases.extend(leases);
    for t in &taken {
        given.jobs.push(GivenJob { project: pname.clone(), job: t.copy.clone().unwrap_or_else(|| t.mail.clone()), dead: t.dead });
        projects::after_reclaim(engine, org_id, project, t).await;
    }
    // the next waiter in line takes the free slots, and the queue hands the job out again
    Box::pin(slots::grant(engine, org_id, project)).await?;
    if !taken.is_empty() {
        Box::pin(projects::dispatch(engine, org_id, project)).await?;
    }
    Ok(())
}

/// Nodes moved in the tree (the moved node and everything under it): every
/// project where one of them holds a lease or an un-acked job or waits in the
/// slot line or listens on the queue, and every moved project, is re-checked, so
/// a holder that no longer reaches its project loses what it held there
/// (`slots::check`, `projects::release_stale`), its waiting claim leaves the line
/// and its queue listener is paused (`drop_unreached_dogs`), and the line and
/// queue go on. Each holder is told once, when the pass ends. Reads bounded
/// keyset pages of project ids.
#[logged]
pub async fn after_move(engine: &Arc<Engine>, org_id: i64, moved: &[i64]) {
    if moved.is_empty() {
        return;
    }
    let told = BATCH
        .scope(RefCell::new(Vec::new()), async {
            moved_pass(engine, org_id, moved).await;
            BATCH.with(|batch| std::mem::take(&mut *batch.borrow_mut()))
        })
        .await;
    for (to, because, given) in told {
        slots::notify(engine, org_id, &to, &notice_body(&because.join("; "), &given)).await;
    }
}

/// [`after_move`]'s work, run inside its notice batch.
#[logged]
async fn moved_pass(engine: &Arc<Engine>, org_id: i64, moved: &[i64]) {
    let mut after = 0_i64;
    loop {
        let page: Result<Vec<i64>> = async {
            let client = engine.db.get().await?;
            Ok(client
                .query(
                    &format!("SELECT project_id FROM (
                                SELECT project_id FROM ot.slot_leases WHERE org_id = $1 AND ended_at IS NULL AND holder_agent_id = ANY($2)
                                UNION SELECT project_id FROM ot.slot_leases WHERE org_id = $1 AND ended_at IS NULL AND project_id = ANY($2)
                                UNION SELECT m.recipient_agent_id FROM ot.mail m
                                 WHERE m.org_id = $1 AND (m.extra->'claimed'->>'by_id')::bigint = ANY($2) AND {o}
                                UNION SELECT m.recipient_agent_id FROM ot.mail m
                                 WHERE m.org_id = $1 AND m.recipient_agent_id = ANY($2) AND {o}
                                UNION SELECT (w.memo->>'target_id')::bigint FROM ot.watchdogs w
                                 WHERE w.org_id = $1 AND w.owner_agent_id = ANY($2) AND w.memo ? 'target_id'
                                   AND ((w.kind = 'slot' AND w.state IN ('armed', 'paused') AND NOT w.memo ? 'lease')
                                     OR (w.kind = 'fair_queue' AND w.state = 'armed'))
                                UNION SELECT (w.memo->>'target_id')::bigint FROM ot.watchdogs w
                                 WHERE w.org_id = $1 AND w.kind IN ('slot', 'fair_queue') AND w.state = 'armed'
                                   AND (w.memo->>'target_id')::bigint = ANY($2)
                              ) touched WHERE project_id > $3 ORDER BY project_id LIMIT 64", o = projects::OUTSTANDING),
                    &[&org_id, &moved, &after],
                )
                .await?
                .iter()
                .map(|r| r.get(0))
                .collect())
        }.await;
        let page = match page {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "reading the projects a move touched failed");
                return;
            }
        };
        for &project in &page {
            after = project;
            if let Err(e) = drop_unreached_dogs(engine, org_id, project).await {
                tracing::warn!(project, error = %format!("{e:#}"), "dropping a mover's slot claim and queue listener failed");
            }
            if let Err(e) = Box::pin(slots::check(engine, org_id, project)).await {
                tracing::warn!(project, error = %format!("{e:#}"), "rechecking project slots after a move failed");
            }
            if let Err(e) = Box::pin(projects::dispatch(engine, org_id, project)).await {
                tracing::warn!(project, error = %format!("{e:#}"), "running a project's queue after a move failed");
            }
        }
        if page.len() < 64 {
            break;
        }
    }
}

/// Agents that no longer reach `project` lose the places they kept in it without
/// holding anything: a claim WAITING in its slot line is removed (the owner
/// claims again when it reaches the project), and a queue listener on it is
/// paused (not removed: moving back does not resume it, the owner resumes it).
/// User 2026-10-27 18:01Z m603e6114476e, "Drop both". The project row is locked
/// first, as `slots::grant` and the hand-out lock it. Each owner is told through
/// [`tell`]; the line is re-run by the caller's `slots::check`.
#[logged]
async fn drop_unreached_dogs(engine: &Arc<Engine>, org_id: i64, project: i64) -> Result<()> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let Some(p) = tx.query_opt("SELECT name FROM ot.agents WHERE id = $1 AND kind = 'project' FOR NO KEY UPDATE", &[&project]).await? else {
        return Ok(());
    };
    let pname: String = p.get(0);
    let mut reach: HashMap<i64, bool> = HashMap::new();
    // (dog row, owner, owner's name, what it lost)
    let mut dropped: Vec<(i64, i64, String, Given)> = Vec::new();
    let mut after = 0_i64;
    loop {
        let rows = tx
            .query(
                "SELECT w.id, w.uid::text, w.kind::text, a.id, a.name::text FROM ot.watchdogs w JOIN ot.agents a ON a.id = w.owner_agent_id
                  WHERE w.org_id = $1 AND (w.memo->>'target_id')::bigint = $2 AND w.id > $3
                    AND ((w.kind = 'slot' AND w.state IN ('armed', 'paused') AND NOT w.memo ? 'lease')
                      OR (w.kind = 'fair_queue' AND w.state = 'armed'))
                  ORDER BY w.id LIMIT 200",
                &[&org_id, &project, &after],
            )
            .await?;
        for r in &rows {
            let (row, uid, kind, owner, name): (i64, String, String, i64, String) = (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4));
            after = row;
            let reaches = match reach.get(&owner) {
                Some(r) => *r,
                None => {
                    let r = projects::reaches(&*tx, owner, project).await?;
                    reach.insert(owner, r);
                    r
                }
            };
            if reaches {
                continue;
            }
            let mut lost = Given::default();
            if kind == "slot" {
                let n = tx
                    .execute(
                        "UPDATE ot.watchdogs SET state = 'removed', memo = memo || jsonb_build_object('reason', $2::text)
                          WHERE id = $1 AND state IN ('armed', 'paused')",
                        &[&row, &CLAIM_REASON],
                    )
                    .await?;
                if n == 1 {
                    lost.claims.push(GivenClaim { project: pname.clone(), claim: uid });
                }
            } else {
                let n = tx
                    .execute(
                        "UPDATE ot.watchdogs SET state = 'paused', memo = memo || jsonb_build_object('paused_why', $2::text)
                          WHERE id = $1 AND state = 'armed'",
                        &[&row, &LISTENER_WHY],
                    )
                    .await?;
                if n == 1 {
                    lost.listeners.push(GivenListener { project: pname.clone(), listener: uid });
                }
            }
            if !lost.is_empty() {
                dropped.push((row, owner, name, lost));
            }
        }
        if rows.len() < 200 {
            break;
        }
    }
    tx.commit().await?;
    drop(client);
    if dropped.is_empty() {
        return Ok(());
    }
    let mut ch = vec![Change::Watchdogs, Change::Agent(project)];
    for (row, owner, name, lost) in dropped {
        crate::runtime::watchdogs::disarm(engine, row);
        ch.push(Change::Agent(owner));
        tell(engine, org_id, &name, &you(projects::MOVED_OUT), &lost).await;
    }
    changes::notify_id(engine, org_id, ch);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn end<'a>() -> Ending<'a> {
        Ending::default()
    }

    /// User 2026-10-27 16:18Z mea799ba1df7c: a turn that dies for any reason other
    /// than a manual interrupt or the agent ending it deliberately releases.
    #[test]
    fn every_abnormal_turn_end_counts_as_a_death() {
        let cases: [(&str, Ending, &str); 6] = [
            ("the idle watchdog", Ending { error: Some("the turn produced nothing for too long and was stopped"), ..end() }, HOW_DIED),
            ("the time limit", Ending { error: Some("the turn ran past its time limit and was stopped"), ..end() }, HOW_DIED),
            ("the CLI crashing", Ending { error: Some("the Claude process exited during the turn (status 1; eof)"), ..end() }, HOW_DIED),
            ("a provider failure", Ending { error: Some("API Error: 500"), ..end() }, HOW_DIED),
            ("the user's Windows session ending", Ending { session_ended: true, ..end() }, HOW_DIED),
            ("a freeze", Ending { frozen: true, ..end() }, HOW_FROZEN),
        ];
        for (name, e, how) in cases {
            let d = died(&e).unwrap_or_else(|| panic!("{name} must count as a death"));
            assert_eq!(d.how, how, "{name}");
            // the job's record and a dead letter name the holder in the third person
            assert!(d.why.starts_with("its turn") || d.why.starts_with("the user's"), "{name}: {}", d.why);
            assert!(d.because.starts_with("your turn") || d.because.starts_with("the user's"), "{name}: {}", d.because);
        }
        assert_eq!(died(&Ending { limited: true, ..end() }).unwrap().how, HOW_FROZEN, "a usage-limit refusal");
    }

    /// User 2026-10-28 10:07:18Z mb1ca1568502c: a request-rate 429 is retried after a few minutes; the
    /// holder is told it was a rate limit, never that a usage limit froze it.
    #[test]
    fn a_rate_limit_retry_freeze_is_not_called_a_usage_limit() {
        let d = died(&Ending { frozen: true, rate_limited: true, ..end() }).expect("the retry freeze takes the holdings back");
        assert_eq!(d.how, HOW_FROZEN);
        assert!(d.why.starts_with("its turn") && d.why.contains("rate limit") && d.why.contains("429"), "{}", d.why);
        assert!(d.because.starts_with("your turn") && d.because.contains("rate limit") && d.because.contains("429"), "{}", d.because);
        assert!(!d.why.contains("usage limit") && !d.because.contains("usage limit"), "{} / {}", d.why, d.because);
        // a real usage limit still reads as one, whatever else is set
        let u = died(&Ending { limited: true, frozen: true, ..end() }).unwrap();
        assert!(u.why.contains("usage limit") && u.because.contains("usage limit"));
        assert!(died(&Ending { interrupted: true, frozen: true, rate_limited: true, ..end() }).is_none());
    }

    #[test]
    fn a_manual_interrupt_or_a_deliberate_end_is_not_a_death() {
        assert!(died(&end()).is_none(), "a finished turn");
        assert!(died(&Ending { interrupted: true, ..end() }).is_none(), "a manual interrupt");
        // an interrupted turn the CLI reported as an error is still the manual interrupt's
        assert!(died(&Ending { interrupted: true, error: Some("interrupted"), ..end() }).is_none());
        assert!(died(&Ending { interrupted: true, limited: true, frozen: true, ..end() }).is_none(), "halt and Stop all interrupt first");
        assert!(died(&Ending { compact: true, error: Some("compaction failed"), ..end() }).is_none(), "a compaction is not the agent's own turn");
    }

    #[test]
    fn the_notice_names_every_lease_and_job_and_what_to_do() {
        let given = Given {
            leases: vec![GivenLease { project: "build".into(), lease: "s1".into(), slots: 1 }, GivenLease { project: "build".into(), lease: "s2".into(), slots: 2 }],
            jobs: vec![GivenJob { project: "dev".into(), job: "m9".into(), dead: false }, GivenJob { project: "dev".into(), job: "m10".into(), dead: true }],
            ..Default::default()
        };
        let text = notice_body(&you("was frozen by a usage limit"), &given);
        assert!(text.contains("because you were frozen by a usage limit."), "{text}");
        assert!(text.contains("a concurrency slot of project build (lease s1)"), "{text}");
        assert!(text.contains("2 concurrency slots of project build (lease s2)"), "{text}");
        assert!(text.contains("mail m9 of project dev"), "{text}");
        assert!(text.contains("mail m10 of project dev (its last attempt: it went to the project's dead letters)"), "{text}");
        assert!(text.contains("take a new one with a slot watchdog"), "{text}");
        assert!(text.contains("an ack of a released job is refused"), "{text}");
        // a notice about leases alone does not talk about jobs, and the reverse
        let leases = notice_body("x", &Given { leases: given.leases.clone(), ..Default::default() });
        assert!(!leases.contains("mail jobs"), "{leases}");
        let jobs = notice_body("x", &Given { jobs: given.jobs.clone(), ..Default::default() });
        assert!(!jobs.contains("slot"), "{jobs}");
    }

    #[test]
    fn the_notice_names_a_removed_claim_and_a_paused_listener() {
        let given = Given {
            claims: vec![GivenClaim { project: "build".into(), claim: "w1".into() }],
            listeners: vec![GivenListener { project: "dev".into(), listener: "q1".into() }],
            ..Default::default()
        };
        let text = notice_body(&you("moved out of the project"), &given);
        assert!(text.contains("because you moved out of the project."), "{text}");
        assert!(text.contains("claim w1 on project build"), "{text}");
        assert!(text.contains("listener q1 on project dev"), "{text}");
        assert!(text.contains("orgtree_watchdog action=resume"), "{text}");
        assert!(text.contains("claim again with a slot watchdog"), "{text}");
        assert!(!text.contains("mail jobs"), "{text}");
        // a listener alone says nothing about slots
        let listener = notice_body("x", &Given { listeners: given.listeners.clone(), ..Default::default() });
        assert!(!listener.contains("slot"), "{listener}");
        assert!(Given::default().is_empty() && !given.is_empty());
    }

    #[test]
    fn merging_adds_every_kind() {
        let mut a = Given { leases: vec![GivenLease::default()], ..Default::default() };
        a.merge(Given { jobs: vec![GivenJob::default()], claims: vec![GivenClaim::default()], listeners: vec![GivenListener::default()], ..Default::default() });
        assert_eq!((a.leases.len(), a.jobs.len(), a.claims.len(), a.listeners.len()), (1, 1, 1, 1));
    }

    #[test]
    fn a_reason_reads_in_the_second_person() {
        assert_eq!(you("was halted"), "you were halted");
        assert_eq!(you("was frozen by a usage limit"), "you were frozen by a usage limit");
        assert_eq!(you("moved out of the project"), "you moved out of the project");
        assert_eq!(you("stopped watching the project"), "you stopped watching the project");
    }

    #[test]
    fn an_error_is_cut_to_one_short_line() {
        let long = format!("first line\n{}", "x".repeat(400));
        let because = died(&Ending { error: Some(&long), ..end() }).unwrap().because;
        assert!(!because.contains('\n'), "{because}");
        assert!(because.chars().count() < 260, "{} chars", because.chars().count());
        assert!(because.contains('…'));
    }
}
