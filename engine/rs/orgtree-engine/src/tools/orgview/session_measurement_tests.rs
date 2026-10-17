use super::*;
use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
use tracing_subscriber::prelude::*;

struct NormCalls(Arc<AtomicUsize>);
impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for NormCalls {
    fn on_new_span(&self, attrs: &tracing::span::Attributes<'_>, _: &tracing::span::Id, _: tracing_subscriber::layer::Context<'_, S>) {
        struct Method(bool);
        impl tracing::field::Visit for Method {
            fn record_debug(&mut self, _: &tracing::field::Field, _: &dyn std::fmt::Debug) {}
            fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
                if field.name()=="m" && value=="domain.scope.norm_path" { self.0=true; }
            }
        }
        let mut method=Method(false);attrs.record(&mut method);
        if method.0 { self.0.fetch_add(1,Ordering::Relaxed); }
    }
}

#[test]
fn session_scope_baseline_measurement() {
    let mut rows=HashMap::new();
    let dirs:Vec<Value>=(0..24).map(|n|json!({"path":format!("D:/synthetic/folder-{n}"),"mode":"rw"})).collect();
    let ceiling=crate::domain::scope::org_ceiling(&json!(dirs));
    for id in 1..=35 {
        let parent=match id {1=>None,2=>Some(1),3=>Some(2),_=>Some(3)};
        rows.insert(id,(parent,json!({"add_dirs":dirs,"tools":{"mcp":["*"]},"org_visibility":"full"})));
    }
    let calls=Arc::new(AtomicUsize::new(0));
    let subscriber=tracing_subscriber::registry().with(NormCalls(calls.clone()));
    crate::domain::scope::normalization_measurement::reset();
    let start=std::time::Instant::now();
    let scopes=tracing::subscriber::with_default(subscriber,||{
        let mut cache=HashMap::new();
        (1..=35).map(|id|inspection_scope(id,&rows,&ceiling,&mut cache).unwrap()).collect::<Vec<_>>()
    });
    let elapsed=start.elapsed().as_secs_f64()*1000.0;
    for scope in scopes {assert_eq!(scope["add_dirs"],json!(dirs));}
    let normalizations=crate::domain::scope::normalization_measurement::count();
    println!("SESSION_SCOPE_MEASURE {}",json!({"fixture":"35 agents, shared depth3 +32 reports,24dirs each","norm_calls":normalizations,"logged_norm_calls":calls.load(Ordering::Relaxed),"elapsed_ms":elapsed,"tracing":"span counter only, no file logger; timing is not the live stall"}));
    assert!(normalizations>0,"counter must observe real product normalization");
    assert!(normalizations<5000,"shared ancestry and list normalization must avoid the measured154368-call baseline");
    assert_eq!(calls.load(Ordering::Relaxed),0,"pure normalization must not emit per-path spans");
}

// Frozen pre-optimization ancestry algorithm: compare the complete effective
// JSON, rather than checking only selected permission fields.
fn legacy_scope(id:i64,rows:&HashMap<i64,(Option<i64>,Value)>,ceiling:&Value)->Result<Value> {
    let mut chain=Vec::new();let mut next=Some(id);let mut seen=std::collections::HashSet::new();
    while let Some(at)=next {
        if chain.len()>=1024 || !seen.insert(at) {crate::refuse!(Conflict,"invalid scope ancestry");}
        let Some((parent,sc))=rows.get(&at) else {crate::refuse!(Conflict,"missing scope ancestor");};
        chain.push(sc);next=*parent;
    }
    let mut effective=ceiling.clone();
    for sc in chain.into_iter().rev() {effective=crate::domain::scope::clamp(sc,&effective);}
    Ok(effective)
}

