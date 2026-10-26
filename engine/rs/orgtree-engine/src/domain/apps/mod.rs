pub mod bridge;
pub(crate) mod files;
pub mod wire;
pub mod storage;
pub use storage::run;

#[cfg(test)] mod template_control {
    use serde_json::json;
    use crate::domain::templates;
    #[test] fn custom_apps_templates_expose_definition_count_without_exposing_html(){
        let raw=json!({"id":"app-team","name":"App team","apps":[{"name":"Notes","html":"<p>PRIVATE-TEMPLATE-5831</p>","initial_state":{"note":"PRIVATE-TEMPLATE-5831"},"capabilities":["mail.send"]}]});
        let t=templates::parse(&raw.to_string()).unwrap();let out=templates::plan_json(&t,&[],&[]);
        assert_eq!(out["apps"],1,"template preview must count portable app definitions");
        assert!(!format!("{t:?}").contains("PRIVATE-TEMPLATE-5831"));assert!(!out.to_string().contains("PRIVATE-TEMPLATE-5831"));
    }
    #[test] fn custom_apps_templates_refuse_grants_ids_and_saved_panel_data(){
        let base=json!({"id":"app-team","name":"App team","apps":[{"name":"Notes","html":"<p>notes</p>"}]});
        for (key,value) in [("permissions",json!({"mail.send":"allow"})),("panels",json!([{"state":{"private":"saved"}}])),("id",json!("foreign-id"))]{let mut bad=base.clone();bad["apps"][0][key]=value;assert!(templates::parse(&bad.to_string()).is_err(),"template apps must refuse {key}");}
    }
}
