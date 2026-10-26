//! Read-only App files. Paths/decisions are native-only; HTML gets references.
//! All callers share the app gate with code/permission mutation. No PG client
//! or transaction crosses file IO, a permission prompt, or a media stream.
use std::{collections::HashMap,path::PathBuf,sync::Mutex,time::{Duration,Instant}};
use anyhow::Result;
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use tokio_util::sync::CancellationToken;
use crate::{engine::Engine,orgs::OrgHandle,runtime::Caller};
use std::sync::Arc;
use super::{bridge::{self,Bound,Choice},files,wire};

pub const READ_MAX:usize=64*1024;
const REGISTRY_MAX:usize=4096;

#[derive(Clone,Deserialize,Serialize)]
#[serde(tag="action",rename_all="snake_case",deny_unknown_fields)]
pub enum FileCall {
    Choose,
    Open{root:String,path:String},
    Read{file:String,offset:Option<u64>,limit:Option<usize>},
    Media{file:String},
}
#[derive(Deserialize)]
#[serde(tag="action",rename_all="snake_case",deny_unknown_fields)]
enum NativeRequest {
    Call{session:String,request:FileCall},
    Decide{session:String,challenge:String,choice:Choice,path:Option<String>},
    Permissions{app:String},
    Revoke{app:String,expected_rev:i64,expected_permission_rev:i64,grant:String},
    Browse{session:String,path:String,after:Option<String>,limit:Option<usize>},
}

