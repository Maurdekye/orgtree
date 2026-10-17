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
fn session_blip_scope_baseline_measurement() {
    let mut rows=HashMap::new();
    let dirs:Vec<Value>=(0..24).map(|n|json!({"path":format!("D:/synthetic/folder-{n}"),"mode":"rw"})).collect();
    let ceiling=crate::domain::scope::org_ceiling(&json!(dirs));
    for id in 1..=35 {
        let parent=match id {1=>None,2=>Some(1),3=>Some(2),_=>Some(3)};
        rows.insert(id,(parent,json!({"add_dirs":dirs,"tools":{"mcp":["*"]},"org_visibility":"full"})));
    }
    let calls=Arc::new(AtomicUsize::new(0));
    let subscriber=tracing_subscriber::registry().with(NormCalls(calls.clone()));
    let start=std::time::Instant::now();
    let scopes=tracing::subscriber::with_default(subscriber,||{
        (1..=35).map(|id|inspection_scope(id,&rows,&ceiling).unwrap()).collect::<Vec<_>>()
    });
    let elapsed=start.elapsed().as_secs_f64()*1000.0;
    for scope in scopes {assert_eq!(scope["add_dirs"],json!(dirs));}
    println!("SESSION_SCOPE_MEASURE {}",json!({"fixture":"35 agents, shared depth3 +32 reports,24dirs each","norm_calls":calls.load(Ordering::Relaxed),"elapsed_ms":elapsed,"tracing":"span counter only, no file logger; timing is not the live stall"}));
    assert!(calls.load(Ordering::Relaxed)>0,"counter must observe real product normalization");
}
