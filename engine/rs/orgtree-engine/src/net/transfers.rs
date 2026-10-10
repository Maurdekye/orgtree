//! Durable outgoing attachment workers. No credentials enter these rows.
//! Byte progress is transport consumption; only a hub response confirms it.
use super::*;
use futures::FutureExt;
use std::collections::HashSet;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::task::JoinSet;

const PIECE: u64 = 8 * 1024 * 1024;

#[derive(Debug)]
pub(super) struct Permanent(String);
impl std::fmt::Display for Permanent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Permanent {}

#[logged]
pub(super) fn permanent(message: &str) -> anyhow::Error {
    Permanent(message.to_string()).into()
}

#[derive(Debug)]
struct Job {
    id: String,
    org: i64,
    inbox: i64,
    hub: String,
    address: String,
    source: Value,
    total: i64,
    session: Option<String>,
    sha: Option<String>,
    attempt: i32,
}

/// Prepare jobs without doing file/network I/O. An empty result means wait.
#[logged]
pub(super) async fn ready(engine: &Engine, org: i64, inbox: i64, hub: &str, address: &str, files: &[Value]) -> Result<Option<Vec<String>>> {
    let mut c = engine.db.get().await?;
    let tx = c.transaction().await?;
    for (index, file) in files.iter().enumerate() {
        let total = file["bytes"].as_u64().and_then(|n| i64::try_from(n).ok()).unwrap_or(0);
        let id = crate::util::uid("transfer");
        // Existing completed IDs are retained for pre-migration queued mail.
        let result = file["hub_id"].as_str();
        tx.execute(
            "INSERT INTO ot.net_transfers (id,org_id,inbox_id,file_no,hub,address,source,total,state,result_id,confirmed,processed)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $9::text IS NULL THEN 'queued' ELSE 'complete' END,$9,
                CASE WHEN $9::text IS NULL THEN 0::bigint ELSE $8::bigint END,CASE WHEN $9::text IS NULL THEN 0::bigint ELSE $8::bigint END)
            ON CONFLICT (inbox_id,file_no) DO NOTHING",
            &[&id, &org, &inbox, &(index as i32), &hub, &address, &crate::util::pg_json(file).as_ref(), &total, &result],
        )
        .await?;
    }
    tx.execute("UPDATE ot.org_inbox SET hub=$2 WHERE id=$1 AND hub IS NULL", &[&inbox, &hub]).await?;
    let rows = tx.query("SELECT state,result_id,address,error FROM ot.net_transfers WHERE inbox_id=$1 ORDER BY file_no", &[&inbox]).await?;
    tx.commit().await?;
    let mut ids = Vec::new();
    for r in rows {
        let state: String = r.get(0);
        if state == "removed" { continue; }
        if r.get::<_, String>(2) != address {
            return Err(permanent("the transfer's hub address changed; restore that hub or retry on the new hub"));
        }
        if matches!(state.as_str(), "failed" | "cancelled" | "paused") {
            return Err(permanent(r.get::<_, Option<String>>(3).as_deref().unwrap_or("attachment transfer is held; retry or remove the file")));
        }
        if state != "complete" {
            return Ok(None);
        }
        ids.push(r.get::<_, Option<String>>(1).ok_or_else(|| permanent("completed upload has no hub attachment ID"))?);
    }
    Ok(Some(ids))
}

#[logged]
pub(super) fn start(engine: &Arc<Engine>) {
    let e = engine.clone();
    tokio::spawn(async move {
        if let Err(err) = scheduler(&e).await {
            tracing::error!(error=%format!("{err:#}"), "transfer scheduler stopped");
        }
    });
}

#[derive(Debug)]
enum Work {
    Upload(Job, Part),
    Download(incoming::Job, Part),
}

impl Work {
    #[nolog]
    fn id(&self) -> &str {
        match self { Self::Upload(j, _) => &j.id, Self::Download(j, _) => &j.id }
    }
    #[nolog]
    fn address(&self) -> &str {
        match self {
            Self::Upload(j, _) => &j.address,
            Self::Download(j, _) => &j.address,
        }
    }
}
#[logged]
async fn run_work(work: &Work, e: &Arc<Engine>) -> Result<String> {
    match work {
        Work::Upload(j, p) => upload(e, p, j).await,
        Work::Download(j, p) => incoming::run(e, p, j).await,
    }
}
#[logged]
async fn settle_work(work: &Work, e: &Engine, result: Result<String>) -> Result<()> {
    match work {
        Work::Upload(j, _) => settle(e, j, result).await,
        Work::Download(j, _) => incoming::settle(e, j, result).await,
    }
}