#[derive(Clone)]
struct Reference {id:String,grant:String,path:PathBuf}
struct Pending {session:String,bound:Bound,call:FileCall,until:Instant}
#[derive(Clone)]
pub(crate) struct MediaLease {
    pub session:String,pub org:i64,pub app:String,pub panel:String,pub rev:i64,
    pub reference:String,pub until:Instant,pub cancel:CancellationToken,
}
struct Temporary {session:String,bound:Bound,reference:Reference}
#[derive(Default)]
pub struct Registry {
    pending:Mutex<HashMap<String,Pending>>,
    temporary:Mutex<HashMap<String,Temporary>>,
    media:Mutex<HashMap<String,MediaLease>>,
}
impl Registry {
    #[nolog]
    fn ask(&self,session:&str,bound:&Bound,call:FileCall)->Result<String>{
        let mut pending=self.pending.lock().map_err(|_|anyhow::anyhow!("App file requests unavailable"))?;
        let now=Instant::now();pending.retain(|_,p|p.until>now);
        if pending.values().any(|p|p.session==session){crate::refuse!(Conflict,"answer the pending file permission first");}
        if pending.len()>=REGISTRY_MAX{crate::refuse!(Conflict,"too many pending app file requests");}
        let id=bridge::secret();pending.insert(id.clone(),Pending{session:session.into(),bound:bound.clone(),call,until:now+Duration::from_secs(120)});Ok(id)
    }
    #[nolog]
    fn consume(&self,session:&str,bound:&Bound,id:&str)->Result<FileCall>{
        let mut pending=self.pending.lock().map_err(|_|anyhow::anyhow!("App file requests unavailable"))?;
        if !pending.get(id).is_some_and(|p|p.session==session&&same(&p.bound,bound)&&p.until>Instant::now()) {crate::refuse!(Forbidden,"app file permission expired or does not match");}
        Ok(pending.remove(id).expect("checked pending").call)
    }
    #[nolog]
    fn temporary(&self,session:&str,bound:&Bound,id:&str)->Result<Option<Reference>>{
        let temporary=self.temporary.lock().map_err(|_|anyhow::anyhow!("App file references unavailable"))?;
        Ok(temporary.get(id).filter(|r|r.session==session&&same(&r.bound,bound)).map(|r|r.reference.clone()))
    }
    #[nolog]
    fn remember_once(&self,session:&str,bound:&Bound,path:PathBuf,id:Option<String>)->Result<Reference>{
        let mut temporary=self.temporary.lock().map_err(|_|anyhow::anyhow!("App file references unavailable"))?;
        if temporary.len()>=REGISTRY_MAX{crate::refuse!(Conflict,"too many temporary app files");}
        let reference=Reference{id:id.unwrap_or_else(||crate::util::uid("app-file")),grant:String::new(),path};
        temporary.insert(reference.id.clone(),Temporary{session:session.into(),bound:bound.clone(),reference:reference.clone()});Ok(reference)
    }
    #[nolog]
    pub(super) fn forget(&self,org:i64,app:Option<&str>,panel:Option<&str>,session:Option<&str>)->Result<()>{
        let matches=|bound:&Bound,token:&str|bound.org==org&&app.is_none_or(|a|a==bound.app)&&panel.is_none_or(|p|p==bound.panel)&&session.is_none_or(|s|s==token);
        self.pending.lock().map_err(|_|anyhow::anyhow!("App file requests unavailable"))?.retain(|_,p|!matches(&p.bound,&p.session));
        self.temporary.lock().map_err(|_|anyhow::anyhow!("App file references unavailable"))?.retain(|_,p|!matches(&p.bound,&p.session));
        self.media.lock().map_err(|_|anyhow::anyhow!("App media unavailable"))?.retain(|_,m|{
            let matched=m.org==org&&app.is_none_or(|a|a==m.app)&&panel.is_none_or(|p|p==m.panel)&&session.is_none_or(|s|s==m.session);
            if matched{m.cancel.cancel();} !matched
        });Ok(())
    }
    #[nolog]
    fn media(&self,session:&str,bound:&Bound,file:&str,lifetime:Duration)->Result<String>{
        let mut media=self.media.lock().map_err(|_|anyhow::anyhow!("App media unavailable"))?;
        media.retain(|_,m|{if m.until<=Instant::now(){m.cancel.cancel();false}else{true}});
        if media.len()>=REGISTRY_MAX{crate::refuse!(Conflict,"too many app media streams");}
        let ticket=bridge::secret();media.insert(ticket.clone(),MediaLease{session:session.into(),org:bound.org,app:bound.app.clone(),panel:bound.panel.clone(),rev:bound.rev,reference:file.into(),until:Instant::now()+lifetime,cancel:CancellationToken::new()});Ok(ticket)
    }
    #[nolog]
    pub(crate) fn lease(&self,org:i64,ticket:&str)->Result<MediaLease>{
        let media=self.media.lock().map_err(|_|anyhow::anyhow!("App media unavailable"))?;
        let Some(value)=media.get(ticket).filter(|m|m.org==org&&m.until>Instant::now()&&!m.cancel.is_cancelled())else{crate::refuse!(Forbidden,"app media reference expired or was revoked");};Ok(value.clone())
    }
}
#[nolog]
fn same(left:&Bound,right:&Bound)->bool {left.org==right.org&&left.app==right.app&&left.panel==right.panel&&left.rev==right.rev}
#[nolog]
fn validate(call:&FileCall)->Result<()>{
    wire::bounded(&serde_json::to_value(call)?,wire::EVENT_MAX,false)?;
    match call{
        FileCall::Open{root,path}=>{
            if !["scratch","uploads","artifacts"].contains(&root.as_str()){crate::refuse!(BadRequest,"file root must be scratch, uploads or artifacts");}
            wire::text(path,4096,"relative file name",false)?;
            if path.contains(':')||std::path::Path::new(path).components().any(|c|!matches!(c,std::path::Component::Normal(_))){crate::refuse!(Forbidden,"app files need a relative name without parent components");}
        },
        FileCall::Read{file,limit,..}=>{wire::text(file,120,"file reference",false)?;if !(1..=READ_MAX).contains(&limit.unwrap_or(READ_MAX)){crate::refuse!(BadRequest,"file read limit must be 1-65536 bytes");}},
        FileCall::Media{file}=>wire::text(file,120,"file reference",false)?,
        FileCall::Choose=>{},
    }Ok(())
}
#[nolog]
fn declared(value:&Value)->Result<()>{
    if !value["capabilities"].as_array().is_some_and(|v|v.iter().any(|c|c=="files.read")){crate::refuse!(Forbidden,"app does not declare files.read");}
    if value["permissions"]["files.read"]=="deny"{crate::refuse!(Forbidden,"app file access is denied");}Ok(())
}

