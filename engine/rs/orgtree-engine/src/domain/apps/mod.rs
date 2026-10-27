pub mod bridge;
pub(crate) mod policy;
pub mod events;

pub mod file_access;
pub(crate) mod files;
pub(crate) mod labels;
pub mod net;
pub mod wire;
pub mod storage;
pub mod runtime;
pub mod templates;
pub use storage::run;

#[cfg(test)] mod template_control {
    use serde_json::json;
    use crate::domain::templates;
    #[test] fn custom_apps_annotation_example_is_a_valid_inert_portable_bundle(){
        let app:super::wire::Bundle=serde_json::from_str(include_str!("../../../../../../docs/examples/apps/annotation-notes.orgtree-app")).unwrap();
        super::wire::bundle(&app).unwrap();assert!(app.panels.is_empty());assert_eq!(app.definition.capabilities,vec!["events.fire"]);assert_eq!(app.definition.events.iter().map(|e|e.name.as_str()).collect::<Vec<_>>(),vec!["notes.ready"]);
        assert_eq!(app.definition.initial_state,json!({"note":""}));
    }
    #[test] fn custom_apps_templates_expose_definition_count_without_exposing_html(){
        let raw=json!({"id":"app-team","name":"App team","apps":[{"name":"Notes","html":"<p>PRIVATE-TEMPLATE-5831</p>","initial_state":{"note":"PRIVATE-TEMPLATE-5831"},"capabilities":["mail.send"]}]});
        let t=templates::parse(&raw.to_string()).unwrap();let out=templates::plan_json(&t,&[],&[]);
        assert_eq!(out["apps"],1,"template preview must count portable app definitions");
        assert!(!format!("{t:?}").contains("PRIVATE-TEMPLATE-5831"));assert!(!out.to_string().contains("PRIVATE-TEMPLATE-5831"));
    }
    #[test] fn custom_apps_templates_refuse_grants_ids_and_saved_panel_data(){
        let base=json!({"id":"app-team","name":"App team","apps":[{"name":"Notes","html":"<p>notes</p>"}]});
        for (key,value) in [("permissions",json!({"mail.send":"allow"})),("panels",json!([{"state":{"private":"saved"}}])),("id",json!("foreign-id"))]{let mut bad=base.clone();bad["apps"][0][key]=value;assert!(templates::parse(&bad.to_string()).is_err(),"template apps must refuse {key}");}
        let mut bad=base;bad["apps"][0]["capabilities"]=json!(["PRIVATE-TEMPLATE-REFUSAL-632"]);let error=templates::parse(&bad.to_string()).unwrap_err();assert!(!error.contains("PRIVATE-TEMPLATE-REFUSAL-632"));
    }
}

