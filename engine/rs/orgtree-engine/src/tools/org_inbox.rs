//! Explicit org-wide extraction. Policy, authority and custody share one lock.
use std::sync::Arc;
use anyhow::Result;
use serde_json::{json,Value};
use crate::{changes::{self,Change},domain::orginbox,engine::Engine,runtime::Caller};
use super::{Done,mailtools,me};

#[nolog]
pub(super) fn limit(args:&Value,pull:bool)->Result<i64> {
    let max=if pull {20} else {200};
    match args.get("limit") {
        None=>Ok(if pull {20} else {50}),
        Some(v)=>v.as_i64().filter(|n|*n>=1 && *n<=max)
            .ok_or_else(||anyhow::anyhow!("limit must be an integer from 1 to {max}")),
    }
}

#[nolog]
fn after(args:&Value,org:i64,agent:i64)->Result<i64> {
    let Some(v)=args.get("cursor") else {return Ok(0);};
    let prefix=format!("oi1:{org}:{agent}:");
    v.as_str().and_then(|s|s.strip_prefix(&prefix)).and_then(|s|s.parse::<i64>().ok())
        .filter(|n|*n>=0).ok_or_else(||anyhow::anyhow!("invalid org inbox cursor"))
}

#[logged]
pub(super) fn check_args(args:&Value)->Result<()> {
    let allowed:&[&str]=match args["action"].as_str() {
        Some("settings")=>&["action"],
        Some("configure")=>crate::refuse!(Forbidden,"org inbox mode changes are user-only; ask your superior or the user"),
        Some("list") if args["org_inbox"]==true=>&["action","org_inbox","limit","cursor"],
        Some("pull")=>&["action","limit"],
        _=>crate::refuse!(BadRequest,"org inbox supports settings, list with org_inbox=true, or pull"),
    };
    if args.as_object().is_none_or(|a|a.keys().any(|k|!allowed.contains(&k.as_str()))) {
        crate::refuse!(BadRequest,"unexpected org inbox field; do not combine org and project/own-mail reads");
    }
    Ok(())
}