#[nolog]
pub async fn native(engine:&Arc<Engine>,org:&Arc<OrgHandle>,input:&Value)->Result<Value>{
    wire::bounded(input,wire::EVENT_MAX+8192,false)?;
    let request:NativeRequest=serde_json::from_value(input.clone()).map_err(|_|crate::domain::UserError::BadRequest("invalid native App file request".into()))?;
    match request{
        NativeRequest::Permissions{app}=>permissions(engine,org,&app,None).await,
        NativeRequest::Revoke{app,expected_rev,expected_permission_rev,grant}=>revoke(engine,org,&app,expected_rev,expected_permission_rev,&grant).await,
        NativeRequest::Browse{session,path,after,limit}=>{
            let bound=engine.custom_apps.bound(org.id,&session)?;bridge::snapshot(engine,&bound).await?;
            tokio::task::spawn_blocking(move||browse(&path,after.as_deref(),limit.unwrap_or(100))).await?
        },
        NativeRequest::Call{session,request:call}=>{
            validate(&call)?;let bound=engine.custom_apps.bound(org.id,&session)?;let _guard=bound.gate.lock.lock().await;
            engine.custom_apps.bound(org.id,&session)?;let value=bridge::snapshot(engine,&bound).await?;declared(&value)?;
            bound.gate.admit()?;
            if !matches!(call,FileCall::Choose){
                if let Some(reference)=authorized(engine,org,&session,&bound,&value,&call).await?{return execute(engine,org,&session,&bound,&call,reference,None).await;}
            }
            let challenge=engine.custom_apps.file_access.ask(&session,&bound,call.clone())?;
            Ok(json!({"permission_required":{"challenge":challenge,"app":bound.app,"panel":bound.panel,"name":value["name"],"label":value["label"],"capability":"files.read","request":call}}))
        },
        NativeRequest::Decide{session,challenge,choice,path}=>{
            let bound=engine.custom_apps.bound(org.id,&session)?;let _guard=bound.gate.lock.lock().await;
            engine.custom_apps.bound(org.id,&session)?;
            let value=bridge::snapshot(engine,&bound).await?;declared(&value)?;
            let call=engine.custom_apps.file_access.consume(&session,&bound,&challenge)?;
            if matches!(choice,Choice::Deny){
                super::storage::run_locked(engine,org,None,&json!({"action":"permission_set","app":bound.app,"expected_rev":bound.rev,"expected_permission_rev":value["permission_rev"],"capability":"files.read","permission":"deny"})).await?;
                engine.custom_apps.file_access.forget(org.id,Some(&bound.app),None,None)?;
                crate::refuse!(Forbidden,"app file access denied");
            }
            let existing=if let FileCall::Read{file,..}|FileCall::Media{file}= &call{Some(reference(engine,&bound,file).await?)}else{None};
            let selected=match &call{
                FileCall::Choose=>files::checked_path(std::path::Path::new(path.as_deref().ok_or_else(||crate::domain::UserError::BadRequest("choose a file before allowing access".into()))?))?,
                FileCall::Open{root,path:relative}=>{if path.is_some(){crate::refuse!(BadRequest,"Orgtree file permission does not take a computer path");}org_path(engine,org,root,relative).await?},
                _=>{if path.is_some(){crate::refuse!(BadRequest,"existing file permission does not take a computer path");}existing.as_ref().expect("read/media reference").path.clone()},
            };
            // Validate the pinned regular file before recording ANY grant.
            let selected_check=selected.clone();tokio::task::spawn_blocking(move||files::open_read(&selected_check)).await??;
            let chosen=if matches!(choice,Choice::Always){
                let scope=if matches!(call,FileCall::Open{..}){"orgtree"}else{"file"};
                remember(engine,&bound,scope,&selected,value["permission_rev"].as_i64().unwrap_or(1)).await?
            }else{engine.custom_apps.file_access.remember_once(&session,&bound,selected,existing.as_ref().map(|r|r.id.clone()))?};
            execute(engine,org,&session,&bound,&call,chosen,None).await
        },
    }
}

// Storage/IO helpers are kept below the native decision boundary. They are
// shared by agent reads, which add their current scope before disclosing data.