#[cfg(test)] mod new_apps_control {
    use serde_json::json;
    #[test] fn custom_apps_panel_open_closed_uses_agent_creation_without_show_or_start(){
        use super::{storage::{panel_open_mode,PanelOpenMode},wire::{parse,Request}};
        // Exercise the actual wire defaults and the planner used by the store:
        // Show permits reuse/start; CreateClosed only inserts open=running=false.
        let mode=|input,agent|{
            let Request::PanelOpen{closed,new,slug,panel,..}=parse(&input).unwrap() else{panic!("panel_open")};
            panel_open_mode(agent,closed,new||slug.is_some(),panel.is_some())
        };
        assert_eq!(mode(json!({"action":"panel_open","app":"notes"}),false).unwrap(),PanelOpenMode::Show{fresh:false});
        assert_eq!(mode(json!({"action":"panel_open","app":"notes","closed":false}),false).unwrap(),PanelOpenMode::Show{fresh:false});
        for input in [json!({"action":"panel_open","app":"notes","new":true}),json!({"action":"panel_open","app":"notes","slug":"desk"})]{
            assert_eq!(mode(input,false).unwrap(),PanelOpenMode::Show{fresh:true});
        }
        for agent in [false,true]{
            for new in [false,true]{
                assert_eq!(mode(json!({"action":"panel_open","app":"notes","closed":true,"new":new}),agent).unwrap(),PanelOpenMode::CreateClosed);
            }
        }
        assert_eq!(mode(json!({"action":"panel_open","app":"notes"}),true).unwrap(),PanelOpenMode::CreateClosed);
        assert_eq!(mode(json!({"action":"panel_open","panel":"existing"}),false).unwrap(),PanelOpenMode::Show{fresh:false});
        assert!(mode(json!({"action":"panel_open","panel":"existing","closed":true}),false).is_err(),"closed never modifies an existing copy");
        assert!(mode(json!({"action":"panel_open","panel":"existing"}),true).is_err(),"agents cannot show existing copies");
        assert!(mode(json!({"action":"panel_open","panel":"existing","new":true}),false).is_err());
        assert!(parse(&json!({"action":"panel_open","app":"notes","closed":"true"})).is_err(),"flag is a boolean");
    }
    #[test] fn custom_apps_seen_is_explicit_bounded_and_not_an_authority_grant(){
        assert!(super::wire::parse(&json!({"action":"mark_seen","apps":["app-one","app-two"]})).is_ok());
        for apps in [json!([]),json!(["same","same"]),json!([""]),json!(vec!["x";201])]{assert!(super::wire::parse(&json!({"action":"mark_seen","apps":apps})).is_err());}
        assert!(super::wire::parse(&json!({"action":"mark_seen","apps":["x"],"permissions":{"org.read":"allow"}})).is_err());
        assert!(crate::http::apps::read_input(r#"{"action":"mark_seen","apps":["x"]}"#).is_err());
    }
    /// An app or panel asks for its slug only when it is made (migration 0075),
    /// read by orgtree_present's own docs::requested_slug.
    #[test] fn custom_apps_slug_is_asked_only_when_an_app_or_panel_is_made(){
        use super::wire::{parse,Request};
        let def=json!({"name":"לוח","html":"<p>x</p>"});
        match parse(&json!({"action":"app_create","definition":def,"slug":"  Weekly board "})).unwrap(){Request::AppCreate{slug,..}=>assert_eq!(slug.as_deref(),Some("Weekly board")),_=>panic!("app_create")}
        match parse(&json!({"action":"app_create","definition":def,"slug":" "})).unwrap(){Request::AppCreate{slug,..}=>assert!(slug.is_none(),"a blank slug is none"),_=>panic!("app_create")}
        match parse(&json!({"action":"app_create","definition":def})).unwrap(){Request::AppCreate{slug,..}=>assert!(slug.is_none()),_=>panic!("app_create")}
        match parse(&json!({"action":"panel_open","app":"notes","slug":"desk"})).unwrap(){Request::PanelOpen{slug,..}=>assert_eq!(slug.as_deref(),Some("desk")),_=>panic!("panel_open")}
        for (bad,words) in [(json!({"action":"app_create","definition":def,"slug":"שבועי"}),"no ASCII letter or digit"),
            (json!({"action":"app_create","definition":def,"slug":["x"]}),"slug is text"),
            (json!({"action":"app_update","app":"notes","expected_rev":1,"definition":def,"slug":"x"}),"keeps its slug once made"),
            (json!({"action":"panel_update","panel":"notes-panel-1","expected_rev":1,"slug":"x"}),"keeps its slug once made"),
            (json!({"action":"panel_open","panel":"notes-panel-1","slug":"x"}),"existing panel keeps its slug")]{
            let err=parse(&bad).err().expect("refused").to_string();assert!(err.contains(words),"{bad}: {err}");
        }
        assert!(parse(&json!({"action":"app_get","app":"notes","slug":null})).is_ok(),"no slug beside a read is no slug");
    }
    #[test] fn custom_apps_refs_is_a_bounded_read_of_exact_ids(){
        assert!(super::wire::parse(&json!({"action":"refs","apps":["app1"],"panels":["panel1"]})).is_ok());
        assert!(super::wire::parse(&json!({"action":"refs","panels":["panel1"]})).is_ok());
        let full=json!({"action":"refs","apps":vec!["app";32],"panels":vec!["panel";32]});
        assert!(super::wire::parse(&full).is_ok(),"64 IDs together is the bound");
        for bad in [json!({"action":"refs"}),json!({"action":"refs","apps":[],"panels":[]}),
            json!({"action":"refs","apps":vec!["app";33],"panels":vec!["panel";32]}),json!({"action":"refs","apps":[""]}),
            json!({"action":"refs","apps":["app1"],"state":{}})]{assert!(super::wire::parse(&bad).is_err(),"{bad}");}
        assert!(crate::http::apps::read_input(r#"{"action":"refs","apps":["app1"]}"#).is_ok(),"refs is a read");
    }
}
