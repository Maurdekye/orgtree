//! Product roots (PYPG PG-1/PG-2): the engine's own data root, bound by
//! `bind-product`. Every test works in a fresh temporary folder and passes
//! its own environment map, so none of them can reach the live data.

use orgtree_prototype_guard::{
    bind_product_root, validate_product_root, validate_root, Env, GuardError, ProductBinding, PRODUCT_FILE, PRODUCT_SCHEMA,
};
use std::path::{Path, PathBuf};

struct Tmp(PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) {
        // the per-test parent folder (junctions are removed by each test first)
        let _ = std::fs::remove_dir_all(self.0.parent().unwrap());
    }
}

fn tmp(tag: &str) -> Tmp {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let p = std::env::temp_dir().join(format!("orgtree-product-test-{tag}-{}-{n}", std::process::id())).join("data");
    std::fs::create_dir_all(&p).unwrap();
    Tmp(p)
}

fn env_for(data: &Path) -> Env {
    let mut env = Env::new();
    env.insert("ORGTREE_DATA".into(), data.display().to_string());
    env
}

fn id() -> Result<String, GuardError> {
    Ok("0123456789abcdef0123456789abcdef".into())
}

fn bind(p: &Path, env: &Env) -> Result<orgtree_prototype_guard::PrototypeRoot, GuardError> {
    bind_product_root(p, env, id, 1, "test")
}

fn code<T: std::fmt::Debug>(r: Result<T, GuardError>) -> &'static str {
    r.expect_err("must refuse").code
}

#[test]
fn binds_and_validates_the_engines_own_root() {
    let t = tmp("ok");
    let env = env_for(&t.0);
    let r = bind(&t.0, &env).unwrap();
    assert!(r.is_product());
    assert_eq!(r.root_id(), "0123456789abcdef0123456789abcdef");
    let again = validate_product_root(&t.0, &env).unwrap();
    assert!(again.is_product());
    // a second bind keeps the first binding (idempotent), even with a new id
    let r2 = bind_product_root(&t.0, &env, || Ok("ffffffffffffffffffffffffffffffff".into()), 2, "test").unwrap();
    assert_eq!(r2.root_id(), "0123456789abcdef0123456789abcdef");
}

#[test]
fn a_product_root_is_never_a_prototype_root() {
    let t = tmp("notproto");
    let env = env_for(&t.0);
    bind(&t.0, &env).unwrap();
    // no prototype marker, and ORGTREE_DATA protects it from the prototype door
    assert!(validate_root(&t.0, &env).is_err());
    // and its marker form never passes the prototype marker check
    let r = validate_product_root(&t.0, &env).unwrap();
    let real = orgtree_prototype_guard::canonical(&t.0).unwrap();
    assert!(!r.marker().disposable);
    assert!(orgtree_prototype_guard::check_marker(r.marker(), &real).is_err());
}

#[test]
fn refuses_a_root_that_is_not_orgtree_data() {
    let t = tmp("other");
    let other = tmp("other2");
    assert_eq!(code(bind(&t.0, &env_for(&other.0))), "product.not_engine_root");
    assert_eq!(code(bind(&t.0, &Env::new())), "product.not_engine_root");
    // bound for itself, then served under another ORGTREE_DATA: refused
    bind(&t.0, &env_for(&t.0)).unwrap();
    assert_eq!(code(validate_product_root(&t.0, &env_for(&other.0))), "product.not_engine_root");
}

#[test]
fn refuses_in_an_agent_session_or_the_installed_app() {
    let t = tmp("deny");
    let parent = t.0.parent().unwrap().to_path_buf();
    for (var, val) in [
        ("ORGTREE_AGENT_PARENT_DATA", t.0.clone()),
        ("ORGTREE_AGENT_PARENT_DATA", parent.clone()),
        ("ORGTREE_AGENT_LEGACY_DATA", t.0.join("inner")),
    ] {
        let mut env = env_for(&t.0);
        env.insert(var.into(), val.display().to_string());
        assert_eq!(code(bind(&t.0, &env)), "root.protected", "{var}={}", val.display());
    }
    // %ProgramFiles%\Orgtree around the root
    let pf = t.0.parent().unwrap().parent().unwrap();
    let inside = pf.join("Orgtree").join("data");
    std::fs::create_dir_all(&inside).unwrap();
    let mut env = env_for(&inside);
    env.insert("ProgramFiles".into(), pf.display().to_string());
    assert_eq!(code(bind(&inside, &env)), "root.protected");
    let _ = std::fs::remove_dir_all(pf.join("Orgtree"));
    // a binding written earlier does not help once an agent variable names it
    bind(&t.0, &env_for(&t.0)).unwrap();
    let mut env = env_for(&t.0);
    env.insert("ORGTREE_AGENT_PARENT_DATA".into(), t.0.display().to_string());
    assert_eq!(code(validate_product_root(&t.0, &env)), "root.protected");
}

