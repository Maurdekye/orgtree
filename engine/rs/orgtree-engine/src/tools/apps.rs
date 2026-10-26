use std::sync::Arc;
use anyhow::Result;
use serde_json::Value;
use crate::{engine::Engine,runtime::Caller};
use super::Done;
#[nolog]
pub async fn run(engine:&Arc<Engine>,caller:&Caller,args:&Value)->Result<Done>{
    crate::trace::private_app(run_private(engine,caller,args)).await
}
#[nolog]
async fn run_private(engine:&Arc<Engine>,caller:&Caller,args:&Value)->Result<Done>{
    let org=engine.orgs.by_id(caller.org_id).ok_or_else(||crate::domain::UserError::NotFound("organization not open".into()))?;
    if args["action"].as_str().is_some_and(|action|action.starts_with("file_")){
        return Done::json(&crate::domain::apps::file_access::agent(engine,&org,caller,args).await?);
    }
    let mut input=args.clone();
    if input["action"]=="app_import"&&input.get("path").is_some(){
        if !input.as_object().is_some_and(|o|o.keys().all(|k|["action","path"].contains(&k.as_str()))){crate::refuse!(BadRequest,"app_import takes bundle OR path, without additional fields");}
        let raw=input["path"].as_str().filter(|s|!s.is_empty()).ok_or_else(||crate::domain::UserError::BadRequest("app_import path must be a nonempty string".into()))?.to_owned();
        crate::domain::apps::storage::file_authority(engine,&org,caller).await?;
        let p=crate::domain::docs::presenter(engine,&org,caller.agent_id).await?;
        let bundle=tokio::task::spawn_blocking(move||crate::domain::apps::files::read(&p,&raw)).await??;
        input=serde_json::json!({"action":"app_import","bundle":bundle});
    }
    let export=input["action"]=="app_export";
    let as_file=match input.get("as_file"){Some(Value::Bool(v))if export=>*v,None=>export,_=>crate::refuse!(BadRequest,"as_file is a boolean for app_export only")};
    input.as_object_mut().ok_or_else(||crate::domain::UserError::BadRequest("Apps arguments must be an object".into()))?.remove("as_file");
    let out=crate::domain::apps::run(engine,&org,Some(caller),&input).await?;
    if as_file{
        crate::domain::apps::storage::file_authority(engine,&org,caller).await?;
        let p=crate::domain::docs::presenter(engine,&org,caller.agent_id).await?;let bundle=out["bundle"].clone();
        let mut file=tokio::task::spawn_blocking(move||crate::domain::apps::files::write(&p.scratch,&bundle)).await??;
        file["panels"]=out["panels"].clone();Done::json(&file)
    }else{Done::json(&out)}
}
