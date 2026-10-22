use super::*;

#[nolog]
fn rows(count: usize, depth: usize) -> Vec<Row> {
    (0..count).map(|i| Row { id:(i+1) as i64, parent: (i%depth>0).then_some(i as i64),
        name:format!("node-{i}"), tier:if i%depth==depth-1 || i+1==count {"sol"} else {"project"}.into(),
        account:None,seat:0.0,grant:0.0,charter:Some("Synthetic template role".into()),team_charter:None,
        scope:json!({"fast_mode":false}),extra:Value::Null }).collect()
}

#[nolog]
fn available() -> Avail {
    let mut av=Avail::default();
    av.tiers.insert("sol".into(), Offer {seat:0.0,provider:"openai".into(),accounts:Vec::new(),default_ok:true,readings:HashMap::new()}); av
}

#[test]
#[nolog]
fn nested_wire_has_no_node_or_depth_ceiling_and_drops_on_a_small_stack() {
    // Depth and total nodes vary independently; the final case is within 1 KiB
    // of the byte cap. All intermediates own shallow nodes, including errors.
    std::thread::Builder::new().stack_size(256*1024).spawn(|| {
        for (count,depth,near_cap) in [(1000,20,false),(1000,1000,false),(5000,5000,false),(12000,12000,true)] {
            let input=rows(count,depth);let clock=std::time::Instant::now();
            let mut saved=from_rows("scale","Scale",None,&input,None,None,&json!({}),&Include::default()).unwrap();
            if near_cap {
                let size=saved.body().unwrap().len();
                saved.root["description"]=json!("x".repeat(FILE_MAX as usize-size-128));
            }
            let body=saved.body().unwrap();let export=clock.elapsed().as_secs_f64();
            assert!(body.len() as u64<=FILE_MAX);
            if near_cap { assert!(body.len()>FILE_MAX as usize-1024); }
            let clock=std::time::Instant::now();let t=parse(&body).unwrap();let parse_s=clock.elapsed().as_secs_f64();
            let clock=std::time::Instant::now();assert!(validate(&t).is_empty());let validate_s=clock.elapsed().as_secs_f64();
            let cloned=t.clone();assert_eq!(cloned.agents.len(),count);drop(cloned);
            let clock=std::time::Instant::now();let (plan,blocked)=plan(&t,&Choices::default(),&available(),&[]).unwrap();
            assert!(blocked.is_empty());assert_eq!(plan.len(),count);assert_eq!(plan.last().unwrap().depth,depth-1);
            let preview=plan_json(&t,&plan,&blocked);let _wire=serde_json::to_string(&preview).unwrap();let plan_s=clock.elapsed().as_secs_f64();
            let clock=std::time::Instant::now();let requests:Vec<_>=plan.iter().flat_map(|p|creation_requests(p,false)).collect();
            assert_eq!(requests.iter().filter(|r|r["op"]=="hire"||r["op"]=="create_project").count(),count);
            eprintln!("TEMPLATE_SCALE {}",json!({"nodes":count,"depth":depth,"bytes":body.len(),"export_seconds":export,"parse_seconds":parse_s,"validate_seconds":validate_s,"preview_seconds":plan_s,"request_seconds":clock.elapsed().as_secs_f64(),"canonical_create":"measured separately"}));
        }
        let excessive=" ".repeat(FILE_MAX as usize+1);
        assert!(parse(&excessive).unwrap_err().contains("16 MiB"));
        // Unknown format versions fail clearly without trying another format.
        assert!(parse(r#"{"id":"x","name":"X","version":2,"agents":[]}"#).unwrap_err().contains("version 2"));
    }).unwrap().join().unwrap();
}

#[test]
#[nolog]
fn project_policy_speed_and_explicit_harness_pin_round_trip() {
    let mut input=rows(3,3);
    input[0].scope=json!({"mail_queue":"ack","mail_queue_exclude_sender":true,"mail_queue_ack_timeout":false,"mail_queue_max_attempts":7,"mail_queue_ack_reminders":4,"mail_queue_turn_end_reminder":true,"event_listeners":true,"slots_capacity":3,"peer_mail":true});
    input[2].tier="or-test-model".into();input[2].scope=json!({"fast_mode":false});input[2].extra=json!({"harness":"opencode","harness_pin":true});
    let body=from_rows("x","X",None,&input,None,None,&json!({}),&Include::default()).unwrap().body().unwrap();
    let t=parse(&body).unwrap();assert!(validate(&t).is_empty(),"{:?}",validate(&t));
    assert_eq!(t.agents[0].settings.as_ref().unwrap()["ack_reminders"],4);
    let mut av=available();av.tiers.insert("or-test-model".into(),Offer {seat:0.0,provider:"openrouter".into(),accounts:vec![],default_ok:true,readings:HashMap::new()});
    let (p,blocked)=plan(&t,&Choices::default(),&av,&[]).unwrap();assert_eq!(blocked,["node-2"]);
    assert!(p[2].note.as_ref().unwrap().contains("pinned harness"));
    av.harnesses.push("opencode".into());let (p,b)=plan(&t,&Choices::default(),&av,&[]).unwrap();assert!(b.is_empty());
    let req=hire_request(&p[2],false);assert_eq!(req["fast_mode"],false);assert_eq!(req["harness"],"opencode");
    let config=creation_requests(&p[0],false);assert_eq!(config[1]["settings"]["mail_queue"],"ack");assert_eq!(config[1]["settings"]["slots"],3);
    input[2].extra["harness_pin"]=json!(false);
    let saved=from_rows("x","X",None,&input,None,None,&json!({}),&Include::default()).unwrap();assert!(saved.nodes[2].get("harness").is_none());
    let inc=Include {effort:false,settings:false,..Include::default()};let saved=from_rows("x","X",None,&input,None,None,&json!({}),&inc).unwrap();
    assert!(saved.nodes.iter().all(|s|s.get("settings").is_none()&&s.get("fast_mode").is_none()&&s.get("harness").is_none()));
    let speedy=parse(r#"{"id":"x","name":"X","agents":[{"name":"speedy","tier":"sol","fast_mode":true}]}"#).unwrap();
    let (_,b)=plan(&speedy,&Choices::default(),&available(),&[]).unwrap();assert_eq!(b,["speedy"]);
    let mut c=Choices::default();c.overrides.insert("speedy".into(),SlotChoice {fast_mode:Some(false),..Default::default()});assert!(plan(&speedy,&c,&available(),&[]).unwrap().1.is_empty());
}

#[test]
#[nolog]
fn legacy_default_parser_ceiling_is_measured_separately_from_four_level_validation() {
    #[derive(Deserialize)] struct OldTemplate { #[allow(dead_code)] agents: Vec<OldSlot> }
    #[derive(Deserialize)] struct OldSlot { #[serde(default)] #[allow(dead_code)] reports: Vec<OldSlot> }
    let body=|depth:usize| format!("{{\"agents\":[{}{{}}{}]}}","{\"reports\":[".repeat(depth-1),"]}".repeat(depth-1));
    let mut last=0;
    for depth in 1..100 { if serde_json::from_str::<OldTemplate>(&body(depth)).is_ok(){last=depth}else{break} }
    eprintln!("LEGACY_TEMPLATE_PARSER last_accepted_tree_levels={last} first_refused={}",last+1);
    assert_eq!(last,63);
}