#[test]
fn refuses_unbound_badly_bound_and_copied_roots() {
    let t = tmp("binding");
    let env = env_for(&t.0);
    assert_eq!(code(validate_product_root(&t.0, &env)), "product.unbound");
    let write = |b: &ProductBinding| std::fs::write(t.0.join(PRODUCT_FILE), serde_json::to_string(b).unwrap()).unwrap();
    let real = orgtree_prototype_guard::canonical(&t.0).unwrap();
    let good = ProductBinding {
        schema: PRODUCT_SCHEMA.into(),
        root_id: "0123456789abcdef0123456789abcdef".into(),
        root_path: real.clone(),
        created_at_unix: 1,
        created_by: "t".into(),
    };
    write(&good);
    validate_product_root(&t.0, &env).unwrap();
    write(&ProductBinding { schema: "orgtree.p03.prototype-root/v1".into(), ..good.clone() });
    assert_eq!(code(validate_product_root(&t.0, &env)), "product.bad_binding");
    write(&ProductBinding { root_id: "0123456789ABCDEF0123456789ABCDEF".into(), ..good.clone() });
    assert_eq!(code(validate_product_root(&t.0, &env)), "product.bad_binding");
    write(&ProductBinding { root_path: format!("{real}-copy"), ..good.clone() });
    assert_eq!(code(validate_product_root(&t.0, &env)), "root.moved_or_copied");
    // an extra field is refused (strict parse)
    std::fs::write(t.0.join(PRODUCT_FILE), r#"{"schema":"orgtree.product-root/v1","root_id":"0123456789abcdef0123456789abcdef","root_path":"x","created_at_unix":1,"created_by":"t","disposable":true}"#).unwrap();
    assert_eq!(code(validate_product_root(&t.0, &env)), "product.bad_binding");
    // bind over a binding for another path refuses rather than overwriting
    write(&ProductBinding { root_path: format!("{real}-copy"), ..good });
    assert_eq!(code(bind(&t.0, &env)), "root.moved_or_copied");
}

#[cfg(windows)]
#[test]
fn refuses_a_junction_in_the_cluster_folder_or_at_the_root() {
    let t = tmp("junction");
    let env = env_for(&t.0);
    bind(&t.0, &env).unwrap();
    let target = t.0.parent().unwrap().join("elsewhere");
    std::fs::create_dir_all(&target).unwrap();
    std::fs::create_dir_all(t.0.join("pg")).unwrap();
    let link = t.0.join("pg").join("cluster");
    let ok = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&link)
        .arg(&target)
        .stdout(std::process::Stdio::null())
        .status()
        .unwrap()
        .success();
    assert!(ok, "mklink /J failed");
    assert_eq!(code(validate_product_root(&t.0, &env)), "root.reparse_point");
    std::fs::remove_dir(&link).unwrap();
    validate_product_root(&t.0, &env).unwrap();
    // a junction elsewhere in the data root is not the custodian's business
    let other = t.0.join("scratch-link");
    assert!(std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(&other).arg(&target)
        .stdout(std::process::Stdio::null()).status().unwrap().success());
    validate_product_root(&t.0, &env).unwrap();
    std::fs::remove_dir(&other).unwrap();
    // the root itself as a junction: refused (ORGTREE_DATA names the link)
    let root_link = t.0.parent().unwrap().join("data-link");
    assert!(std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(&root_link).arg(&t.0)
        .stdout(std::process::Stdio::null()).status().unwrap().success());
    let r = validate_product_root(&root_link, &env_for(&root_link));
    std::fs::remove_dir(&root_link).unwrap();
    assert_eq!(code(r), "root.reparse_point");
}