#[nolog]
async fn org_path(engine:&Engine,org:&OrgHandle,root:&str,name:&str)->Result<PathBuf>{
    match root{
        "scratch"=>files::scoped_path(&engine.cfg.scratch_root(&org.slug),name),
        "uploads"=>{
            if name.split(['/', '\\']).next()==Some("@org-inbox"){
                let client=engine.db.get().await?;
                let settings:Value=client.query_one("SELECT settings FROM ot.orgs WHERE id=$1",&[&org.id]).await?.get(0);
                if !crate::domain::orginbox::enabled(&settings){crate::refuse!(Forbidden,"the organization's inbox is disabled");}
            }
            files::scoped_path(&engine.cfg.path("uploads").join(&org.slug),name)
        },
        "artifacts"=>{
            let client=engine.db.get().await?;
            let Some(row)=client.query_opt("SELECT path FROM ot.deliveries WHERE org_id=$1 AND uid=$2",&[&org.id,&name]).await?else{crate::refuse!(NotFound,"retained artifact not found in this organization");};
            files::checked_path(std::path::Path::new(&row.get::<_,String>(0)))
        },
        _=>crate::refuse!(BadRequest,"unknown Orgtree file collection"),
    }
}
#[nolog]
async fn org_member(engine:&Engine,bound:&Bound,path:&std::path::Path)->Result<bool>{
    let org=engine.orgs.by_id(bound.org).ok_or_else(||crate::domain::UserError::NotFound("organization closed".into()))?;
    if files::relative(path,&engine.cfg.scratch_root(&org.slug)).is_some(){return Ok(true);}
    if let Some(relative)=files::relative(path,&engine.cfg.path("uploads").join(&org.slug)){
        let relative=relative.to_string_lossy();org_path(engine,&org,"uploads",&relative).await?;return Ok(true);
    }
    let client=engine.db.get().await?;
    Ok(client.query_one("SELECT EXISTS(SELECT 1 FROM ot.deliveries WHERE org_id=$1 AND path=$2)",&[&bound.org,&path.to_string_lossy().as_ref()]).await?.get(0))
}
#[nolog]
async fn reference(engine:&Engine,bound:&Bound,id:&str)->Result<Reference>{
    let client=engine.db.get().await?;
    let row=client.query_opt("SELECT r.path,r.grant_id,g.scope,g.path FROM ot.custom_app_file_refs r JOIN ot.custom_app_file_grants g ON g.org_id=r.org_id AND g.app_id=r.app_id AND g.id=r.grant_id AND g.app_rev=r.app_rev WHERE r.org_id=$1 AND r.app_id=$2 AND r.panel_id=$3 AND r.app_rev=$4 AND r.id=$5",&[&bound.org,&bound.app,&bound.panel,&bound.rev,&id]).await?;
    let Some(row)=row else{crate::refuse!(Forbidden,"file reference is unavailable for this panel; choose the file again");};
    let path=PathBuf::from(row.get::<_,String>(0));let scope:String=row.get(2);let granted:Option<String>=row.get(3);drop(client);
    if scope=="file"&&granted.as_deref()!=path.to_str(){crate::refuse!(Forbidden,"file reference no longer matches its grant");}
    if scope=="orgtree"&&!org_member(engine,bound,&path).await?{crate::refuse!(Forbidden,"file left this organization's collections");}
    Ok(Reference{id:id.into(),grant:row.get(1),path})
}
#[nolog]
async fn stored_reference(engine:&Engine,bound:&Bound,grant:&str,path:&std::path::Path)->Result<Reference>{
    let raw=path.to_string_lossy().to_string();let mut client=engine.db.get().await?;let tx=client.transaction().await?;
    if let Some(row)=tx.query_opt("SELECT id FROM ot.custom_app_file_refs WHERE org_id=$1 AND app_id=$2 AND panel_id=$3 AND app_rev=$4 AND grant_id=$5 AND path=$6 LIMIT 1",&[&bound.org,&bound.app,&bound.panel,&bound.rev,&grant,&raw]).await?{
        let id:String=row.get(0);tx.commit().await?;return Ok(Reference{id,grant:grant.into(),path:path.into()});
    }
    let count:i64=tx.query_one("SELECT count(*) FROM ot.custom_app_file_refs WHERE org_id=$1 AND app_id=$2 AND panel_id=$3",&[&bound.org,&bound.app,&bound.panel]).await?.get(0);
    if count>=1024{crate::refuse!(Conflict,"a panel can remember at most 1024 file references");}
    let id=crate::util::uid("app-file");
    tx.execute("INSERT INTO ot.custom_app_file_refs(org_id,app_id,panel_id,id,app_rev,grant_id,path) VALUES($1,$2,$3,$4,$5,$6,$7)",&[&bound.org,&bound.app,&bound.panel,&id,&bound.rev,&grant,&raw]).await?;
    tx.commit().await?;Ok(Reference{id,grant:grant.into(),path:path.into()})
}
#[nolog]
async fn authorized(engine:&Engine,org:&OrgHandle,session:&str,bound:&Bound,value:&Value,call:&FileCall)->Result<Option<Reference>>{
    match call{
        FileCall::Choose=>Ok(None),
        FileCall::Read{file,..}|FileCall::Media{file}=>{
            if let Some(r)=engine.custom_apps.file_access.temporary(session,bound,file)?{return Ok(Some(r));}
            let r=reference(engine,bound,file).await?;
            if value["permissions"]["files.read"]=="allow"{Ok(Some(r))}else{Ok(None)}
        },
        FileCall::Open{root,path}=>{
            if value["permissions"]["files.read"]!="allow"{return Ok(None);}
            let client=engine.db.get().await?;
            let row=client.query_opt("SELECT id FROM ot.custom_app_file_grants WHERE org_id=$1 AND app_id=$2 AND app_rev=$3 AND scope='orgtree' ORDER BY id LIMIT 1",&[&bound.org,&bound.app,&bound.rev]).await?;drop(client);
            let Some(row)=row else{return Ok(None);};let selected=org_path(engine,org,root,path).await?;
            Ok(Some(stored_reference(engine,bound,&row.get::<_,String>(0),&selected).await?))
        },
    }
}
#[nolog]
async fn remember(engine:&Engine,bound:&Bound,scope:&str,path:&std::path::Path,permission_rev:i64)->Result<Reference>{
    let mut client=engine.db.get().await?;let tx=client.transaction().await?;
    let row=tx.query_opt("SELECT rev,permission_rev,permissions FROM ot.custom_apps WHERE org_id=$1 AND id=$2 FOR UPDATE",&[&bound.org,&bound.app]).await?;
    let Some(row)=row else{crate::refuse!(NotFound,"app removed");};
    if row.get::<_,i64>(0)!=bound.rev||row.get::<_,i64>(1)!=permission_rev{crate::refuse!(Conflict,"app permissions changed; reopen its file request");}
    let raw=if scope=="file"{Some(path.to_string_lossy().to_string())}else{None};
    let old=tx.query_opt("SELECT id FROM ot.custom_app_file_grants WHERE org_id=$1 AND app_id=$2 AND app_rev=$3 AND scope=$4 AND path IS NOT DISTINCT FROM $5 ORDER BY id LIMIT 1",&[&bound.org,&bound.app,&bound.rev,&scope,&raw]).await?;
    let grant=if let Some(row)=old{row.get::<_,String>(0)}else{
        let count:i64=tx.query_one("SELECT count(*) FROM ot.custom_app_file_grants WHERE org_id=$1 AND app_id=$2",&[&bound.org,&bound.app]).await?.get(0);
        if count>=128{crate::refuse!(Conflict,"an app can remember at most 128 file grants");}
        let id=crate::util::uid("app-grant");tx.execute("INSERT INTO ot.custom_app_file_grants(org_id,app_id,id,app_rev,scope,path) VALUES($1,$2,$3,$4,$5,$6)",&[&bound.org,&bound.app,&id,&bound.rev,&scope,&raw]).await?;id
    };
    let mut permissions:Value=row.get(2);permissions["files.read"]=json!("allow");
    tx.execute("UPDATE ot.custom_apps SET permissions=$3,permission_rev=permission_rev+1,updated_at=now() WHERE org_id=$1 AND id=$2",&[&bound.org,&bound.app,&permissions]).await?;
    tx.commit().await?;drop(client);
    if let Some(org)=engine.orgs.by_id(bound.org){org.emit(json!({"type":"custom_apps_changed","org":org.slug}));}
    stored_reference(engine,bound,&grant,path).await
}
#[nolog]
async fn agent_scope(engine:&Arc<Engine>,org:&Arc<OrgHandle>,caller:&Caller,path:&std::path::Path)->Result<()>{
    super::storage::file_authority(engine,org,caller).await?;
    let p=crate::domain::docs::presenter(engine,org,caller.agent_id).await?;
    if !std::iter::once(p.scratch).chain(p.dirs.into_iter().map(PathBuf::from)).any(|root|files::relative(path,&root).is_some()){
        crate::refuse!(Forbidden,"app permission does not extend the calling agent's folders");
    }Ok(())
}
#[nolog]
async fn execute(engine:&Arc<Engine>,org:&Arc<OrgHandle>,session:&str,bound:&Bound,call:&FileCall,reference:Reference,caller:Option<&Caller>)->Result<Value>{
    if let Some(caller)=caller{agent_scope(engine,org,caller,&reference.path).await?;}
    let selected=reference.path.clone();
    let opened=tokio::task::spawn_blocking(move||files::open_read(&selected)).await??;
    let metadata=opened.metadata()?;let bytes=metadata.len();
    let name=reference.path.file_name().map(|s|s.to_string_lossy().to_string()).unwrap_or_default();
    let mut info=json!({"id":reference.id,"name":name,"bytes":bytes,"mime":mime_guess::from_path(&reference.path).first_or_octet_stream().to_string()});
    match call{
        FileCall::Read{offset,limit,..}=>{
            let offset=offset.unwrap_or(0);let limit=limit.unwrap_or(READ_MAX);
            if offset>bytes{crate::refuse!(BadRequest,"file offset exceeds the current size");}
            let data=tokio::task::spawn_blocking(move||->Result<Vec<u8>>{use std::io::{Read,Seek};let mut opened=opened;opened.seek(std::io::SeekFrom::Start(offset))?;let mut data=Vec::new();opened.take(limit as u64).read_to_end(&mut data)?;Ok(data)}).await??;
            if let Some(caller)=caller{agent_scope(engine,org,caller,&reference.path).await?;}
            use base64::Engine as _;info["offset"]=json!(offset);info["length"]=json!(data.len());info["eof"]=json!(offset+data.len() as u64>=bytes);info["base64"]=json!(base64::engine::general_purpose::STANDARD.encode(data));
        },
        FileCall::Media{..}=>{
            if caller.is_some(){crate::refuse!(Forbidden,"agents read media bytes through file_read within their own folders");}
            if crate::http::media_file::media_type(&reference.path).is_none(){crate::refuse!(BadRequest,"file is not a supported video or audio format");}
            if bytes>crate::http::media_file::MAX_BYTES{crate::refuse!(BadRequest,"media playback is limited to 256 MiB");}
            let ticket=engine.custom_apps.file_access.media(session,bound,&reference.id,engine.custom_apps.remaining(org.id,session)?)?;
            info["media_path"]=json!(format!("/api/orgs/{}/apps/media?ticket={ticket}",org.slug));
        },
        FileCall::Choose|FileCall::Open{..}=>{},
    }Ok(info)
}
#[nolog]
pub(crate) async fn media(engine:&Arc<Engine>,org:&Arc<OrgHandle>,ticket:&str)->Result<(std::fs::File,PathBuf,MediaLease)>{
    if ticket.len()!=64||!ticket.bytes().all(|b|b.is_ascii_hexdigit()){crate::refuse!(Forbidden,"invalid app media ticket");}
    let lease=engine.custom_apps.file_access.lease(org.id,ticket)?;
    let bound=engine.custom_apps.bound(org.id,&lease.session)?;let _guard=bound.gate.lock.lock().await;
    if bound.app!=lease.app||bound.panel!=lease.panel||bound.rev!=lease.rev{crate::refuse!(Forbidden,"app media host changed");}
    let value=bridge::snapshot(engine,&bound).await?;declared(&value)?;
    let call=FileCall::Media{file:lease.reference.clone()};
    let reference=authorized(engine,org,&lease.session,&bound,&value,&call).await?.ok_or_else(||crate::domain::UserError::Forbidden("app file permission changed".into()))?;
    let selected=reference.path.clone();let file=tokio::task::spawn_blocking(move||files::open_read(&selected)).await??;
    if lease.cancel.is_cancelled(){crate::refuse!(Forbidden,"app media was revoked");}
    Ok((file,reference.path,lease))
}
#[nolog]
async fn permissions(engine:&Arc<Engine>,org:&Arc<OrgHandle>,app:&str,caller:Option<&Caller>)->Result<Value>{
    if let Some(caller)=caller{super::storage::file_authority(engine,org,caller).await?;}
    let client=engine.db.get().await?;
    let row=client.query_opt("SELECT rev,permission_rev,permissions FROM ot.custom_apps WHERE org_id=$1 AND id=$2",&[&org.id,&app]).await?;
    let Some(row)=row else{crate::refuse!(NotFound,"app not found");};
    let rev:i64=row.get(0);let permission_rev:i64=row.get(1);let modes:Value=row.get(2);
    let rows=client.query("SELECT id,scope,path FROM ot.custom_app_file_grants WHERE org_id=$1 AND app_id=$2 AND app_rev=$3 ORDER BY id LIMIT 128",&[&org.id,&app,&rev]).await?;drop(client);
    let mut grants=Vec::new();
    for row in rows{
        let path:Option<String>=row.get(2);let mut grant=json!({"id":row.get::<_,String>(0),"scope":row.get::<_,String>(1)});
        if let Some(path)=path{
            if let Some(caller)=caller{if agent_scope(engine,org,caller,std::path::Path::new(&path)).await.is_err(){continue;}}
            grant["name"]=json!(std::path::Path::new(&path).file_name().map(|s|s.to_string_lossy().to_string()).unwrap_or_default());
            if caller.is_none(){grant["path"]=json!(path);}
        }else{grant["name"]=json!("This organization's scratch, uploads and retained artifacts");}
        grants.push(grant);
    }
    Ok(json!({"app":app,"rev":rev,"permission_rev":permission_rev,"permission":modes["files.read"].as_str().unwrap_or("ask"),"grants":grants,"write":"unavailable"}))
}
#[nolog]
async fn revoke(engine:&Arc<Engine>,org:&Arc<OrgHandle>,app:&str,rev:i64,permission_rev:i64,grant:&str)->Result<Value>{
    let gate=engine.custom_apps.gate(org.id,app)?;let _guard=gate.lock.lock().await;
    let mut client=engine.db.get().await?;let tx=client.transaction().await?;
    let row=tx.query_opt("SELECT rev,permission_rev FROM ot.custom_apps WHERE org_id=$1 AND id=$2 FOR UPDATE",&[&org.id,&app]).await?;
    let Some(row)=row else{crate::refuse!(NotFound,"app not found");};
    if row.get::<_,i64>(0)!=rev||row.get::<_,i64>(1)!=permission_rev{crate::refuse!(Conflict,"app permissions changed; read and reconcile");}
    tx.execute("DELETE FROM ot.custom_app_file_grants WHERE org_id=$1 AND app_id=$2 AND id=$3",&[&org.id,&app,&grant]).await?;
    tx.execute("UPDATE ot.custom_apps SET permission_rev=permission_rev+1 WHERE org_id=$1 AND id=$2",&[&org.id,&app]).await?;
    tx.commit().await?;drop(client);
    engine.custom_apps.file_access.forget(org.id,Some(app),None,None)?;
    org.emit(json!({"type":"custom_apps_changed","org":org.slug}));permissions(engine,org,app,None).await
}
#[nolog]
fn browse(raw:&str,after:Option<&str>,limit:usize)->Result<Value>{
    if !(1..=200).contains(&limit){crate::refuse!(BadRequest,"file picker limit must be 1-200");}
    if raw.is_empty(){
        let mut roots=Vec::new();
        #[cfg(windows)] for letter in b'A'..=b'Z'{let path=format!("{}:/",letter as char);if std::path::Path::new(&path).is_dir(){roots.push(json!({"name":path,"path":path,"directory":true}));}}
        #[cfg(not(windows))] roots.push(json!({"name":"/","path":"/","directory":true}));
        return Ok(json!({"path":"","parent":null,"items":roots,"next_cursor":null}));
    }
    let path=files::checked_path(std::path::Path::new(raw))?;
    // Native-only listing is bounded; it is never an iframe or agent method.
    // Keyset order stays stable between pages, with a disclosed scan ceiling.
    let mut entries=Vec::new();let mut scanned=0;
    for entry in std::fs::read_dir(&path)?{
        scanned+=1;if scanned>20_000{break;}let entry=entry?;let name=entry.file_name().to_string_lossy().to_string();
        if after.is_some_and(|after|name.as_str()<=after){continue;}
        let ty=entry.file_type()?;if ty.is_symlink(){continue;}
        entries.push(json!({"name":name,"path":entry.path().to_string_lossy(),"directory":ty.is_dir()}));
    }
    entries.sort_by(|a,b|a["name"].as_str().cmp(&b["name"].as_str()));let more=entries.len()>limit;entries.truncate(limit);
    let next=if more{entries.last().map(|v|v["name"].clone())}else{None};
    Ok(json!({"path":path.to_string_lossy(),"parent":path.parent().map(|p|p.to_string_lossy()),"items":entries,"next_cursor":next,"scan_limited":scanned>20_000}))
}

