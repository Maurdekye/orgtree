//! Project watchdog delivery forms (docs/rust-engine/project-watchdogs.md, spec rev 2.1 §13):
//! a fire of a project's watchdog is the project's event (`listeners::fire_from_dog`),
//! a broadcast to the live agents directly under the project, or one job in the
//! project's mail queue. The two forms below are not project events: no
//! `project_fires` row, no `project.event`, nothing a listener sees.
use super::*;

/// The most agents one broadcast fire mails (the desk megaphone's cap).
const BROADCAST_CAP: usize = 1000;

/// What a form's mail says about the dog that sent it.
#[derive(Debug, Clone)]
pub(super) struct Source {
    pub handle: String,
    pub name: String,
    pub kind: String,
    pub target: String,
}

#[logged]
impl Source {
    #[nolog]
    pub(super) fn of(dog: &Dog) -> Self {
        Source {
            handle: crate::domain::watchdogs::handle(&dog.owner_name, &dog.uid),
            name: dog.name.clone(),
            kind: dog.kind.clone(),
            target: dog.target.clone(),
        }
    }

    /// The engine-written first line (F3); `verb` is the form's phrase.
    #[nolog]
    fn line(&self, verb: &str, project: &str) -> String {
        format!("watchdog @{} (\"{}\", {} · {}) {verb} project @{project}", self.handle, self.name, self.kind, self.target)
    }
}

/// The form's whole message: its first line, a blank line and the capped fire body.
#[nolog]
fn message(src: &Source, verb: &str, project: &str, body: &str) -> String {
    format!("{}\n\n{}", src.line(verb, project), crate::domain::listeners::cap_dog_message(body.trim()))
}

/// Add `suffix` to the last ring entry's gist of dog `row`.
#[logged]
pub(super) async fn gist_suffix(engine: &Arc<Engine>, row: i64, suffix: &str) {
    if let Ok(client) = engine.db.get().await {
        let _ = client.execute(
            "UPDATE ot.watchdogs SET events = jsonb_set(events, '{-1,gist}', to_jsonb((events->-1->>'gist') || $2::text))
              WHERE id = $1 AND jsonb_array_length(events) > 0", &[&row, &suffix]).await;
    }
}

/// Broadcast (F4): one mail per live agent directly under the project, in
/// sibling order, capped at 1000. `passive` makes the mail a notice. Returns
/// (sent, members found, past the cap).
#[logged]
pub(super) async fn broadcast(engine: &Arc<Engine>, org_id: i64, project: i64, pname: &str, src: &Source, passive: bool, body: &str)
    -> Result<(usize, usize, bool)> {
    let members: Vec<(i64, String)> = {
        let client = engine.db.get().await?;
        client.query(
            "SELECT id, name FROM ot.agents WHERE parent_id = $1 AND kind = 'agent' AND state = 'live' ORDER BY sibling_order, id LIMIT $2",
            &[&project, &((BROADCAST_CAP + 1) as i64)]).await?
            .iter().map(|r| (r.get(0), r.get(1))).collect()
    };
    let over = members.len() > BROADCAST_CAP;
    let members = &members[..members.len().min(BROADCAST_CAP)];
    let text = message(src, "broadcast to the members of", pname, body);
    let mut sent = 0;
    for (_, name) in members {
        let mut out = Outgoing::new(From::Watchdog { key: src.handle.clone(), name: src.name.clone() }, name, &text);
        out.kind = "watchdog".into();
        out.notice = passive || (crate::mailhub::safe_start() && !crate::rig::recovers());
        match mail::send(engine, org_id, out).await {
            Ok(_) => sent += 1,
            Err(e) => tracing::warn!(watchdog = %src.handle, to = %name, error = %format!("{e:#}"), "a project watchdog's broadcast to one member failed"),
        }
    }
    Ok((sent, members.len(), over))
}

/// Queue (F5): one job in the project's mailbox, whether or not anything
/// listens on the queue. Sending it dispatches it and, when nobody took it,
/// nudges an unwatched project. Returns the job's mail uid.
#[logged]
pub(super) async fn enqueue(engine: &Arc<Engine>, org_id: i64, pname: &str, src: &Source, body: &str) -> Result<String> {
    let text = message(src, "queued a job on", pname, body);
    // the job's sender is the dog's HANDLE: names repeat across projects, the handle is what configure and remove take
    let mut out = Outgoing::new(From::Watchdog { key: src.handle.clone(), name: src.handle.clone() }, pname, &text);
    out.kind = "watchdog".into();
    Ok(mail::send(engine, org_id, out).await?.uid)
}
