//! App/panel mutations share app→panel lock order. Agent scope locks precede
//! those rows; no org revision lock is taken. Only committed invalidations push.
//! HTML/state may be private, so the entry points do not log request values.
use std::sync::Arc;
use anyhow::Result;
use serde_json::{json, Value};
use tokio_postgres::Transaction;
use crate::{engine::Engine, orgs::OrgHandle, runtime::Caller};
use super::wire::{self, Definition, Placement, Request};

const APP_META:&str="jsonb_build_object('id',a.id,'origin',a.origin,'name',a.name,'description',a.description,'capabilities',a.capabilities,'events',a.declared_events,'width',a.width,'height',a.height,'rev',a.rev,'permissions',a.permissions,'permission_rev',a.permission_rev,'is_new',a.is_new,'created_by',a.created_by,'created_at',a.created_at,'updated_at',a.updated_at)";
// Panel links were removed (user 2026-10-26): the inert linked_agents column is
// never read or written; agents follow a panel's events with app_listener dogs.
// created_at orders the Apps list: apps newest first, each app's panels in
// creation order (USER 2026-10-26 "newest first", "Fixed order").
const PANEL_META:&str="jsonb_build_object('id',p.id,'app',p.app_id,'label',p.label,'rev',p.rev,'open',p.is_open,'running',p.is_running,'run_generation',p.run_generation,'placement',p.placement,'created_at',p.created_at,'updated_at',p.updated_at,'used_at',p.used_at,'event_seq',p.event_seq)";

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
    let extra=if full{" || jsonb_build_object('definition',jsonb_build_object('name',a.name,'description',a.description,'html',a.html,'initial_state',a.initial_state,'capabilities',a.capabilities,'events',a.declared_events,'width',a.width,'height',a.height))"}else{""};
    let lock=if write{"UPDATE"}else{"SHARE"};
    let row=tx.query_opt(&format!("SELECT {APP_META}{extra} FROM ot.custom_apps a WHERE a.org_id=$1 AND a.id=$2 FOR {lock} OF a"),&[&org,&id]).await?;
    let Some(row)=row else {crate::refuse!(NotFound,"app not found in this organization");};Ok(super::policy::metadata(row.get(0)))
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
/// A copy's History holds only fired events agents can listen to and the copy
/// starting and stopping (user 2026-10-26 md6edfebc1975: "dont record anything
/// else"). Messages sent with the event action or orgtree.emit keep reaching
/// orgtree.on from their own store (mcbcd7b3cb6c0 "Keep, separate").
pub const HISTORY:[&str;3]=[super::events::FIRED,"panel.started","panel.stopped"];
/// A History row. Callers already hold the app row, so this panel row lock
/// keeps app→panel order.
#[nolog]
pub(super) async fn event(tx:&Transaction<'_>,org:i64,id:&str,name:&str,payload:&Value,actor:&str)->Result<i64>{
    debug_assert!(HISTORY.contains(&name),"History records only fires, starts and stops");record(tx,org,id,"history",name,payload,actor).await
}
/// Both stores advance the copy's event_seq, so a running host and History see
/// new rows; each keeps its own latest 256 (provisional), so messages never push
/// History out.
#[nolog]
async fn record(tx:&Transaction<'_>,org:i64,id:&str,kind:&str,name:&str,payload:&Value,actor:&str)->Result<i64>{
    wire::text(name,80,"event name",false)?;wire::bounded(payload,wire::EVENT_MAX,false)?;
    let seq:i64=tx.query_one("INSERT INTO ot.custom_panel_events(org_id,panel_id,kind,name,payload,actor) VALUES($1,$2,$3,$4,$5,$6) RETURNING seq",&[&org,&id,&kind,&name,&payload,&actor]).await?.get(0);
    tx.execute("UPDATE ot.custom_panels SET event_seq=$3 WHERE org_id=$1 AND id=$2",&[&org,&id,&seq]).await?;
    tx.execute("DELETE FROM ot.custom_panel_events WHERE org_id=$1 AND panel_id=$2 AND kind=$3 AND seq < (SELECT seq FROM ot.custom_panel_events WHERE org_id=$1 AND panel_id=$2 AND kind=$3 ORDER BY seq DESC OFFSET 255 LIMIT 1)",&[&org,&id,&kind]).await?;
    Ok(seq)
}
#[nolog]
async fn update_state(tx:&Transaction<'_>,org:i64,id:&str,state:&Value)->Result<Value>{
    wire::bounded(state,wire::STATE_MAX,true)?;
    tx.execute("UPDATE ot.custom_panels SET state=$3,rev=rev+1,updated_at=now() WHERE org_id=$1 AND id=$2",&[&org,&id,&state]).await?;
    panel(tx,org,id,false).await
}

