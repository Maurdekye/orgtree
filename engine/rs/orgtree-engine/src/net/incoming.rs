//! Durable inbound custody and checkpointed downloads. Nothing is delivered
//! until all files (including a long body) are complete on local disk.
use super::*;
use futures::StreamExt;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

#[derive(Debug)]
pub(super) struct Job {
    pub id: String,
    pub org: i64,
    pub hub: String,
    pub address: String,
    envelope: Value,
    attempt: i32,
}

#[logged]
pub(super) async fn stage(e: &Engine, p: &Part, hub: &str, address: &str, m: &Value) -> Result<()> {
    let mid = m["id"].as_str().unwrap_or("");
    let id = crate::util::uid("incoming");
    let mut files = Vec::new();
    if let Some(total) = m["body_bytes"].as_u64() {
        files.push((json!(["api", "messages", mid, "body"]), "message.txt".to_owned(), Some(total), true));
    }
    for a in m["attachments"].as_array().into_iter().flatten() {
        let fid = a["id"].as_str().ok_or_else(|| anyhow::anyhow!("attachment has no hub ID"))?;
        let name = a["name"].as_str().unwrap_or("file");
        let safe = std::path::Path::new(name).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
        files.push((json!(["api", "attachments", fid]), safe, a["bytes"].as_u64(), false));
    }
    anyhow::ensure!(files.len() <= 1024, "incoming attachment manifest is too large");
    let mut c = e.db.get().await?;
    let tx = c.transaction().await?;
    crate::domain::orginbox::admit(&tx, &[p.org_id]).await?;
    let added = tx
        .execute(
            "INSERT INTO ot.net_incoming(id,org_id,hub,address,net_id,envelope) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(org_id,net_id) DO NOTHING",
            &[&id, &p.org_id, &hub, &address, &mid, &crate::util::pg_json(m).as_ref()],
        )
        .await?;
    if added > 0 {
        for (index, (route, name, total, body)) in files.into_iter().enumerate() {
            let total = total.map(i64::try_from).transpose()?;
            let path = e.cfg.path("uploads").join(&p.slug).join("@org-inbox").join(&id).join(format!("{index}.part"));
            tx.execute(
                "INSERT INTO ot.net_downloads(id,incoming_id,file_no,route,name,path,total,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
                &[
                    &crate::util::uid("download"),
                    &id,
                    &(index as i32),
                    &crate::util::pg_json(&route).as_ref(),
                    &name,
                    &path.to_string_lossy().as_ref(),
                    &total,
                    &body,
                ],
            )
            .await?;
        }
    }
    tx.commit().await?;
    changes::notify_id(e, p.org_id, vec![Change::OrgInbox]);
    Ok(())
}

#[logged]
pub(super) async fn claim(e: &Engine, active: &HashSet<String>) -> Result<Option<(Job, Part)>> {
    let parts = e.net.parts.load_full();
    let addresses: Vec<String> = active.iter().cloned().collect();
    let orgs: Vec<i64> = parts.iter().map(|p| p.org_id).collect();
    let (eligible_orgs, eligible_hubs, eligible_addresses) = transfers::eligible(e, &parts, active);
    let mut c = e.db.get().await?;
    let tx = c.transaction().await?;
    tx.execute(
        "UPDATE ot.net_incoming SET state='retry_wait',next_at=now() WHERE state IN ('downloading','delivering') AND NOT(address=ANY($1)) AND org_id=ANY($2)",
        &[&addresses, &orgs],
    )
    .await?;
    let rows = tx.query("SELECT n.id,n.org_id,n.hub,n.address,n.envelope,n.attempt FROM ot.net_incoming n WHERE n.state IN ('queued','retry_wait') AND n.next_at<=now() AND EXISTS(SELECT 1 FROM unnest($1::bigint[],$2::text[],$3::text[]) AS route(org,hub,address) WHERE route.org=n.org_id AND route.hub=n.hub AND route.address=n.address) AND NOT EXISTS(SELECT 1 FROM ot.net_incoming older WHERE older.org_id=n.org_id AND older.hub=n.hub AND older.envelope->>'from'=n.envelope->>'from' AND older.state<>'complete' AND (older.created_at,older.id)<(n.created_at,n.id)) ORDER BY n.next_at,n.created_at LIMIT 1 FOR UPDATE OF n SKIP LOCKED",&[&eligible_orgs,&eligible_hubs,&eligible_addresses]).await?;
    for r in rows {
        let job = Job { id: r.get(0), org: r.get(1), hub: r.get(2), address: r.get(3), envelope: r.get(4), attempt: r.get(5) };
        let Some(part) = parts
            .iter()
            .find(|p| p.org_id == job.org && p.registered.contains(&job.hub) && p.hubs.iter().any(|(h, a)| h == &job.hub && a == &job.address))
        else {
            continue;
        };
        tx.execute("UPDATE ot.net_incoming SET state='downloading',attempt=attempt+1,error=NULL,updated_at=now() WHERE id=$1", &[&job.id]).await?;
        tx.commit().await?;
        return Ok(Some((job, part.clone())));
    }
    tx.commit().await?;
    Ok(None)
}

