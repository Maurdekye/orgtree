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
    if std::env::var("ORGTREE_TEMPLATE_AUDIENCE_BATCH_MEASUREMENT").as_deref()==Ok("1") {
        audience_batch_red_control(&e,&planned).await;
    }
    let clock=std::time::Instant::now();let mut c=e.db.get().await?;let tx=c.transaction().await?;
    let uuid=uuid::Uuid::new_v4();let settings=template.settings.as_ref().map(|s|crate::http::settings::template_settings(&e,s)).transpose().map_err(ApiError::unprocessable)?.unwrap_or_default();
    let id:i64=tx.query_one("INSERT INTO ot.orgs(uuid,slug,name,settings) VALUES($1,$2,$3,$4) RETURNING id",&[&uuid,&slug,&name,&json!(settings)]).await?.get(0);
    let org=crate::orgs::provisional(id,uuid.to_string(),slug.clone(),name.into());let mut effects=crate::domain::ops::Effects::default();
    let operations=planned.iter().map(|p|creation_requests(p,false).len()).sum::<usize>();
    let (hired,projects)=create_nodes(&e,&org,&tx,&planned,false,&mut effects).await?;
    let links=crate::domain::template_links::plan(&template,&planned);
    assert!(links.dogs.is_empty()&&links.audiences.is_empty(),"timing input contains no external effects");
    tx.commit().await?;let create_seconds=clock.elapsed().as_secs_f64();
    e.orgs.insert(org);
    if let Some(md)=template.org_md {std::fs::create_dir_all(e.cfg.workspace_dir(&slug)).unwrap();std::fs::write(e.cfg.workspace_dir(&slug).join("org.md"),md).unwrap();}
    Ok(Json(json!({"slug":slug,"hired":hired,"projects":projects,"measurement":{"create_seconds":create_seconds,"operations":operations,"seconds_per_op":create_seconds/operations as f64,"effects_applied":false}})))
}