#[nolog]
pub(crate) async fn run_locked(engine:&Arc<Engine>,org:&Arc<OrgHandle>,caller:Option<&Caller>,input:&Value)->Result<Value>{
    let request=wire::parse(input)?;
    let mut client=engine.db.get().await?;let tx=client.transaction().await?;
    let actor=authorize(&tx,org.id,caller).await?;let mut changed=false;
    let out=match request {
        Request::Listeners{app:id,panel,after,limit}=>super::events::listeners(&tx,org.id,&id,panel.as_deref(),after,limit).await?,
        Request::FireEvent{panel,name,payload}=>{
            let producer=if let Some(caller)=caller{json!({"kind":"agent","id":caller.agent_id,"name":caller.name})}else{json!({"kind":"user"})};
            let out=super::events::publish(&tx,org.id,&panel,&name,&payload,producer).await?;changed=true;out
        },
        Request::List{kind,app:filter,after,limit,open,running}=>{
            let n=page(limit)?;let after=after.unwrap_or_default();let kind=kind.unwrap_or_else(||"apps".into());
            let rows=match kind.as_str(){
                "apps"=>tx.query(&format!("SELECT {APP_META} FROM ot.custom_apps a WHERE a.org_id=$1 AND a.id>$2 ORDER BY a.id LIMIT $3"),&[&org.id,&after,&(n+1)]).await?,
                "panels"=>{
                    let visible=match open{Some(true)=>" AND p.is_open",Some(false)=>" AND NOT p.is_open",None=>""};
                    let active=match running{Some(true)=>" AND p.is_running",Some(false)=>" AND NOT p.is_running",None=>""};
                    tx.query(&format!("SELECT {PANEL_META} FROM ot.custom_panels p WHERE p.org_id=$1 AND p.id>$2 AND ($3::text IS NULL OR p.app_id=$3){visible}{active} ORDER BY p.id LIMIT $4"),&[&org.id,&after,&filter,&(n+1)]).await?
                },
                _=>crate::refuse!(BadRequest,"list kind must be apps or panels"),
            };
            let more=rows.len()>n as usize;let items:Vec<Value>=rows.into_iter().take(n as usize).map(|r|{let v:Value=r.get(0);if kind=="apps"{super::policy::metadata(v)}else{v}}).collect();
            let next=if more{items.last().map(|v|v["id"].clone())}else{None};let mut out=json!({"kind":kind,"items":items,"next_cursor":next});
            if kind=="apps"{out["new_count"]=json!(tx.query_one("SELECT count(*) FROM ot.custom_apps WHERE org_id=$1 AND is_new",&[&org.id]).await?.get::<_,i64>(0));}out
        }
        Request::MarkSeen{apps}=>{
            // Canonical row order for overlapping acknowledgements; no code
            // revision, saved state or permission is changed. Unknown IDs are
            // ignored, so a concurrent deletion is an idempotent no-op.
            let rows=tx.query("SELECT id FROM ot.custom_apps WHERE org_id=$1 AND id=ANY($2) ORDER BY id FOR UPDATE",&[&org.id,&apps]).await?;
            let ids:Vec<String>=rows.iter().map(|r|r.get(0)).collect();
            changed=tx.execute("UPDATE ot.custom_apps SET is_new=false WHERE org_id=$1 AND id=ANY($2) AND is_new",&[&org.id,&ids]).await?>0;
            let count:i64=tx.query_one("SELECT count(*) FROM ot.custom_apps WHERE org_id=$1 AND is_new",&[&org.id]).await?.get(0);
            json!({"seen":ids,"new_count":count})
        }
        Request::PermissionSet{app:id,expected_rev,expected_permission_rev,capability,permission}=>{
            if caller.is_some(){crate::refuse!(Forbidden,"only the user may decide app execution permissions; ask your superior instead");}
            let old=app(&tx,org.id,&id,false,true).await?;revision(&old,expected_rev)?;
            if old["permission_rev"].as_i64()!=Some(expected_permission_rev){crate::refuse!(Conflict,"app permissions changed; read and reconcile");}
            if !wire::CAPABILITIES.contains(&capability.as_str())||!super::policy::available(&old,&capability){crate::refuse!(BadRequest,"app does not declare that capability");}
            if !["ask","allow","deny"].contains(&permission.as_str()){crate::refuse!(BadRequest,"permission must be ask, allow or deny");}
            let mut permissions=old["permissions"].clone();permissions[&capability]=json!(permission);
            if ["files.read","files.write"].contains(&capability.as_str())&&permission!="allow"{let mode=capability.strip_prefix("files.").expect("file capability");tx.execute("DELETE FROM ot.custom_app_file_grants WHERE org_id=$1 AND app_id=$2 AND mode=$3",&[&org.id,&id,&mode]).await?;}
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
            let id=crate::util::uid("app");let def=&value.definition;let caps=json!(def.capabilities);let declarations=json!(def.events);
            tx.execute("INSERT INTO ot.custom_apps(org_id,id,name,description,html,initial_state,capabilities,width,height,created_by,declared_events,origin) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'imported')",&[&org.id,&id,&def.name,&def.description,&def.html,&def.initial_state,&caps,&def.width,&def.height,&actor,&declarations]).await?;
            let mut saved=Vec::new();
            for p in &value.panels{
                let pid=crate::util::uid("panel");let place=serde_json::to_value(Placement{width:def.width,height:def.height,..Placement::default()})?;
                tx.execute("INSERT INTO ot.custom_panels(org_id,id,app_id,label,state,placement,is_open) VALUES($1,$2,$3,$4,$5,$6,false)",&[&org.id,&pid,&id,&p.label,&p.state,&place]).await?;
                let mut meta=panel(&tx,org.id,&pid,false).await?;meta.as_object_mut().unwrap().remove("state");saved.push(meta);
            }
            changed=true;json!({"imported":id,"app":app(&tx,org.id,&id,false,false).await?,"panels":saved,"warning":"Apps imported from outside this org have full access to it and its state. Be careful importing apps from untrustworthy sources."})
        }
        Request::AppCreate{definition:def}=>{
            wire::definition(&def)?;let id=crate::util::uid("app");let caps=json!(def.capabilities);let declarations=json!(def.events);
            tx.execute("INSERT INTO ot.custom_apps(org_id,id,name,description,html,initial_state,capabilities,width,height,created_by,declared_events,origin) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'created')",&[&org.id,&id,&def.name,&def.description,&def.html,&def.initial_state,&caps,&def.width,&def.height,&actor,&declarations]).await?;
            changed=true;app(&tx,org.id,&id,false,false).await?
        }
        Request::AppUpdate{app:id,expected_rev,definition:def}=>{
            wire::definition(&def)?;let old=app(&tx,org.id,&id,false,true).await?;revision(&old,expected_rev)?;let caps=json!(def.capabilities);let declarations=json!(def.events);let restrictive=super::policy::restrictive_overrides(&old["permissions"]);
            tx.execute("DELETE FROM ot.custom_app_file_grants WHERE org_id=$1 AND app_id=$2",&[&org.id,&id]).await?;
            // Code replacement revokes external grants; user Ask/Deny stays restrictive.
            tx.execute("UPDATE ot.custom_apps SET name=$3,description=$4,html=$5,initial_state=$6,capabilities=$7,width=$8,height=$9,declared_events=$10,permissions=$11,permission_rev=permission_rev+1,rev=rev+1,updated_at=now() WHERE org_id=$1 AND id=$2",&[&org.id,&id,&def.name,&def.description,&def.html,&def.initial_state,&caps,&def.width,&def.height,&declarations,&restrictive]).await?;
            // PROVISIONAL code-changed rule, not a user ruling: visible copies reload
            // the new code as before; a hidden running copy powers off rather than
            // silently running code nobody started, and stays off after a restart.
            let restarted=tx.query("UPDATE ot.custom_panels SET is_running=is_open,run_generation=run_generation+1,rev=rev+1,updated_at=now() WHERE org_id=$1 AND app_id=$2 AND is_running RETURNING id,is_open",&[&org.id,&id]).await?;
            for row in &restarted{if !row.get::<_,bool>(1){event(&tx,org.id,row.get::<_,&str>(0),"panel.stopped",&json!({"reason":"code changed"}),&actor).await?;}}
            super::events::invalidate(&tx,org.id,&id,None,Some(&declarations)).await?;
            changed=true;app(&tx,org.id,&id,false,false).await?
        }
        Request::AppDelete{app:id,expected_rev,delete_panels}=>{
            revision(&app(&tx,org.id,&id,false,true).await?,expected_rev)?;
            if !delete_panels && tx.query_opt("SELECT 1 FROM ot.custom_panels WHERE org_id=$1 AND app_id=$2 LIMIT 1",&[&org.id,&id]).await?.is_some(){crate::refuse!(Conflict,"app has saved panels; explicitly set delete_panels to remove them");}
            super::events::invalidate(&tx,org.id,&id,None,None).await?;
            tx.execute("DELETE FROM ot.custom_apps WHERE org_id=$1 AND id=$2",&[&org.id,&id]).await?;changed=true;json!({"deleted":id})
        }
        Request::PanelOpen{app:app_id,panel:panel_id,new,label}=>{
            if caller.is_some()&&panel_id.is_some(){crate::refuse!(Forbidden,"only the user may open an app window; use panel_get for an existing copy or panel_open with app to create a closed copy");}
            if new && panel_id.is_some(){crate::refuse!(BadRequest,"new and panel are mutually exclusive");}
            let id=if let Some(ref panel_id)=panel_id{
                let row=tx.query_opt("SELECT app_id FROM ot.custom_panels WHERE org_id=$1 AND id=$2",&[&org.id,panel_id]).await?;
                let Some(row)=row else{crate::refuse!(NotFound,"saved panel not found");};let actual:String=row.get(0);
                if app_id.as_ref().is_some_and(|id|id!=&actual){crate::refuse!(BadRequest,"panel belongs to a different app");}actual
            }else{app_id.ok_or_else(||crate::domain::UserError::BadRequest("open requires app or panel".into()))?};
            let a=app(&tx,org.id,&id,true,true).await?;
            // Provisional mockup default: opening an app reuses its last panel.
            let existing=if let Some(pid)=panel_id{Some(pid)}else if !new&&caller.is_none(){
                tx.query_opt("SELECT id FROM ot.custom_panels WHERE org_id=$1 AND app_id=$2 ORDER BY used_at DESC,id DESC LIMIT 1",&[&org.id,&id]).await?.map(|r|r.get::<_,String>(0))
            }else{None};
            // Opening starts a stopped copy; showing a hidden running copy reveals
            // the same runtime. Agents only create closed copies, which stay off.
            let (pid,starts)=if let Some(pid)=existing{
                let running:bool=tx.query_one("SELECT is_running FROM ot.custom_panels WHERE org_id=$1 AND id=$2 FOR UPDATE",&[&org.id,&pid]).await?.get(0);
                if !running{super::runtime::can_start(&tx,org.id).await?;}
                tx.execute("UPDATE ot.custom_panels SET is_open=true,is_running=true,run_generation=run_generation+(NOT is_running)::int,used_at=now(),updated_at=now(),rev=rev+1 WHERE org_id=$1 AND id=$2",&[&org.id,&pid]).await?;(pid,!running)
            }else{
                if caller.is_none(){super::runtime::can_start(&tx,org.id).await?;}
                let pid=crate::util::uid("panel");let def:Definition=serde_json::from_value(a["definition"].clone())?;
                // "Panel N", never the app's name (user 2026-10-26). The app row
                // lock above serializes numbering; existing labels never change.
                let label=match label{Some(label)=>label,None=>{
                    let rows=tx.query("SELECT label FROM ot.custom_panels WHERE org_id=$1 AND app_id=$2 AND label LIKE 'Panel %'",&[&org.id,&id]).await?;
                    super::labels::default_panel_label(rows.iter().map(|r|r.get::<_,&str>(0)))
                }};wire::text(&label,120,"panel label",false)?;
                let placement=serde_json::to_value(Placement{width:def.width,height:def.height,..Placement::default()})?;
                tx.execute("INSERT INTO ot.custom_panels(org_id,id,app_id,label,state,placement,is_open,is_running) VALUES($1,$2,$3,$4,$5,$6,$7,$7)",&[&org.id,&pid,&id,&label,&def.initial_state,&placement,&caller.is_none()]).await?;(pid,caller.is_none())
            };
            // Opening a stopped copy starts it (user 2026-10-26 mcbcd7b3cb6c0); showing
            // a running one and an agent's closed copy record nothing.
            if starts{event(&tx,org.id,&pid,"panel.started",&json!({"reason":"opened"}),&actor).await?;}changed=true;panel(&tx,org.id,&pid,false).await?
        }
        Request::PanelGet{panel:id}=>panel(&tx,org.id,&id,false).await?,
        Request::PanelUpdate{panel:id,expected_rev,label,open,placement}=>{
            let old=panel(&tx,org.id,&id,true).await?;revision(&old,expected_rev)?;
            if caller.is_some()&&(open==Some(true)||(placement.is_some()&&open.unwrap_or(old["open"].as_bool().unwrap_or(false)))){crate::refuse!(Forbidden,"only the user may open or show an app window; agents may create and configure closed saved panels");}
            let label=label.unwrap_or_else(||old["label"].as_str().unwrap_or("").into());wire::text(&label,120,"panel label",false)?;
            let place=placement.unwrap_or(serde_json::from_value(old["placement"].clone())?);wire::placement(&place)?;
            let place=serde_json::to_value(place)?;let open=open.unwrap_or(old["open"].as_bool().unwrap_or(false));
            // Hide keeps the runtime; Show (user only) starts a stopped copy.
            if open&&old["running"]!=true{super::runtime::can_start(&tx,org.id).await?;}
            tx.execute("UPDATE ot.custom_panels SET label=$3,is_open=$4,is_running=is_running OR $4,run_generation=run_generation+($4 AND NOT is_running)::int,placement=$5,rev=rev+1,updated_at=now() WHERE org_id=$1 AND id=$2",&[&org.id,&id,&label,&open,&place]).await?;
            if open&&old["running"]!=true{event(&tx,org.id,&id,"panel.started",&json!({"reason":"opened"}),&actor).await?;}changed=true;panel(&tx,org.id,&id,false).await?
        }
        Request::PanelDuplicate{panel:id,expected_rev}=>{
            let old=panel(&tx,org.id,&id,true).await?;revision(&old,expected_rev)?;let pid=crate::util::uid("panel");
            let label:String=format!("{} copy",old["label"].as_str().unwrap_or("Panel")).chars().take(120).collect();
            let mut place:Placement=serde_json::from_value(old["placement"].clone())?;place.mode="float".into();place.anchor=None;place.x+=24.;place.y+=24.;let place=serde_json::to_value(place)?;
            if caller.is_none(){super::runtime::can_start(&tx,org.id).await?;}
            tx.execute("INSERT INTO ot.custom_panels(org_id,id,app_id,label,state,placement,is_open,is_running) VALUES($1,$2,$3,$4,$5,$6,$7,$7)",&[&org.id,&pid,&old["app"].as_str().unwrap_or(""),&label,&old["state"],&place,&caller.is_none()]).await?;
            if caller.is_none(){event(&tx,org.id,&pid,"panel.started",&json!({"reason":"opened"}),&actor).await?;}changed=true;panel(&tx,org.id,&pid,false).await?
        }
        Request::PanelDelete{panel:id,expected_rev}=>{
            let old=panel(&tx,org.id,&id,true).await?;revision(&old,expected_rev)?;
            super::events::invalidate(&tx,org.id,old["app"].as_str().unwrap_or(""),Some(&id),None).await?;
            tx.execute("DELETE FROM ot.custom_panels WHERE org_id=$1 AND id=$2",&[&org.id,&id]).await?;changed=true;json!({"deleted":id})
        }
        // USER 2026-10-26: anyone with Apps tools may start any copy hidden or
        // power one off. Starting never shows a window; already-running is a no-op.
        Request::PanelStart{panel:id,expected_rev}=>{
            let old=panel(&tx,org.id,&id,true).await?;if let Some(rev)=expected_rev{revision(&old,rev)?;}
            if old["running"]==true{old}else{
                super::runtime::can_start(&tx,org.id).await?;
                tx.execute("UPDATE ot.custom_panels SET is_running=true,run_generation=run_generation+1,rev=rev+1,updated_at=now() WHERE org_id=$1 AND id=$2",&[&org.id,&id]).await?;
                event(&tx,org.id,&id,"panel.started",&json!({}),&actor).await?;changed=true;panel(&tx,org.id,&id,false).await?
            }
        }
        Request::PanelStop{panel:id,expected_rev}=>{
            let old=panel(&tx,org.id,&id,true).await?;if let Some(rev)=expected_rev{revision(&old,rev)?;}
            if old["running"]!=true&&old["open"]!=true{old}else{
                tx.execute("UPDATE ot.custom_panels SET is_running=false,is_open=false,run_generation=run_generation+1,rev=rev+1,updated_at=now() WHERE org_id=$1 AND id=$2",&[&org.id,&id]).await?;
                event(&tx,org.id,&id,"panel.stopped",&json!({}),&actor).await?;changed=true;panel(&tx,org.id,&id,false).await?
            }
        }
        Request::Runtime{..}=>crate::refuse!(BadRequest,"runtime is read through the Apps runtime listing"),
        Request::StateSet{panel:id,expected_rev,state}=>{
            revision(&panel(&tx,org.id,&id,true).await?,expected_rev)?;let out=update_state(&tx,org.id,&id,&state).await?;changed=true;out
        }
        Request::StatePatch{panel:id,expected_rev,patch}=>{
            let old=panel(&tx,org.id,&id,true).await?;revision(&old,expected_rev)?;let mut state=old["state"].clone();wire::merge(&mut state,&patch)?;
            let out=update_state(&tx,org.id,&id,&state).await?;changed=true;out
        }
        Request::Event{panel:id,name,payload}=>{
            panel(&tx,org.id,&id,true).await?;let seq=record(&tx,org.id,&id,"message",&name,&payload,&actor).await?;changed=true;json!({"panel":id,"seq":seq})
        }
        Request::Events{panel:id,after,limit,messages}=>{
            panel(&tx,org.id,&id,false).await?;let n=page(limit)?;let after=after.unwrap_or(0);if after<0{crate::refuse!(BadRequest,"event cursor must be nonnegative");}
            let kind=if messages{"message"}else{"history"};
            let rows=tx.query("SELECT jsonb_build_object('seq',seq,'name',name,'payload',payload,'actor',actor,'at',at) FROM ot.custom_panel_events WHERE org_id=$1 AND panel_id=$2 AND kind=$5 AND seq>$3 ORDER BY seq LIMIT $4",&[&org.id,&id,&after,&(n+1),&kind]).await?;
            let more=rows.len()>n as usize;let events:Vec<Value>=rows.into_iter().take(n as usize).map(|r|r.get(0)).collect();let next=if more{events.last().map(|v|v["seq"].clone())}else{None};
            let oldest:Option<i64>=tx.query_one("SELECT min(seq) FROM ot.custom_panel_events WHERE org_id=$1 AND panel_id=$2 AND kind=$3",&[&org.id,&id,&kind]).await?.get(0);
            json!({"panel":id,"events":events,"next_cursor":next,"oldest_retained":oldest})
        }
    };
    tx.commit().await?;drop(client);
    if input["action"]=="fire_event"{super::events::notify(engine);}
    if changed{org.emit(json!({"type":"custom_apps_changed","org":org.slug}));}
    // No app.event signal follows a commit: panel links are gone (user
    // 2026-10-26), and agents hear from panels only through app event listeners.
    Ok(out)
}