#[nolog]
pub async fn agent(engine:&Arc<Engine>,org:&Arc<OrgHandle>,caller:&Caller,input:&Value)->Result<Value>{
    super::storage::file_authority(engine,org,caller).await?;
    let action=input["action"].as_str().unwrap_or("");
    if action=="file_permissions"{
        if !input.as_object().is_some_and(|v|v.keys().all(|k|["action","app"].contains(&k.as_str()))){crate::refuse!(BadRequest,"unexpected file permission fields");}
        return permissions(engine,org,input["app"].as_str().unwrap_or(""),Some(caller)).await;
    }
    if !["file_open","file_read"].contains(&action){crate::refuse!(Forbidden,"agents may inspect/read app files but never choose files or decide grants");}
    let mut args=input.clone();let object=args.as_object_mut().ok_or_else(||crate::domain::UserError::BadRequest("file request must be an object".into()))?;
    let panel=object.remove("panel").and_then(|v|v.as_str().map(str::to_owned)).unwrap_or_default();
    if let Some(length)=object.remove("length"){object.insert("limit".into(),length);}
    object.insert("action".into(),json!(if action=="file_open"{"open"}else{"read"}));
    let call:FileCall=serde_json::from_value(args).map_err(|_|crate::domain::UserError::BadRequest("invalid app file read arguments".into()))?;validate(&call)?;
    let client=engine.db.get().await?;let row=client.query_opt("SELECT p.app_id,a.rev FROM ot.custom_panels p JOIN ot.custom_apps a ON a.org_id=p.org_id AND a.id=p.app_id WHERE p.org_id=$1 AND p.id=$2",&[&org.id,&panel]).await?;
    let Some(row)=row else{crate::refuse!(NotFound,"panel not found");};let app:String=row.get(0);let rev:i64=row.get(1);drop(client);
    let gate=engine.custom_apps.gate(org.id,&app)?;let bound=Bound{org:org.id,app,panel,rev,gate:gate.clone()};let _guard=gate.lock.lock().await;
    // Agent reads need the saved panel identity, not a running HTML host.
    let client=engine.db.get().await?;
    let value:Value=client.query_one("SELECT jsonb_build_object('capabilities',a.capabilities,'permissions',a.permissions) FROM ot.custom_apps a JOIN ot.custom_panels p ON p.org_id=a.org_id AND p.app_id=a.id WHERE a.org_id=$1 AND a.id=$2 AND a.rev=$3 AND p.id=$4",&[&bound.org,&bound.app,&bound.rev,&bound.panel]).await?.get(0);drop(client);declared(&value)?;
    if value["permissions"]["files.read"]!="allow"{crate::refuse!(Forbidden,"the user must grant this app read access first");}
    bound.gate.admit()?;
    if let FileCall::Open{root,path}=&call{let selected=org_path(engine,org,root,path).await?;agent_scope(engine,org,caller,&selected).await?;}
    let reference=authorized(engine,org,"",&bound,&value,&call).await?.ok_or_else(||crate::domain::UserError::Forbidden("the user must grant this file collection first".into()))?;
    execute(engine,org,"",&bound,&call,reference,Some(caller)).await
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test] fn app_files_only_accept_fixed_read_actions_and_relative_collections(){
        for value in [json!({"action":"write","path":"x"}),json!({"action":"choose","path":"C:/secret"}),json!({"action":"read","file":"x","as_user":true})]{assert!(serde_json::from_value::<FileCall>(value).is_err());}
        for value in [json!({"action":"open","root":"scratch","path":"../other/file"}),json!({"action":"open","root":"uploads","path":"C:/other"}),json!({"action":"read","file":"x","limit":65537}),json!({"action":"read","file":"x","limit":0})]{assert!(validate(&serde_json::from_value(value).unwrap()).is_err());}
        assert!(validate(&FileCall::Open{root:"scratch".into(),path:"agent/outbox/demo.mp4".into()}).is_ok());
    }
    #[test] fn app_files_declared_permission_is_not_a_grant(){
        assert!(declared(&json!({"capabilities":[]})).is_err());
        assert!(declared(&json!({"capabilities":["files.read"],"permissions":{"files.read":"deny"}})).is_err());
        assert!(declared(&json!({"capabilities":["files.read"],"permissions":{}})).is_ok());
    }
    #[test] fn app_files_read_paths_cannot_escape_or_reopen_links(){
        let dir=std::env::temp_dir().join(crate::util::uid("app-file-controls"));std::fs::create_dir(&dir).unwrap();
        let file=dir.join("demo.txt");std::fs::write(&file,b"synthetic approved file").unwrap();
        assert!(files::open_read(&file).is_ok());
        assert!(files::scoped_path(&dir,"../other").is_err());
        assert!(files::scoped_path(&dir,"/outside").is_err());
        assert!(files::open_read(&dir).is_err());
        std::fs::remove_file(file).unwrap();std::fs::remove_dir(dir).unwrap();
    }
    #[test] fn app_files_challenges_and_once_references_are_host_panel_and_revision_bound(){
        let hosts=bridge::Registry::default();let files=Registry::default();
        let bound=Bound{org:1,app:"app".into(),panel:"panel".into(),rev:1,gate:hosts.gate(1,"app").unwrap()};
        let challenge=files.ask("host",&bound,FileCall::Choose).unwrap();
        let mut other=bound.clone();other.panel="other".into();assert!(files.consume("host",&other,&challenge).is_err());
        other=bound.clone();other.rev=2;assert!(files.consume("host",&other,&challenge).is_err());
        assert!(files.consume("other-host",&bound,&challenge).is_err());
        assert!(files.consume("host",&bound,&challenge).is_ok());assert!(files.consume("host",&bound,&challenge).is_err());
        let reference=files.remember_once("host",&bound,PathBuf::from("synthetic.mp4"),None).unwrap();
        assert!(files.temporary("host",&bound,&reference.id).unwrap().is_some());
        assert!(files.temporary("other-host",&bound,&reference.id).unwrap().is_none());
        assert!(files.temporary("host",&other,&reference.id).unwrap().is_none());
        let ticket=files.media("host",&bound,&reference.id,Duration::from_secs(30)).unwrap();
        let lease=files.lease(1,&ticket).unwrap();assert!(files.lease(2,&ticket).is_err());
        files.forget(1,Some("app"),None,Some("other-host")).unwrap();assert!(!lease.cancel.is_cancelled());
        files.forget(1,Some("app"),None,Some("host")).unwrap();assert!(lease.cancel.is_cancelled());
        assert!(files.lease(1,&ticket).is_err());assert!(files.temporary("host",&bound,&reference.id).unwrap().is_none());
    }
}
