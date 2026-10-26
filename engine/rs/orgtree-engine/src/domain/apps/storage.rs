//! App/panel mutations share app→panel lock order. Agent scope locks precede
//! those rows; no org revision lock is taken. Only committed invalidations push.
//! HTML/state may be private, so the entry points do not log request values.
use std::sync::Arc;
use anyhow::Result;
use serde_json::{json, Value};
use tokio_postgres::Transaction;
use crate::{engine::Engine, orgs::OrgHandle, runtime::Caller};
use super::wire::{self, Definition, Placement, Request};

const APP_META:&str="jsonb_build_object('id',a.id,'name',a.name,'description',a.description,'capabilities',a.capabilities,'width',a.width,'height',a.height,'rev',a.rev,'permissions',a.permissions,'permission_rev',a.permission_rev,'created_by',a.created_by,'updated_at',a.updated_at)";
const PANEL_META:&str="jsonb_build_object('id',p.id,'app',p.app_id,'label',p.label,'rev',p.rev,'open',p.is_open,'placement',p.placement,'linked_agents',p.linked_agents,'updated_at',p.updated_at,'used_at',p.used_at,'event_seq',p.event_seq)";

#[nolog]
pub(crate) async fn file_authority(engine:&Arc<Engine>,org:&Arc<OrgHandle>,caller:&Caller)->Result<()> {
    let mut client=engine.db.get().await?;let tx=client.transaction().await?;authorize(&tx,org.id,Some(caller)).await?;tx.commit().await?;Ok(())
}

#[nolog]
async fn authorize(tx:&Transaction<'_>,org:i64,caller:Option<&Caller>) -> Result<String> {
    let Some(caller)=caller else {return Ok("user".into());};
    if caller.org_id!=org {crate::refuse!(Forbidden,"Apps caller belongs to another organization");}
    // Reuse canonical root-first locking so scope revocations cannot win after
    // the check but before the write. A cyclic/incomplete scope never grants.
    let rows=crate::domain::projects::locked_ancestor_rows(tx,caller.agent_id,"a.id").await?;
    if rows.is_empty() {crate::refuse!(Forbidden,"agent scope is unavailable");}
    let live=tx.query_opt("SELECT 1 FROM ot.agents WHERE org_id=$1 AND id=$2 AND name=$3 AND state='live' AND kind='agent'",&[&org,&caller.agent_id,&caller.name]).await?;
    if live.is_none() {crate::refuse!(Forbidden,"calling agent is no longer live in this organization");}
    if !crate::domain::tool_groups::allows(&crate::tools::caller_tools_in(tx,caller).await?,"orgtree_apps") {crate::refuse!(Forbidden,"Apps requires org-modifying tools");}
    Ok(caller.name.clone())
}
#[nolog]
fn page(limit:Option<i64>) -> Result<i64> {
    let n=limit.unwrap_or(100);if !(1..=200).contains(&n){crate::refuse!(BadRequest,"limit must be 1-200");}Ok(n)
}
#[nolog]
fn revision(actual:&Value,wanted:i64) -> Result<()> {
    if wanted<1 || actual["rev"].as_i64()!=Some(wanted) {crate::refuse!(Conflict,"panel or app changed; read its current revision and retry");}Ok(())
}
#[nolog]
async fn app(tx:&Transaction<'_>,org:i64,id:&str,full:bool,write:bool) -> Result<Value> {
    let extra=if full{" || jsonb_build_object('definition',jsonb_build_object('name',a.name,'description',a.description,'html',a.html,'initial_state',a.initial_state,'capabilities',a.capabilities,'width',a.width,'height',a.height))"}else{""};
    let lock=if write{"UPDATE"}else{"SHARE"};
    let row=tx.query_opt(&format!("SELECT {APP_META}{extra} FROM ot.custom_apps a WHERE a.org_id=$1 AND a.id=$2 FOR {lock} OF a"),&[&org,&id]).await?;
    let Some(row)=row else {crate::refuse!(NotFound,"app not found in this organization");};Ok(row.get(0))
}
#[nolog]
async fn panel(tx:&Transaction<'_>,org:i64,id:&str,write:bool) -> Result<Value> {
    let row=tx.query_opt("SELECT app_id FROM ot.custom_panels WHERE org_id=$1 AND id=$2",&[&org,&id]).await?;
    let Some(row)=row else {crate::refuse!(NotFound,"panel not found in this organization");};
    let app_id:String=row.get(0);app(tx,org,&app_id,false,false).await?;
    let lock=if write{"UPDATE"}else{"SHARE"};
    let row=tx.query_opt(&format!("SELECT {PANEL_META} || jsonb_build_object('state',p.state) FROM ot.custom_panels p WHERE p.org_id=$1 AND p.id=$2 FOR {lock} OF p"),&[&org,&id]).await?;
    let Some(row)=row else {crate::refuse!(NotFound,"panel was deleted");};Ok(row.get(0))
}
#[nolog]
async fn event(tx:&Transaction<'_>,org:i64,id:&str,name:&str,payload:&Value,actor:&str)->Result<i64>{
    wire::text(name,80,"event name",false)?;wire::bounded(payload,wire::EVENT_MAX,false)?;
    let seq:i64=tx.query_one("INSERT INTO ot.custom_panel_events(org_id,panel_id,name,payload,actor) VALUES($1,$2,$3,$4,$5) RETURNING seq",&[&org,&id,&name,&payload,&actor]).await?.get(0);
    tx.execute("UPDATE ot.custom_panels SET event_seq=$3 WHERE org_id=$1 AND id=$2",&[&org,&id,&seq]).await?;
    // Provisional: retain the latest256 events per panel, not unbounded history.
    tx.execute("DELETE FROM ot.custom_panel_events WHERE org_id=$1 AND panel_id=$2 AND seq < (SELECT seq FROM ot.custom_panel_events WHERE org_id=$1 AND panel_id=$2 ORDER BY seq DESC OFFSET 255 LIMIT 1)",&[&org,&id]).await?;
    Ok(seq)
}
#[nolog]
async fn update_state(tx:&Transaction<'_>,org:i64,id:&str,state:&Value,actor:&str)->Result<Value>{
    wire::bounded(state,wire::STATE_MAX,true)?;
    tx.execute("UPDATE ot.custom_panels SET state=$3,rev=rev+1,updated_at=now() WHERE org_id=$1 AND id=$2",&[&org,&id,&state]).await?;
    let out=panel(tx,org,id,false).await?;
    event(tx,org,id,"state.changed",&json!({"rev":out["rev"]}),actor).await?;panel(tx,org,id,false).await
}

