//! App/panel mutations share app→panel lock order. Agent scope locks precede
//! those rows; no org revision lock is taken. Only committed invalidations push.
//! HTML/state may be private, so the entry points do not log request values.
use std::sync::Arc;
use anyhow::Result;
use serde_json::{json, Value};
use tokio_postgres::Transaction;
use crate::{engine::Engine, orgs::OrgHandle, runtime::Caller};
use super::wire::{self, Definition, Placement, Request};

const APP_META:&str="jsonb_build_object('id',a.id,'origin',a.origin,'name',a.name,'description',a.description,'capabilities',a.capabilities,'events',a.declared_events,'width',a.width,'height',a.height,'rev',a.rev,'permissions',a.permissions,'permission_rev',a.permission_rev,'sites',a.declared_sites,'site_permissions',a.site_permissions,'is_new',a.is_new,'created_by',a.created_by,'created_at',a.created_at,'updated_at',a.updated_at)";
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
/// One page of a log (user 2026-10-27 md2006b10cf40: History should "reload in
/// realtime" and "lazily load as you scroll down"): newest first, before walking
/// back to older rows, or after reading newer rows oldest first to follow new
/// ones. Each writer of one copy's log holds a row lock the others need before it
/// inserts, so its seqs commit in order and neither cursor skips a row; retention
/// only ends the walk back sooner. Returns the comparison, order and bound.
#[nolog]
fn cursor(after:Option<i64>,before:Option<i64>) -> Result<(&'static str,&'static str,i64)> {
    if after.or(before).is_some_and(|c|c<0){crate::refuse!(BadRequest,"cursor must be nonnegative");}
    Ok(match after{Some(a)=>(">","ASC",a),None=>("<","DESC",before.unwrap_or(i64::MAX))})
}
#[nolog]
fn revision(actual:&Value,wanted:i64) -> Result<()> {
    if wanted<1 || actual["rev"].as_i64()!=Some(wanted) {crate::refuse!(Conflict,"panel or app changed; read its current revision and retry");}Ok(())
}
#[nolog]
async fn app(tx:&Transaction<'_>,org:i64,id:&str,full:bool,write:bool) -> Result<Value> {
    let extra=if full{" || jsonb_build_object('definition',jsonb_build_object('name',a.name,'description',a.description,'html',a.html,'initial_state',a.initial_state,'capabilities',a.capabilities,'events',a.declared_events,'sites',a.declared_sites,'width',a.width,'height',a.height))"}else{""};
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

/// The app-level Permission history (design m232e1d1ccb57): every stored
/// permission change, native prompt answer and code-change reset, written in
/// the change's own transaction. Latest 128 per app (provisional).
pub const PERMISSION_HISTORY:i64=128;
#[nolog]
async fn log_permission(tx:&Transaction<'_>,org:i64,app:&str,capability:&str,site:Option<&str>,permission:&str,via:&str,actor:&str,panel:Option<&str>)->Result<()>{
    tx.execute("INSERT INTO ot.custom_app_permission_log(org_id,app_id,capability,site,permission,via,actor,panel_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",&[&org,&app,&capability,&site,&permission,&via,&actor,&panel]).await?;
    tx.execute("DELETE FROM ot.custom_app_permission_log WHERE org_id=$1 AND app_id=$2 AND seq < (SELECT seq FROM ot.custom_app_permission_log WHERE org_id=$1 AND app_id=$2 ORDER BY seq DESC OFFSET $3 LIMIT 1)",&[&org,&app,&(PERMISSION_HISTORY-1)]).await?;
    Ok(())
}
/// One stored permission choice, for a whole capability or (internet access
/// only) one site row, with its history entry. The caller holds the app row
/// lock and has checked both revisions.
#[nolog]
async fn set_permission(tx:&Transaction<'_>,org:i64,id:&str,old:&Value,capability:&str,site:Option<&str>,permission:&str,via:&str,actor:&str,panel:Option<&str>)->Result<()>{
    if wire::RETIRED_CAPABILITIES.contains(&capability){crate::refuse!(BadRequest,"{}",wire::MAIL_SEND_REMOVED);}
    if !wire::CAPABILITIES.contains(&capability)||!super::policy::available(old,capability){crate::refuse!(BadRequest,"app does not declare that capability");}
    match site{
        None=>{
            if !["ask","allow","deny"].contains(&permission){crate::refuse!(BadRequest,"permission must be ask, allow or deny");}
            let mut permissions=old["permissions"].clone();permissions[capability]=json!(permission);
            if ["files.read","files.write"].contains(&capability)&&permission!="allow"{let mode=capability.strip_prefix("files.").expect("file capability");tx.execute("DELETE FROM ot.custom_app_file_grants WHERE org_id=$1 AND app_id=$2 AND mode=$3",&[&org,&id,&mode]).await?;}
            tx.execute("UPDATE ot.custom_apps SET permissions=$3,permission_rev=permission_rev+1,updated_at=now() WHERE org_id=$1 AND id=$2",&[&org,&id,&permissions]).await?;
        }
        Some(site)=>{
            if capability!=super::net::CAPABILITY{crate::refuse!(BadRequest,"only internet access (net.fetch) has per-site permissions");}
            if !["ask","allow","deny","default"].contains(&permission){crate::refuse!(BadRequest,"a site permission must be ask, allow, deny or default");}
            let mut rows=old["site_permissions"].as_object().cloned().unwrap_or_default();
            // A stored row can always be removed, even one a code change left undeclared.
            if !(permission=="default"&&rows.contains_key(site)){super::policy::net_row(old,site)?;}
            if permission=="default"{rows.remove(site);}else{rows.insert(site.to_owned(),json!(permission));}
            if rows.len()>super::net::SITE_CHOICES_MAX{crate::refuse!(Conflict,"an app keeps at most {} site choices; remove some first",super::net::SITE_CHOICES_MAX);}
            tx.execute("UPDATE ot.custom_apps SET site_permissions=$3,permission_rev=permission_rev+1,updated_at=now() WHERE org_id=$1 AND id=$2",&[&org,&id,&Value::Object(rows)]).await?;
        }
    }
    log_permission(tx,org,id,capability,site,permission,via,actor,panel).await
}
/// The user's answer to a native app prompt. Always allow and Deny store the
/// choice (internet access: on the host's site row); Allow once only records
/// itself. One transaction with its history entry; the caller holds the gate.
#[nolog]
pub(super) async fn prompt_answer(engine:&Arc<Engine>,org:&Arc<OrgHandle>,id:&str,expected:(i64,i64),capability:&str,site:Option<&str>,permission:&str,panel:&str)->Result<()>{
    let mut client=engine.db.get().await?;let tx=client.transaction().await?;
    let old=app(&tx,org.id,id,false,true).await?;revision(&old,expected.0)?;
    if old["permission_rev"].as_i64()!=Some(expected.1){crate::refuse!(Conflict,"app permissions changed; read and reconcile");}
    if permission=="once"{log_permission(&tx,org.id,id,capability,site,"once","prompt","user",Some(panel)).await?;}
    else{set_permission(&tx,org.id,id,&old,capability,site,permission,"prompt","user",Some(panel)).await?;}
    tx.commit().await?;drop(client);
    org.emit(json!({"type":"custom_apps_changed","org":org.slug}));Ok(())
}

#[nolog]
pub(crate) async fn run_locked(engine:&Arc<Engine>,org:&Arc<OrgHandle>,caller:Option<&Caller>,input:&Value)->Result<Value>{
    let request=wire::parse(input)?;
    let mut client=engine.db.get().await?;let tx=client.transaction().await?;
    let actor=authorize(&tx,org.id,caller).await?;let mut changed=false;
    // A rename or deletion changes what shown app event watchdogs name (USER 2026-10-27).
    let mut dogs_named=false;
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
        Request::PermissionSet{app:id,expected_rev,expected_permission_rev,capability,permission,site}=>{
            // Agents may restrict internet access but never grant it or lift a
            // Deny (design m232e1d1ccb57); every other choice is the user's.
            if caller.is_some(){
                if capability!=super::net::CAPABILITY{crate::refuse!(Forbidden,"only the user may decide app execution permissions; ask your superior instead");}
                if !["ask","deny"].contains(&permission.as_str()){crate::refuse!(Forbidden,"agents may set internet access to ask or deny, never allow; ask your superior to allow it");}
            }
            let old=app(&tx,org.id,&id,false,true).await?;revision(&old,expected_rev)?;
            if old["permission_rev"].as_i64()!=Some(expected_permission_rev){crate::refuse!(Conflict,"app permissions changed; read and reconcile");}
            if caller.is_some(){
                let current=match &site{Some(site)=>old["site_permissions"][site.as_str()].as_str(),None=>old["permissions"][capability.as_str()].as_str()};
                if current==Some("deny")&&permission!="deny"{crate::refuse!(Forbidden,"only the user may lift an internet access Deny");}
            }
            set_permission(&tx,org.id,&id,&old,&capability,site.as_deref(),&permission,"change",&actor,None).await?;
            changed=true;app(&tx,org.id,&id,false,false).await?
        }
        // Paged like History (user 2026-10-27 m838e66af753b "ssme for permission
        // history"); every writer holds the app row for update, so seqs commit in order.
        Request::PermissionHistory{app:id,after,before,limit}=>{
            app(&tx,org.id,&id,false,false).await?;let n=page(limit)?;let (op,order,from)=cursor(after,before)?;
            let rows=tx.query(&format!("SELECT jsonb_build_object('seq',seq,'capability',capability,'site',site,'permission',permission,'via',via,'actor',actor,'panel',panel_id,'at',at) FROM ot.custom_app_permission_log WHERE org_id=$1 AND app_id=$2 AND seq{op}$3 ORDER BY seq {order} LIMIT $4"),&[&org.id,&id,&from,&(n+1)]).await?;
            let more=rows.len()>n as usize;let entries:Vec<Value>=rows.into_iter().take(n as usize).map(|r|r.get(0)).collect();let next=if more{entries.last().map(|v|v["seq"].clone())}else{None};
            json!({"app":id,"entries":entries,"next_cursor":next})
        }
        Request::AppGet{app:id}=>app(&tx,org.id,&id,true,false).await?,
        // Mention chips show what an Apps menu row shows: an app's name and its
        // most recently used copy (the copy an app row click opens), a panel's
        // label, app and run state. Never HTML, state or permissions. A missing
        // ID is left out, which is how a chip learns its target is gone.
        // `asked` is the id as asked: a mention written with an app's or
        // panel's old generic id (before migration 0075) finds its row by it.
        Request::Refs{apps,panels}=>{
            let apps=tx.query("SELECT jsonb_build_object('asked',r.ref,'id',a.id,'name',a.name,'recent',(SELECT p.label FROM ot.custom_panels p WHERE p.org_id=a.org_id AND p.app_id=a.id ORDER BY p.used_at DESC,p.id DESC LIMIT 1)) FROM unnest($2::text[]) WITH ORDINALITY AS r(ref,n) JOIN ot.custom_apps a ON a.org_id=$1 AND a.id=ot.custom_app_ref($1,r.ref) ORDER BY r.n",&[&org.id,&apps]).await?;
            let panels=tx.query("SELECT jsonb_build_object('asked',r.ref,'id',p.id,'app',p.app_id,'app_name',a.name,'label',p.label,'open',p.is_open,'running',p.is_running) FROM unnest($2::text[]) WITH ORDINALITY AS r(ref,n) JOIN ot.custom_panels p ON p.org_id=$1 AND p.id=ot.custom_panel_ref($1,r.ref) JOIN ot.custom_apps a ON a.org_id=p.org_id AND a.id=p.app_id ORDER BY r.n",&[&org.id,&panels]).await?;
            json!({"apps":apps.iter().map(|r|r.get::<_,Value>(0)).collect::<Vec<_>>(),"panels":panels.iter().map(|r|r.get::<_,Value>(0)).collect::<Vec<_>>()})
        }
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
            // The database makes every id from the name (migration 0075).
            let def=&value.definition;let caps=json!(wire::current_capabilities(&def.capabilities));let declarations=json!(def.events);let sites=json!(def.sites);
            let id:String=tx.query_one("INSERT INTO ot.custom_apps(org_id,name,description,html,initial_state,capabilities,width,height,created_by,declared_events,origin,declared_sites) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'imported',$11) RETURNING id",&[&org.id,&def.name,&def.description,&def.html,&def.initial_state,&caps,&def.width,&def.height,&actor,&declarations,&sites]).await?.get(0);
            let mut saved=Vec::new();
            for p in &value.panels{
                let place=serde_json::to_value(Placement{width:def.width,height:def.height,..Placement::default()})?;
                let pid:String=tx.query_one("INSERT INTO ot.custom_panels(org_id,app_id,label,state,placement,is_open) VALUES($1,$2,$3,$4,$5,false) RETURNING id",&[&org.id,&id,&p.label,&p.state,&place]).await?.get(0);
                let mut meta=panel(&tx,org.id,&pid,false).await?;meta.as_object_mut().unwrap().remove("state");saved.push(meta);
            }
            changed=true;json!({"imported":id,"app":app(&tx,org.id,&id,false,false).await?,"panels":saved,"warning":"Apps imported from outside this org have full access to it and its state. Be careful importing apps from untrustworthy sources."})
        }
        // The id is the slug asked for, else the name's (migration 0075); the
        // database cleans it and adds -2, -3... when it is taken.
        Request::AppCreate{definition:def,slug}=>{
            wire::definition(&def)?;let caps=json!(wire::current_capabilities(&def.capabilities));let declarations=json!(def.events);let sites=json!(def.sites);
            let id:String=tx.query_one("INSERT INTO ot.custom_apps(org_id,id,name,description,html,initial_state,capabilities,width,height,created_by,declared_events,origin,declared_sites) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'created',$12) RETURNING id",&[&org.id,&slug,&def.name,&def.description,&def.html,&def.initial_state,&caps,&def.width,&def.height,&actor,&declarations,&sites]).await?.get(0);
            changed=true;app(&tx,org.id,&id,false,false).await?
        }
        Request::AppUpdate{app:id,expected_rev,definition:def}=>{
            wire::definition(&def)?;let old=app(&tx,org.id,&id,false,true).await?;revision(&old,expected_rev)?;let caps=json!(wire::current_capabilities(&def.capabilities));let declarations=json!(def.events);let restrictive=super::policy::restrictive_overrides(&old["permissions"]);
            tx.execute("DELETE FROM ot.custom_app_file_grants WHERE org_id=$1 AND app_id=$2",&[&org.id,&id]).await?;
            // Code replacement revokes external grants and every Allow, internet
            // site rows included (design m232e1d1ccb57); user Ask/Deny stays
            // restrictive. Permission history records each cleared Allow.
            let sites=json!(def.sites);let site_rows=super::policy::restrictive_overrides(&old["site_permissions"]);
            for (cap,choice) in old["permissions"].as_object().into_iter().flatten(){if choice=="allow"{log_permission(&tx,org.id,&id,cap,None,"default","code",&actor,None).await?;}}
            for (site,choice) in old["site_permissions"].as_object().into_iter().flatten(){if choice=="allow"{log_permission(&tx,org.id,&id,super::net::CAPABILITY,Some(site.as_str()),"default","code",&actor,None).await?;}}
            tx.execute("UPDATE ot.custom_apps SET name=$3,description=$4,html=$5,initial_state=$6,capabilities=$7,width=$8,height=$9,declared_events=$10,permissions=$11,declared_sites=$12,site_permissions=$13,permission_rev=permission_rev+1,rev=rev+1,updated_at=now() WHERE org_id=$1 AND id=$2",&[&org.id,&id,&def.name,&def.description,&def.html,&def.initial_state,&caps,&def.width,&def.height,&declarations,&restrictive,&sites,&site_rows]).await?;
            // PROVISIONAL code-changed rule, not a user ruling: visible copies reload
            // the new code as before; a hidden running copy powers off rather than
            // silently running code nobody started, and stays off after a restart.
            let restarted=tx.query("UPDATE ot.custom_panels SET is_running=is_open,run_generation=run_generation+1,rev=rev+1,updated_at=now() WHERE org_id=$1 AND app_id=$2 AND is_running RETURNING id,is_open",&[&org.id,&id]).await?;
            for row in &restarted{if !row.get::<_,bool>(1){event(&tx,org.id,row.get::<_,&str>(0),"panel.stopped",&json!({"reason":"code changed"}),&actor).await?;}}
            dogs_named=super::events::has_listeners(&tx,org.id,&id).await?;
            super::events::invalidate(&tx,org.id,&id,None,Some(&declarations)).await?;
            changed=true;app(&tx,org.id,&id,false,false).await?
        }
        Request::AppDelete{app:id,expected_rev,delete_panels}=>{
            revision(&app(&tx,org.id,&id,false,true).await?,expected_rev)?;
            if !delete_panels && tx.query_opt("SELECT 1 FROM ot.custom_panels WHERE org_id=$1 AND app_id=$2 LIMIT 1",&[&org.id,&id]).await?.is_some(){crate::refuse!(Conflict,"app has saved panels; explicitly set delete_panels to remove them");}
            dogs_named=super::events::has_listeners(&tx,org.id,&id).await?;
            super::events::invalidate(&tx,org.id,&id,None,None).await?;
            tx.execute("DELETE FROM ot.custom_apps WHERE org_id=$1 AND id=$2",&[&org.id,&id]).await?;changed=true;json!({"deleted":id})
        }
        Request::PanelOpen{app:app_id,panel:panel_id,new,label,slug}=>{
            // a slug names a new copy (wire::parse refuses it beside panel)
            let new=new||slug.is_some();
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
                let def:Definition=serde_json::from_value(a["definition"].clone())?;
                // "Panel N", never the app's name (user 2026-10-26). The app row
                // lock above serializes numbering; existing labels never change.
                let label=match label{Some(label)=>label,None=>{
                    let rows=tx.query("SELECT label FROM ot.custom_panels WHERE org_id=$1 AND app_id=$2 AND label LIKE 'Panel %'",&[&org.id,&id]).await?;
                    super::labels::default_panel_label(rows.iter().map(|r|r.get::<_,&str>(0)))
                }};wire::text(&label,120,"panel label",false)?;
                let placement=serde_json::to_value(Placement{width:def.width,height:def.height,..Placement::default()})?;
                // the slug asked for, else its app's slug and label (migration 0075)
                let pid:String=tx.query_one("INSERT INTO ot.custom_panels(org_id,id,app_id,label,state,placement,is_open,is_running) VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id",&[&org.id,&slug,&id,&label,&def.initial_state,&placement,&caller.is_none()]).await?.get(0);(pid,caller.is_none())
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
            if label!=old["label"].as_str().unwrap_or(""){dogs_named=super::events::has_listeners(&tx,org.id,old["app"].as_str().unwrap_or("")).await?;}
            if open&&old["running"]!=true{event(&tx,org.id,&id,"panel.started",&json!({"reason":"opened"}),&actor).await?;}changed=true;panel(&tx,org.id,&id,false).await?
        }
        Request::PanelDuplicate{panel:id,expected_rev}=>{
            let old=panel(&tx,org.id,&id,true).await?;revision(&old,expected_rev)?;
            let label:String=format!("{} copy",old["label"].as_str().unwrap_or("Panel")).chars().take(120).collect();
            let mut place:Placement=serde_json::from_value(old["placement"].clone())?;place.mode="float".into();place.anchor=None;place.x+=24.;place.y+=24.;let place=serde_json::to_value(place)?;
            if caller.is_none(){super::runtime::can_start(&tx,org.id).await?;}
            let pid:String=tx.query_one("INSERT INTO ot.custom_panels(org_id,app_id,label,state,placement,is_open,is_running) VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING id",&[&org.id,&old["app"].as_str().unwrap_or(""),&label,&old["state"],&place,&caller.is_none()]).await?.get(0);
            if caller.is_none(){event(&tx,org.id,&pid,"panel.started",&json!({"reason":"opened"}),&actor).await?;}changed=true;panel(&tx,org.id,&pid,false).await?
        }
        Request::PanelDelete{panel:id,expected_rev}=>{
            let old=panel(&tx,org.id,&id,true).await?;revision(&old,expected_rev)?;
            dogs_named=super::events::has_listeners(&tx,org.id,old["app"].as_str().unwrap_or("")).await?;
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
        Request::Events{panel:id,after,before,limit,messages}=>{
            panel(&tx,org.id,&id,false).await?;let n=page(limit)?;let (op,order,from)=cursor(after,before)?;
            let kind=if messages{"message"}else{"history"};
            let rows=tx.query(&format!("SELECT jsonb_build_object('seq',seq,'name',name,'payload',payload,'actor',actor,'at',at) FROM ot.custom_panel_events WHERE org_id=$1 AND panel_id=$2 AND kind=$5 AND seq{op}$3 ORDER BY seq {order} LIMIT $4"),&[&org.id,&id,&from,&(n+1),&kind]).await?;
            let more=rows.len()>n as usize;let events:Vec<Value>=rows.into_iter().take(n as usize).map(|r|r.get(0)).collect();let next=if more{events.last().map(|v|v["seq"].clone())}else{None};
            let oldest:Option<i64>=tx.query_one("SELECT min(seq) FROM ot.custom_panel_events WHERE org_id=$1 AND panel_id=$2 AND kind=$3",&[&org.id,&id,&kind]).await?.get(0);
            json!({"panel":id,"events":events,"next_cursor":next,"oldest_retained":oldest})
        }
    };
    tx.commit().await?;drop(client);
    if input["action"]=="fire_event"{super::events::notify(engine);}
    if changed{org.emit(json!({"type":"custom_apps_changed","org":org.slug}));}
    if dogs_named{crate::changes::notify_id(engine,org.id,vec![crate::changes::Change::Watchdogs]);}
    // No app.event signal follows a commit: panel links are gone (user
    // 2026-10-26), and agents hear from panels only through app event listeners.
    Ok(if input["action"]=="refs"{out}else{with_refs(&org.slug,out)})
}

