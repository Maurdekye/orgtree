//! `orgtree_watchdog configure` edits (docs/rust-engine/watchdog-on-behalf.md, spec rev 1.5 §5):
//! the behaviour fields (tier A) and the fields that decide what a dog watches or runs (tier B) of an
//! armed, paused or exited dog, by anyone who may manage it. `plan` validates EVERYTHING first (create's
//! own validators and smoke, the editor's and the owner's hands, reach, uniqueness, held jobs and
//! leases) and writes nothing; `apply` merges the plan into configure's single transaction.
use super::*;

/// kind, owner, project and name never change.
const FIXED: [&str; 4] = ["kind", "owner", "project", "name"];

/// Every field an edit may carry (besides `connection_messages` and `project_delivery`, which `configure` owns).
const FIELDS: [&str; 24] = [
    "notice", "interval_s", "pattern", "fire_mode", "quiet_period_s", "once", "target", "shell", "hello", "heartbeat", "protocols",
    "credentials", "payload_pattern", "retained", "batch", "count", "slots", "threshold_percent", "usage_events", "windows",
    "accounts", "fire_actions", "event_name", "panel",
];

/// Does the call carry any field this module edits (or a fixed one, to refuse it)?
#[nolog]
pub(super) fn wants(args: &Value) -> bool {
    let has = |k: &str| args.get(k).is_some_and(|v| !v.is_null());
    FIXED.iter().chain(FIELDS.iter()).any(|k| has(k)) || has("all_panels")
}

/// May a dog of `kind` carry `field`?
#[nolog]
fn belongs(field: &str, kind: &str) -> bool {
    let poll = ["file", "command", "process", "stream", "websocket", "mqtt"];
    match field {
        "notice" => true,
        "once" => kind != "slot",
        "interval_s" => poll.contains(&kind) || kind == "activity",
        "pattern" => ["file", "command", "stream", "websocket", "mqtt", "activity", "event", "project_listener"].contains(&kind),
        "fire_mode" | "quiet_period_s" => poll.contains(&kind),
        "target" => kind != "usage" && kind != "app_listener",
        "shell" => kind == "command" || kind == "stream",
        "hello" | "heartbeat" | "protocols" => kind == "websocket",
        "credentials" => kind == "websocket" || kind == "mqtt",
        "payload_pattern" | "retained" => kind == "mqtt",
        "batch" => kind == "fair_queue",
        "count" => kind == "listener_watch",
        "slots" => kind == "slot",
        "threshold_percent" | "usage_events" | "windows" | "accounts" => kind == "usage",
        "fire_actions" => kind != "fair_queue",
        _ => false,
    }
}

/// What an edit changes, decided before any write.
#[derive(Debug, Default)]
pub(super) struct Plan {
    /// field names, in the order the call gave them (never values)
    pub changed: Vec<String>,
    pub target: Option<String>,
    pub pattern: Option<Option<String>>,
    pub shell: Option<String>,
    pub interval: Option<i32>,
    pub fire_mode: Option<String>,
    pub quiet: Option<Option<i32>>,
    pub once: Option<bool>,
    pub memo_set: Vec<(String, Value)>,
    pub memo_del: Vec<String>,
    /// a poll dog's baseline restarts (target, shell or pattern changed)
    pub rebaseline: bool,
    /// the runner is replaced (stream, websocket, mqtt tier B)
    pub restart: bool,
    /// silence timers restart
    pub silence_reset: bool,
    /// new inline credentials to seal for this dog (`Some(None)`: remove the sealed row)
    pub sealed: Option<Option<Vec<u8>>>,
    /// what create only WARNS about (a smoke reporting the target broken): saved, and returned to the editor
    pub warnings: Vec<String>,
    /// a slot claim re-admitted at the back: (project, whole-lease count)
    pub slot_admit: Option<(i64, i32)>,
    /// a listener's new project: its event listeners are switched on as at create
    pub switch_on: Option<i64>,
}

#[nolog]
fn has(args: &Value, k: &str) -> bool {
    args.get(k).is_some_and(|v| !v.is_null())
}

/// The usage config an edit leaves behind: the stored one with the given fields replaced, validated.
/// STUB (red commit): the Fable-pip fields are not handled yet.
#[nolog]
fn merged_usage(existing: &Value, args: &Value) -> Result<Value> {
    let mut merged = if existing.is_object() { existing.clone() } else { json!({}) };
    for key in ["threshold_percent", "usage_events", "windows", "accounts"] {
        if has(args, key) {
            merged[key] = args[key].clone();
        }
    }
    usage::validate(&merged)
}

/// scheme://host:port of a URL, lower case: "the same host" for credentials.
#[nolog]
fn host_key(target: &str) -> String {
    let t = target.trim();
    match t.split_once("://") {
        Some((scheme, rest)) => format!("{}://{}", scheme.to_lowercase(), rest.split('/').next().unwrap_or("").to_lowercase()),
        None => t.to_lowercase(),
    }
}

