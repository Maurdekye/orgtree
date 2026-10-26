//! Native folder/computer grants and one-shot confirmed changes. The iframe
//! sees references and names only. Agents intersect grants with live scope.
use super::*;
use std::path::Path;

#[derive(Clone)]struct Grant{id:String,scope:String,mode:String,path:Option<PathBuf>}
struct Once{session:String,bound:Bound,grant:Grant}
struct Change{session:String,bound:Bound,caller:Option<Caller>,grant:String,path:PathBuf,io:files::io::Change,until:Instant}
struct Outcome{org:i64,agent:i64,value:Value,until:Instant}
#[derive(Default)]pub(super) struct Registry{
    once:Mutex<HashMap<String,Once>>,changes:Mutex<HashMap<String,Change>>,outcomes:Mutex<HashMap<String,Outcome>>,
}
impl Registry{
    #[nolog]pub(super) fn forget(&self,org:i64,app:Option<&str>,panel:Option<&str>,session:Option<&str>)->Result<()>{
        let matches=|b:&Bound,s:&str|b.org==org&&app.is_none_or(|v|v==b.app)&&panel.is_none_or(|v|v==b.panel)&&session.is_none_or(|v|v==s);
        self.once.lock().map_err(|_|anyhow::anyhow!("file grants unavailable"))?.retain(|_,r|!matches(&r.bound,&r.session));
        self.changes.lock().map_err(|_|anyhow::anyhow!("file changes unavailable"))?.retain(|_,r|!matches(&r.bound,&r.session)&&r.until>Instant::now());Ok(())
    }
}
#[nolog]pub(super) fn within(path:&Path,root:&Path)->bool{crate::domain::scope::path_within(&path.to_string_lossy(),&root.to_string_lossy())}
#[nolog]pub(super) fn extended(call:&FileCall)->bool{!matches!(call,FileCall::Choose{}|FileCall::Open{..}|FileCall::Read{..}|FileCall::Media{..})}
#[nolog]fn mode(call:&FileCall)->&str{match call{FileCall::Grant{mode,..}=>mode,FileCall::Write{..}|FileCall::Delete{..}=>"write",_=>"read"}}
#[nolog]pub(super) fn validate(call:&FileCall)->Result<()>{
    match call{
        FileCall::Roots{}=>{},
        FileCall::Grant{scope,mode}=>{if !["orgtree","folder","computer"].contains(&scope.as_str())||!["read","write"].contains(&mode.as_str()){crate::refuse!(BadRequest,"file scope must be orgtree, folder or computer; mode must be read or write");}},
        FileCall::List{directory,root,after,limit}=>{
            if directory.is_some()==root.is_some(){crate::refuse!(BadRequest,"list requires exactly one directory reference or Orgtree root");}
            if let Some(root)=root{if !["scratch","uploads","artifacts"].contains(&root.as_str()){crate::refuse!(BadRequest,"unknown Orgtree collection");}}
            if let Some(id)=directory{wire::text(id,120,"directory reference",false)?;}if let Some(after)=after{wire::text(after,4096,"file cursor",false)?;}
            if !(1..=200).contains(&limit.unwrap_or(100)){crate::refuse!(BadRequest,"file listing limit must be 1-200");}
        },
        FileCall::Child{directory,path}=>{wire::text(directory,120,"directory reference",false)?;wire::text(path,4096,"relative child name",false)?;files::scoped_path(&std::env::temp_dir(),path)?;},
        FileCall::Write{directory,name,base64,..}=>{
            wire::text(directory,120,"directory reference",false)?;wire::text(name,255,"file name",false)?;
            if Path::new(name).components().count()!=1||name.contains(['/', '\\', ':']){crate::refuse!(BadRequest,"write name must be one ordinary file name");}files::scoped_path(&std::env::temp_dir(),name)?;decode(base64)?;
        },
        FileCall::Delete{file}=>wire::text(file,120,"file reference",false)?,
        _=>crate::refuse!(BadRequest,"unknown scoped file action"),
    }Ok(())
}
#[nolog]fn decode(raw:&str)->Result<Vec<u8>>{
    use base64::Engine as _;
    if raw.len()>files::io::WRITE_MAX.div_ceil(3)*4{crate::refuse!(BadRequest,"file writes are limited to 65536 bytes");}
    let bytes=base64::engine::general_purpose::STANDARD.decode(raw).map_err(|_|crate::domain::UserError::BadRequest("file data must be standard base64".into()))?;
    if bytes.len()>files::io::WRITE_MAX{crate::refuse!(BadRequest,"file writes are limited to 65536 bytes");}Ok(bytes)
}
#[nolog]async fn covers(engine:&Engine,bound:&Bound,grant:&Grant,path:&Path)->Result<bool>{
    Ok(match grant.scope.as_str(){"computer"=>true,"folder"=>grant.path.as_ref().is_some_and(|root|within(path,root)),"file"=>grant.path.as_deref()==Some(path),"orgtree"=>{
        let org=engine.orgs.by_id(bound.org).ok_or_else(||crate::domain::UserError::NotFound("organization closed".into()))?;
        if path==engine.cfg.scratch_root(&org.slug)||path==engine.cfg.path("uploads").join(&org.slug){true}else{org_member(engine,bound,path).await?}
    },_=>false})
}
#[nolog]async fn grants(engine:&Engine,bound:&Bound,session:&str,mode:&str)->Result<Vec<Grant>>{
    let client=engine.db.get().await?;
    let rows=client.query("SELECT id,scope,mode,path FROM ot.custom_app_file_grants WHERE org_id=$1 AND app_id=$2 AND app_rev=$3 AND mode=$4 ORDER BY CASE scope WHEN 'file' THEN 0 WHEN 'folder' THEN 1 WHEN 'orgtree' THEN 2 ELSE 3 END,id LIMIT 130",&[&bound.org,&bound.app,&bound.rev,&mode]).await?;drop(client);
    let mut out:Vec<_>=rows.into_iter().map(|r|Grant{id:r.get(0),scope:r.get(1),mode:r.get(2),path:r.get::<_,Option<String>>(3).map(PathBuf::from)}).collect();
    out.extend(engine.custom_apps.file_access.scopes.once.lock().map_err(|_|anyhow::anyhow!("file grants unavailable"))?.values().filter(|r|r.session==session&&same(&r.bound,bound)&&r.grant.mode==mode).map(|r|r.grant.clone()));Ok(out)
}
#[nolog]async fn grant_for(engine:&Engine,bound:&Bound,session:&str,value:&Value,path:&Path,mode:&str)->Result<Grant>{
    declared_mode(value,mode)?;
    if org_member(engine,bound,path).await?{if let Some(id)=implicit_org_grant(engine,bound,value,mode).await?{return Ok(Grant{id,scope:"orgtree".into(),mode:mode.into(),path:None});}}
    for grant in grants(engine,bound,session,mode).await?{
        let once=grant.id.starts_with("once-");
        if (once||value["permissions"][format!("files.{mode}")]=="allow")&&covers(engine,bound,&grant,path).await?{return Ok(grant);}
    }
    crate::refuse!(Forbidden,"the user must grant this app the required file scope first");
}
#[nolog]async fn get_ref(engine:&Engine,bound:&Bound,session:&str,id:&str)->Result<Reference>{
    if let Some(reference)=engine.custom_apps.file_access.temporary(session,bound,id)?{return Ok(reference);}reference(engine,bound,id).await
}
#[nolog]async fn save_ref(engine:&Engine,bound:&Bound,session:&str,grant:&Grant,path:&Path)->Result<Reference>{
    if !grant.id.starts_with("once-"){return stored_reference(engine,bound,&grant.id,path).await;}
    let mut refs=engine.custom_apps.file_access.temporary.lock().map_err(|_|anyhow::anyhow!("file references unavailable"))?;
    if let Some(old)=refs.values().find(|r|r.session==session&&same(&r.bound,bound)&&r.reference.grant==grant.id&&r.reference.path==path){return Ok(old.reference.clone());}
    if refs.len()>=REGISTRY_MAX{crate::refuse!(Conflict,"too many temporary app files");}
    let reference=Reference{id:crate::util::uid("app-file"),grant:grant.id.clone(),path:path.into(),mode:grant.mode.clone()};
    refs.insert(reference.id.clone(),Temporary{session:session.into(),bound:bound.clone(),reference:reference.clone()});Ok(reference)
}
#[nolog]async fn info(reference:&Reference)->Result<Value>{
    let path=reference.path.clone();let name=path.file_name().map(|s|s.to_string_lossy().to_string()).unwrap_or_else(||"Disk".into());
    let directory=crate::trace::private_app_blocking(move||->Result<bool>{if files::open_read(&path).is_ok(){Ok(false)}else{files::directory(&path)?;Ok(true)}}).await??;
    Ok(json!({"id":reference.id,"name":name,"directory":directory}))
}
#[nolog]pub(super) async fn call(engine:&Arc<Engine>,org:&Arc<OrgHandle>,session:&str,request:&FileCall)->Result<Value>{
    super::validate(request)?;let bound=engine.custom_apps.bound(org.id,session)?;let _gate=bound.gate.lock.lock().await;
    engine.custom_apps.bound(org.id,session)?;let value=bridge::snapshot(engine,&bound).await?;declared_mode(&value,mode(request))?;bound.gate.admit()?;
    if let FileCall::Grant{scope,mode:requested_mode}=request{
        if scope=="orgtree"{if implicit_org_grant(engine,&bound,&value,requested_mode).await?.is_some(){return Ok(json!({"granted":true,"scope":"orgtree","mode":requested_mode,"implicit":true}));}}
        let challenge=engine.custom_apps.file_access.ask(session,&bound,request.clone())?;
        return Ok(json!({"permission_required":{"challenge":challenge,"app":bound.app,"panel":bound.panel,"name":value["name"],"label":value["label"],"capability":format!("files.{}",mode(request)),"request":request}}));
    }
    execute(engine,org,session,&bound,&value,request,None).await
}
#[nolog]pub(super) async fn decide(engine:&Arc<Engine>,org:&Arc<OrgHandle>,session:&str,bound:&Bound,value:&Value,request:&FileCall,choice:Choice,path:Option<&str>)->Result<Value>{
    let FileCall::Grant{scope,mode}=request else{crate::refuse!(BadRequest,"only a grant request can record file permission");};declared_mode(value,mode)?;
    if matches!(choice,Choice::Deny){
        super::super::storage::run_locked(engine,org,None,&json!({"action":"permission_set","app":bound.app,"expected_rev":bound.rev,"expected_permission_rev":value["permission_rev"],"capability":format!("files.{mode}"),"permission":"deny"})).await?;
        engine.custom_apps.file_access.forget(org.id,Some(&bound.app),None,None)?;crate::refuse!(Forbidden,"app file access denied");
    }
    let path=if scope=="folder"{
        let path=files::checked_path(Path::new(path.ok_or_else(||crate::domain::UserError::BadRequest("choose a folder before allowing access".into()))?))?;
        let check=path.clone();crate::trace::private_app_blocking(move||files::directory(&check)).await??;Some(path)
    }else{if path.is_some(){crate::refuse!(BadRequest,"this scope does not take a path");}None};
    let grant=if matches!(choice,Choice::Always){remember(engine,bound,scope,mode,path.as_deref(),value["permission_rev"].as_i64().unwrap_or(1)).await?}else{
        let grant=Grant{id:crate::util::uid("once-grant"),scope:scope.clone(),mode:mode.clone(),path};
        let mut once=engine.custom_apps.file_access.scopes.once.lock().map_err(|_|anyhow::anyhow!("file grants unavailable"))?;
        if once.len()>=REGISTRY_MAX{crate::refuse!(Conflict,"too many temporary file scopes");}once.insert(grant.id.clone(),Once{session:session.into(),bound:bound.clone(),grant:grant.clone()});grant
    };
    let roots=match scope.as_str(){
        "folder"=>vec![("Chosen folder".into(),grant.path.clone().expect("chosen folder"))],
        "orgtree"=>vec![("Scratch".into(),engine.cfg.scratch_root(&org.slug)),("Uploads".into(),engine.cfg.path("uploads").join(&org.slug))],
        _=>disks(),
    };
    let mut result=Vec::new();for (name,path) in roots{let reference=save_ref(engine,bound,session,&grant,&path).await?;result.push(json!({"id":reference.id,"name":name,"directory":true}));}
    Ok(json!({"scope":scope,"mode":mode,"roots":result}))
}
#[nolog]fn disks()->Vec<(String,PathBuf)>{
    #[cfg(windows)] {let mut out=Vec::new();for letter in b'A'..=b'Z'{let path=format!("{}:/",letter as char);if Path::new(&path).is_dir(){out.push((format!("Drive {}",letter as char),path.into()));}}out}
    #[cfg(not(windows))] {vec![("/".into(),PathBuf::from("/"))]}
}
#[nolog]async fn remember(engine:&Engine,bound:&Bound,scope:&str,mode:&str,path:Option<&Path>,expected:i64)->Result<Grant>{
    let raw=path.map(|p|p.to_string_lossy().to_string());let mut client=engine.db.get().await?;let tx=client.transaction().await?;
    let row=tx.query_one("SELECT rev,permission_rev,permissions FROM ot.custom_apps WHERE org_id=$1 AND id=$2 FOR UPDATE",&[&bound.org,&bound.app]).await?;
    if row.get::<_,i64>(0)!=bound.rev||row.get::<_,i64>(1)!=expected{crate::refuse!(Conflict,"app permissions changed; reopen its file request");}
    let old=tx.query_opt("SELECT id FROM ot.custom_app_file_grants WHERE org_id=$1 AND app_id=$2 AND app_rev=$3 AND scope=$4 AND mode=$5 AND path IS NOT DISTINCT FROM $6 LIMIT 1",&[&bound.org,&bound.app,&bound.rev,&scope,&mode,&raw]).await?;
    let id=if let Some(row)=old{row.get::<_,String>(0)}else{
        let count:i64=tx.query_one("SELECT count(*) FROM ot.custom_app_file_grants WHERE org_id=$1 AND app_id=$2 AND NOT implicit",&[&bound.org,&bound.app]).await?.get(0);if count>=128{crate::refuse!(Conflict,"an app can remember at most 128 file grants");}
        let id=crate::util::uid("app-grant");tx.execute("INSERT INTO ot.custom_app_file_grants(org_id,app_id,id,app_rev,scope,mode,path) VALUES($1,$2,$3,$4,$5,$6,$7)",&[&bound.org,&bound.app,&id,&bound.rev,&scope,&mode,&raw]).await?;id
    };
    let mut permissions:Value=row.get(2);permissions[format!("files.{mode}")]=json!("allow");
    tx.execute("UPDATE ot.custom_apps SET permissions=$3,permission_rev=permission_rev+1 WHERE org_id=$1 AND id=$2",&[&bound.org,&bound.app,&permissions]).await?;tx.commit().await?;drop(client);
    if let Some(org)=engine.orgs.by_id(bound.org){org.emit(json!({"type":"custom_apps_changed","org":org.slug}));}
    Ok(Grant{id,scope:scope.into(),mode:mode.into(),path:path.map(Path::to_path_buf)})
}

