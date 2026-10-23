//! Bounded destinations, independent of read/attention state. Never log content.
use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use tokio_postgres::{Client, GenericClient};

pub const RETAIN: i64 = 2000;

#[nolog]
pub async fn record_mail(client: &impl GenericClient, org: i64, uid: &str, body: &str, reason: Option<&str>) -> Result<()> {
    let Some(blurb) = crate::runtime::convo::user_mention_blurb(body)
        .or_else(||reason.and_then(crate::runtime::convo::user_mention_blurb)) else { return Ok(()) };
    client.query("SELECT ot.record_user_mention(org_id,'mail:'||uid,created_at,
      jsonb_build_object('kind','mail','id',uid,'to',CASE WHEN recipient_kind='user' THEN 'user_inbox' ELSE recipient_name END),$3)
      FROM ot.mail WHERE org_id=$1 AND uid=$2", &[&org,&uid,&blurb]).await?;
    Ok(())
}

#[nolog]
pub async fn record_org_mail(client: &impl GenericClient, org: i64, uid: &str, body: &str) -> Result<()> {
    let Some(blurb)=crate::runtime::convo::user_mention_blurb(body) else {return Ok(())};
    let clean=crate::util::pg_text(&blurb);
    client.query("SELECT ot.record_user_mention(i.org_id,'orgmail:'||i.uid,i.at,
      jsonb_build_object('kind','mail','id',i.uid,'to','@org:'||o.slug),$3)
      FROM ot.org_inbox i JOIN ot.orgs o ON o.id=i.org_id WHERE i.org_id=$1 AND i.uid=$2", &[&org,&uid,&clean.as_ref()]).await?;
    Ok(())
}

/// Once per org, before its feed/HTTP can clear markers. Only pending/live
/// projections are eligible, with at most RETAIN candidates per source.
#[nolog]
pub async fn seed(client: &mut Client, org: i64) -> Result<()> {
    let tx=client.transaction().await?;
    tx.execute("INSERT INTO ot.mention_navigation_state(org_id) VALUES($1) ON CONFLICT DO NOTHING", &[&org]).await?;
    let seeded:bool=tx.query_one("SELECT seeded FROM ot.mention_navigation_state WHERE org_id=$1 FOR UPDATE", &[&org]).await?.get(0);
    if !seeded {
        for (table, predicate, kind, key, target) in [
            ("agents", "state='live'", "agent", "extra->'user_mention'->>'id'",
             "jsonb_build_object('kind','agent','node',name,'generation',generation,'mention_id',m->>'id','event_id',m->>'event_id')"),
            ("work_items", "archived_at IS NULL AND NOT coalesce((extra->>'deleted')::boolean,false)", "work", "extra->'user_mention'->>'rev'",
             "jsonb_build_object('kind','work','item',slug,'rev',m->'rev')"),
        ] {
            // Identifiers above are fixed source literals, never request input.
            tx.query(&format!("SELECT ot.record_user_mention($1,'{kind}:'||id||':'||key,(m->>'at')::timestamptz,{target},coalesce(m->>'blurb',''))
              FROM (SELECT *,extra->'user_mention' AS m,{key} AS key FROM ot.{table}
                WHERE org_id=$1 AND {predicate} AND extra->'user_mention' IS NOT NULL
                AND extra->>'user_mention'<>'null' ORDER BY id DESC LIMIT $2) candidates
              WHERE key IS NOT NULL AND pg_input_is_valid(m->>'at','timestamp with time zone')"), &[&org,&RETAIN]).await?;
        }
        let rows=tx.query("SELECT uid,body,urgent_reason FROM (SELECT uid,body,urgent_reason FROM ot.mail
          WHERE org_id=$1 AND recipient_kind='user' AND state='pending' ORDER BY id DESC LIMIT $2) pending
          WHERE body ILIKE '%@user%' OR urgent_reason ILIKE '%@user%'", &[&org,&RETAIN]).await?;
        for r in rows { record_mail(&tx,org,r.get(0),r.get(1),r.get(2)).await?; }
        tx.execute("UPDATE ot.mention_navigation_state SET seeded=true WHERE org_id=$1", &[&org]).await?;
    }
    tx.commit().await?;
    Ok(())
}

#[nolog]
pub fn cursor(value: &str) -> Option<(DateTime<Utc>,i64)> {
    let (at,id)=value.split_once('|')?;
    Some((DateTime::parse_from_rfc3339(at).ok()?.with_timezone(&Utc),id.parse().ok()?))
}

#[nolog]
pub async fn next(client: &impl GenericClient, org: i64, before: Option<&str>, known_latest: Option<&str>) -> Result<Value> {
    let latest=client.query_opt("SELECT id,at,target,blurb FROM ot.mention_navigation WHERE org_id=$1 ORDER BY at DESC,id DESC LIMIT 1", &[&org]).await?;
    let latest_id=latest.as_ref().map(|r|r.get::<_,i64>(0).to_string());
    let parsed=before.and_then(cursor).filter(|_|latest_id.as_deref()==known_latest);
    let row=if let Some((at,id))=parsed {
        client.query_opt("SELECT id,at,target,blurb FROM ot.mention_navigation WHERE org_id=$1 AND (at,id)<($2,$3) ORDER BY at DESC,id DESC LIMIT 1", &[&org,&at,&id]).await?
    } else {
        latest
    };
    let mention=row.map(|r| {
        let id:i64=r.get(0); let at:DateTime<Utc>=r.get(1);
        json!({"id":id.to_string(),"at":at,"cursor":format!("{}|{id}",at.to_rfc3339()),"target":r.get::<_,Value>(2),"blurb":r.get::<_,String>(3)})
    });
    Ok(json!({"latest_id":latest_id,"mention":mention,"retained_limit":RETAIN}))
}

#[cfg(test)]
mod tests {
    #[test]
    fn cursor_rejects_malformed_values() {
        assert!(super::cursor("2026-10-22T23:00:00Z|42").is_some());
        for bad in ["", "42", "yesterday|42", "2026-10-22T23:00:00Z|oops"] { assert!(super::cursor(bad).is_none()); }
    }
}