#[derive(Debug)]
struct File {
    id: String,
    route: Value,
    name: String,
    path: std::path::PathBuf,
    body: bool,
    total: Option<i64>,
    confirmed: i64,
    validator: Option<String>,
    complete: bool,
    expired: bool,
}

#[logged]
async fn save(e: &Engine, id: &str, at: u64, total: Option<i64>, validator: &Option<String>, complete: bool) -> Result<()> {
    e.db.get()
        .await?
        .execute(
            "UPDATE ot.net_downloads SET processed=$2,confirmed=$2,total=$3,validator=$4,complete=$5,updated_at=now() WHERE id=$1",
            &[&id, &(at as i64), &total, &validator, &complete],
        )
        .await?;
    Ok(())
}

#[logged]
async fn download(e: &Engine, p: &Part, job: &Job, f: &File) -> Result<u64> {
    let meta = tokio::fs::metadata(&f.path).await.ok();
    if f.complete && meta.as_ref().is_some_and(|m| Some(m.len() as i64) == f.total) {
        return Ok(f.total.unwrap() as u64);
    }
    let mut offset = f.confirmed as u64;
    if f.expired || f.validator.is_none() || meta.as_ref().is_none_or(|m| m.len() < offset) {
        offset = 0
    }
    // A crash can leave a durable last-byte checkpoint before the EOF/complete
    // write. Revalidate the final byte and EOF instead of asking for bytes=N-,
    // which is unsatisfiable and would retry forever on a correct 416 response.
    if offset > 0 && f.total == Some(offset as i64) {
        offset -= 1;
    }
    if offset == 0 && f.confirmed > 0 {
        e.db.get()
            .await?
            .execute(
                "UPDATE ot.net_downloads SET restart_reason=$2 WHERE id=$1",
                &[&f.id, &"partial expired, lost, or has no stable validator; restarted from zero"],
            )
            .await?;
    }
    let mut url = reqwest::Url::parse(&job.address)?;
    let segments: Vec<&str> = f.route.as_array().ok_or_else(|| anyhow::anyhow!("download route missing"))?.iter().filter_map(Value::as_str).collect();
    url.path_segments_mut().map_err(|_| anyhow::anyhow!("invalid hub URL"))?.pop_if_empty().extend(segments);
    let mut request = HTTP.get(url).timeout(FILE_TIMEOUT).header("X-Org-Auth", p.auth());
    if offset > 0 {
        request = request.header("Range", format!("bytes={offset}-")).header("If-Range", f.validator.as_deref().unwrap_or(""));
    }
    let response = request.send().await?;
    let status = response.status().as_u16();
    if matches!(status, 401 | 403 | 404 | 410 | 413) {
        return Err(transfers::permanent(&format!("download HTTP {status}; retry after correcting the cause")));
    }
    let response = response.error_for_status()?;
    let validator = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|h| h.to_str().ok())
        .filter(|s| !s.starts_with("W/"))
        .or_else(|| response.headers().get(reqwest::header::LAST_MODIFIED).and_then(|h| h.to_str().ok()))
        .map(str::to_owned);
    let total = if status == 206 {
        if offset > 0 && validator != f.validator {
            save(e,&f.id,0,f.total,&None,false).await?;
            return Err(transfers::permanent("hub changed the download validator in a partial response; retry starts from zero"));
        }
        let range = response.headers().get(reqwest::header::CONTENT_RANGE).and_then(|h| h.to_str().ok()).unwrap_or("");
        let parsed = range
            .strip_prefix("bytes ")
            .and_then(|v| v.split_once('/'))
            .and_then(|(span, total)| span.split_once('-').map(|(start, end)| (start, end, total)))
            .and_then(|(s, end, total)| Some((s.parse::<u64>().ok()?, end.parse::<u64>().ok()?, total.parse::<u64>().ok()?)));
        let (start, end, total) = parsed.ok_or_else(|| anyhow::anyhow!("hub returned invalid download range"))?;
        anyhow::ensure!(start == offset && end >= start && end < total, "hub returned a different download range");
        Some(i64::try_from(total)?)
    } else {
        anyhow::ensure!(status == 200, "unexpected download status {status}");
        offset = 0; // If-Range mismatch or a legacy hub: replace, never append.
        response.content_length().map(i64::try_from).transpose()?
    };
    if let (Some(expected), Some(got)) = (f.total, total) {
        anyhow::ensure!(expected == got, "download size changed; retry or cancel this file")
    }
    let expected = total.or(f.total);
    let cap = expected.map(|n| n as u64).unwrap_or(1024 * 1024 * 1024);
    let parent = f.path.parent().ok_or_else(|| anyhow::anyhow!("download path has no folder"))?;
    tokio::fs::create_dir_all(parent).await?;
    let mut file = tokio::fs::OpenOptions::new().write(true).create(true).truncate(false).open(&f.path).await?;
    file.set_len(offset).await?;
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    file.sync_data().await?;
    save(e, &f.id, offset, expected, &validator, false).await?;
    let mut chunks = response.bytes_stream();
    let mut at = offset;
    let mut confirmed = offset;
    let mut last = Instant::now();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk?;
        anyhow::ensure!(at + chunk.len() as u64 <= cap, "download exceeds its declared size");
        file.write_all(&chunk).await?;
        at += chunk.len() as u64;
        if at - confirmed >= 8 * 1024 * 1024 || last.elapsed() >= Duration::from_secs(1) {
            file.flush().await?;
            file.sync_data().await?;
            save(e, &f.id, at, expected, &validator, false).await?;
            confirmed = at;
            last = Instant::now();
        }
    }
    anyhow::ensure!(expected.is_none_or(|n| n as u64 == at), "download stopped before all bytes arrived");
    file.flush().await?;
    file.sync_data().await?;
    save(e, &f.id, at, Some(at as i64), &validator, true).await?;
    Ok(at)
}