// Full mail bodies and chunks must not enter method diagnostics.
#[nolog]
pub async fn read(engine:&Arc<Engine>,caller:&Caller,args:&Value)->Result<Done> {
    check_args(args)?;
    let action=args["action"].as_str().unwrap();
    let mut c=engine.db.get().await?;
    let who=me(&c,caller).await?;
    let tx=c.transaction().await?;
    let raw:Value=tx.query_one("SELECT settings FROM ot.orgs WHERE id=$1 FOR UPDATE",&[&who.org_id]).await?.get(0);
    let multi=crate::feed::groups::effective_settings(&raw,&engine.settings.defaults())["org_inbox_multi_holder"].as_bool().unwrap_or(false);
    if !orginbox::live_holders(&*tx,who.org_id,multi).await?.contains(&who.name) {
        crate::refuse!(Forbidden,"reading the org inbox requires its current extern audience; fallback delivery grants no audience");
    }
    if action=="settings" {return Done::json(&json!({"mode":orginbox::mode(&raw),"enabled":orginbox::enabled(&raw),"can_configure":false}));}
    orginbox::check(&raw)?;
    let pull=action=="pull";
    let max=limit(args,pull)?;
    if !pull {
        let cursor=after(args,who.org_id,who.id)?;
        let rows=tx.query("SELECT id,uid,peer,kind,at,left(body,201) FROM ot.org_inbox WHERE org_id=$1 AND dnd_held AND id>$2 ORDER BY id LIMIT $3",
            &[&who.org_id,&cursor,&(max+1)]).await?;
        let mut items=Vec::new();let mut budget=16000usize;let mut last=cursor;
        for r in rows.iter().take(max as usize) {
            let preview=crate::util::gist(&r.get::<_,String>(5),200);
            if !items.is_empty() && preview.len()>budget {break;}
            budget=budget.saturating_sub(preview.len());last=r.get(0);
            items.push(json!({"id":r.get::<_,String>(1),"from":r.get::<_,String>(2),"kind":r.get::<_,String>(3),
                "at":crate::util::iso(r.get(4)),"preview":preview,"state":"held"}));
        }
        let more=rows.len()>items.len();
        return Done::json(&json!({"messages":items,"has_more":more,"next_cursor":if more {Some(format!("oi1:{}:{}:{last}",who.org_id,who.id))}else{None},"consumed":false}));
    }
    let rows=tx.query("SELECT to_jsonb(i) FROM ot.org_inbox i WHERE org_id=$1 AND dnd_held ORDER BY id LIMIT $2 FOR UPDATE",&[&who.org_id,&max]).await?;
    let mut items=Vec::new();let mut budget=256*1024usize;let mut receipts=Vec::new();
    for r in &rows {
        let row:Value=r.get(0);
        let body=row["body"].as_str().unwrap_or("");
        let mut item=mailtools::mail_chunk(body,0)?;
        let bytes=item["content"].as_str().unwrap().len();
        if bytes>budget {break;} budget-=bytes;
        let copies=orginbox::publish_copies(&tx,who.org_id,&[who.name.clone()],row["peer"].as_str().unwrap(),body,
            row["kind"].as_str().unwrap(),&row["attachments"],&crate::domain::replies::snapshots(row.get("reply_to"),row.get("replies")),
            row["net_id"].as_str(),row["hub"].as_str()).await?;
        let uid=&copies[0].2;
        receipts.extend(tx.query("UPDATE ot.mail SET state='read',read_at=now(),delivered_at=now(),extra=extra || jsonb_build_object('manual_read',true,'org_inbox_source',$2::text) WHERE uid=$1 RETURNING uid,kind,org_id,net_id,net_hub",&[uid,&row["uid"].as_str().unwrap()]).await?);
        tx.execute("UPDATE ot.org_inbox SET dnd_held=false,pulled_by=$2,read=true,delivered_to=$3 WHERE uid=$1",
            &[&row["uid"].as_str().unwrap(),&who.id,&orginbox::delivered_with(&row,&[who.name.as_str()])]).await?;
        item["id"]=json!(uid);item["message_id"]=json!(uid);item["org_message_id"]=row["uid"].clone();
        item["delivery_id"]=json!(format!("inbox:{}:{uid}:{}",who.id,item["body_sha256"].as_str().unwrap()));
        item["from"]=row["peer"].clone();item["kind"]=row["kind"].clone();item["at"]=crate::domain::tree::ts(&row["at"]);
        item["direction"]=json!("received");item["state"]=json!("read");item["will_redeliver"]=json!(false);
        item["attachments"]=Value::Array(row["attachments"].as_array().into_iter().flatten().filter(|a|a["transfer_removed"]!=true).cloned().collect());
        item["reply_to"]=row["reply_to"].clone();item["replies"]=row["replies"].clone();
        items.push(item);
    }
    let more=tx.query_opt("SELECT 1 FROM ot.org_inbox WHERE org_id=$1 AND dnd_held LIMIT 1",&[&who.org_id]).await?.is_some();
    tx.commit().await?;drop(c);
    crate::domain::mail::consumed(engine,&receipts);
    if !items.is_empty() {changes::notify_id(engine,who.org_id,vec![Change::OrgInbox,Change::Mailbox(who.id)]);}
    mailtools::inbox_read_done(&json!({"messages":items,"has_more":more,"consumed_for_org":true,
        "continuation":"For cut bodies, use ordinary inbox chunk with message_id and delivery_id; this personal read copy is never automatically delivered."}),&items,who.id,false)
}

#[cfg(test)]
mod org_dnd_tests {
    use super::*;
    #[test] fn org_dnd_pull_limits_and_cursor_reject_cross_scope() {
        assert_eq!(limit(&json!({}),true).unwrap(),20);
        for v in [json!(0),json!(21),json!(1.5),json!("3")] {assert!(limit(&json!({"limit":v}),true).is_err());}
        assert_eq!(after(&json!({"cursor":"oi1:3:4:9"}),3,4).unwrap(),9);
        assert!(after(&json!({"cursor":"oi1:3:4:9"}),3,5).is_err());
        assert!(after(&json!({"cursor":"oi1:3:4:9"}),2,4).is_err());
    }
    #[test] fn org_dnd_agent_configure_is_always_refused() {
        let e=check_args(&json!({"action":"configure","mode":"normal"})).unwrap_err();
        assert!(e.to_string().contains("user-only"));
        assert!(check_args(&json!({"action":"pull","project":"p"})).is_err());
        assert!(check_args(&json!({"action":"settings"})).is_ok());
        assert!(check_args(&json!({"action":"list","org_inbox":true})).is_ok());
    }
}