#[logged]
async fn claim_work(e: &Engine, active: &HashSet<String>, incoming_first: bool) -> Result<Option<Work>> {
    if incoming_first {
        if let Some((j, p)) = incoming::claim(e, active).await? {
            return Ok(Some(Work::Download(j, p)));
        }
    }
    if let Some((j, p)) = claim(e, active).await? {
        return Ok(Some(Work::Upload(j, p)));
    }
    if !incoming_first {
        if let Some((j, p)) = incoming::claim(e, active).await? {
            return Ok(Some(Work::Download(j, p)));
        }
    }
    Ok(None)
}

#[logged]
async fn scheduler(e: &Arc<Engine>) -> Result<()> {
    // The old process cannot still own a request after engine startup.
    e.db.get()
        .await?
        .execute("UPDATE ot.net_transfers SET state='queued',next_at=now() WHERE state IN ('preparing','uploading','confirming')", &[])
        .await?;
    e.db.get().await?.execute("UPDATE ot.net_incoming SET state='queued',next_at=now() WHERE state IN ('downloading','delivering')", &[]).await?;
    let mut tasks = JoinSet::new();
    let mut incoming_first = false;
    let mut active = HashSet::<String>::new();
    loop {
        if let Err(err) = failures::dispatch(e).await {
            tracing::warn!(error=%format!("{err:#}"), "transfer failure notification deferred");
        }
        while tasks.len() < 2 {
            incoming_first = !incoming_first;
            match claim_work(e, &active, incoming_first).await {
                Ok(Some(work)) => {
                    active.insert(work.address().to_owned());
                    let e = e.clone();
                    tasks.spawn(async move {
                        let address = work.address().to_owned();
                        let id = work.id().to_owned();
                        let stop = CancellationToken::new();
                        e.net.transfer_stops.pin().insert(id.clone(), stop.clone());
                        let future = async {
                            // Register before checking intent: a racing cancel either
                            // sees this token or the worker sees the persisted cancel.
                            if !control::running(&e, &id).await? { return Ok(()); }
                            let outcome = tokio::select! {
                                biased;
                                _ = stop.cancelled() => return Ok(()),
                                result = run_work(&work, &e) => result,
                            };
                            settle_work(&work, &e, outcome).await
                        };
                        let result = tokio::select! {
                            _=e.shutdown.cancelled()=>return address,
                            result=std::panic::AssertUnwindSafe(future).catch_unwind()=>
                                result.unwrap_or_else(|_|Err(anyhow::anyhow!("transfer worker failed unexpectedly"))),
                        };
                        e.net.transfer_stops.pin().remove(&id);
                        if let Err(err) = result {
                            tracing::warn!(error=%format!("{err:#}"),"transfer worker or result write failed");
                        }
                        // Even a panic returns ownership; claim recovers any unfinished state.
                        address
                    });
                }
                Ok(None) => break,
                Err(err) => {
                    tracing::warn!(error=%format!("{err:#}"), "transfer claim failed");
                    break;
                }
            }
        }
        tokio::select! {
            _ = e.shutdown.cancelled() => { tasks.abort_all(); while tasks.join_next().await.is_some() {} return Ok(()); }
            done = tasks.join_next(), if !tasks.is_empty() => {
                match done {
                    Some(Ok(address)) => { active.remove(&address); }
                    Some(Err(err)) => tracing::error!(error=%err, "transfer worker panicked"),
                    None => {}
                }
            }
            _ = tokio::time::sleep(Duration::from_secs(1)) => {}
        }
    }
}