#[logged]
pub(super) async fn run(e: &Arc<Engine>, p: &Part, job: &Job) -> Result<String> {
    let c = e.db.get().await?;
    let rows=c.query("SELECT id,route,name,path,body,total,confirmed,validator,complete,updated_at<now()-interval '24 hours' FROM ot.net_downloads WHERE incoming_id=$1 ORDER BY file_no",&[&job.id]).await?;
    drop(c);
    let mut body = job.envelope["body"].as_str().unwrap_or("").to_owned();
    let mut attachments = Vec::new();
    for r in rows {
        let f = File {
            id: r.get(0),
            route: r.get(1),
            name: r.get(2),
            path: std::path::PathBuf::from(r.get::<_, String>(3)),
            body: r.get(4),
            total: r.get(5),
            confirmed: r.get(6),
            validator: r.get(7),
            complete: r.get(8),
            expired: r.get(9),
        };
        let bytes = isolation::run(e, &[p.org_id], download(e, p, job, &f)).await?;
        if f.body && bytes <= WHOLE_BODY_INLINE {
            body = String::from_utf8_lossy(&tokio::fs::read(&f.path).await?).into_owned();
        } else {
            if f.body {
                let preview = body.rfind(CONTINUES).map_or(body.as_str(), |i| &body[..i]);
                body = format!("{preview}\n\n[this message is {bytes} bytes long: the whole of it is attached as message.txt]");
            }
            attachments.push(json!({"name":f.name,"path":f.path.to_string_lossy(),"bytes":bytes}));
        }
    }
    // A short atomic boundary decides whether cancel or delivery wins.
    // Once delivering, controls cannot cancel or retry this envelope.
    let n = e.db.get().await?.execute("UPDATE ot.net_incoming SET state='delivering' WHERE id=$1 AND state='downloading'", &[&job.id]).await?;
    if n == 0 { return Err(anyhow::anyhow!("transfer was stopped before delivery")); }
    publish_inbound(e, p, &job.hub, &job.address, &job.envelope, body, attachments).await?;
    Ok(job.envelope["id"].as_str().unwrap_or("").to_owned())
}

#[logged]
pub(super) async fn settle(e: &Engine, job: &Job, outcome: Result<String>) -> Result<()> {
    let (state, error) = match outcome {
        Ok(_) => ("complete", None),
        Err(err) => {
            let state = if err.is::<transfers::Permanent>() { "failed" } else { "retry_wait" };
            (state, Some(err.downcast_ref::<reqwest::Error>().map(short_error).unwrap_or_else(|| crate::util::gist(&err.to_string(), 300))))
        }
    };
    let delay = (2i32.pow((job.attempt as u32).min(8))).min(300) as f64;
    let mut c = e.db.get().await?;
    let tx = c.transaction().await?;
    let n = tx.execute("UPDATE ot.net_incoming SET state=$2,error=$3,next_at=now()+make_interval(secs=>$4),updated_at=now() WHERE id=$1 AND state IN ('downloading','delivering')", &[&job.id,&state,&error,&delay]).await?;
    if n > 0 && state == "failed" {
        failures::record(&tx,job.org,&job.id,false,error.as_deref().unwrap_or("download failed")).await?;
    }
    tx.commit().await?;
    drop(c);
    changes::notify_id(e, job.org, vec![Change::OrgInbox]);
    kick(e);
    Ok(())
}