#[nolog]
pub(crate) async fn run_locked(engine:&Arc<Engine>,org:&Arc<OrgHandle>,caller:Option<&Caller>,input:&Value)->Result<Value>{
    let request=wire::parse(input)?;
    let mut client=engine.db.get().await?;let tx=client.transaction().await?;
    let actor=authorize(&tx,org.id,caller).await?;let mut changed=false;
    let out=match request {
        Request::List{kind,app:filter,after,limit,open}=>{
            let n=page(limit)?;let after=after.unwrap_or_default();let kind=kind.unwrap_or_else(||"apps".into());
            let rows=match kind.as_str(){
                "apps"=>tx.query(&format!("SELECT {APP_META} FROM ot.custom_apps a WHERE a.org_id=$1 AND a.id>$2 ORDER BY a.id LIMIT $3"),&[&org.id,&after,&(n+1)]).await?,
                "panels"=>{
                    let active=match open{Some(true)=>" AND p.is_open",Some(false)=>" AND NOT p.is_open",None=>""};
                    tx.query(&format!("SELECT {PANEL_META} FROM ot.custom_panels p WHERE p.org_id=$1 AND p.id>$2 AND ($3::text IS NULL OR p.app_id=$3){active} ORDER BY p.id LIMIT $4"),&[&org.id,&after,&filter,&(n+1)]).await?
                },
                _=>crate::refuse!(BadRequest,"list kind must be apps or panels"),
            };
            let more=rows.len()>n as usize;let items:Vec<Value>=rows.into_iter().take(n as usize).map(|r|r.get(0)).collect();
            let next=if more{items.last().map(|v|v["id"].clone())}else{None};json!({"kind":kind,"items":items,"next_cursor":next})
        }
        Request::PermissionSet{app:id,expected_rev,expected_permission_rev,capability,permission}=>{
            if caller.is_some(){crate::refuse!(Forbidden,"only the user may decide app execution permissions; ask your superior instead");}
            let old=app(&tx,org.id,&id,false,true).await?;revision(&old,expected_rev)?;
            if old["permission_rev"].as_i64()!=Some(expected_permission_rev){crate::refuse!(Conflict,"app permissions changed; read and reconcile");}
            if !wire::CAPABILITIES.contains(&capability.as_str())||!old["capabilities"].as_array().is_some_and(|a|a.iter().any(|c|c==&capability)){crate::refuse!(BadRequest,"app does not declare that capability");}
            if !["ask","allow","deny"].contains(&permission.as_str()){crate::refuse!(BadRequest,"permission must be ask, allow or deny");}
            let mut permissions=old["permissions"].clone();permissions[&capability]=json!(permission);
            tx.execute("UPDATE ot.custom_apps SET permissions=$3,permission_rev=permission_rev+1,updated_at=now() WHERE org_id=$1 AND id=$2",&[&org.id,&id,&permissions]).await?;
            changed=true;app(&tx,org.id,&id,false,false).await?
        }
        Request::AppGet{app:id}=>app(&tx,org.id,&id,true,false).await?,
        Request::AppExport{app:id,expected_rev,include_panels}=>{
            // All panel writers first share-lock the app. Its exclusive lock
            // gives this export one consistent definition/panel snapshot.
            let old=app(&tx,org.id,&id,true,true).await?;revision(&old,expected_rev)?;
            let mut saved=Vec::new();
            if include_panels{
                for row in tx.query("SELECT label,state FROM ot.custom_panels WHERE org_id=$1 AND app_id=$2 ORDER BY id LIMIT 17",&[&org.id,&id]).await?{saved.push(wire::PortablePanel{label:row.get(0),state:row.get(1)});}
            }
            let value=wire::Bundle{format:"orgtree-app".into(),version:1,definition:serde_json::from_value(old["definition"].clone())?,panels:saved};
            wire::bundle(&value)?;json!({"panels":value.panels.len(),"bundle":value})
        }
        Request::AppImport{bundle:value}=>{
            let id=crate::util::uid("app");let def=&value.definition;let caps=json!(def.capabilities);
            tx.execute("INSERT INTO ot.custom_apps(org_id,id,name,description,html,initial_state,capabilities,width,height,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",&[&org.id,&id,&def.name,&def.description,&def.html,&def.initial_state,&caps,&def.width,&def.height,&actor]).await?;
            let mut saved=Vec::new();
            for p in &value.panels{
                let pid=crate::util::uid("panel");let place=serde_json::to_value(Placement{width:def.width,height:def.height,..Placement::default()})?;
                tx.execute("INSERT INTO ot.custom_panels(org_id,id,app_id,label,state,placement,is_open) VALUES($1,$2,$3,$4,$5,$6,false)",&[&org.id,&pid,&id,&p.label,&p.state,&place]).await?;
                let mut meta=panel(&tx,org.id,&pid,false).await?;meta.as_object_mut().unwrap().remove("state");saved.push(meta);
            }
            changed=true;json!({"imported":id,"app":app(&tx,org.id,&id,false,false).await?,"panels":saved})
        }
        Request::AppCreate{definition:def}=>{
            wire::definition(&def)?;let id=crate::util::uid("app");let caps=json!(def.capabilities);
            tx.execute("INSERT INTO ot.custom_apps(org_id,id,name,description,html,initial_state,capabilities,width,height,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",&[&org.id,&id,&def.name,&def.description,&def.html,&def.initial_state,&caps,&def.width,&def.height,&actor]).await?;
            changed=true;app(&tx,org.id,&id,false,false).await?
        }
        Request::AppUpdate{app:id,expected_rev,definition:def}=>{
            wire::definition(&def)?;let old=app(&tx,org.id,&id,false,true).await?;revision(&old,expected_rev)?;let caps=json!(def.capabilities);
            // Provisional security default: every code update revokes grants.
            tx.execute("UPDATE ot.custom_apps SET name=$3,description=$4,html=$5,initial_state=$6,capabilities=$7,width=$8,height=$9,permissions='{}',permission_rev=permission_rev+1,rev=rev+1,updated_at=now() WHERE org_id=$1 AND id=$2",&[&org.id,&id,&def.name,&def.description,&def.html,&def.initial_state,&caps,&def.width,&def.height]).await?;
            changed=true;app(&tx,org.id,&id,false,false).await?
        }
        Request::AppDelete{app:id,expected_rev,delete_panels}=>{
            revision(&app(&tx,org.id,&id,false,true).await?,expected_rev)?;
            if !delete_panels && tx.query_opt("SELECT 1 FROM ot.custom_panels WHERE org_id=$1 AND app_id=$2 LIMIT 1",&[&org.id,&id]).await?.is_some(){crate::refuse!(Conflict,"app has saved panels; explicitly set delete_panels to remove them");}
            tx.execute("DELETE FROM ot.custom_apps WHERE org_id=$1 AND id=$2",&[&org.id,&id]).await?;changed=true;json!({"deleted":id})
        }
        Request::PanelOpen{app:app_id,panel:panel_id,new,label}=>{
            if new && panel_id.is_some(){crate::refuse!(BadRequest,"new and panel are mutually exclusive");}
            let id=if let Some(ref panel_id)=panel_id{
                let row=tx.query_opt("SELECT app_id FROM ot.custom_panels WHERE org_id=$1 AND id=$2",&[&org.id,panel_id]).await?;
                let Some(row)=row else{crate::refuse!(NotFound,"saved panel not found");};let actual:String=row.get(0);
                if app_id.as_ref().is_some_and(|id|id!=&actual){crate::refuse!(BadRequest,"panel belongs to a different app");}actual
            }else{app_id.ok_or_else(||crate::domain::UserError::BadRequest("open requires app or panel".into()))?};
            let a=app(&tx,org.id,&id,true,true).await?;
            // Provisional mockup default: opening an app reuses its last panel.
            let existing=if let Some(pid)=panel_id{Some(pid)}else if !new{
                tx.query_opt("SELECT id FROM ot.custom_panels WHERE org_id=$1 AND app_id=$2 ORDER BY used_at DESC,id DESC LIMIT 1",&[&org.id,&id]).await?.map(|r|r.get::<_,String>(0))
            }else{None};
            let pid=if let Some(pid)=existing{
                tx.execute("UPDATE ot.custom_panels SET is_open=true,used_at=now(),updated_at=now(),rev=rev+1 WHERE org_id=$1 AND id=$2",&[&org.id,&pid]).await?;pid
            }else{
                let pid=crate::util::uid("panel");let def:Definition=serde_json::from_value(a["definition"].clone())?;
                let label=label.unwrap_or_else(||def.name.clone());wire::text(&label,120,"panel label",false)?;
                let placement=serde_json::to_value(Placement{width:def.width,height:def.height,..Placement::default()})?;
                tx.execute("INSERT INTO ot.custom_panels(org_id,id,app_id,label,state,placement) VALUES($1,$2,$3,$4,$5,$6)",&[&org.id,&pid,&id,&label,&def.initial_state,&placement]).await?;pid
            };
            event(&tx,org.id,&pid,"panel.opened",&json!({}),&actor).await?;changed=true;panel(&tx,org.id,&pid,false).await?
        }
        Request::PanelGet{panel:id}=>panel(&tx,org.id,&id,false).await?,
        Request::PanelUpdate{panel:id,expected_rev,label,open,placement,linked_agents}=>{
            let old=panel(&tx,org.id,&id,true).await?;revision(&old,expected_rev)?;
            let label=label.unwrap_or_else(||old["label"].as_str().unwrap_or("").into());wire::text(&label,120,"panel label",false)?;
            let place=placement.unwrap_or(serde_json::from_value(old["placement"].clone())?);wire::placement(&place)?;
            if let Some(anchor)=&place.anchor{
                if tx.query_opt("SELECT 1 FROM ot.agents WHERE org_id=$1 AND name=$2 AND state='live'",&[&org.id,anchor]).await?.is_none(){crate::refuse!(NotFound,"canvas attachment node is not live in this org");}
            }
            let links=linked_agents.unwrap_or(serde_json::from_value(old["linked_agents"].clone())?);
            if links.len()>64{crate::refuse!(BadRequest,"at most64 linked agents per panel");}
            let mut seen=std::collections::HashSet::new();for name in &links{
                if !seen.insert(name) || tx.query_opt("SELECT 1 FROM ot.agents WHERE org_id=$1 AND name=$2 AND kind='agent' AND state='live'",&[&org.id,name]).await?.is_none(){crate::refuse!(BadRequest,"linked agents must be unique live agents in this org");}
            }
            let place=serde_json::to_value(place)?;let links=json!(links);let open=open.unwrap_or(old["open"].as_bool().unwrap_or(false));
            tx.execute("UPDATE ot.custom_panels SET label=$3,is_open=$4,placement=$5,linked_agents=$6,rev=rev+1,updated_at=now() WHERE org_id=$1 AND id=$2",&[&org.id,&id,&label,&open,&place,&links]).await?;
            event(&tx,org.id,&id,"panel.changed",&json!({}),&actor).await?;changed=true;panel(&tx,org.id,&id,false).await?
        }
        Request::PanelDuplicate{panel:id,expected_rev}=>{
            let old=panel(&tx,org.id,&id,true).await?;revision(&old,expected_rev)?;let pid=crate::util::uid("panel");
            let label:String=format!("{} copy",old["label"].as_str().unwrap_or("Panel")).chars().take(120).collect();
            let mut place:Placement=serde_json::from_value(old["placement"].clone())?;place.mode="float".into();place.anchor=None;place.x+=24.;place.y+=24.;let place=serde_json::to_value(place)?;
            tx.execute("INSERT INTO ot.custom_panels(org_id,id,app_id,label,state,placement,linked_agents) VALUES($1,$2,$3,$4,$5,$6,$7)",&[&org.id,&pid,&old["app"].as_str().unwrap_or(""),&label,&old["state"],&place,&old["linked_agents"]]).await?;
            event(&tx,org.id,&pid,"panel.duplicated",&json!({"source":id}),&actor).await?;changed=true;panel(&tx,org.id,&pid,false).await?
        }
        Request::PanelDelete{panel:id,expected_rev}=>{
            revision(&panel(&tx,org.id,&id,true).await?,expected_rev)?;tx.execute("DELETE FROM ot.custom_panels WHERE org_id=$1 AND id=$2",&[&org.id,&id]).await?;changed=true;json!({"deleted":id})
        }
        Request::StateSet{panel:id,expected_rev,state}=>{
            revision(&panel(&tx,org.id,&id,true).await?,expected_rev)?;let out=update_state(&tx,org.id,&id,&state,&actor).await?;changed=true;out
        }
        Request::StatePatch{panel:id,expected_rev,patch}=>{
            let old=panel(&tx,org.id,&id,true).await?;revision(&old,expected_rev)?;let mut state=old["state"].clone();wire::merge(&mut state,&patch)?;
            let out=update_state(&tx,org.id,&id,&state,&actor).await?;changed=true;out
        }
        Request::Event{panel:id,name,payload}=>{
            panel(&tx,org.id,&id,true).await?;let seq=event(&tx,org.id,&id,&name,&payload,&actor).await?;changed=true;json!({"panel":id,"seq":seq})
        }
        Request::Events{panel:id,after,limit}=>{
            panel(&tx,org.id,&id,false).await?;let n=page(limit)?;let after=after.unwrap_or(0);if after<0{crate::refuse!(BadRequest,"event cursor must be nonnegative");}
            let rows=tx.query("SELECT jsonb_build_object('seq',seq,'name',name,'payload',payload,'actor',actor,'at',at) FROM ot.custom_panel_events WHERE org_id=$1 AND panel_id=$2 AND seq>$3 ORDER BY seq LIMIT $4",&[&org.id,&id,&after,&(n+1)]).await?;
            let more=rows.len()>n as usize;let events:Vec<Value>=rows.into_iter().take(n as usize).map(|r|r.get(0)).collect();let next=if more{events.last().map(|v|v["seq"].clone())}else{None};
            let oldest:Option<i64>=tx.query_one("SELECT min(seq) FROM ot.custom_panel_events WHERE org_id=$1 AND panel_id=$2",&[&org.id,&id]).await?.get(0);
            json!({"panel":id,"events":events,"next_cursor":next,"oldest_retained":oldest})
        }
    };
    tx.commit().await?;
    if changed{org.emit(json!({"type":"custom_apps_changed","org":org.slug}));}
    Ok(out)
}