#[test]
fn session_scope_memoization_preserves_complete_scope_in_any_request_order() {
    let ceiling=crate::domain::scope::org_ceiling(&json!([{"path":"D:/synthetic","mode":"rw"}]));
    let rows=HashMap::from([
        (1,(None,json!({"permission_mode":"default","org_visibility":"team","add_dirs":[{"path":"D:/synthetic/a","mode":"ro"},{"path":"D:/synthetic/b","mode":"rw"}],"tools":{"bash":false,"mcp":["one","two"]}}))),
        (2,(Some(1),json!({"permission_mode":"bypassPermissions","org_visibility":"full","add_dirs":["D:/synthetic/a/child","D:/synthetic/b","D:/synthetic/../outside"],"tools":{"mcp":["*"]}}))),
        (3,(Some(2),json!({"permission_mode":"plan","org_visibility":"self","add_dirs":["D:/synthetic/b/deeper"],"tools":{"mcp":["two","three"]},"extra_knob":7}))),
        (4,(Some(1),json!({"add_dirs":["D:/synthetic/a"],"tools":{"mcp":[]}}))),
    ]);
    for order in [[1,2,3,4],[3,4,2,1],[4,3,1,2]] {
        let mut cache=HashMap::new();
        for id in order {assert_eq!(inspection_scope(id,&rows,&ceiling,&mut cache).unwrap(),legacy_scope(id,&rows,&ceiling).unwrap());}
    }
}

#[test]
fn session_scope_memoization_keeps_missing_cycle_and_total_depth_refusals() {
    let ceiling=crate::domain::scope::org_ceiling(&json!([]));
    for rows in [HashMap::from([(1,(Some(2),json!({})))]),HashMap::from([(1,(Some(2),json!({}))),(2,(Some(1),json!({})))])] {
        assert!(inspection_scope(1,&rows,&ceiling,&mut HashMap::new()).is_err());
    }
    let rows:HashMap<_,_>=(1..=1025).map(|id|(id,((id>1).then_some(id-1),json!({})))).collect();
    let mut cache=HashMap::new();
    assert!(inspection_scope(1024,&rows,&ceiling,&mut cache).is_ok(),"original1024-node bound remains allowed");
    assert!(inspection_scope(1025,&rows,&ceiling,&mut cache).is_err(),"cached ancestor cannot hide excessive total depth");
    assert!(inspection_scope(1025,&rows,&ceiling,&mut HashMap::new()).is_err());
}

#[test]
fn session_scope_projection_preserves_visibility_filters_and_sibling_ranks() {
    let ceiling=crate::domain::scope::org_ceiling(&json!([]));
    let scopes=HashMap::from([(1,(None,json!({"org_visibility":"self"}))),(2,(Some(1),json!({}))),(3,(None,json!({})))]);
    let records=vec![(1,json!({"name":"me","state":"live","sibling_order":10})),(2,json!({"name":"child","state":"live","sibling_order":0})),(3,json!({"name":"hidden","state":"live","sibling_order":0}))];
    let project=|names|inspection_projection(1,"me".into(),false,names,scopes.clone(),records.clone(),ceiling.clone());
    let out:Value=serde_json::from_str(&project(Vec::new()).unwrap().text).unwrap();
    assert_eq!(out["nodes"].as_array().unwrap().len(),2);
    assert_eq!(out["nodes"][0]["name"],"me");
    assert_eq!(out["nodes"][0]["sibling_index"],1,"rank includes hidden live siblings");
    assert_eq!(out["nodes"][0]["live_sibling_count"],2);
    assert!(project(vec!["hidden".into()]).is_err(),"explicit filter cannot expose a hidden agent");
}

#[test]
fn session_scope_folder_list_optimization_preserves_overlap_and_path_semantics() {
    let dirs=json!([{"path":"D:/synthetic/a/../b/child","mode":"rw"},{"path":"D:/synthetic/boundary","mode":"rw"},{"path":"D:/synthetic/b/ro","mode":"ro"},{"path":7}]);
    let ceiling=json!([{"path":"D:/synthetic/b","mode":"ro"},{"path":"D:/synthetic/b/child","mode":"rw"},{"path":"D:/synthetic/b/ro","mode":"rw"},{}]);
    let out=crate::domain::scope::clamp_dirs(dirs.as_array().unwrap(),ceiling.as_array().unwrap());
    assert_eq!(out,json!([{"path":"D:/synthetic/a/../b/child","mode":"rw"},{"path":"D:/synthetic/b/ro","mode":"ro"}]).as_array().unwrap().clone());
}
