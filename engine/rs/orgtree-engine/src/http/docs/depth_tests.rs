//! Disposable native checks of the actual document/folder/gallery entry points.
use super::*;
use crate::domain::{docs, native_fixture::Fixture, projects};

struct Case {
    fixture: Fixture,
    client: tokio_postgres::Client,
    connection: tokio::task::JoinHandle<Result<(), tokio_postgres::Error>>,
    engine: Arc<Engine>,
    org: Arc<crate::orgs::OrgHandle>,
    root: i64,
    leaf: i64,
    allowed: String,
    denied: String,
}

#[nolog]
async fn case(label: &str) -> Case {
    let fixture=Fixture::from_env().await;
    let (mut client,connection)=fixture.cfg.connect(tokio_postgres::NoTls).await.unwrap();
    let connection=tokio::spawn(async move { connection.await });
    crate::migrate::run(&mut client,&|_|{}).await.unwrap();
    let mut engine=Engine::for_tests(fixture.engine_root(label));
    let manager=deadpool_postgres::Manager::from_config(fixture.cfg.clone(),tokio_postgres::NoTls,
        deadpool_postgres::ManagerConfig{recycling_method:deadpool_postgres::RecyclingMethod::Fast});
    Arc::get_mut(&mut engine).unwrap().db=deadpool_postgres::Pool::builder(manager).max_size(4)
        .runtime(deadpool_postgres::Runtime::Tokio1).build().unwrap();
    let allowed=fixture.engine_root(&format!("{label}-allowed")).to_string_lossy().to_string();
    let denied=fixture.engine_root(&format!("{label}-denied")).to_string_lossy().to_string();
    let uuid=uuid::Uuid::new_v4();let slug=format!("document-depth-{uuid}");
    let settings=json!({"dirs":[{"path":allowed,"mode":"rw"},{"path":denied,"mode":"rw"}]});
    let id:i64=client.query_one("INSERT INTO ot.orgs(uuid,slug,name,settings) VALUES($1,$2,$2,$3) RETURNING id",&[&uuid,&slug,&settings]).await.unwrap().get(0);
    let org=crate::orgs::provisional(id,uuid.to_string(),slug.clone(),slug);
    let scope=json!({"add_dirs":[{"path":allowed,"mode":"ro"}]});
    let root:i64=client.query_one("INSERT INTO ot.agents(org_id,name,kind,tier,state,born,scope) VALUES($1,'root','agent','sol','live','synthetic',$2) RETURNING id",&[&id,&scope]).await.unwrap().get(0);
    client.execute("INSERT INTO ot.agents(org_id,name,kind,tier,state,born) SELECT $1,'project-'||n,'project','project','live','synthetic' FROM generate_series(1,1500) n ORDER BY n",&[&id]).await.unwrap();
    client.execute("WITH chain AS (SELECT id,lag(id,1,$2::bigint) OVER (ORDER BY id) parent FROM ot.agents WHERE org_id=$1 AND kind='project') UPDATE ot.agents a SET parent_id=c.parent FROM chain c WHERE a.id=c.id",&[&id,&root]).await.unwrap();
    let bottom:i64=client.query_one("SELECT id FROM ot.agents WHERE org_id=$1 AND name='project-1500'",&[&id]).await.unwrap().get(0);
    let scope=json!({"add_dirs":[{"path":allowed,"mode":"rw"},{"path":denied,"mode":"rw"}]});
    let leaf:i64=client.query_one("INSERT INTO ot.agents(org_id,name,parent_id,kind,tier,state,born,scope) VALUES($1,'leaf',$2,'agent','sol','live','synthetic',$3) RETURNING id",&[&id,&bottom,&scope]).await.unwrap().get(0);
    Case{fixture,client,connection,engine,org,root,leaf,allowed,denied}
}

#[nolog]
async fn finish(c: Case) {
    drop(c.engine);drop(c.client);c.connection.await.unwrap().unwrap();
}

#[tokio::test]
#[ignore="explicit owned disposable native fixture required"]
#[nolog]
async fn deep_presenter_keeps_folder_clamps_and_project_admission() {
    let c=case("deep-presenter").await;
    let p=docs::presenter_in(&c.engine,&c.org,c.leaf,&c.client).await.unwrap();
    assert!(!p.may_present,"the nearest agent superior remains above1500project levels");
    assert!(p.dirs.contains(&c.allowed));assert!(!p.dirs.contains(&c.denied),"root folder restriction survives");
    let held=c.engine.cfg.teams_dir(&c.org.slug).join(c.root.to_string());
    std::fs::create_dir_all(&held).unwrap();let file=held.join("held.txt");std::fs::write(&file,"owned synthetic content").unwrap();
    assert!(docs::readable(&p,&file.to_string_lossy()).is_ok(),"full ancestor shared-folder authority also serves logo set");
    let denied=std::path::Path::new(&c.denied).join("denied.txt");std::fs::write(&denied,"must stay denied").unwrap();
    assert!(docs::readable(&p,&denied.to_string_lossy()).is_err());
    let presented=docs::present(&c.engine,&c.org,&p,&json!({"title":"Deep member","body":"synthetic","project":"project-1"})).await.unwrap();
    assert!(presented.1["presentation"]["id"].is_string(),"member may present1500levels up without a user audience");
    c.client.execute("INSERT INTO ot.agents(org_id,name,parent_id,kind,tier,state,born) VALUES($1,'below-leaf',$2,'project','project','live','synthetic')",&[&c.org.id,&c.leaf]).await.unwrap();
    assert!(docs::present(&c.engine,&c.org,&p,&json!({"title":"No audience","body":"synthetic","project":"below-leaf"})).await.is_err(),"above-project reach alone still needs user audience");
    c.client.execute("UPDATE ot.agents SET parent_id=$2 WHERE org_id=$1 AND name='project-1'",&[&c.org.id,&c.leaf]).await.unwrap();
    assert!(tokio::time::timeout(std::time::Duration::from_secs(5),docs::presenter_in(&c.engine,&c.org,c.leaf,&c.client)).await.unwrap().is_err(),"a cyclic folder chain refuses promptly");
    std::fs::write(c.fixture.engine_root("depth-results").join("presenter.json"),json!({"levels":1500,"clamp":true,"shared_folder_read":true,"project_member_present":true,"outside_project_refused":true,"cycle_refused":true}).to_string()).unwrap();
    finish(c).await;
}