/// All paths acquire this gate before root-first agent/database locks. No PG
/// connection is held while an action dispatch calls another domain service.
#[nolog]
pub async fn run(engine:&Arc<Engine>,org:&Arc<OrgHandle>,caller:Option<&Caller>,input:&Value)->Result<Value>{
    wire::parse(input)?;
    if caller.is_some_and(|c|c.org_id!=org.id){crate::refuse!(Forbidden,"Apps caller belongs to another organization");}
    let action=input["action"].as_str().unwrap_or("");
    if ["list","app_get","panel_get","events","app_create","app_import","app_export"].contains(&action){return run_locked(engine,org,caller,input).await;}
    let app=if let Some(app)=input["app"].as_str(){app.to_owned()}else{
        let client=engine.db.get().await?;let panel=input["panel"].as_str().unwrap_or("");
        let row=client.query_opt("SELECT app_id FROM ot.custom_panels WHERE org_id=$1 AND id=$2",&[&org.id,&panel]).await?;
        let Some(row)=row else{crate::refuse!(NotFound,"saved panel not found");};row.get::<_,String>(0)
    };
    let gate=engine.custom_apps.gate(org.id,&app)?;let _guard=gate.lock.lock().await;
    let out=run_locked(engine,org,caller,input).await?;
    if ["app_update","app_delete"].contains(&action){engine.custom_apps.revoke(org.id,Some(&app),None)?;}
    if action=="panel_delete"||(action=="panel_update"&&input["open"]==false){engine.custom_apps.revoke(org.id,None,input["panel"].as_str())?;}
    Ok(out)
}