/// Every app and panel result carries its mention token, as docket items carry
/// `ref`, so an agent writes the exact @app:/@panel: reference for the user
/// (USER 2026-10-27 m449dc0a35cbe). Apps are the rows with capabilities;
/// panels name their app and have a label.
#[nolog]
fn with_refs(slug:&str,mut out:Value)->Value{
    fn one(slug:&str,v:&mut Value){
        let Some(o)=v.as_object_mut() else{return};
        let Some(id)=o.get("id").and_then(Value::as_str).map(str::to_owned) else{return};
        let kind=if o.contains_key("capabilities"){"app"}else if o.get("app").is_some_and(Value::is_string)&&o.contains_key("label"){"panel"}else{return};
        o.insert("ref".into(),json!(format!("@{kind}:{slug}/{id}")));
    }
    one(slug,&mut out);
    if let Some(v)=out.get_mut("app"){one(slug,v);}
    for key in ["items","panels"]{if let Some(rows)=out.get_mut(key).and_then(Value::as_array_mut){for v in rows{one(slug,v);}}}
    out
}

/// An app or panel a request names by its old generic id (before migration
/// 0075) is named by its current id from here on, so gates, hosts, locks and
/// answers all see one id. A name that matches nothing is left as it is, for
/// the action's own refusal. Refs keep the asked names: their answer echoes
/// each one (`asked`).
#[nolog]
async fn current_ids(engine:&Arc<Engine>,org:i64,input:&Value)->Result<Value>{
    let mut out=input.clone();
    let app=input["app"].as_str();let panel=input["panel"].as_str();
    let apps:Vec<String>=if input["action"]=="mark_seen"{input["apps"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()}else{Vec::new()};
    if app.is_none()&&panel.is_none()&&apps.is_empty(){return Ok(out)}
    let client=engine.db.get().await?;
    let row=client.query_one("SELECT ot.custom_app_ref($1,$2),ot.custom_panel_ref($1,$3),(SELECT array_agg(coalesce(ot.custom_app_ref($1,u.a),u.a) ORDER BY u.n) FROM unnest($4::text[]) WITH ORDINALITY AS u(a,n))",&[&org,&app,&panel,&apps]).await?;
    if let Some(id)=row.get::<_,Option<String>>(0){out["app"]=json!(id);}
    if let Some(id)=row.get::<_,Option<String>>(1){out["panel"]=json!(id);}
    if let Some(ids)=row.get::<_,Option<Vec<String>>>(2){out["apps"]=json!(ids);}
    Ok(out)
}

/// All paths acquire this gate before root-first agent/database locks. No PG
/// connection is held while an action dispatch calls another domain service.
#[nolog]
pub async fn run(engine:&Arc<Engine>,org:&Arc<OrgHandle>,caller:Option<&Caller>,input:&Value)->Result<Value>{
    let request=wire::parse(input)?;
    if caller.is_some_and(|c|c.org_id!=org.id){crate::refuse!(Forbidden,"Apps caller belongs to another organization");}
    let input=&current_ids(engine,org.id,input).await?;
    if let Request::Runtime{after,limit,sample}=request{return super::runtime::list(engine,org,caller,after,limit,sample).await;}
    let action=input["action"].as_str().unwrap_or("");
    if ["list","app_get","panel_get","refs","events","app_create","app_import","app_export","mark_seen","listeners","permission_history"].contains(&action){return run_locked(engine,org,caller,input).await;}
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
    // Anything short of Allow ends this app's internet requests in flight and
    // its Allow once answers (Deny wins over temporary grants).
    if action=="permission_set"&&input["capability"]==super::net::CAPABILITY&&input["permission"]!="allow"{engine.custom_apps.net.revoke(org.id,Some(&app),None);}
    if let (Some(cap),Some(before))=(file_cap,before.as_ref()){
        if removes_file_access(before,cap,input["permission"].as_str().unwrap_or("")){engine.custom_apps.file_access.forget(org.id,Some(&app),None)?;}
    }
    // Power off and deletion end the runtime and its authority. Hide keeps the
    // runtime with its file and media links, so hidden media keeps playing
    // (USER 2026-10-26 mf7add4fda093); it ends only open questions.
    if action=="panel_delete"||action=="panel_stop"{engine.custom_apps.revoke(org.id,None,input["panel"].as_str())?;engine.custom_apps.runtime.revoke(org.id,input["panel"].as_str())?;}
    if action=="panel_update"&&input["open"]==false{engine.custom_apps.file_access.forget_prompts(org.id,None,input["panel"].as_str(),None)?;engine.custom_apps.net.forget_once(org.id,input["panel"].as_str().unwrap_or(""));}
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
    #[test]
    fn app_and_panel_results_carry_their_mention_token() {
        assert_eq!(with_refs("acme", json!({"id":"app1","name":"Notes","capabilities":[]}))["ref"], "@app:acme/app1");
        assert_eq!(with_refs("acme", json!({"id":"panel1","app":"app1","label":"Panel 1"}))["ref"], "@panel:acme/panel1");
        let list = with_refs("acme", json!({"kind":"panels","items":[{"id":"panel2","app":"app1","label":"Panel 2"}],"next_cursor":null}));
        assert_eq!(list["items"][0]["ref"], "@panel:acme/panel2");
        let apps = with_refs("acme", json!({"kind":"apps","items":[{"id":"app2","capabilities":["events.fire"]}],"new_count":0}));
        assert_eq!(apps["items"][0]["ref"], "@app:acme/app2");
        let import = with_refs("acme", json!({"imported":"app3","app":{"id":"app3","capabilities":[]},"panels":[{"id":"panel3","app":"app3","label":"Panel 1"}]}));
        assert_eq!(import["app"]["ref"], "@app:acme/app3");
        assert_eq!(import["panels"][0]["ref"], "@panel:acme/panel3");
        // a deletion, an export's panel count, history and events stay as they are
        for other in [json!({"deleted":"panel1"}), json!({"panels":2,"bundle":{"format":"orgtree-app"}}),
            json!({"app":"app1","entries":[]}), json!({"panel":"panel1","events":[],"next_cursor":null})] {
            assert_eq!(with_refs("acme", other.clone()), other);
        }
    }
}