#[logged]
async fn claim(e: &Engine, active: &HashSet<String>) -> Result<Option<(Job, Part)>> {
    let parts = e.net.parts.load_full();
    let addresses: Vec<String> = active.iter().cloned().collect();
    let orgs: Vec<i64> = parts.iter().map(|p| p.org_id).collect();
    let mut c = e.db.get().await?;
    let tx = c.transaction().await?;
    // A result write can fail transiently after the worker exits. Reclaim
    // only requests which this scheduler no longer owns, never live workers.
    tx.execute(
        "UPDATE ot.net_transfers SET state='retry_wait',next_at=now() WHERE state IN ('preparing','uploading','confirming')
        AND NOT(address=ANY($1)) AND org_id=ANY($2)",
        &[&addresses, &orgs],
    )
    .await?;
    let rows = tx
        .query(
            "SELECT t.id,t.org_id,t.inbox_id,t.hub,t.address,t.source,t.total,t.session_id,t.sha256,t.attempt
        FROM ot.net_transfers t JOIN ot.org_inbox i ON i.id=t.inbox_id
        WHERE t.state IN ('queued','retry_wait') AND t.next_at<=now() AND i.state='queued'
          AND NOT(t.address=ANY($1)) AND t.org_id=ANY($2)
        ORDER BY t.next_at,t.updated_at,t.id LIMIT 50 FOR UPDATE OF t SKIP LOCKED",
            &[&addresses, &orgs],
        )
        .await?;
    for r in rows {
        let job = Job {
            id: r.get(0),
            org: r.get(1),
            inbox: r.get(2),
            hub: r.get(3),
            address: r.get(4),
            source: r.get(5),
            total: r.get(6),
            session: r.get(7),
            sha: r.get(8),
            attempt: r.get(9),
        };
        let Some(part) = parts
            .iter()
            .find(|p| p.org_id == job.org && p.registered.contains(&job.hub) && p.hubs.iter().any(|(h, a)| h == &job.hub && a == &job.address))
        else {
            continue;
        };
        if backed_off(e, &job.address) {
            continue;
        }
        tx.execute("UPDATE ot.net_transfers SET state='preparing',attempt=attempt+1,error=NULL,updated_at=now() WHERE id=$1", &[&job.id]).await?;
        tx.commit().await?;
        return Ok(Some((job, part.clone())));
    }
    tx.commit().await?;
    Ok(None)
}

#[logged]
async fn progress(e: &Engine, id: &str, state: &str, processed: i64, confirmed: i64) -> Result<()> {
    let c = e.db.get().await?;
    c.execute(
        "UPDATE ot.net_transfers SET state=$2,processed=$3,confirmed=$4,updated_at=now() WHERE id=$1
        AND state IN ('preparing','uploading','confirming')",
        &[&id, &state, &processed, &confirmed],
    )
    .await?;
    Ok(())
}

/// Bounded stream; progress updates at most four times per second.
#[logged]
async fn body(e: &Arc<Engine>, job: &Job, offset: u64, length: u64) -> Result<reqwest::Body> {
    let path = job.source["path"].as_str().ok_or_else(|| permanent("staged attachment has no path"))?;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| permanent("staged attachment cannot be read; restore it or remove this file before sending"))?;
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    let context = (file.take(length), e.clone(), job.id.clone(), offset, offset, Instant::now());
    let stream = futures::stream::try_unfold(context, |(mut file, e, id, mut at, confirmed, mut last)| async move {
        let mut bytes = vec![0u8; 64 * 1024];
        let n = file.read(&mut bytes).await?;
        if n == 0 {
            return Ok::<_, std::io::Error>(None);
        }
        bytes.truncate(n);
        at += n as u64;
        if last.elapsed() >= Duration::from_millis(250) {
            progress(&e, &id, "uploading", at as i64, confirmed as i64).await.map_err(std::io::Error::other)?;
            last = Instant::now();
        }
        Ok(Some((bytes, (file, e, id, at, confirmed, last))))
    });
    Ok(reqwest::Body::wrap_stream(stream))
}

#[logged]
async fn json_response(r: reqwest::Response) -> Result<Value> {
    let code = r.status().as_u16();
    if matches!(code, 400 | 401 | 403 | 410 | 413 | 422) {
        return Err(permanent(&format!("attachment transfer HTTP {code}; retry after correcting the cause")));
    }
    Ok(r.error_for_status()?.json().await?)
}