#[nolog]async fn execute(engine:&Arc<Engine>,org:&Arc<OrgHandle>,session:&str,bound:&Bound,value:&Value,request:&FileCall,caller:Option<&Caller>)->Result<Value>{
    match request{
        FileCall::Roots{}=>{
            implicit_org_grant(engine,bound,value,"read").await?;let read=grants(engine,bound,session,"read").await?;let mut items=Vec::new();let mut seen=std::collections::HashSet::new();
            for grant in read{
                if !grant.id.starts_with("once-")&&value["permissions"]["files.read"]!="allow"&&!(grant.scope=="orgtree"&&super::super::policy::org_allowed(value,"files.read")){continue;}
                let paths=if let Some(caller)=caller{
                    let p=crate::domain::docs::presenter(engine,org,caller.agent_id).await?;
                    let mut held:Vec<_>=std::iter::once(p.scratch).chain(p.dirs.into_iter().map(PathBuf::from)).collect();
                    if let Some(path)=&grant.path{held.push(path.clone());}held
                }else{match grant.scope.as_str(){"file"|"folder"=>grant.path.clone().into_iter().collect(),"orgtree"=>vec![engine.cfg.scratch_root(&org.slug),engine.cfg.path("uploads").join(&org.slug)],_=>disks().into_iter().map(|(_,p)|p).collect()}};
                for path in paths{
                    if !covers(engine,bound,&grant,&path).await?||!seen.insert(path.clone()){continue;}
                    if let Some(caller)=caller{if agent_mode(engine,org,caller,&path,false).await.is_err(){continue;}}
                    let reference=save_ref(engine,bound,session,&grant,&path).await?;let Ok(mut item)=info(&reference).await else{continue;};
                    if let Some(caller)=caller{agent_mode(engine,org,caller,&path,false).await?;}item["scope"]=json!(grant.scope);items.push(item);
                    if items.len()>=200{return Ok(json!({"items":items,"limited":true}));}
                }
            }Ok(json!({"items":items,"limited":false}))
        },
        FileCall::List{directory,root,after,limit}=>{
            if root.as_deref()==Some("artifacts"){return artifacts(engine,org,session,bound,value,after.as_deref(),limit.unwrap_or(100),caller).await;}
            let path=if let Some(root)=root{match root.as_str(){"scratch"=>engine.cfg.scratch_root(&org.slug),"uploads"=>engine.cfg.path("uploads").join(&org.slug),_=>crate::refuse!(BadRequest,"unknown file collection")}}else{get_ref(engine,bound,session,directory.as_deref().expect("validated directory")).await?.path};
            let grant=grant_for(engine,bound,session,value,&path,"read").await?;
            if let Some(caller)=caller{agent_mode(engine,org,caller,&path,false).await?;}
            let selected=path.clone();let cursor=after.clone();let size=limit.unwrap_or(100);let (entries,more,capped)=crate::trace::private_app_blocking(move||files::io::list(&selected,cursor.as_deref(),size)).await??;
            let next=if more{entries.last().map(|e|e.name.clone())}else{None};let mut items=Vec::new();
            for entry in entries{
                let child=path.join(&entry.name);if !covers(engine,bound,&grant,&child).await?{continue;}
                if let Some(caller)=caller{if agent_mode(engine,org,caller,&child,false).await.is_err(){continue;}}
                let reference=save_ref(engine,bound,session,&grant,&child).await?;items.push(json!({"id":reference.id,"name":entry.name,"directory":entry.directory}));
            }
            if let Some(caller)=caller{agent_mode(engine,org,caller,&path,false).await?;}
            Ok(json!({"items":items,"next_cursor":next,"scan_limited":capped}))
        },
        FileCall::Child{directory,path}=>{
            let parent=get_ref(engine,bound,session,directory).await?;let selected=files::scoped_path(&parent.path,path)?;
            let grant=grant_for(engine,bound,session,value,&selected,"read").await?;if let Some(caller)=caller{agent_mode(engine,org,caller,&selected,false).await?;}
            let reference=save_ref(engine,bound,session,&grant,&selected).await?;let result=info(&reference).await?;if let Some(caller)=caller{agent_mode(engine,org,caller,&selected,false).await?;}Ok(result)
        },
        FileCall::Write{directory,name,base64,replace}=>{
            let parent=get_ref(engine,bound,session,directory).await?;let selected=files::scoped_path(&parent.path,name)?;
            prepare(engine,org,session,bound,value,&selected,Some(decode(base64)?),*replace,caller).await
        },
        FileCall::Delete{file}=>{
            let reference=get_ref(engine,bound,session,file).await?;prepare(engine,org,session,bound,value,&reference.path,None,false,caller).await
        },
        _=>crate::refuse!(BadRequest,"unsupported scoped file request"),
    }
}
#[nolog]async fn artifacts(engine:&Arc<Engine>,org:&Arc<OrgHandle>,session:&str,bound:&Bound,value:&Value,after:Option<&str>,limit:usize,caller:Option<&Caller>)->Result<Value>{
    let client=engine.db.get().await?;let rows=client.query("SELECT uid,path FROM ot.deliveries WHERE org_id=$1 AND ($2::text IS NULL OR uid>$2) ORDER BY uid LIMIT $3",&[&org.id,&after,&(limit as i64+1)]).await?;drop(client);
    let more=rows.len()>limit;let mut items=Vec::new();let mut cursor=None;
    for row in rows.into_iter().take(limit){let uid:String=row.get(0);cursor=Some(uid.clone());let path=PathBuf::from(row.get::<_,String>(1));
        if let Some(caller)=caller{if agent_mode(engine,org,caller,&path,false).await.is_err(){continue;}}
        let grant=grant_for(engine,bound,session,value,&path,"read").await?;let reference=save_ref(engine,bound,session,&grant,&path).await?;
        items.push(json!({"id":reference.id,"name":path.file_name().map(|n|n.to_string_lossy()),"delivery":uid,"directory":false}));
    }Ok(json!({"items":items,"next_cursor":if more{cursor}else{None},"scan_limited":false}))
}
#[nolog]async fn prepare(engine:&Arc<Engine>,org:&Arc<OrgHandle>,session:&str,bound:&Bound,value:&Value,path:&Path,data:Option<Vec<u8>>,replace:bool,caller:Option<&Caller>)->Result<Value>{
    let grant=grant_for(engine,bound,session,value,path,"write").await?;if let Some(caller)=caller{agent_mode(engine,org,caller,path,true).await?;}
    let selected=path.to_path_buf();let io=crate::trace::private_app_blocking(move||files::io::prepare(&selected,data,replace)).await??;
    // Only this org's classified collections bypass confirmation. A folder or
    // computer grant covering an outside target never enters this branch.
    if super::super::policy::org_allowed(value,"files.write")&&org_member(engine,bound,path).await?{
        return confirm(engine,org,Change{session:session.into(),bound:bound.clone(),caller:caller.cloned(),grant:grant.id,path:path.into(),io,until:Instant::now()+Duration::from_secs(120)},true).await;
    }
    let challenge=bridge::secret();let detail=io.detail.clone();let until=Instant::now()+Duration::from_secs(120);
    let mut changes=engine.custom_apps.file_access.scopes.changes.lock().map_err(|_|anyhow::anyhow!("file changes unavailable"))?;changes.retain(|_,r|r.until>Instant::now());
    if changes.len()>=64||changes.values().any(|r|same(&r.bound,bound)){crate::refuse!(Conflict,"answer the pending file change first");}
    changes.insert(challenge.clone(),Change{session:session.into(),bound:bound.clone(),caller:caller.cloned(),grant:grant.id,path:path.into(),io,until});drop(changes);
    // Drop target pins at the actual deadline, including when nobody makes a
    // later request that would otherwise prune the registry lazily.
    let weak=Arc::downgrade(engine);let expiry=challenge.clone();
    tokio::spawn(async move{tokio::time::sleep_until(until.into()).await;if let Some(engine)=weak.upgrade(){if let Ok(mut changes)=engine.custom_apps.file_access.scopes.changes.lock(){if changes.get(&expiry).is_some_and(|c|c.until<=Instant::now()){changes.remove(&expiry);}}}});
    org.emit(json!({"type":"custom_apps_changed","org":org.slug}));
    if caller.is_some(){Ok(json!({"pending_confirmation":challenge,"expires_in_seconds":120,"instruction":"Ask the user to open App settings → Permissions → Files → Pending changes. Agents cannot confirm changes."}))}
    else{Ok(json!({"confirmation_required":{"challenge":challenge,"app":bound.app,"panel":bound.panel,"name":value["name"],"label":value["label"],"capability":"files.write","request":{"action":if detail["operation"]=="delete"{"delete"}else{"write"}},"detail":detail}}))}
}