/// Validate an edit against `dog` for `actor` (`None`: the user). Nothing is written.
#[logged]
pub(super) async fn plan(engine: &Arc<Engine>, org_id: i64, actor: Option<i64>, dog: &Dog, args: &Value) -> Result<Plan> {
    for k in FIXED {
        if has(args, k) {
            refuse!(BadRequest, "kind, owner, project and name are fixed; create a new watchdog instead");
        }
    }
    let kind = dog.kind.as_str();
    let mut p = Plan::default();
    let mut given: Vec<&str> = Vec::new();
    for k in FIELDS {
        if has(args, k) {
            if matches!(k, "event_name" | "panel") {
                refuse!(BadRequest, "an app listener's subscription is changed by creating it again; notice and once can be edited");
            }
            if !belongs(k, kind) {
                refuse!(BadRequest, "{k} is not a field of a {kind} watchdog");
            }
            given.push(k);
        }
    }
    if has(args, "all_panels") {
        refuse!(BadRequest, "an app listener's subscription is changed by creating it again; notice and once can be edited");
    }
    let by_other = actor.is_some() && actor != Some(dog.owner);
    let project_dog = dog.project_owned();
    let tier_b = given.iter().any(|k| matches!(*k, "target" | "shell" | "hello" | "heartbeat" | "protocols" | "credentials" | "slots" | "accounts")
        || (*k == "pattern" && kind == "mqtt"));
    let scratch = owner_scratch(engine, org_id, &dog.owner_name, dog.workdir.as_deref());
    let editor_name: String = match actor {
        Some(a) => engine.db.get().await?.query_one("SELECT name FROM ot.agents WHERE id = $1", &[&a]).await?.get(0),
        None => "@user".into(),
    };

    // ---- tier A
    if has(args, "notice") {
        let Some(n) = args["notice"].as_bool() else { refuse!(BadRequest, "notice must be true or false") };
        if project_dog && n && dog.delivery() != "broadcast" {
            refuse!(BadRequest, "a project watchdog's fires go to the project's listeners; each listener's own notice flag decides whether it wakes");
        }
        p.memo_set.push(("notice".into(), json!(n)));
        p.changed.push("notice".into());
    }
    if has(args, "once") {
        let Some(o) = args["once"].as_bool() else { refuse!(BadRequest, "once must be true or false") };
        p.once = Some(o);
        p.changed.push("once".into());
    }
    if has(args, "interval_s") {
        let Some(n) = args["interval_s"].as_i64() else { refuse!(BadRequest, "interval_s must be a whole number of seconds") };
        p.interval = Some(n.max(super::interval_floor(kind)).min(i32::MAX as i64) as i32);
        p.changed.push("interval_s".into());
    }
    // the effective pattern and silence settings after the edit
    let mut pattern = dog.pattern.clone();
    if has(args, "pattern") {
        let Some(text) = args["pattern"].as_str() else { refuse!(BadRequest, "pattern must be a regex string") };
        let text = text.trim();
        if !text.is_empty() {
            if let Err(e) = compile(text) {
                refuse!(BadRequest, "pattern does not compile: {e}");
            }
        }
        pattern = (!text.is_empty()).then(|| text.to_string());
        if (kind == "command" || kind == "mqtt") && pattern.is_none() {
            refuse!(BadRequest, "a {kind} watchdog needs a pattern");
        }
        p.pattern = Some(pattern.clone());
        p.changed.push("pattern".into());
        if matches!(kind, "file" | "command" | "stream" | "activity") {
            p.rebaseline = true;
        }
    }
    if has(args, "fire_mode") || has(args, "quiet_period_s") {
        let mut m = json!({ "fire_mode": args.get("fire_mode").filter(|v| !v.is_null()).cloned().unwrap_or(json!(dog.fire_mode)) });
        if has(args, "quiet_period_s") {
            m["quiet_period_s"] = args["quiet_period_s"].clone();
        } else if m["fire_mode"] == "silence" {
            m["quiet_period_s"] = json!(dog.quiet_s);
        }
        let (mode, quiet) = super::silence_pair(&m)?;
        p.fire_mode = Some(mode);
        p.quiet = Some(quiet);
        p.silence_reset = true;
        for k in ["fire_mode", "quiet_period_s"] {
            if has(args, k) {
                p.changed.push(k.into());
            }
        }
    }
    if has(args, "batch") {
        p.memo_set.push(("batch".into(), json!(super::batch_value(&args["batch"])?)));
        p.changed.push("batch".into());
    }
    if has(args, "count") {
        let project = dog.memo["target_id"].as_i64().map(|_| dog.target.clone()).unwrap_or_default();
        p.memo_set.push(("count".into(), json!(super::count_value(&args["count"], &project)?)));
        p.changed.push("count".into());
    }

    // ---- tier B: what the dog watches or runs
    let new_target = if has(args, "target") {
        let Some(t) = args["target"].as_str().map(str::trim).filter(|t| !t.is_empty()) else { refuse!(BadRequest, "target must be a non-empty string") };
        Some(t.to_string())
    } else {
        None
    };
    let mut target = dog.target.clone();
    let mut shell = dog.shell.clone();
    if has(args, "shell") {
        let s = args["shell"].as_str().map(|s| s.trim().to_lowercase()).unwrap_or_default();
        if s != "native" && s != "bash" {
            refuse!(BadRequest, "shell must be native or bash");
        }
        if s == "bash" && resolve_bash().is_none() {
            refuse!(BadRequest, "shell bash needs a bash on this machine");
        }
        shell = Some(s.clone());
        p.shell = Some(s);
        p.changed.push("shell".into());
        p.rebaseline = true;
        // a stream's process is replaced by a tier B change
        if kind == "stream" {
            p.restart = true;
        }
    }
    // hands of the owner AND the editor for what a command or stream runs
    if matches!(kind, "command" | "stream") && (new_target.is_some() || has(args, "shell")) {
        for who in std::iter::once(dog.owner).chain(actor.filter(|a| *a != dog.owner && !project_dog)) {
            if !holds_bash(engine, who).await? {
                refuse!(Forbidden, "a command/stream watchdog runs with the hands of its owner and of whoever edits it — it needs the bash {} does not hold; ask for it (orgtree_request_scope) or watch a file instead",
                        if who == dog.owner { dog.owner_name.as_str() } else { editor_name.as_str() });
            }
        }
        if project_dog {
            if let Some(c) = actor {
                if !holds_bash(engine, c).await? {
                    refuse!(Forbidden, "a command/stream watchdog runs with the hands of whoever edits it too — it needs the bash {editor_name} does not hold");
                }
            }
        }
    }
    if let Some(t) = &new_target {
        match kind {
            "file" => {
                let full = file_target(&scratch, t);
                let editor_dir: Option<(i64, PathBuf)> = match actor.filter(|a| *a != dog.owner) {
                    Some(a) => {
                        let r = engine.db.get().await?.query_one("SELECT name, scratch_dir FROM ot.agents WHERE id = $1", &[&a]).await?;
                        Some((a, owner_scratch(engine, org_id, &r.get::<_, String>(0), r.get::<_, Option<String>>(1).as_deref())))
                    }
                    None => None,
                };
                let refusal = || format!("cannot watch {t} — only files in your working folder, the workspace, or a folder you hold are watchable (orgtree_request_scope can ask for more)");
                if !file_contained(engine, org_id, dog.owner, &scratch, &full).await? {
                    refuse!(Forbidden, "{}", refusal());
                }
                if let Some((a, dir)) = editor_dir {
                    if !file_contained(engine, org_id, a, &dir, &full).await? {
                        refuse!(Forbidden, "{}", refusal());
                    }
                }
                target = full.to_string_lossy().into_owned();
            }
            "process" => {
                if !regex::Regex::new(r"^(pid|port):\d+$").map(|r| r.is_match(t)).unwrap_or(false) {
                    refuse!(BadRequest, "process targets are `pid:N` or `port:N`");
                }
                target = t.clone();
            }
            "activity" => {
                let bare = t.trim_start_matches('@').to_string();
                let client = engine.db.get().await?;
                let Some(row) = client.query_opt("SELECT id FROM ot.agents WHERE org_id = $1 AND name = $2 AND state = 'live' AND kind = 'agent'", &[&org_id, &bare]).await? else {
                    refuse!(NotFound, "no live agent named {bare} to watch");
                };
                let tid: i64 = row.get(0);
                if !below(engine, dog.owner, tid).await? {
                    refuse!(Forbidden, "activity target must be yourself or a descendant");
                }
                p.memo_set.push(("target_id".into(), json!(tid)));
                target = bare;
            }
            "event" => {
                let mut merged = json!({ "pattern": pattern, "threshold": dog.memo["threshold"], "event_scope": dog.memo["event_scope"] });
                merged["target"] = json!(t);
                events::validate(t, &merged)?;
                target = t.clone();
            }
            "command" | "stream" => target = t.clone(),
            "fair_queue" | "slot" | "project_listener" | "listener_watch" => {
                let client = engine.db.get().await?;
                let Some(pr) = crate::domain::projects::by_name(&**client, org_id, t).await? else {
                    refuse!(NotFound, "no project named {} to use as a target; a {kind} watchdog takes a project's name", t.trim_start_matches('@'));
                };
                if pr.state != "live" {
                    refuse!(Conflict, "project {} is retired", pr.name);
                }
                let old_pid = dog.memo["target_id"].as_i64();
                if old_pid != Some(pr.id) {
                    // the editor is the setter: its reach, or its audience, may stand in for the owner's (W6); a new check replaces the grant
                    let delegate = actor.filter(|a| *a != dog.owner).map(|a| Delegate { setter: a, setter_name: editor_name.clone(), owner_name: dog.owner_name.clone() });
                    let what = match kind { "fair_queue" => "watch its mailbox", "slot" => "claim its concurrency slots", "project_listener" => "listen for its events", _ => "watch its listener count" };
                    // the user edits a relay's target with their own authority (as create does), recording the grant
                    let user_for_relay = actor.is_none() && dog.owner_kind == "project" && kind == "fair_queue"
                        && !crate::domain::projects::reaches(&**client, dog.owner, pr.id).await?;
                    let reach = if user_for_relay { Some(json!({ "project": pr.id, "via": "user", "from": "user" })) }
                        else { watch_reach(&**client, org_id, dog.owner, &dog.owner_name, delegate.as_ref(), &pr, what).await? };
                    match reach {
                        Some(g) => p.memo_set.push(("reach_grant".into(), g)),
                        None => p.memo_del.push("reach_grant".into()),
                    }
                    // a relay may not target itself or close a relay loop (R7)
                    if kind == "fair_queue" && dog.owner_kind == "project" {
                        if pr.id == dog.owner {
                            refuse!(BadRequest, "project {} cannot relay into itself", pr.name);
                        }
                        if crate::domain::projects::relay_loop(&**client, dog.owner, pr.id).await? {
                            refuse!(Conflict, "a relay from {} into {} would close a loop", pr.name, dog.owner_name);
                        }
                    }
                    // one fair_queue / listener / listener_watch per owner per project, the dog itself aside
                    if kind != "slot" {
                        if let Some(r) = client.query_opt(
                            "SELECT uid, state FROM ot.watchdogs WHERE kind = $3 AND owner_agent_id = $1 AND id <> $4
                                AND state IN ('armed', 'paused') AND (memo->>'target_id')::bigint = $2 ORDER BY id LIMIT 1",
                            &[&dog.owner, &pr.id, &kind, &dog.row]).await? {
                            refuse!(Conflict, "{} already has {kind} watchdog {} ({}) on project {}; one per agent per project",
                                dog.owner_name, r.get::<_, String>(0), r.get::<_, String>(1), pr.name);
                        }
                    }
                    // what the dog holds through its old project stays its business first
                    if kind == "fair_queue" {
                        let held: i64 = client.query_one(&format!(
                            "SELECT count(*) FROM ot.mail m WHERE m.recipient_agent_id = $1 AND (m.extra->'claimed'->>'by_id')::bigint = $2
                                AND m.extra->'claimed'->>'dog' = $3 AND {}", crate::domain::projects::OUTSTANDING),
                            &[&old_pid, &dog.owner, &dog.uid]).await?.get(0);
                        if held > 0 {
                            refuse!(Conflict, "ACK or hand back the {held} jobs you hold through this watchdog first");
                        }
                        // a relay (project-owned): jobs it relayed that are still outstanding in the old project (R3)
                        if dog.owner_kind == "project" {
                            let relayed: i64 = client.query_one(&format!(
                                "SELECT count(*) FROM ot.mail m WHERE m.recipient_agent_id = $1 AND (m.extra->'claimed'->>'by_project')::bigint = $2
                                    AND m.extra->'claimed'->>'dog' = $3 AND {}", crate::domain::projects::OUTSTANDING),
                                &[&old_pid, &dog.owner, &dog.uid]).await?.get(0);
                            if relayed > 0 {
                                let from: String = client.query_one("SELECT name FROM ot.agents WHERE id = $1", &[&old_pid]).await?.get(0);
                                refuse!(Conflict, "{relayed} relayed jobs from @{from} are still outstanding in @{}; let them finish or take them back from @{from}'s queue, then edit", dog.owner_name);
                            }
                        }
                    }
                    if kind == "slot" && dog.memo.get("lease").is_some() {
                        refuse!(Conflict, "release the held slot first (release_slot), then edit");
                    }
                    if matches!(kind, "project_listener" | "listener_watch") {
                        p.switch_on = Some(pr.id);
                    }
                    p.memo_set.push(("target_id".into(), json!(pr.id)));
                    if kind == "slot" {
                        p.slot_admit = Some((pr.id, crate::domain::slots::requested(&dog.memo)));
                    }
                }
                target = pr.name.clone();
            }
            // websocket and mqtt validate their whole connection below
            _ => {}
        }
        p.changed.push("target".into());
        if matches!(kind, "file" | "command" | "process" | "activity") {
            p.rebaseline = true;
        }
        if kind == "stream" {
            p.restart = true;
        }
    }
    if has(args, "slots") {
        if dog.memo.get("lease").is_some() {
            refuse!(Conflict, "release the held slot first (release_slot), then edit");
        }
        let n = super::slots_value(&args["slots"])?;
        p.memo_set.push(("slots".into(), json!(n)));
        p.changed.push("slots".into());
        let project = p.memo_set.iter().find(|(k, _)| k == "target_id").and_then(|(_, v)| v.as_i64()).or(dog.memo["target_id"].as_i64());
        if let Some(pid) = project {
            p.slot_admit = Some((pid, n as i32));
        }
    }
    if matches!(kind, "websocket" | "mqtt") && (given.iter().any(|k| matches!(*k, "hello" | "heartbeat" | "protocols" | "credentials" | "payload_pattern" | "retained" | "target")) || has(args, "pattern")) {
        net(engine, org_id, actor, dog, args, &scratch, &editor_name, new_target.as_deref(), pattern.as_deref(), &mut p, &mut target).await?;
    }
    if kind == "usage" && given.iter().any(|k| matches!(*k, "threshold_percent" | "usage_events" | "windows" | "accounts")) {
        let validated = merged_usage(&dog.memo["usage"], args)?;
        let org = engine.orgs.by_id(org_id).map(|o| o.slug.clone()).unwrap_or_default();
        let rows = crate::tools::usage::watchdog_rows(engine, &org);
        if validated["accounts"].as_array().is_some_and(|ids| ids.iter().any(|id| !rows.iter().any(|r| r["account"] == *id))) {
            refuse!(Forbidden, "requested usage account is unavailable to this organization");
        }
        let (baseline, pending) = usage::initial(engine, org_id, dog.owner, &validated, &rows).await?;
        p.memo_set.push(("usage".into(), validated));
        p.memo_set.push(("run".into(), json!({ "usage": baseline, "usage_pending": pending, "usage_pending_fired": 0 })));
        for k in ["threshold_percent", "usage_events", "windows", "accounts"] {
            if has(args, k) {
                p.changed.push(k.into());
            }
        }
    }

    // ---- fire_actions
    if has(args, "fire_actions") || args.get("fire_actions").is_some_and(|v| v.as_array().is_some_and(|a| a.is_empty())) {
        if project_dog {
            refuse!(BadRequest, "fire_actions run as an agent; put them on your project_listener instead");
        }
        let list = super::fire_actions_arg(args)?;
        if by_other {
            super::fire_actions_listed(&list, &dog.owner_name)?;
        }
        if list.is_empty() {
            p.memo_del.push("fire_actions".into());
            p.memo_del.push("actions_by".into());
        } else {
            p.memo_set.push(("fire_actions".into(), json!(list)));
            // who the fire-time check intersects with: an editor above the owner; the owner (or the user) ends it
            if by_other {
                p.memo_set.push(("actions_by".into(), json!({ "id": actor, "name": editor_name })));
            } else if actor.is_none() {
                // the user's authority covers the owner's: no setter check at fire, recorded honestly
                p.memo_set.push(("actions_by".into(), json!("user")));
            } else {
                p.memo_set.push(("actions_by".into(), json!("owner")));
            }
        }
        p.changed.push("fire_actions".into());
    }

    // ---- smoke on what a poll dog now runs or watches (create's own smoke); a dog that cannot work is refused
    if matches!(kind, "file" | "command" | "process" | "stream") && (new_target.is_some() || has(args, "shell") || has(args, "pattern")) {
        let re = pattern.as_deref().and_then(|t| compile(t).ok());
        let cwd = scratch.is_dir().then_some(scratch.clone());
        let smoked = smoke(kind, &target, re.as_ref(), shell.as_deref(), cwd.as_deref()).await;
        // create only warns about a broken target: the edit saves it and returns the warning
        if smoked["broken"].as_bool().unwrap_or(false) {
            p.warnings.push(format!("ARMED BUT THE NEW TARGET DOES NOT WORK — {}", smoked["broken_why"].as_str().or(smoked["error"].as_str()).unwrap_or("its smoke run failed; see the dog's health after its first check")));
        }
    }
    if new_target.is_some() && !matches!(kind, "websocket" | "mqtt") {
        p.target = Some(target.clone());
    }
    // a project's dog may not become a duplicate of another (D16, the form excluded), the dog itself aside
    if project_dog {
        let mut eff = dog.memo.clone();
        for (k, v) in &p.memo_set {
            eff[k.as_str()] = v.clone();
        }
        let client = engine.db.get().await?;
        if let Some(dup) = project_duplicate(&**client, dog.owner, kind, &target, pattern.as_deref(), shell.as_deref(), &eff, dog.row).await? {
            refuse!(Conflict, "project {} already has this watchdog: {}/{}; listen to the project instead of adding another", dog.owner_name, dog.owner_name, dup);
        }
    }
    let _ = tier_b;
    Ok(p)
}

/// The websocket / mqtt connection after an edit: the whole set is validated as create validates it, with the
/// stored credentials reused for the same host (rev 1.5 5b), and the smoke rerun.
#[logged]
#[allow(clippy::too_many_arguments)]
async fn net(engine: &Arc<Engine>, org_id: i64, actor: Option<i64>, dog: &Dog, args: &Value, scratch: &Path, editor_name: &str,
    new_target: Option<&str>, pattern: Option<&str>, p: &mut Plan, target: &mut String) -> Result<()> {
    let kind = dog.kind.as_str();
    let memo_net = dog.memo[kind].clone();
    // the editor needs the web tool too (W3 with the editor as setter)
    if let Some(a) = actor.filter(|a| *a != dog.owner) {
        if !holds_web(engine, a).await? {
            refuse!(Forbidden, "a {kind} watchdog reaches the network with the hands of whoever edits it too — it needs the web tool {editor_name} does not hold");
        }
    }
    let t = new_target.unwrap_or(&dog.target).to_string();
    let host_changed = new_target.is_some() && host_key(&t) != host_key(&dog.target);
    let stored_kind = memo_net["credentials"]["kind"].as_str().map(str::to_string);
    let mut merged = json!({ "target": t, "pattern": pattern, "name": dog.name });
    if kind == "websocket" {
        merged["hello"] = if has(args, "hello") { args["hello"].clone() } else { memo_net["hello"].clone() };
        merged["protocols"] = if has(args, "protocols") { args["protocols"].clone() } else { memo_net["protocols"].clone() };
        merged["heartbeat"] = if has(args, "heartbeat") { args["heartbeat"].clone() } else { memo_net["heartbeat"].clone() };
        merged["notify_on_connect"] = memo_net["notify_on_connect"].clone();
    } else {
        merged["payload_pattern"] = if has(args, "payload_pattern") { args["payload_pattern"].clone() } else { memo_net["payload_pattern"].clone() };
        merged["retained"] = if has(args, "retained") { args["retained"].clone() } else { memo_net["retained"].clone() };
    }
    // credentials: given, or the stored ones on the same host
    let mut stored: Option<Vec<u8>> = None;
    if has(args, "credentials") {
        merged["credentials"] = args["credentials"].clone();
    } else {
        match stored_kind.as_deref() {
            Some("file") => {
                if host_changed {
                    refuse!(BadRequest, "the new target is a different host; re-supply credentials with this edit (stored ones are never sent to a new host)");
                }
                merged["credentials"] = memo_net["credentials"]["path"].clone();
            }
            Some("inline") => {
                if host_changed {
                    refuse!(BadRequest, "the new target is a different host; re-supply credentials with this edit (stored ones are never sent to a new host)");
                }
                let sealed: Option<Vec<u8>> = engine.db.get().await?
                    .query_opt("SELECT sealed FROM ot.watchdog_secrets WHERE watchdog_id = $1", &[&dog.row]).await?.map(|r| r.get(0));
                let Some(sealed) = sealed else { refuse!(Conflict, "its inline credentials are gone; re-supply credentials with this edit") };
                let bytes = engine.dogs.mqtt.key(&mqtt::secrets_dir(engine))
                    .and_then(|k| crate::mqtt::seal::unseal(&k, dog.row, &sealed))
                    .map_err(|e| crate::domain::user_err(crate::domain::UserError::Unprocessable, format!("the stored credentials cannot be read: {e}")))?;
                stored = Some(bytes);
            }
            _ => {}
        }
    }
    // a credentials file must sit in a folder the editor holds too
    if let (Some(path), Some(a)) = (merged["credentials"].as_str().map(str::to_string), actor.filter(|a| *a != dog.owner)) {
        let r = engine.db.get().await?.query_one("SELECT name, scratch_dir FROM ot.agents WHERE id = $1", &[&a]).await?;
        let dir = owner_scratch(engine, org_id, &r.get::<_, String>(0), r.get::<_, Option<String>>(1).as_deref());
        if !file_contained(engine, org_id, a, &dir, &file_target(scratch, &path)).await? {
            refuse!(Forbidden, "cannot read credentials from {path} — only files in a folder you hold are readable; use inline credentials instead");
        }
    }
    if kind == "websocket" {
        let c = websocket::validate(engine, org_id, dog.owner, scratch, &t, &merged, stored.as_deref()).await?;
        let (smoked, parked) = websocket::smoke(engine, &c).await;
        drop(parked);
        if smoked["broken"].as_bool().unwrap_or(false) {
            p.warnings.push(format!("ARMED, BUT NOT CONNECTED — {}", smoked["note"].as_str().or(smoked["error"].as_str()).unwrap_or("see the dog's connection state")));
        }
        *target = c.target.clone();
        p.target = Some(c.target.clone());
        if has(args, "credentials") {
            p.sealed = Some(websocket::sealed(engine, &c, dog.row)?);
        }
        p.memo_set.push(("websocket".into(), c.memo.clone()));
    } else {
        let c = mqtt::validate(engine, org_id, dog.owner, scratch, &t, &merged, stored.as_deref()).await?;
        let (smoked, parked) = mqtt::smoke(engine, dog.owner, &c).await;
        drop(parked);
        if smoked["broken"].as_bool().unwrap_or(false) {
            p.warnings.push(format!("ARMED, BUT NOT CONNECTED — {}", smoked["note"].as_str().or(smoked["error"].as_str()).unwrap_or("see the dog's connection state")));
        }
        *target = c.target.clone();
        p.target = Some(c.target.clone());
        if has(args, "credentials") {
            p.sealed = Some(mqtt::sealed(engine, &c, dog.row)?);
        }
        p.memo_set.push(("mqtt".into(), c.memo.clone()));
    }
    for k in ["target", "hello", "heartbeat", "protocols", "credentials", "payload_pattern", "retained"] {
        if has(args, k) && !p.changed.iter().any(|c| c == k) {
            p.changed.push(k.to_string());
        }
    }
    // every edit of the connection reconnects the runner (rev 1.6): the live connection holds its compiled filter,
    // so a pattern, payload_pattern or retained edit must take effect now too (same host: no credentials needed)
    p.restart = true;
    Ok(())
}

/// Merge a plan into the dog's memo (inside configure's transaction) and write its columns and side effects.
#[logged]
pub(super) async fn apply(tx: &tokio_postgres::Transaction<'_>, dog: &Dog, org_id: i64, plan: &Plan, memo: &mut Value, state: &str) -> Result<()> {
    for (k, v) in &plan.memo_set {
        memo[k.as_str()] = v.clone();
    }
    if let Some(o) = memo.as_object_mut() {
        for k in &plan.memo_del {
            o.remove(k);
        }
    }
    if plan.rebaseline {
        memo["run"] = json!({});
        if dog.kind == "file" {
            let t = plan.target.clone().unwrap_or_else(|| dog.target.clone());
            memo["run"]["offset"] = json!(std::fs::metadata(&t).map(|m| m.len()).unwrap_or(0));
        }
    }
    if let Some(project) = plan.switch_on {
        crate::domain::listeners::switch_on(tx, project).await?;
    }
    if let Some((project, count)) = plan.slot_admit {
        tx.query_one("SELECT id FROM ot.agents WHERE id = $1 FOR NO KEY UPDATE", &[&project]).await?;
        crate::domain::slots::admit(tx, project, Some(dog.owner), i64::from(count), Some(dog.row)).await?;
        // a waiting claim re-joins at the back, as a resume does
        memo["queued_at"] = json!(Utc::now().timestamp_millis());
    }
    let _ = (org_id, state);
    // R3 rule 7 again, in the locked transaction: a claim committed since `plan` still blocks the retarget (a relay's
    // outstanding jobs `by_project`, an agent's own `by_id`), and nothing is written
    if plan.memo_set.iter().any(|(k, _)| k == "target_id") && dog.kind == "fair_queue" {
        if let Some(old) = dog.memo["target_id"].as_i64() {
            let (col, who) = if dog.project_owned() { ("by_project", "relay") } else { ("by_id", "dog") };
            let held: i64 = tx.query_one(&format!(
                "SELECT count(*) FROM ot.mail m WHERE m.recipient_agent_id = $1 AND (m.extra->'claimed'->>'{col}')::bigint = $2
                    AND m.extra->'claimed'->>'dog' = $3 AND {}", crate::domain::projects::OUTSTANDING),
                &[&old, &dog.owner, &dog.uid]).await?.get(0);
            if held > 0 {
                if who == "relay" {
                    let from: String = tx.query_one("SELECT name FROM ot.agents WHERE id = $1", &[&old]).await?.get(0);
                    refuse!(Conflict, "{held} relayed jobs from @{from} are still outstanding in @{}; let them finish or take them back from @{from}'s queue, then edit", dog.owner_name);
                }
                refuse!(Conflict, "ACK or hand back the {held} jobs you hold through this watchdog first");
            }
        }
    }
    // D16 again, under the project row lock configure holds: two edits that each passed the early check
    // in `plan` cannot both be written into one tuple (the dog itself excepted)
    if dog.project_owned() {
        let target = plan.target.clone().unwrap_or_else(|| dog.target.clone());
        let pattern = plan.pattern.clone().unwrap_or_else(|| dog.pattern.clone());
        let shell = plan.shell.clone().or_else(|| dog.shell.clone());
        if let Some(dup) = project_duplicate(tx, dog.owner, &dog.kind, &target, pattern.as_deref(), shell.as_deref(), memo, dog.row).await? {
            refuse!(Conflict, "project {} already has this watchdog: {}/{}; listen to the project instead of adding another", dog.owner_name, dog.owner_name, dup);
        }
    } else if let Some(pid) = plan.memo_set.iter().find(|(k, _)| k == "target_id").and_then(|(_, v)| v.as_i64())
        .filter(|_| matches!(dog.kind.as_str(), "fair_queue" | "project_listener" | "listener_watch")) {
        // one fair_queue / listener / listener_watch per owner per project, under the owner row lock
        tx.query_one("SELECT id FROM ot.agents WHERE id = $1 FOR NO KEY UPDATE", &[&dog.owner]).await?;
        if let Some((uid, state)) = owner_limit_clash(tx, dog.owner, &dog.kind, pid, dog.row).await? {
            refuse!(Conflict, "{} already has {} watchdog {} ({}) on that project; one per agent per project", dog.owner_name, dog.kind, uid, state);
        }
    }
    tx.execute(
        "UPDATE ot.watchdogs SET target = coalesce($2, target), pattern = CASE WHEN $3 THEN $4 ELSE pattern END, shell = coalesce($5, shell),
                interval_s = coalesce($6, interval_s), fire_mode = coalesce($7, fire_mode),
                quiet_period_s = CASE WHEN $8 THEN $9 ELSE quiet_period_s END, once = coalesce($10, once),
                next_check_at = CASE WHEN $11 AND state = 'armed' AND kind IN ('file','command','process') THEN now() ELSE next_check_at END,
                silence_since = CASE WHEN $12 AND state = 'armed' AND fire_mode = 'silence' THEN now() ELSE silence_since END
          WHERE id = $1",
        &[&dog.row, &plan.target, &plan.pattern.is_some(), &plan.pattern.clone().flatten(), &plan.shell, &plan.interval, &plan.fire_mode,
          &plan.quiet.is_some(), &plan.quiet.flatten(), &plan.once, &plan.rebaseline, &plan.silence_reset],
    )
    .await?;
    if plan.silence_reset {
        tx.execute("UPDATE ot.watchdogs SET next_silence_at = CASE WHEN fire_mode = 'silence' AND state = 'armed' THEN now() + greatest(coalesce(quiet_period_s, 600), 1) * interval '1 second' END WHERE id = $1", &[&dog.row]).await?;
    }
    match &plan.sealed {
        Some(Some(bytes)) => {
            tx.execute("INSERT INTO ot.watchdog_secrets (watchdog_id, sealed) VALUES ($1, $2) ON CONFLICT (watchdog_id) DO UPDATE SET sealed = $2", &[&dog.row, bytes]).await?;
        }
        Some(None) => {
            tx.execute("DELETE FROM ot.watchdog_secrets WHERE watchdog_id = $1", &[&dog.row]).await?;
        }
        None => {}
    }
    Ok(())
}

#[cfg(test)]
mod pip_tests {
    use super::*;
    const SWITCH: &str = "remove this dog and create a new one to switch pip mode";
    fn msg(r: Result<Value>) -> String { r.expect_err("must be refused").to_string() }

    // spec usage-watchdog-fable-pip.md section 8, test 15 (the pure half: the merge and the mode-switch refusals;
    // the re-seed itself is `usage::initial`, the call that follows a successful merge)
    #[test]
    fn configure_may_change_the_offset_inside_pip_mode() {
        let pip = json!({"fable_pip_offset":-2,"usage_events":["pip_reached"]});
        let merged = merged_usage(&pip, &json!({"fable_pip_offset":-1})).unwrap();
        assert_eq!(merged["fable_pip_offset"], json!(-1));
        assert_eq!(merged["usage_events"], json!(["pip_reached"]));
        let merged = merged_usage(&pip, &json!({"usage_events":["pip_reached","pip_cleared"],"accounts":["claude-5"]})).unwrap();
        assert_eq!((merged["fable_pip_offset"].clone(), merged["accounts"].clone()), (json!(-2), json!(["claude-5"])));
    }
    #[test]
    fn configure_cannot_switch_a_dog_into_or_out_of_pip_mode() {
        let pip = json!({"fable_pip_offset":-2,"usage_events":["pip_reached"]});
        let plain = json!({"threshold_percent":98,"usage_events":["above"]});
        assert_eq!(msg(merged_usage(&plain, &json!({"fable_pip_offset":1}))), SWITCH);
        assert_eq!(msg(merged_usage(&pip, &json!({"fable_pip_offset":null}))), SWITCH);
        assert_eq!(msg(merged_usage(&pip, &json!({"threshold_percent":98}))), SWITCH);
        assert_eq!(msg(merged_usage(&pip, &json!({"windows":["weekly"]}))), SWITCH);
        // control: the same plain dog still edits normally
        assert_eq!(merged_usage(&plain, &json!({"threshold_percent":90})).unwrap()["threshold_percent"], json!(90));
    }
}