#[logged]
async fn upload(e: &Arc<Engine>, p: &Part, job: &Job) -> Result<String> {
    let path = job.source["path"].as_str().ok_or_else(|| permanent("staged attachment has no path"))?;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| permanent("staged attachment cannot be read; restore it or remove this file before sending"))?;
    if file.metadata().await?.len() != job.total as u64 {
        return Err(permanent("staged attachment size changed; remove it and attach it again"));
    }
    let mut hasher = Sha256::new();
    let mut buf = vec![0; 256 * 1024];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hex::encode(hasher.finalize());
    if job.sha.as_ref().is_some_and(|old| old != &digest) {
        return Err(permanent("staged attachment contents changed; remove it and attach it again"));
    }
    drop(file);
    e.db.get().await?.execute("UPDATE ot.net_transfers SET sha256=$2 WHERE id=$1", &[&job.id, &digest]).await?;
    let health =
        HTTP.get(format!("{}/healthz", job.address)).timeout(Duration::from_secs(5)).send().await?.error_for_status()?.json::<Value>().await?;
    let limit = AttachmentLimit::from_health(&health);
    if job.total as u64 > limit.bytes {
        return Err(permanent(&limit.message()));
    }
    let resumable = health["features"].as_array().is_some_and(|fs| fs.iter().any(|f| f == "uploads"));
    if !resumable {
        progress(e, &job.id, "uploading", 0, 0).await?;
        let result = json_response(
            HTTP.post(format!("{}/api/attachments", job.address))
                .timeout(FILE_TIMEOUT)
                .header("X-Org-Auth", p.auth())
                .query(&[("name", job.source["name"].as_str().unwrap_or("file"))])
                .header(reqwest::header::CONTENT_LENGTH, job.total)
                .body(body(e, job, 0, job.total as u64).await?)
                .send()
                .await?,
        )
        .await?;
        return result["id"].as_str().map(str::to_owned).ok_or_else(|| anyhow::anyhow!("hub upload response has no attachment ID"));
    }
    let mut status = Value::Null;
    if let Some(id) = &job.session {
        let r = HTTP.get(format!("{}/api/uploads/{id}", job.address)).timeout(Duration::from_secs(10)).header("X-Org-Auth", p.auth()).send().await?;
        if !matches!(r.status().as_u16(), 404 | 410) {
            status = json_response(r).await?;
        }
        // Missing, expired or damaged sessions start over; transient errors retain them.
    }
    if status.is_null() {
        status = json_response(
            HTTP.post(format!("{}/api/uploads", job.address))
                .timeout(Duration::from_secs(10))
                .header("X-Org-Auth", p.auth())
                .json(&json!({"bytes":job.total,"name":job.source["name"],"sha256":digest}))
                .send()
                .await?,
        )
        .await?;
        let id = status["id"].as_str().ok_or_else(|| anyhow::anyhow!("hub session response has no ID"))?;
        e.db.get().await?.execute("UPDATE ot.net_transfers SET session_id=$2,processed=0,confirmed=0 WHERE id=$1", &[&job.id, &id]).await?;
    }
    let id = status["id"].as_str().ok_or_else(|| anyhow::anyhow!("hub session response has no ID"))?.to_string();
    loop {
        let offset = status["offset"].as_u64().ok_or_else(|| anyhow::anyhow!("hub session response has no offset"))?;
        if offset > job.total as u64 || status["bytes"].as_i64() != Some(job.total) {
            return Err(permanent("hub upload session does not match this attachment"));
        }
        if status["complete"] == true {
            if offset != job.total as u64 {
                return Err(permanent("hub completed an attachment at the wrong size"));
            }
            return Ok(id);
        }
        let length = PIECE.min(job.total as u64 - offset);
        if length == 0 {
            return Err(anyhow::anyhow!("hub has all bytes but has not confirmed completion"));
        }
        progress(e, &job.id, "uploading", offset as i64, offset as i64).await?;
        let r = HTTP
            .patch(format!("{}/api/uploads/{id}", job.address))
            .query(&[("offset", offset)])
            .timeout(FILE_TIMEOUT)
            .header("X-Org-Auth", p.auth())
            .header(reqwest::header::CONTENT_LENGTH, length)
            .body(body(e, job, offset, length).await?)
            .send()
            .await?;
        progress(e, &job.id, "confirming", (offset + length) as i64, offset as i64).await?;
        status = json_response(r).await?;
        if status["offset"].as_u64().unwrap_or(0) <= offset {
            return Err(anyhow::anyhow!("hub upload made no confirmed progress"));
        }
    }
}

#[logged]
async fn settle(e: &Engine, job: &Job, outcome: Result<String>) -> Result<()> {
    let mut c = e.db.get().await?;
    let tx = c.transaction().await?;
    match outcome {
        Ok(id) => {
            tx.execute("UPDATE ot.net_transfers SET state='complete',processed=total,confirmed=total,result_id=$2,error=NULL,updated_at=now() WHERE id=$1 AND state IN ('preparing','uploading','confirming')", &[&job.id,&id]).await?;
        }
        Err(err) => {
            let state = if err.is::<Permanent>() { "failed" } else { "retry_wait" };
            let error = err.downcast_ref::<reqwest::Error>().map(short_error).unwrap_or_else(|| crate::util::gist(&err.to_string(), 300));
            let delay = (2i32.pow((job.attempt as u32).min(8))).min(300);
            let n = tx.execute("UPDATE ot.net_transfers SET state=$2,error=$3,next_at=now()+make_interval(secs=>$4),updated_at=now() WHERE id=$1 AND state IN ('preparing','uploading','confirming')", &[&job.id,&state,&error,&(delay as f64)]).await?;
            if n > 0 {
                tx.execute("UPDATE ot.org_inbox SET last_err=$2 WHERE id=$1 AND state='queued'", &[&job.inbox,&error]).await?;
                if state == "failed" { failures::record(&tx,job.org,&job.id,true,&error).await?; }
            }
        }
    }
    tx.commit().await?;
    drop(c);
    changes::notify_id(e, job.org, vec![Change::OrgInbox]);
    kick(e);
    Ok(())
}

