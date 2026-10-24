//! Focused opt-in synthetic proof: temporary native Linux data, PG16+, fake CLIs.
use super::*;

async fn invoke(engine:&Arc<Engine>,org:Option<&Arc<OrgHandle>>,name:&str,args:Value)->Result<Value> {
    let result=handle(engine,org,&json!({"id":1,"method":"tools/call","params":{"name":name,"arguments":args}})).await;
    if result["result"]["isError"]==true { anyhow::bail!("{name}: {}",result["result"]["content"][0]["text"]); }
    Ok(serde_json::from_str(result["result"]["content"][0]["text"].as_str().unwrap())?)
}

#[tokio::test]
#[ignore = "requires an owned temporary Linux root, PostgreSQL and fake login fixture"]
async fn synthetic_user_mcp_groups_and_native_profile_glue() {
    let root=std::path::PathBuf::from(std::env::var("ORGTREE_USERMCP_TEST_ROOT").expect("owned fixture root"));
    assert!(root.to_string_lossy().starts_with("/tmp/orgtree-headless-sol-"));
    assert_eq!(std::fs::read_to_string(root.join(".synthetic-owned")).unwrap(),"headless-sol user MCP synthetic fixture\n");
    let mut engine=Engine::for_tests(root.join("data"));
    {
        let e=Arc::get_mut(&mut engine).unwrap();
        e.cfg.pg_bin=Some(std::env::var("ORGTREE_P03_PG_BIN").unwrap().into());
        e.cfg.pg_bootstrap=true;
        e.cfg.standalone=true;
    }
    let mut pg=crate::pg::Cluster::start(&engine.cfg,&|_|{}).await.unwrap();
    let result:Result<()>=async {
        pg.ensure_database(crate::pg::ENGINE_DB).await?;
        let (mut client,connection)=pg.connect_config(crate::pg::ENGINE_DB).connect(tokio_postgres::NoTls).await?;
        let connection=tokio::spawn(connection);
        crate::migrate::run(&mut client,&|_|{}).await?;
        drop(client);connection.abort();let _=connection.await;
        Arc::get_mut(&mut engine).unwrap().db=pg.pool(crate::pg::ENGINE_DB,8)?;
        let capture=crate::trace::LogCapture::start().await;
        tracing::info!("synthetic user MCP database positive log control");
        invoke(&engine,None,"orgtree_create_org",json!({"name":"Synthetic MCP"})).await?;
        let org=engine.orgs.get("synthetic-mcp").unwrap();
        for name in ["a","b"] {
            invoke(&engine,Some(&org),"orgtree_hire",json!({"name":name,"tier":"sol","grant":8,"charter":"Synthetic fixture only","index":0,
                "add_dirs":[],"org_visibility":"self","tools":{"bash":false,"web":false,"edit":false,"subagents":false,"mcp":[]}})).await?;
        }
        invoke(&engine,Some(&org),"orgtree_reorder",json!({"node":"b","index":0})).await?;
        invoke(&engine,Some(&org),"orgtree_reallocate",json!({"node":"a","delta":-4})).await?;
        invoke(&engine,Some(&org),"orgtree_move",json!({"node":"a","new_parent":"b"})).await?;
        invoke(&engine,Some(&org),"orgtree_move",json!({"moves":[{"node":"a","new_parent":"@user"}]})).await?;
        invoke(&engine,Some(&org),"orgtree_retool",json!({"node":"a","charter":"Changed synthetic charter"})).await?;
        invoke(&engine,Some(&org),"orgtree_retire",json!({"node":"a"})).await?;
        invoke(&engine,Some(&org),"orgtree_rehire",json!({"node":"a","target":"b"})).await?;
        invoke(&engine,Some(&org),"orgtree_move",json!({"node":"a","new_parent":"@user"})).await?;
        let client=engine.db.get().await?;
        let rows=client.query("SELECT id,name,generation FROM ot.agents WHERE org_id=$1 AND state='live' ORDER BY name",&[&org.id]).await?;
        let asker=|n:usize|crate::domain::asks::Asker{id:rows[n].get(0),name:rows[n].get(1),generation:rows[n].get(2),superior:None,may_ask_user:true};
        drop(client);
        let (a,b)=(asker(0),asker(1));
        let qa=crate::domain::asks::ask(&engine,&org,&a,&json!({"question":"First synthetic question?","options":[{"label":"Go"},{"label":"Stop"}]})).await?;
        let qb=crate::domain::asks::ask(&engine,&org,&b,&json!({"question":"Second synthetic question?"})).await?;
        let first=invoke(&engine,Some(&org),"orgtree_questions",json!({"limit":1})).await?;
        assert_eq!(first["questions"].as_array().unwrap().len(),1);
        assert!(first["next_cursor"].is_string());
        let second=invoke(&engine,Some(&org),"orgtree_questions",json!({"limit":1,"cursor":first["next_cursor"]})).await?;
        assert_eq!(second["questions"].as_array().unwrap().len(),1);
        assert_ne!(first["questions"][0]["id"],second["questions"][0]["id"]);
        let card=invoke(&engine,Some(&org),"orgtree_questions",json!({"action":"get","id":qa})).await?;
        invoke(&engine,Some(&org),"orgtree_answer",json!({"ask":qa,"rev":card["rev"],"answers":[{"selected":["Go"]}]})).await?;
        invoke(&engine,Some(&org),"orgtree_answer",json!({"ask":qb,"answers":[{"text":"Synthetic answer"}]})).await?;
        assert!(invoke(&engine,Some(&org),"orgtree_questions",json!({})).await?["questions"].as_array().unwrap().is_empty());
        let credit=crate::domain::asks::request_credits(&engine,&org,&a,6.0,"Synthetic credit request").await?;
        invoke(&engine,Some(&org),"orgtree_questions",json!({"action":"credit","id":credit,"decision":"approve","granted":6,"dry":true})).await?;
        invoke(&engine,Some(&org),"orgtree_questions",json!({"action":"credit","id":credit,"decision":"approve","granted":6})).await?;
        crate::domain::asks::ask(&engine,&org,&a,&json!({"question":"Mixed synthetic request?"})).await?;
        crate::domain::asks::request_credits(&engine,&org,&a,7.0,"Synthetic increase").await?;
        let mixed=crate::domain::asks::request_scope(&engine,&org,&a,&[json!({"kind":"tool","tool":"web"})],"Synthetic scope").await?;
        let card=invoke(&engine,Some(&org),"orgtree_questions",json!({"action":"get","id":mixed})).await?;
        invoke(&engine,Some(&org),"orgtree_questions",json!({"action":"batch","node":"a","revs":card["revs"],"answers":[{"text":"Continue"}],"credits":{"deny":true},"scope":["deny"]})).await?;
        invoke(&engine,Some(&org),"orgtree_settings",json!({"scope":"org","action":"configure","settings":{"compact_at":90,"max_top_grant":100}})).await?;
        assert_eq!(invoke(&engine,Some(&org),"orgtree_settings",json!({"scope":"org"})).await?["effective"]["compact_at"],90);
        invoke(&engine,None,"orgtree_settings",json!({"scope":"defaults","action":"configure","settings":{"compact_at":0.8}})).await?;
        invoke(&engine,None,"orgtree_settings",json!({"scope":"runtime","action":"configure","settings":{"warming_enabled":false,"credit_bubble_alloc_enabled":false}})).await?;
        invoke(&engine,None,"orgtree_settings",json!({"scope":"provider","action":"configure","provider":"openai","settings":{"enabled":true}})).await?;
        let secret="SYNTHETIC_STORED_KEY_CANARY_2d17";
        let account=invoke(&engine,None,"orgtree_accounts",json!({"action":"add","provider":"openai","kind":"apikey","key":secret})).await?;
        assert!(!account.to_string().contains(secret));
        let id=account["id"].as_str().unwrap();
        for (action,extra) in [("enable",json!({"enabled":false})),("identity",json!({})),("marks",json!({}))] {
            let mut args=json!({"action":action,"id":id});args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            assert!(!invoke(&engine,None,"orgtree_accounts",args).await?.to_string().contains(secret));
        }
        assert!(!invoke(&engine,None,"orgtree_accounts",json!({})).await?.to_string().contains(secret));
        invoke(&engine,None,"orgtree_accounts",json!({"action":"remove","id":id})).await?;
        let claude=invoke(&engine,None,"orgtree_accounts",json!({"action":"claude_key_add","token":secret})).await?;
        let claude_id=claude["registered"].clone();
        assert!(!claude.to_string().contains(secret));
        invoke(&engine,None,"orgtree_accounts",json!({"action":"order","keys":[claude_id]})).await?;
        invoke(&engine,None,"orgtree_accounts",json!({"action":"remove","id":claude_id})).await?;
        // Provider-native login is simulated by a fake CLI; Orgtree reads the real profile formats.
        let fake=root.join("fakecli/login");assert!(fake.is_file());
        for provider in ["claude","openai"] {
            let account=invoke(&engine,None,"orgtree_accounts",json!({"action":"add","provider":provider,"kind":"managed"})).await?;
            let id=account["id"].as_str().unwrap();
            let profile=account["account"]["credential"]["path"].as_str().unwrap();
            assert!(profile.starts_with(root.to_str().unwrap()));
            let before=invoke(&engine,None,"orgtree_accounts",json!({"action":"identity","id":id})).await?;
            assert_eq!(before["auth"],"unauthenticated");
            let var=if provider=="claude" {"CLAUDE_CONFIG_DIR"} else {"CODEX_HOME"};
            assert!(std::process::Command::new(&fake).arg(provider).env(var,profile).status()?.success());
            let after=invoke(&engine,None,"orgtree_accounts",json!({"action":"identity","id":id})).await?;
            assert_eq!(after["auth"],"authenticated");
            assert_eq!(after["email"],format!("{provider}@synthetic.invalid"));
            assert!(!root.join("home").join(if provider=="claude" {".claude"} else {".codex"}).exists(),"managed login must not change default profile");
        }
        let log=capture.finish().await;
        assert!(log.contains("synthetic user MCP database positive log control"));
        assert!(!log.contains(secret),"stored key leaked to verbose diagnostics");
        println!("SYNTHETIC_USER_MCP_GROUPS: tree/question/settings/accounts positive paths, private logs and fake Claude/Codex profile identities verified");
        Ok(())
    }.await;
    engine.shutdown.cancel();
    pg.stop().await;
    result.unwrap();
}