/// All paths acquire this gate before root-first agent/database locks. No PG
/// connection is held while an action dispatch calls another domain service.
#[nolog]
pub async fn run(engine:&Arc<Engine>,org:&Arc<OrgHandle>,caller:Option<&Caller>,input:&Value)->Result<Value>{
    let request=wire::parse(input)?;
    if caller.is_some_and(|c|c.org_id!=org.id){crate::refuse!(Forbidden,"Apps caller belongs to another organization");}
    if let Request::Runtime{after,limit,sample}=request{return super::runtime::list(engine,org,caller,after,limit,sample).await;}
    let action=input["action"].as_str().unwrap_or("");
    if ["list","app_get","panel_get","events","app_create","app_import","app_export","mark_seen","listeners"].contains(&action){return run_locked(engine,org,caller,input).await;}
    let app=if let Some(app)=input["app"].as_str(){app.to_owned()}else{
        let client=engine.db.get().await?;let panel=input["panel"].as_str().unwrap_or("");
        let row=client.query_opt("SELECT app_id FROM ot.custom_panels WHERE org_id=$1 AND id=$2",&[&org.id,&panel]).await?;
        let Some(row)=row else{crate::refuse!(NotFound,"saved panel not found");};row.get::<_,String>(0)
    };
    let gate=engine.custom_apps.gate(org.id,&app)?;let _guard=gate.lock.lock().await;
    if action=="fire_event"{gate.admit()?;}
    // A Files permission change ends links only if it removes access, so read
    // the access the app had before the change (under the same gate).
    let file_cap=input["capability"].as_str().filter(|cap|action=="permission_set"&&matches!(*cap,"files.read"|"files.write"));
    let before=if file_cap.is_some(){
        let client=engine.db.get().await?;
        client.query_opt("SELECT jsonb_build_object('origin',origin,'capabilities',capabilities,'permissions',permissions) FROM ot.custom_apps WHERE org_id=$1 AND id=$2",&[&org.id,&app]).await?.map(|row|row.get::<_,Value>(0))
    }else{None};
    let out=run_locked(engine,org,caller,input).await?;
    if ["app_update","app_delete"].contains(&action){engine.custom_apps.revoke(org.id,Some(&app),None)?;engine.custom_apps.runtime.revoke_app(org.id,&app)?;}
    if let (Some(cap),Some(before))=(file_cap,before.as_ref()){
        if removes_file_access(before,cap,input["permission"].as_str().unwrap_or("")){engine.custom_apps.file_access.forget(org.id,Some(&app),None)?;}
    }
    // Power off and deletion end the runtime and its authority. Hide keeps the
    // runtime with its file and media links, so hidden media keeps playing
    // (USER 2026-10-26 mf7add4fda093); it ends only open questions.
    if action=="panel_delete"||action=="panel_stop"{engine.custom_apps.revoke(org.id,None,input["panel"].as_str())?;engine.custom_apps.runtime.revoke(org.id,input["panel"].as_str())?;}
    if action=="panel_update"&&input["open"]==false{engine.custom_apps.file_access.forget_prompts(org.id,None,input["panel"].as_str(),None)?;}
    Ok(out)
}