/// Loopback-only proof entry: real spool, database, HTTP stream and result
/// persistence, without registering any real network identity.
#[cfg(debug_assertions)]
#[logged]
pub(super) async fn rig_attempt(e: &Arc<Engine>, org: i64, args: &Value) -> Result<Value> {
    let address = args["address"].as_str().unwrap_or("");
    let url = reqwest::Url::parse(address)?;
    anyhow::ensure!(
        url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.username().is_empty() && url.password().is_none(),
        "rig transfer needs loopback HTTP"
    );
    let part = Part {
        org_id: org,
        slug: "rig".into(),
        name: "rig".into(),
        net_slug: "rig.transfer".into(),
        secret: "synthetic-proof".into(),
        hubs: vec![("rig-transfer".into(), address.into())],
        registered: HashSet::from(["rig-transfer".into()]),
    };
    if args["action"] == "notifications" {
        failures::dispatch(e).await?;
        return Ok(json!({"ok":true}));
    }
    if args["action"] == "workers" {
        anyhow::ensure!(offline(), "worker proof requires network-offline rig");
        e.net.parts.store(Arc::new(vec![part]));
        if !e.net.rig_workers.swap(true, std::sync::atomic::Ordering::SeqCst) {
            start(e);
        }
        return Ok(json!({"ok":true}));
    }
    if args["action"] == "receive" {
        let message = &args["message"];
        let ack = deliver_inbound(e, &part, "rig-transfer", address, message).await?;
        return Ok(json!({"ack":ack}));
    }
    if args["action"] == "drain" {
        drain(e, &[part]).await?;
        return Ok(json!({"ok":true}));
    }
    if args["action"] == "plan" {
        let total = args["bytes"].as_u64().unwrap_or(1024).min(32 * 1024 * 1024);
        let path = e.cfg.path(&crate::util::uid("rig-transfer"));
        if args["missing"] != true {
            tokio::fs::write(&path, vec![b'x'; total as usize]).await?;
        }
        let count = args["file_count"].as_u64().unwrap_or(1).clamp(1,10);
        let files: Vec<Value> = (0..count).map(|n| json!({"path":path.to_string_lossy(),"name":format!("proof-{n}.bin"),"bytes":total})).collect();
        let (uid, _) = queue_row(e, org, "peer.rig", "transfer proof", args["by"].as_str().unwrap_or("user"), "message", &files, None).await?;
        let c = e.db.get().await?;
        let inbox: i64 = c.query_one("SELECT id FROM ot.org_inbox WHERE uid=$1", &[&uid]).await?.get(0);
        drop(c);
        let available = ready(e, org, inbox, "rig-transfer", address, &files).await?;
        let c = e.db.get().await?;
        let ids: Vec<String> = c.query("SELECT id FROM ot.net_transfers WHERE inbox_id=$1 ORDER BY file_no", &[&inbox]).await?.iter().map(|r|r.get(0)).collect();
        return Ok(json!({"id":ids[0],"ids":ids,"inbox":inbox,"ready":available.is_some()}));
    }
    let id = args["id"].as_str().unwrap_or("");
    let c = e.db.get().await?;
    let r = c
        .query_one(
            "SELECT id,org_id,inbox_id,hub,address,source,total,session_id,sha256,attempt FROM ot.net_transfers WHERE id=$1 AND org_id=$2",
            &[&id, &org],
        )
        .await?;
    let job = Job {
        id: r.get(0),
        org: r.get(1),
        inbox: r.get(2),
        hub: r.get(3),
        address: r.get(4),
        source: r.get(5),
        total: r.get(6),
        session: r.get(7),
        sha: r.get(8),
        attempt: r.get(9),
    };
    anyhow::ensure!(job.address == address, "rig transfer address changed");
    c.execute("UPDATE ot.net_transfers SET state='preparing',attempt=attempt+1 WHERE id=$1", &[&id]).await?;
    drop(c);
    let result = upload(e, &part, &job).await;
    settle(e, &job, result).await?;
    let c = e.db.get().await?;
    let state: String = c.query_one("SELECT state FROM ot.net_transfers WHERE id=$1", &[&id]).await?.get(0);
    Ok(json!({"state":state}))
}