#[tokio::test]
#[ignore="explicit owned disposable native fixture required"]
#[nolog]
async fn deep_descendant_project_folders_keep_order_and_live_org_boundaries() {
    let c=case("deep-project-folders").await;
    let projects=projects::below(&c.client,c.root).await.unwrap();
    assert_eq!(projects.len(),1500,"all pages of deep descendant projects are retained");
    assert_eq!(projects.iter().map(|(_,name)|name.clone()).collect::<Vec<_>>(),(1..=1500).map(|n|format!("project-{n}")).collect::<Vec<_>>(),"nearest-first order");
    c.client.execute("INSERT INTO ot.agents(org_id,name,parent_id,kind,tier,state,born) VALUES($1,'retired',$2,'project','project','archived','synthetic')",&[&c.org.id,&c.root]).await.unwrap();
    let other_uuid=uuid::Uuid::new_v4();let other_slug=format!("foreign-{other_uuid}");
    let other:i64=c.client.query_one("INSERT INTO ot.orgs(uuid,slug,name) VALUES($1,$2,$2) RETURNING id",&[&other_uuid,&other_slug]).await.unwrap().get(0);
    c.client.execute("INSERT INTO ot.agents(org_id,name,parent_id,kind,tier,state,born) VALUES($1,'foreign',$2,'project','project','live','synthetic')",&[&other,&c.root]).await.unwrap();
    c.client.execute("UPDATE ot.agents SET parent_id=$2 WHERE id=$1",&[&c.root,&c.leaf]).await.unwrap();
    let actual=tokio::time::timeout(std::time::Duration::from_secs(5),projects::below(&c.client,c.root)).await.unwrap().unwrap();
    assert_eq!(actual,projects,"cycle back to root is not duplicated; retired/foreign rows excluded");
    std::fs::write(c.fixture.engine_root("depth-results").join("folders.json"),json!({"levels":1500,"projects":actual.len(),"pages_at_256":6,"ordered":true,"cycle":true,"foreign_retired_excluded":true}).to_string()).unwrap();
    finish(c).await;
}

#[tokio::test]
#[ignore="explicit owned disposable native fixture required"]
#[nolog]
async fn deep_human_gallery_keeps_retained_identity_paging_and_cycle_safety() {
    let c=case("deep-gallery").await;
    let members=subtree_members(&c.client,&c.org,"root",true).await.unwrap().unwrap();
    assert_eq!(members.len(),1502);assert!(members.contains(&c.leaf));
    for n in 0..5 {
        let uid=format!("deep-{}-{n}",c.org.id);
        c.client.execute("INSERT INTO ot.documents(uid,org_id,agent_id,node_name,title,body,format,bytes) VALUES($1,$2,$3,'old-leaf-name','Synthetic deep','','markdown',0)",&[&uid,&c.org.id,&c.leaf]).await.unwrap();
    }
    c.client.execute("UPDATE ot.agents SET name='renamed',state='archived' WHERE id=$1",&[&c.leaf]).await.unwrap();
    let Json(page)=list_page(&c.client,&c.org,"root",Some(&members),0,2,None,false,false,None).await.unwrap();
    assert_eq!(page["total"],5);assert_eq!(page["documents"].as_array().unwrap().len(),2);assert_eq!(page["next_offset"],2);
    assert_eq!(page["documents"][0]["node"],"renamed");assert_eq!(page["documents"][0]["node_state"],"archived");
    assert_eq!(subtree_members(&c.client,&c.org,"root",false).await.unwrap(),Some(vec![c.root]));
    c.client.execute("UPDATE ot.agents SET parent_id=$2 WHERE id=$1",&[&c.root,&c.leaf]).await.unwrap();
    let cyclic=tokio::time::timeout(std::time::Duration::from_secs(5),subtree_members(&c.client,&c.org,"root",true)).await.unwrap().unwrap().unwrap();
    let mut dedup=cyclic.clone();dedup.sort_unstable();dedup.dedup();assert_eq!(dedup.len(),1502);assert_eq!(cyclic.len(),1502);
    std::fs::write(c.fixture.engine_root("depth-results").join("gallery.json"),json!({"levels":1500,"members":members.len(),"documents":5,"page_size":2,"next_offset":2,"retired_rename_retained":true,"cycle_unique":true}).to_string()).unwrap();
    finish(c).await;
}