#[derive(Deserialize)]#[serde(tag="action",rename_all="snake_case",deny_unknown_fields)]enum Native{
    Confirm{app:String,challenge:String,allow:bool,session:Option<String>},
    Confirmations{app:String},
}
#[nolog]pub(super) async fn native(engine:&Arc<Engine>,org:&Arc<OrgHandle>,input:&Value)->Option<Result<Value>>{
    if !matches!(input["action"].as_str(),Some("confirm"|"confirmations")){return None;}
    Some(native_inner(engine,org,input).await)
}
#[nolog]async fn native_inner(engine:&Arc<Engine>,org:&Arc<OrgHandle>,input:&Value)->Result<Value>{
    let request:Native=serde_json::from_value(input.clone()).map_err(|_|crate::domain::UserError::BadRequest("invalid native file confirmation".into()))?;
    match request{
        Native::Confirmations{app}=>{
            let mut changes=engine.custom_apps.file_access.scopes.changes.lock().map_err(|_|anyhow::anyhow!("file changes unavailable"))?;changes.retain(|_,r|r.until>Instant::now());
            Ok(json!({"items":changes.iter().filter(|(_,r)|r.bound.org==org.id&&r.bound.app==app).map(|(id,r)|json!({"challenge":id,"app":app,"panel":r.bound.panel,"agent":r.caller.as_ref().map(|c|&c.name),"detail":r.io.detail})).collect::<Vec<_>>()}))
        },
        Native::Confirm{app,challenge,allow,session}=>{
            let gate=engine.custom_apps.gate(org.id,&app)?;let _guard=gate.lock.lock().await;
            let change={let mut changes=engine.custom_apps.file_access.scopes.changes.lock().map_err(|_|anyhow::anyhow!("file changes unavailable"))?;
                let Some(change)=changes.get(&challenge).filter(|c|c.bound.org==org.id&&c.bound.app==app&&c.until>Instant::now())else{crate::refuse!(Forbidden,"file confirmation expired or does not match");};
                if change.caller.is_none()&&session.as_deref()!=Some(&change.session){crate::refuse!(Forbidden,"confirmation belongs to a different panel host");}
                changes.remove(&challenge).expect("checked file confirmation")
            };
            let caller=change.caller.clone();let result=confirm(engine,org,change,allow).await;
            if let Some(caller)=caller{
                let value=match &result{Ok(value)=>value.clone(),Err(_)=>json!({"changed":false,"error":"file change refused or failed; no success was recorded"})};
                let mut outcomes=engine.custom_apps.file_access.scopes.outcomes.lock().map_err(|_|anyhow::anyhow!("file outcomes unavailable"))?;outcomes.retain(|_,r|r.until>Instant::now());if outcomes.len()<64{outcomes.insert(challenge,Outcome{org:org.id,agent:caller.agent_id,value,until:Instant::now()+Duration::from_secs(120)});}
            }result
        },
    }
}
#[nolog]async fn snapshot(engine:&Engine,bound:&Bound)->Result<Value>{
    let client=engine.db.get().await?;
    let row=client.query_opt("SELECT jsonb_build_object('name',a.name,'origin',a.origin,'label',p.label,'capabilities',a.capabilities,'permissions',a.permissions) FROM ot.custom_apps a JOIN ot.custom_panels p ON p.org_id=a.org_id AND p.app_id=a.id WHERE a.org_id=$1 AND a.id=$2 AND a.rev=$3 AND p.id=$4",&[&bound.org,&bound.app,&bound.rev,&bound.panel]).await?;
    let Some(row)=row else{crate::refuse!(Forbidden,"app or panel changed");};Ok(row.get(0))
}
#[nolog]async fn confirm(engine:&Arc<Engine>,org:&Arc<OrgHandle>,change:Change,allow:bool)->Result<Value>{
    if !allow{return Ok(json!({"changed":false,"cancelled":true}));}
    if change.caller.is_none(){engine.custom_apps.bound(org.id,&change.session)?;bridge::snapshot(engine,&change.bound).await?;}
    let value=snapshot(engine,&change.bound).await?;let grant=grant_for(engine,&change.bound,&change.session,&value,&change.path,"write").await?;
    if grant.id!=change.grant{crate::refuse!(Conflict,"file grant changed; request the change again");}
    if let Some(caller)=&change.caller{agent_mode(engine,org,caller,&change.path,true).await?;}
    crate::trace::private_app_blocking(move||files::io::commit(change.io)).await?
}
#[nolog]async fn agent_mode(engine:&Arc<Engine>,org:&Arc<OrgHandle>,caller:&Caller,path:&Path,write:bool)->Result<()>{
    if !write{
        super::super::storage::file_authority(engine,org,caller).await?;
        let p=crate::domain::docs::presenter(engine,org,caller.agent_id).await?;
        if std::iter::once(p.scratch).chain(p.dirs.into_iter().map(PathBuf::from)).any(|root|within(path,&root)){return Ok(());}crate::refuse!(Forbidden,"app permission does not extend the calling agent's folders");
    }
    super::super::storage::file_authority(engine,org,caller).await?;
    let p=crate::domain::docs::presenter(engine,org,caller.agent_id).await?;let client=engine.db.get().await?;
    let settings:Value=client.query_one("SELECT settings FROM ot.orgs WHERE id=$1",&[&org.id]).await?.get(0);
    let settings=crate::feed::groups::effective_settings(&settings,&engine.settings.defaults());
    let chain=crate::domain::projects::scope_ancestor_rows(&**client,caller.agent_id,org.id).await?;drop(client);
    if chain.first().is_none_or(|r|r.get::<_,Option<i64>>(1).is_some()){crate::refuse!(Forbidden,"agent scope ancestry is incomplete");}
    let mut effective=crate::domain::scope::org_ceiling(&settings["dirs"]);for row in chain{if row.get::<_,&str>(3)!="project"{effective=crate::domain::scope::clamp(&row.get::<_,Value>(0),&effective);}}
    if effective["tools"]["edit"]==false||effective["permission_mode"]=="plan"{crate::refuse!(Forbidden,"the calling agent cannot edit files");}
    effective=crate::domain::scope::with_org_notes(&effective,&engine.cfg.org_notes_dir(&org.slug).to_string_lossy());
    effective=crate::domain::scope::with_team_workspaces(&effective,&crate::domain::teams::held(engine,&org.slug,caller.agent_id).await?);
    effective=crate::domain::scope::with_team_workspaces(&effective,&crate::domain::teams::projects_below(engine,&org.slug,caller.agent_id).await?);
    // The org instruction workspace is readable context in Presenter; it is
    // not an implicit writable folder. Only scratch and actual RW grants count.
    if within(path,&p.scratch)||effective["add_dirs"].as_array().into_iter().flatten().any(|r|r["mode"]=="rw"&&r["path"].as_str().is_some_and(|root|within(path,Path::new(root)))){return Ok(());}
    crate::refuse!(Forbidden,"the calling agent needs its own writable folder scope");
}
#[nolog]pub(super) async fn agent(engine:&Arc<Engine>,org:&Arc<OrgHandle>,caller:&Caller,input:&Value)->Result<Value>{
    let action=input["action"].as_str().unwrap_or("");
    if action=="file_result"{
        if !input.as_object().is_some_and(|v|v.keys().all(|k|["action","confirmation"].contains(&k.as_str()))){crate::refuse!(BadRequest,"unexpected file result fields");}
        let id=input["confirmation"].as_str().unwrap_or("");let mut results=engine.custom_apps.file_access.scopes.outcomes.lock().map_err(|_|anyhow::anyhow!("file outcomes unavailable"))?;results.retain(|_,r|r.until>Instant::now());
        if results.get(id).is_some_and(|r|r.org==org.id&&r.agent==caller.agent_id){return Ok(results.remove(id).expect("checked outcome").value);}
        let changes=engine.custom_apps.file_access.scopes.changes.lock().map_err(|_|anyhow::anyhow!("file changes unavailable"))?;
        if changes.get(id).is_some_and(|r|r.bound.org==org.id&&r.caller.as_ref().is_some_and(|c|c.agent_id==caller.agent_id)&&r.until>Instant::now()){return Ok(json!({"pending_confirmation":id}));}crate::refuse!(NotFound,"file confirmation is unavailable or expired");
    }
    let mut args=input.clone();let object=args.as_object_mut().ok_or_else(||crate::domain::UserError::BadRequest("file request must be an object".into()))?;
    let panel=object.remove("panel").and_then(|v|v.as_str().map(str::to_owned)).unwrap_or_default();
    object.insert("action".into(),json!(action.strip_prefix("file_").unwrap_or("")));
    let request:FileCall=serde_json::from_value(args).map_err(|_|crate::domain::UserError::BadRequest("invalid scoped file arguments".into()))?;super::validate(&request)?;
    let client=engine.db.get().await?;let row=client.query_opt("SELECT p.app_id,a.rev FROM ot.custom_panels p JOIN ot.custom_apps a ON a.org_id=p.org_id AND a.id=p.app_id WHERE p.org_id=$1 AND p.id=$2",&[&org.id,&panel]).await?;
    let Some(row)=row else{crate::refuse!(NotFound,"panel not found");};let app:String=row.get(0);let rev:i64=row.get(1);drop(client);
    let gate=engine.custom_apps.gate(org.id,&app)?;let bound=Bound{org:org.id,app,panel,rev,gate:gate.clone()};let _guard=gate.lock.lock().await;
    let value=snapshot(engine,&bound).await?;declared_mode(&value,mode(&request))?;bound.gate.admit()?;
    execute(engine,org,"",&bound,&value,&request,Some(caller)).await
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn app_files_scoped_calls_reject_paths_identity_and_unbounded_data(){
        assert!(validate(&FileCall::Grant{scope:"computer".into(),mode:"write".into()}).is_ok());
        assert!(validate(&FileCall::Grant{scope:"computer".into(),mode:"admin".into()}).is_err());
        assert!(validate(&FileCall::Child{directory:"x".into(),path:"../outside".into()}).is_err());
        assert!(validate(&FileCall::List{directory:Some("x".into()),root:Some("scratch".into()),after:None,limit:None}).is_err());
        assert!(validate(&FileCall::Write{directory:"x".into(),name:"nested/file".into(),base64:"".into(),replace:false}).is_err());
        assert!(decode(&"A".repeat(90000)).is_err());assert_eq!(decode("bmV3").unwrap(),b"new");
        for value in [json!({"action":"grant","scope":"computer","mode":"read","permission":"allow"}),json!({"action":"write","directory":"x","name":"x","base64":"","as_user":true})]{assert!(serde_json::from_value::<FileCall>(value).is_err());}
    }
}