/// The exact former production loop, bounded to 30 seconds and rolled back.
/// This is an expected timing refusal, never a completed-create result.
#[nolog]
async fn audience_batch_red_control(e:&Arc<Engine>,planned:&[Planned]) {
    let total:usize=planned.iter().map(|p|creation_requests(p,false).len()).sum();assert_eq!(total,1900);
    let mut c=e.db.get().await.unwrap();let tx=c.transaction().await.unwrap();
    let uuid=uuid::Uuid::new_v4();let slug=format!("audience-red-{uuid}");
    let id:i64=tx.query_one("INSERT INTO ot.orgs(uuid,slug,name,settings) VALUES($1,$2,$2,'{\"max_top_grant\":0}') RETURNING id",&[&uuid,&slug]).await.unwrap().get(0);
    let org=crate::orgs::provisional(id,uuid.to_string(),slug.clone(),slug);
    let mut fx=crate::domain::ops::Effects::default();let mut completed=0usize;let clock=std::time::Instant::now();
    let outcome=tokio::time::timeout(std::time::Duration::from_secs(30),async {
        for p in planned {for req in creation_requests(p,false) {
            crate::domain::ops::run_in_tx(e,&org,&tx,&crate::domain::ops::Actor::User,&req,&mut fx).await.unwrap();completed+=1;
        }}
    }).await;
    let receipt=json!({"path":"former per-operation snapshots","budget_seconds":30,"seconds":clock.elapsed().as_secs_f64(),"completed_ops":completed,"total_ops":total,"timed_out":outcome.is_err(),"completed_create":false,"effects_applied":false});
    tx.rollback().await.unwrap();
    std::fs::write(std::path::Path::new(&std::env::var("ORGTREE_CLAIM_TEST_OUTPUT").unwrap()).join("audience-batch-red.json"),serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    eprintln!("AUDIENCE_BATCH_RED {receipt}");
    assert!(outcome.is_err(),"old path no longer exceeds the deliberately bounded timing control: {receipt}");
}

/// Nonempty notice parity: direct user/extern grants, a project grant restored
/// after the node batch, and members inheriting an already-held project grant.
/// Savepoint rollback keeps identical org/node names and event payloads.
#[nolog]
async fn audience_batch_notice_parity(e:&Arc<Engine>) {
    let mut c=e.db.get().await.unwrap();let tx=c.transaction().await.unwrap();
    let uuid=uuid::Uuid::new_v4();let slug=format!("notice-parity-{uuid}");
    let id:i64=tx.query_one("INSERT INTO ot.orgs(uuid,slug,name,settings) VALUES($1,$2,$2,'{\"max_top_grant\":0,\"org_inbox_enabled\":true}') RETURNING id",&[&uuid,&slug]).await.unwrap().get(0);
    let org=crate::orgs::provisional(id,uuid.to_string(),slug.clone(),slug.clone());
    let lead:i64=tx.query_one("INSERT INTO ot.agents(org_id,name,tier,kind,state,born,charter,grant_credits) VALUES($1,'lead','sol','agent','live','synthetic','Synthetic lead',1000) RETURNING id",&[&id]).await.unwrap().get(0);
    tx.execute("INSERT INTO ot.agents(org_id,name,tier,kind,state,born,parent_id) VALUES($1,'team','project','project','live','synthetic',$2)",&[&id,&lead]).await.unwrap();
    crate::domain::audiences::grant_tx(e,&*tx,&org,&crate::domain::ops::Actor::User,"team",Some("user"),"setup").await.unwrap();
    tx.execute("DELETE FROM ot.mail WHERE org_id=$1",&[&id]).await.unwrap();
    let template:Template=serde_json::from_value(json!({"id":"parity","name":"Parity","agents":[
        {"name":"direct","tier":"sol","charter":{"text":"Synthetic member"},"audiences":["user"]},
        {"name":"external","tier":"sol","charter":{"text":"Synthetic member"},"audiences":["extern"]},
        {"name":"nested","tier":"project","slots":2,"peer_mail":true,"reports":[{"name":"deep","tier":"sol","charter":{"text":"Synthetic member"}}]}
    ]})).unwrap();
    let (mut planned,blocked)=plan(&template,&Choices::default(),&avail(e,&slug),&[]).unwrap();assert!(blocked.is_empty());
    for p in &mut planned {if p.parent.is_none(){p.parent=Some("team".into());}}
    let mut notices=Vec::new();
    for batched in [false,true] {
        tx.batch_execute("SAVEPOINT notice_path").await.unwrap();
        let mut fx=crate::domain::ops::Effects::default();
        if batched {create_nodes(e,&org,&tx,&planned,false,&mut fx).await.unwrap();}
        else {for p in &planned {for req in creation_requests(p,false) {
            crate::domain::ops::run_in_tx(e,&org,&tx,&crate::domain::ops::Actor::User,&req,&mut fx).await.unwrap();
        }}}
        // Same post-node restore phase as orgops::create, preserving its notices.
        for (grantee,target) in [("nested","user"),("direct","external")] {
            crate::domain::audiences::grant_tx(e,&*tx,&org,&crate::domain::ops::Actor::User,grantee,Some(target),"restored from template").await.unwrap();
        }
        let rows=tx.query("SELECT recipient_name,notice,body,ev FROM ot.mail WHERE org_id=$1 ORDER BY recipient_name,body",&[&id]).await.unwrap();
        notices.push(rows.iter().map(|r|json!({"to":r.get::<_,String>(0),"notice":r.get::<_,bool>(1),"body":r.get::<_,String>(2),"ev":r.get::<_,Option<Value>>(3)})).collect::<Vec<_>>());
        tx.batch_execute("ROLLBACK TO SAVEPOINT notice_path; RELEASE SAVEPOINT notice_path").await.unwrap();
    }
    assert_eq!(notices[0],notices[1],"persisted notices must match the former per-op path exactly");
    assert!(notices[0].iter().any(|n|n["body"].as_str().unwrap().contains("through project @team")),"inherited notices must be exercised");
    assert!(notices[0].iter().any(|n|n["body"].as_str().unwrap().contains("org inbox")),"extern notices must be exercised");
    let receipt=json!({"per_op_notices":notices[0],"batched_notices":notices[1],"identical":true,"effects_applied":false});
    std::fs::write(std::path::Path::new(&std::env::var("ORGTREE_CLAIM_TEST_OUTPUT").unwrap()).join("audience-batch-parity.json"),serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    eprintln!("AUDIENCE_BATCH_NOTICE_PARITY identical notices={}",notices[0].len());
    tx.rollback().await.unwrap();
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
    if std::env::var("ORGTREE_TEMPLATE_AUDIENCE_BATCH_MEASUREMENT").as_deref()==Ok("1") {
        audience_batch_notice_parity(&engine).await;
    }
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
