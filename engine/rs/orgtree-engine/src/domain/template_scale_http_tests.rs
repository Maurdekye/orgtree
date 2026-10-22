//! Deliberately narrow offline measurement fixture. Production list/resolve/save
//! handlers plus the canonical node transaction; effects are never applied.
use super::*;
use std::sync::Arc;
use axum::{extract::{Path,State},Json};
use crate::http::error::{ApiError,ApiResult};
use crate::engine::Engine;

#[nolog]
async fn seed(State(e):State<Arc<Engine>>,Json(b):Json<Value>)->ApiResult<Json<Value>> {
    let n=b["nodes"].as_i64().unwrap();let depth=b["depth"].as_i64().unwrap();
    let uuid=uuid::Uuid::new_v4();let slug=format!("source-{n}-{depth}-{uuid}");
    let c=e.db.get().await?;
    let id:i64=c.query_one("INSERT INTO ot.orgs(uuid,slug,name,settings) VALUES($1,$2,$2,'{\"max_top_grant\":0}') RETURNING id",&[&uuid,&slug]).await?.get(0);
    c.execute("WITH ids AS MATERIALIZED (SELECT g,nextval(pg_get_serial_sequence('ot.agents','id')) AS id FROM generate_series(1,$2::bigint) g), nodes AS (SELECT g,id,CASE WHEN (g-1)%$3=0 THEN NULL ELSE lag(id) OVER(ORDER BY g) END AS parent FROM ids) INSERT INTO ot.agents(id,org_id,name,parent_id,tier,kind,state,born,charter,scope) OVERRIDING SYSTEM VALUE SELECT id,$1,'node-'||g,parent,CASE WHEN (g-1)%$3=0 OR g%$3=0 OR g=$2 THEN 'sol' ELSE 'project' END,CASE WHEN (g-1)%$3=0 OR g%$3=0 OR g=$2 THEN 'agent' ELSE 'project' END,'live','synthetic','Synthetic template role',CASE WHEN (g-1)%$3=0 THEN '{\"tools\":{\"bash\":false},\"org_visibility\":\"self\",\"permission_mode\":\"plan\",\"fast_mode\":false}'::jsonb ELSE '{\"tools\":{\"bash\":true},\"fast_mode\":false}'::jsonb END FROM nodes ORDER BY g",&[&id,&n,&depth]).await?;
    e.orgs.insert(crate::orgs::provisional(id,uuid.to_string(),slug.clone(),slug.clone()));
    if b["near_cap"]==true {
        let raw=c.query("SELECT id,parent_id,name,tier,account,seat::float8,grant_credits::float8,charter,team_charter,scope,extra FROM ot.agents WHERE org_id=$1 ORDER BY id",&[&id]).await?;
        let rows:Vec<Row>=raw.iter().map(|r|Row{id:r.get(0),parent:r.get(1),name:r.get(2),tier:r.get(3),account:r.get(4),seat:r.get(5),grant:r.get(6),charter:r.get(7),team_charter:r.get(8),scope:r.get(9),extra:r.get(10)}).collect();
        let size=from_rows("x","X",None,&rows,None,None,&json!({"max_top_grant":0}),&Include::default()).unwrap().body().unwrap().len();
        std::fs::create_dir_all(e.cfg.workspace_dir(&slug)).unwrap();
        std::fs::write(e.cfg.workspace_dir(&slug).join("org.md"),"x".repeat(FILE_MAX as usize-size-1024)).unwrap();
    }
    Ok(Json(json!({"slug":slug,"nodes":n,"depth":depth})))
}

/// Same canonical per-node requests and one transaction as orgops::create.
/// Network identity, warm/kickoff and all post-commit Effects are intentionally
/// omitted by this fixture, as required by the measurement assignment.
#[nolog]
async fn create(State(e):State<Arc<Engine>>,Json(b):Json<Value>)->ApiResult<Json<Value>> {
    let pick:crate::http::templates::Pick=serde_json::from_value(b["template"].clone()).map_err(|x|ApiError::bad_request(x.to_string()))?;
    let name=b["name"].as_str().unwrap();let slug=crate::util::slugify(name,200);
    let (template,planned,blocked)=crate::http::templates::plan_pick(&e,&pick,&slug,&[])?;
    if !blocked.is_empty(){return Err(ApiError::unprocessable(blocked.join(",")));}
    if let Some(expect)=pick.expect {
        if planned.len()!=expect.len() || planned.iter().any(|p|expect.get(&p.slot.name).map(String::as_str)!=p.tier.as_deref()){return Err(ApiError::conflict("preview moved"));}
    }
    let clock=std::time::Instant::now();let mut c=e.db.get().await?;let tx=c.transaction().await?;
    let uuid=uuid::Uuid::new_v4();let settings=template.settings.as_ref().map(|s|crate::http::settings::template_settings(&e,s)).transpose().map_err(ApiError::unprocessable)?.unwrap_or_default();
    let id:i64=tx.query_one("INSERT INTO ot.orgs(uuid,slug,name,settings) VALUES($1,$2,$3,$4) RETURNING id",&[&uuid,&slug,&name,&json!(settings)]).await?.get(0);
    let org=crate::orgs::provisional(id,uuid.to_string(),slug.clone(),name.into());let mut effects=crate::domain::ops::Effects::default();let mut hired=Vec::new();let mut projects=Vec::new();
    for p in &planned {
        for (index,req) in creation_requests(p,false).iter().enumerate(){
            let result=crate::domain::ops::run_in_tx(&e,&org,&tx,&crate::domain::ops::Actor::User,req,&mut effects).await.map_err(ApiError::from)?;
            if index==0 { if p.slot.project(){projects.push(result["node"].clone());}else{hired.push(result["node"].clone());} }
        }
    }
    let links=crate::domain::template_links::plan(&template,&planned);
    assert!(links.dogs.is_empty()&&links.audiences.is_empty(),"timing input contains no external effects");
    tx.commit().await?;let create_seconds=clock.elapsed().as_secs_f64();
    e.orgs.insert(org);
    if let Some(md)=template.org_md {std::fs::create_dir_all(e.cfg.workspace_dir(&slug)).unwrap();std::fs::write(e.cfg.workspace_dir(&slug).join("org.md"),md).unwrap();}
    Ok(Json(json!({"slug":slug,"hired":hired,"projects":projects,"measurement":{"create_seconds":create_seconds,"effects_applied":false}})))
}

