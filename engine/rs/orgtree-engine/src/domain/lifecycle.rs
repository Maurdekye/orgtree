//! Typed, passive notices committed with their tree operation. Recipients are
//! the affected seat, parents and peers, never an org-wide broadcast.
use anyhow::Result;
use serde_json::{json, Value};
use tokio_postgres::Transaction;

#[derive(Debug)]
struct Seat {
    name: String, parent: Option<i64>, parent_name: Option<String>,
    generation: i32, tier: String, seat: f64, grant: f64,
}

#[logged]
async fn seat(tx: &Transaction<'_>, id: i64) -> Result<Seat> {
    let r = tx.query_one("SELECT a.id,a.name,a.parent_id,p.name,a.generation,a.tier,a.seat::float8,a.grant_credits::float8
        FROM ot.agents a LEFT JOIN ot.agents p ON p.id=a.parent_id WHERE a.id=$1", &[&id]).await?;
    Ok(Seat { name:r.get(1), parent:r.get(2), parent_name:r.get(3),
              generation:r.get(4), tier:r.get(5), seat:r.get(6), grant:r.get(7) })
}

/// Current live peers, read in bounded pages so large orgs lose no recipients.
#[logged]
async fn siblings(tx: &Transaction<'_>, org: i64, parent: Option<i64>, except: i64) -> Result<Vec<i64>> {
    let mut out = Vec::new();
    let mut after = 0_i64;
    loop {
        let rows = tx.query("SELECT id FROM ot.agents WHERE org_id=$1 AND parent_id IS NOT DISTINCT FROM $2
            AND state='live' AND id<>$3 AND id>$4 ORDER BY id LIMIT 200", &[&org,&parent,&except,&after]).await?;
        if rows.is_empty() { break; }
        for r in rows { after=r.get(0); out.push(after); }
    }
    Ok(out)
}

#[logged]
async fn family(tx: &Transaction<'_>, org: i64, parent: Option<i64>, except: i64,
                parent_role: &str, peer_role: &str) -> Result<Vec<(i64,String)>> {
    let mut out = Vec::new();
    if let Some(p) = parent { out.push((p,parent_role.into())); }
    out.extend(siblings(tx,org,parent,except).await?.into_iter().map(|id|(id,peer_role.into())));
    Ok(out)
}

#[logged]
async fn store(tx: &Transaction<'_>, org: i64, recipient: i64, by: &str, ev: Value, body: &str) -> Result<Option<i64>> {
    let uid = crate::util::uid("m");
    // Never wake a passive notice. The next agent boundary drains it normally.
    let changed = tx.execute("INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,kind,notice,body,ev,state)
        SELECT $1,$2,'@system','agent',id,name,'notice',true,$4,$5,'pending' FROM ot.agents
        WHERE id=$3 AND org_id=$2 AND state='live' AND name<>$6", &[&uid,&org,&recipient,&crate::util::pg_text(&body).as_ref(),&crate::util::pg_json(&ev).as_ref(),&by]).await?;
    Ok((changed>0).then_some(recipient))
}

#[logged]
pub async fn record(tx: &Transaction<'_>, org: i64, op: &str, by: &str, subject: Option<i64>, d: &Value) -> Result<Vec<i64>> {
    let Some(id) = subject else { return Ok(Vec::new()) };
    let n = seat(tx,id).await?;
    let slug: String = tx.query_one("SELECT slug FROM ot.orgs WHERE id=$1", &[&org]).await?.get(0);
    let object = crate::events::node_ref(&slug,&n.name,n.generation as i64);
    let mut targets: Vec<(i64,String)> = Vec::new();
    match op {
        "hire" if d["above"].is_string() => {
            let name=d["above"].as_str().unwrap();
            let bid:i64=tx.query_one("SELECT id FROM ot.agents WHERE org_id=$1 AND name=$2", &[&org,&name]).await?.get(0);
            targets=family(tx,org,n.parent,id,"parent","peer").await?;
            targets.retain(|(x,_)|*x!=bid);
            targets.push((bid,"target".into())); targets.push((id,"self".into()));
            targets.extend(siblings(tx,org,Some(bid),id).await?.into_iter().map(|x|(x,"child".into())));
        }
        "hire" | "retire" | "dissolve" | "delete" | "rehire" => {
            targets=family(tx,org,n.parent,id,"report","peer").await?;
            if op=="rehire" { targets.push((id,"self".into())); }
        }
        "rescind" => if let Some(p)=n.parent { targets.push((p,"report".into())); },
        "compacted" | "cheap_compact" | "switch_model" | "reallocate" => {
            targets.push((id,"self".into()));
            if let Some(p)=n.parent { targets.push((p,"report".into())); }
        }
        "limit_reset" => {
            targets=family(tx,org,n.parent,id,"report","peer").await?;
            targets.push((id,"self".into()));
        }
        "switch_queued" | "switch_cancelled" | "switch_dropped" | "session_rebound" | "unstick" | "rename" | "retool" => targets.push((id,"self".into())),
        "move" => {
            targets=family(tx,org,d["old_parent_id"].as_i64(),id,"old_parent","old_peer").await?;
            targets.extend(family(tx,org,n.parent,id,"new_parent","new_peer").await?);
            targets.push((id,"self".into()));
        }
        "swap" => {
            let bname=d["b"].as_str().unwrap_or("");
            let bid: i64=tx.query_one("SELECT id FROM ot.agents WHERE org_id=$1 AND name=$2", &[&org,&bname]).await?.get(0);
            targets=family(tx,org,d["old_parent_a"].as_i64(),id,"parent_of_a","peer_of_a").await?;
            let same_parent=d["old_parent_a"]==d["old_parent_b"];
            let direct=d["old_parent_a"].as_i64()==Some(bid) || d["old_parent_b"].as_i64()==Some(id);
            if !same_parent && !direct {
                targets.extend(family(tx,org,d["old_parent_b"].as_i64(),bid,"parent_of_b","peer_of_b").await?);
            }
            targets.retain(|(x,_)|*x!=id && *x!=bid);
            // Children follow the seat, so their former parent is the opposite current one.
            targets.extend(siblings(tx,org,Some(bid),id).await?.into_iter().map(|x|(x,"child_of_a".into())));
            targets.extend(siblings(tx,org,Some(id),bid).await?.into_iter().map(|x|(x,"child_of_b".into())));
            targets.push((id,"a".into())); targets.push((bid,"b".into()));
        }
        "self_subjugate" => {
            let name=d["promoted"].as_str().unwrap_or("");
            let bid:i64=tx.query_one("SELECT id FROM ot.agents WHERE org_id=$1 AND name=$2", &[&org,&name]).await?.get(0);
            let b=seat(tx,bid).await?;
            targets=family(tx,org,b.parent,bid,"new_parent","peer").await?;
            if let Some(old)=d["old_parent_id"].as_i64() { targets.push((old,"former_parent".into())); }
            targets.extend(siblings(tx,org,Some(id),bid).await?.into_iter().map(|x|(x,"caller_child".into())));
            targets.extend(siblings(tx,org,Some(bid),id).await?.into_iter().map(|x|(x,"target_child".into())));
            targets.push((id,"demoted".into()));targets.push((bid,"promoted".into()));
        }
        _ => return Ok(Vec::new()),
    }
    let mut changed=Vec::new();
    for (target,role) in targets {
        let old_parent = if op=="move" {
            match d["old_parent_id"].as_i64() { Some(p)=>Some(seat(tx,p).await?.name),None=>None }
        } else { None };
        let (variant,fields)=match op {
            "compacted" => ("lifecycle.compacted",json!({"node":n.name,"relation":role,"generation":n.generation,"predecessor":d["session"],"auto":d["auto"],"lost":true,"size_note":null})),
            "switch_queued" => ("lifecycle.switch_queued",json!({"node":n.name,"old":d["old"],"new":d["new"],"by":by})),
            "switch_cancelled" => ("lifecycle.switch_cancelled",json!({"node":n.name,"target":d["target"],"by":by})),
            "switch_dropped" => ("lifecycle.switch_dropped",json!({"node":n.name,"target":d["target"],"kept":d["kept"],"reason":d["reason"]})),
            "session_rebound" => ("lifecycle.session_rebound",json!({"node":n.name,"predecessor":d["predecessor"]})),
            "unstick" => ("policy.unstuck",json!({})),
            "limit_reset" => ("policy.limit_reset",json!({"node":n.name,"relation":role,"released":["frozen"]})),
            "hire" if d["above"].is_string() => {
                let name=d["above"].as_str().unwrap();
                let bid:i64=tx.query_one("SELECT id FROM ot.agents WHERE org_id=$1 AND name=$2", &[&org,&name]).await?.get(0);
                let b=seat(tx,bid).await?;
                ("lifecycle.inserted",json!({"node":n.name,"above":name,"parent":n.parent_name,"role":role,"by":by,"grant_target":b.grant.to_string(),"grant_new":n.grant.to_string(),"committed":(b.seat+b.grant).to_string()}))
            }
            "hire" => ("lifecycle.hired",json!({"node":n.name,"by":by,"relation":role,"tier":n.tier,"grant":n.grant,"parent":n.parent_name,"why":null})),
            "retire" => ("lifecycle.retired",json!({"node":n.name,"by":by,"relation":role,"freed":n.seat+n.grant})),
            "rescind" => ("lifecycle.rescinded",json!({"node":n.name,"clawed":d["clawed_back"]})),
            "rehire" => ("lifecycle.rehired",json!({"node":n.name,"by":by,"relation":role,"grant":n.grant})),
            "dissolve" => ("lifecycle.dissolved",json!({"node":n.name,"by":by,"relation":role,"nodes":d["nodes"],"freed":n.seat+n.grant})),
            "delete" => ("lifecycle.deleted",json!({"node":n.name,"relation":role,"extra":d["nodes"].as_i64().unwrap_or(1)-1})),
            "rename" => ("lifecycle.renamed",json!({"old":d["was"],"new":n.name,"by":by})),
            "cheap_compact" => ("lifecycle.cheap_compacted",json!({"node":n.name,"relation":role,"by":by,"predecessor":d["old_session"],"team_note":null,"request_note":null})),
            "move" => ("lifecycle.moved",json!({"node":n.name,"from_parent":old_parent,"to_parent":n.parent_name,"role":role,"by":by,"tail":null})),
            "switch_model" => {
                let old=d["from"].as_str().unwrap_or("");
                let old_provider=crate::providers::catalog::provider_of(old);
                let new_provider=crate::providers::catalog::provider_of(&n.tier);
                ("lifecycle.model_switched",json!({"node":n.name,"relation":role,"old":old,"new":n.tier,"seat_old":d["seat_old"],"seat_new":n.seat,"by":by,"queued":false,"crossed":old_provider!=new_provider,"old_provider":old_provider,"new_provider":new_provider,"predecessor":d["old_session"]}))
            }
            "reallocate" => {
                let held:f64=tx.query_one("SELECT coalesce(sum(seat+grant_credits),0)::float8 FROM ot.agents WHERE parent_id=$1 AND state='live'", &[&id]).await?.get(0);
                ("access.grant_changed",json!({"relation":role,"node":n.name,"delta":d["delta"],"now":n.grant,"free":n.grant-held,"by":by}))
            }
            "retool" => {
                let change=&d["change"];
                let fields=[("add_dirs","folders"),("tools","tools"),("charter","charter"),("org_visibility","org_visibility"),("permission_mode","permission_mode")];
                let changed:Vec<&str>=fields.iter().filter(|(k,_)|change.get(k).is_some()).map(|(_,v)|*v).collect();
                if changed.is_empty() { continue; }
                ("access.scope_changed",json!({"by":by,"changed":changed}))
            }
            "swap" => {
                let t=seat(tx,target).await?;
                ("lifecycle.seat_swapped",json!({"a":d["a"],"b":d["b"],"role":role,"nested":d["old_parent_a"]==d["old_parent_b"],"by":by,"reports_to_after":t.parent_name,"grant_after":t.grant.to_string(),"audience_note":null}))
            }
            "self_subjugate" => {
                let t=seat(tx,target).await?;
                let count:i64=tx.query_one("WITH RECURSIVE team(id,depth) AS (SELECT id,1 FROM ot.agents WHERE parent_id=$1 AND state='live' UNION ALL SELECT a.id,t.depth+1 FROM ot.agents a JOIN team t ON a.parent_id=t.id WHERE a.state='live' AND t.depth<1024) SELECT count(*) FROM team", &[&id]).await?.get(0);
                ("lifecycle.subtree_promoted",json!({"promoted":d["promoted"],"demoted":n.name,"role":role,"by":by,"reports_to_after":t.parent_name,"subtree":count}))
            }
            _=>continue,
        };
        let object = if op=="swap" && (role=="b" || role.ends_with("_b")) {
            let name=d["b"].as_str().unwrap_or("");
            let gen:i32=tx.query_one("SELECT generation FROM ot.agents WHERE org_id=$1 AND name=$2", &[&org,&name]).await?.get(0);
            crate::events::node_ref(&slug,name,gen as i64)
        } else { object.clone() };
        let ev=crate::events::typed(variant,by,object,fields);
        let body=match op {
            "cheap_compact" => format!("{} now has a fresh session. Its previous session {} remains in history; the seat and team are unchanged.",n.name,d["old_session"].as_str().unwrap_or("")),
            "compacted" => format!("{}'s provider compacted the conversation within its current session. Earlier history remains readable.",n.name),
            "switch_model" => format!("{} changed from {} to {} (by {by}). A provider change starts a new provider session and cache namespace.",n.name,d["from"].as_str().unwrap_or(""),n.tier),
            _ => format!("{}: {} changed by {by}.",variant,n.name),
        };
        if let Some(id)=store(tx,org,target,by,ev,&body).await? { changed.push(id); }
    }
    Ok(changed)
}