/// Whether a Files permission change ends existing file and media links. Only
/// removing access does (USER 2026-10-26 mf7add4fda093): a change that grants or
/// keeps access leaves them. Deny always does, since it also overrides Once
/// grants, which no standing permission covers.
#[nolog]
fn removes_file_access(before:&Value,cap:&str,permission:&str)->bool{
    let mut after=before.clone();after["permissions"][cap]=json!(permission);
    permission=="deny"||(super::policy::org_allowed(before,cap)&&!super::policy::org_allowed(&after,cap))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_a_files_permission_change_that_removes_access_ends_links() {
        // implicit org access (no stored choice): Allow keeps it; Ask and Deny remove it
        let implicit = json!({"origin":"created","capabilities":["files.read"],"permissions":{}});
        assert!(!removes_file_access(&implicit, "files.read", "allow"));
        assert!(removes_file_access(&implicit, "files.read", "ask"));
        assert!(removes_file_access(&implicit, "files.read", "deny"));
        // from Ask, granting or keeping Ask ends nothing; Deny always does (it overrides Once grants)
        let asked = json!({"origin":"created","capabilities":["files.read"],"permissions":{"files.read":"ask"}});
        assert!(!removes_file_access(&asked, "files.read", "allow"));
        assert!(!removes_file_access(&asked, "files.read", "ask"));
        assert!(removes_file_access(&asked, "files.read", "deny"));
        let allowed = json!({"origin":"created","capabilities":["files.read"],"permissions":{"files.read":"allow"}});
        assert!(!removes_file_access(&allowed, "files.read", "allow"));
        assert!(removes_file_access(&allowed, "files.read", "ask"));
        // a write change is judged on write access alone
        assert!(!removes_file_access(&allowed, "files.write", "allow"));
        assert!(removes_file_access(&allowed, "files.write", "ask"));
    }
}
