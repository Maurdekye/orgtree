//! Matched, synthetic-only canonical creation measurement: 50 chains of 20.
use super::*;
use crate::domain::{native_fixture::Fixture, ops, templates};

#[tokio::test(flavor="multi_thread",worker_threads=2)]
#[ignore="explicit owned disposable native fixture required"]
#[nolog]
async fn thousand_nodes_twenty_levels_canonical_creation() {
    let fixture = Fixture::from_env().await;
    let (mut client, connection) = fixture.cfg.connect(tokio_postgres::NoTls).await.unwrap();
    let connection = tokio::spawn(async move { connection.await });
    crate::migrate::run(&mut client,&|_|{}).await.unwrap();
    let mut e = Engine::for_tests(fixture.engine_root("credit-scale-engine"));
    let manager = deadpool_postgres::Manager::from_config(fixture.cfg.clone(),tokio_postgres::NoTls,
        deadpool_postgres::ManagerConfig{recycling_method:deadpool_postgres::RecyclingMethod::Fast});
    Arc::get_mut(&mut e).unwrap().db = deadpool_postgres::Pool::builder(manager).max_size(4)
        .runtime(deadpool_postgres::Runtime::Tokio1).build().unwrap();
    let mut providers = crate::providers::State::default();
    providers.codex.connected=true; providers.codex.installed=true; providers.probed=true;
    e.providers.state.store(Arc::new(providers));
    let mut roots = Vec::new();
    for chain in 0..50 {
        let mut child = None;
        for level in (0..20).rev() {
            let mut slot = json!({"name":format!("node-{}",chain*20+level+1),
                "tier":if level==0||level==19 {"sol"}else{"project"},
                "charter":{"text":"Synthetic template role"},
                "tools":{"bash":level!=0}});
            if level==0 { slot["org_visibility"]=json!("self");slot["permission_mode"]=json!("plan"); }
            if level>0&&level<19 { slot["slots"]=json!(0);slot["peer_mail"]=json!(true); }
            if let Some(next)=child { slot["reports"]=json!([next]); }
            child=Some(slot);
        }
        roots.push(child.unwrap());
    }
    // The base's template validation limit is not under test. The normal plan,
    // requests and per-node transaction loop are, with the peer's exact shape.
    let template:templates::Template=serde_json::from_value(json!({"id":"credit-scale","name":"Credit scale","agents":roots})).unwrap();
    let availability=templates::avail(&e,"credit-scale");
    let (planned,blocked)=templates::plan(&template,&templates::Choices::default(),&availability,&[]).unwrap();
    assert!(blocked.is_empty(),"synthetic cached staffing must be available");
    assert_eq!(planned.len(),1000);
    let output=fixture.engine_root("credit-scale-results");
    let tx=client.transaction().await.unwrap();
    let uuid=uuid::Uuid::new_v4();let slug=format!("credit-scale-{uuid}");
    let org:i64=tx.query_one("INSERT INTO ot.orgs(uuid,slug,name,settings) VALUES($1,$2,$2,'{\"max_top_grant\":0}') RETURNING id",&[&uuid,&slug]).await.unwrap().get(0);
    let handle=crate::orgs::provisional(org,uuid.to_string(),slug.clone(),slug);
    let mut effects=ops::Effects::default();let mut count=0;
    let clock=std::time::Instant::now();
    let result=tokio::time::timeout(std::time::Duration::from_secs(180),async {
        for p in &planned {
            for mut req in templates::creation_requests(p,false) {
                // Match the peer's full default project settings, supported by
                // the base canonical configure operation too.
                if req["op"]=="configure_project" {
                    req["settings"]=json!({"slots":0,"peer_mail":true,"mail_queue":"round_robin",
                        "exclude_sender":false,"ack_timeout":true,"max_attempts":3,"ack_reminders":3,
                        "turn_end_reminder":true,"event_listeners":false});
                }
                crate::util::boxed(|| ops::run_in_tx(&e,&handle,&tx,&ops::Actor::User,&req,&mut effects)).await?;
                count+=1;
                if count%100==0 {std::fs::write(output.join("progress.json"),json!({"operations":count,"seconds":clock.elapsed().as_secs_f64()}).to_string()).unwrap();}
            }
        }
        Ok::<_,anyhow::Error>(())
    }).await;
    let seconds=clock.elapsed().as_secs_f64();
    let completed=matches!(result,Ok(Ok(())));
    let error=match &result {Ok(Err(e))=>Some(e.to_string()),Err(_)=>Some("180 second creation timeout".into()),_=>None};
    std::fs::write(output.join("creation.json"),json!({"nodes":1000,"levels":20,"chains":50,
        "operations":count,"completed":completed,"seconds":seconds,"error":error,"effects_applied":false}).to_string()).unwrap();
    assert!(completed,"canonical creation did not complete: {error:?}");
    assert_eq!(count,1900);
    let ledger=tx.query("SELECT p.name,p.seat::text,p.grant_credits::text,c.seat::text,c.grant_credits::text FROM ot.agents p JOIN ot.agents c ON c.org_id=p.org_id AND c.name='node-'||(((substring(p.name from 6)::int-1)/20)*20+20) WHERE p.org_id=$1 AND p.kind='project' ORDER BY p.id",&[&org]).await.unwrap();
    assert_eq!(ledger.len(),900);
    let ledger:Vec<Value>=ledger.iter().map(|r| {
        let seat:rust_decimal::Decimal=r.get::<_,String>(1).parse().unwrap();
        let grant:rust_decimal::Decimal=r.get::<_,String>(2).parse().unwrap();
        let agent:rust_decimal::Decimal=r.get::<_,String>(3).parse::<rust_decimal::Decimal>().unwrap()+r.get::<_,String>(4).parse::<rust_decimal::Decimal>().unwrap();
        assert_eq!(seat,rust_decimal::Decimal::ZERO);assert_eq!(grant,agent);
        json!({"name":r.get::<_,String>(0),"seat":seat.to_string(),"grant":grant.to_string(),"frontier":agent.to_string()})
    }).collect();
    std::fs::write(output.join("ledger.json"),json!(ledger).to_string()).unwrap();
    tx.commit().await.unwrap(); // No Effects are applied, no provider or kickoff.
    drop(client);drop(e);connection.await.unwrap().unwrap();
}
