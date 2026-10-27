//! Template app definitions are private, inert and never include execution grants.
use anyhow::Result;
use serde::{Deserialize,Deserializer};
use serde_json::{json,Value};
use crate::{engine::Engine,domain::apps::wire::{self,Definition}};

#[derive(Clone)]
pub struct App(pub Definition);
impl std::fmt::Debug for App {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result{f.write_str("[private app definition omitted]")}
}
impl<'de> Deserialize<'de> for App {
    #[nolog]
    fn deserialize<D:Deserializer<'de>>(d:D)->std::result::Result<Self,D::Error>{
        let raw=Value::deserialize(d)?;
        let def:Definition=serde_json::from_value(raw).map_err(|_|serde::de::Error::custom("invalid app definition in template"))?;
        wire::definition(&def).map_err(|_|serde::de::Error::custom("invalid app definition in template"))?;Ok(App(def))
    }
}

/// Only definitions/initial JSON travel. Saved panels, runtime IDs, links,
/// permissions and sessions are intentionally not queried. Provisional default.
#[nolog]
pub async fn capture(engine:&Engine,org:i64,root:&mut Value)->Result<()> {
    let client=engine.db.get().await?;let mut after=String::new();let mut apps=Vec::new();
    let mut size=serde_json::to_vec(root)?.len();
    loop {
        let row=client.query_opt("SELECT id,jsonb_build_object('name',name,'description',description,'html',html,'initial_state',initial_state,'capabilities',capabilities,'events',declared_events,'sites',declared_sites,'width',width,'height',height) FROM ot.custom_apps WHERE org_id=$1 AND id>$2 ORDER BY id LIMIT 1",&[&org,&after]).await?;
        let Some(row)=row else{break;};after=row.get(0);let mut value:Value=row.get(1);
        if let Some(caps)=value.get_mut("capabilities"){wire::drop_retired(caps);}
        // Declared internet sites travel (never their grants); none, no key, so
        // an older Orgtree still reads the template.
        if value["sites"].as_array().is_some_and(|s|s.is_empty()){if let Some(map)=value.as_object_mut(){map.remove("sites");}}
        let _:App=serde_json::from_value(value.clone())?;size+=serde_json::to_vec(&value)?.len()+1;
        if size>crate::domain::templates::FILE_MAX as usize{crate::refuse!(BadRequest,"template definitions exceed the16MiB template bound");}apps.push(value);
    }
    if !apps.is_empty(){root["apps"]=json!(apps);}Ok(())
}

/// New-org creation is user-authorized and already transactional. Restore
/// fresh definitions with Ask/default grants, no copies and no code execution.
#[nolog]
pub async fn restore(tx:&tokio_postgres::Transaction<'_>,org:i64,apps:&[App])->Result<usize> {
    for app in apps {
        let def=&app.0;wire::definition(def)?;let caps=json!(wire::current_capabilities(&def.capabilities));let declarations=json!(def.events);let sites=json!(def.sites);
        // the database makes the id from the name (migration 0075)
        tx.execute("INSERT INTO ot.custom_apps(org_id,name,description,html,initial_state,capabilities,width,height,created_by,declared_events,origin,declared_sites) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'template',$9,'template',$10)",&[&org,&def.name,&def.description,&def.html,&def.initial_state,&caps,&def.width,&def.height,&declarations,&sites]).await?;
    }Ok(apps.len())
}