#[nolog]
async fn result(State(e):State<Arc<Engine>>,Path(slug):Path<String>)->ApiResult<Json<Value>> {
    let org=crate::http::orgs::org(&e,&slug)?;
    let rows=e.db.get().await?.query("SELECT a.name,p.name,a.tier,a.scope FROM ot.agents a LEFT JOIN ot.agents p ON a.parent_id=p.id WHERE a.org_id=$1 AND a.state='live' ORDER BY a.id",&[&org.id]).await?;
    Ok(Json(json!(rows.iter().map(|r|json!({"name":r.get::<_,String>(0),"parent":r.get::<_,Option<String>>(1),"tier":r.get::<_,String>(2),"scope":r.get::<_,Value>(3)})).collect::<Vec<_>>())))
}

#[tokio::test(flavor="multi_thread",worker_threads=2)]
#[ignore="explicit disposable PostgreSQL and a prebuilt desktop measurement driver"]
#[nolog]
async fn engine_and_desktop_depth_measurement() {
    let fixture=super::super::native_fixture::Fixture::from_env().await;
    let mut c=fixture.cfg.connect(tokio_postgres::NoTls).await.unwrap();
    let connection=tokio::spawn(async move{c.1.await});crate::migrate::run(&mut c.0,&|_|{}).await.unwrap();drop(c.0);
    let mut engine=Engine::for_tests(fixture.engine_root("template-http-engine"));
    let manager=deadpool_postgres::Manager::from_config(fixture.cfg.clone(),tokio_postgres::NoTls,deadpool_postgres::ManagerConfig{recycling_method:deadpool_postgres::RecyclingMethod::Fast});
    Arc::get_mut(&mut engine).unwrap().db=deadpool_postgres::Pool::builder(manager).max_size(4).runtime(deadpool_postgres::Runtime::Tokio1).build().unwrap();
    let mut st=crate::providers::State::default();st.codex.connected=true;st.codex.installed=true;st.probed=true;
    engine.providers.state.store(Arc::new(st));
    let app=axum::Router::new().route("/fixture/seed",axum::routing::post(seed)).route("/fixture/result/{slug}",axum::routing::get(result))
        .route("/api/templates",axum::routing::get(crate::http::templates::list))
        .route("/api/templates/resolve",axum::routing::post(crate::http::templates::resolve))
        .route("/api/orgs/{slug}/template",axum::routing::post(crate::http::templates::save))
        .route("/api/orgs",axum::routing::post(create)).with_state(engine.clone());
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let address=listener.local_addr().unwrap();
    let cancel=tokio_util::sync::CancellationToken::new();let stop=cancel.clone();
    let server=tokio::spawn(async move{axum::serve(listener,app).with_graceful_shutdown(stop.cancelled_owned()).await.unwrap()});
    // Keep the normal local path spelling: PowerShell treats a canonical
    // Windows \\?\ prefix as a remote script path under its signature policy.
    let repo=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(3).unwrap().to_path_buf();
    let output=fixture.engine_root("template-desktop-measurement");let args=output.join("driver.args");
    let driver=std::env::var("ORGTREE_TEMPLATE_SCALE_DRIVER").expect("explicit prebuilt own driver");
    assert!(std::path::Path::new(&driver).canonicalize().unwrap().starts_with(std::path::Path::new("C:/orgtree-build/template-dogs-sol").canonicalize().unwrap()));
    std::fs::write(&args,format!("{driver}\r\nhttp://{address}\r\n{}\r\n",output.display())).unwrap();
    let command=tokio::task::spawn_blocking(move||std::process::Command::new("powershell.exe").args(["-NoProfile","-File"]).arg(repo.join("apps/desktop/renderer/tests/joblimit.ps1")).args(["-LimitMB","3072","-TimeoutSec","600","-WorkDir"]).arg(&repo).args(["-Exe","node.exe","-ArgFile"]).arg(args).status().unwrap()).await.unwrap();
    cancel.cancel();server.await.unwrap();drop(engine);connection.await.unwrap().unwrap();
    assert!(command.success(),"desktop depth driver failed");
}
