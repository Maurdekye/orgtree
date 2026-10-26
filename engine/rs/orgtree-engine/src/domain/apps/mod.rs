pub mod bridge;
pub(crate) mod policy;
pub mod events;

pub mod file_access;
pub(crate) mod files;
pub(crate) mod labels;
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
        super::wire::bundle(&app).unwrap();assert!(app.panels.is_empty());assert_eq!(app.definition.capabilities,vec!["mail.send"]);
        assert_eq!(app.definition.initial_state,json!({"to":"","note":""}));
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
    #[test] fn custom_apps_seen_is_explicit_bounded_and_not_an_authority_grant(){
        assert!(super::wire::parse(&json!({"action":"mark_seen","apps":["app-one","app-two"]})).is_ok());
        for apps in [json!([]),json!(["same","same"]),json!([""]),json!(vec!["x";201])]{assert!(super::wire::parse(&json!({"action":"mark_seen","apps":apps})).is_err());}
        assert!(super::wire::parse(&json!({"action":"mark_seen","apps":["x"],"permissions":{"org.read":"allow"}})).is_err());
        assert!(crate::http::apps::read_input(r#"{"action":"mark_seen","apps":["x"]}"#).is_err());
    }
}
