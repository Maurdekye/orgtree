//! Prototype-root guard: no database, no live data. Every protected location
//! comes from a SYNTHETIC environment map that points inside a temp folder,
//! so these tests never read or stat the real `%APPDATA%\Orgtree v2`.
//! Each refusal asserts its exact code, so a mutant that refuses for the
//! wrong reason still fails the test.

use orgtree_pg_custodian::guard::{self, Env, MARKER_FILE};
use std::path::{Path, PathBuf};

struct Sandbox {
    base: PathBuf,
    env: Env,
}

impl Sandbox {
    fn new(tag: &str) -> Self {
        let base = std::env::temp_dir().join(format!(
            "orgtree-p03-guard-{tag}-{}-{}",
            std::process::id(),
            orgtree_pg_custodian::win::random_hex(4).unwrap()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let fake_home = base.join("home");
        let fake_appdata = fake_home.join("AppData").join("Roaming");
        let live = fake_appdata.join("Orgtree v2").join("data");
        std::fs::create_dir_all(&live).unwrap();
        std::fs::create_dir_all(base.join("progfiles")).unwrap();
        let mut env = Env::new();
        env.insert("APPDATA".into(), fake_appdata.to_string_lossy().into());
        env.insert("USERPROFILE".into(), fake_home.to_string_lossy().into());
        env.insert("ORGTREE_DATA".into(), live.to_string_lossy().into());
        env.insert("ORGTREE_AGENT_PARENT_DATA".into(), live.to_string_lossy().to_lowercase());
        env.insert("ORGTREE_AGENT_LEGACY_DATA".into(), fake_home.join("orgtree").to_string_lossy().into());
        env.insert("ProgramFiles".into(), base.join("progfiles").to_string_lossy().into());
        Self { base, env }
    }
    fn live(&self) -> PathBuf {
        PathBuf::from(&self.env["ORGTREE_DATA"])
    }
    fn safe(&self, name: &str) -> PathBuf {
        self.base.join("roots").join(name)
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

fn code_of<T: std::fmt::Debug>(r: orgtree_pg_custodian::Result<T>) -> &'static str {
    match r {
        Ok(v) => panic!("expected a refusal, got Ok({v:?})"),
        Err(e) => e.code,
    }
}

#[test]
fn a_fresh_root_is_marked_and_then_validates() {
    let s = Sandbox::new("fresh");
    let p = s.safe("one");
    let r = guard::init_root(&p, &s.env).unwrap();
    assert_eq!(r.root_id().len(), 32);
    let again = guard::validate_root(&p, &s.env).unwrap();
    assert_eq!(again.root_id(), r.root_id());
    assert!(p.join(MARKER_FILE).is_file());
}

#[test]
fn an_unmarked_folder_is_refused() {
    let s = Sandbox::new("unmarked");
    let p = s.safe("plain");
    std::fs::create_dir_all(&p).unwrap();
    assert_eq!(code_of(guard::validate_root(&p, &s.env)), "root.unmarked");
}

#[test]
fn live_data_and_everything_under_it_is_refused_even_with_a_marker() {
    let s = Sandbox::new("live");
    let live = s.live();
    for p in [live.clone(), live.join("scratch").join("agent"), live.parent().unwrap().to_path_buf()] {
        assert_eq!(code_of(guard::init_root(&p, &s.env)), "root.protected", "{}", p.display());
        assert_eq!(code_of(guard::validate_root(&p, &s.env)), "root.protected", "{}", p.display());
    }
    // A marker planted inside live data does not make it acceptable.
    let planted = live.join("planted");
    std::fs::create_dir_all(&planted).unwrap();
    std::fs::write(planted.join(MARKER_FILE), "{}").unwrap();
    assert_eq!(code_of(guard::validate_root(&planted, &s.env)), "root.protected");
}

#[test]
fn an_ancestor_of_live_data_is_refused() {
    let s = Sandbox::new("ancestor");
    let home = PathBuf::from(&s.env["USERPROFILE"]);
    assert_eq!(code_of(guard::init_root(&home, &s.env)), "root.protected");
}

#[test]
fn spelling_tricks_do_not_escape_the_protected_check() {
    let s = Sandbox::new("spelling");
    let live = s.live();
    let upper = PathBuf::from(live.to_string_lossy().to_uppercase()).join("x");
    let slashed = PathBuf::from(live.to_string_lossy().replace('\\', "/")).join("x");
    let dotted = live.join("..").join("data").join("x");
    let trailing_dot = PathBuf::from(format!("{}.", live.to_string_lossy())).join("x");
    let verbatim = PathBuf::from(format!("\\\\?\\{}", live.join("x").to_string_lossy()));
    for p in [upper, slashed, dotted, trailing_dot, verbatim] {
        assert_eq!(code_of(guard::init_root(&p, &s.env)), "root.protected", "{}", p.display());
    }
}

#[test]
fn every_protected_variable_is_honoured_on_its_own() {
    // Each protected location, alone in the environment, must refuse.
    let s = Sandbox::new("each");
    let home = PathBuf::from(&s.env["USERPROFILE"]);
    let cases: Vec<(&str, String, PathBuf)> = vec![
        ("ORGTREE_DATA", s.env["ORGTREE_DATA"].clone(), s.live().join("r")),
        ("ORGTREE_AGENT_PARENT_DATA", s.env["ORGTREE_AGENT_PARENT_DATA"].clone(), s.live().join("r")),
        ("ORGTREE_AGENT_LEGACY_DATA", s.env["ORGTREE_AGENT_LEGACY_DATA"].clone(), home.join("orgtree").join("r")),
        ("APPDATA", s.env["APPDATA"].clone(), PathBuf::from(&s.env["APPDATA"]).join("Orgtree v2").join("r")),
        ("USERPROFILE", s.env["USERPROFILE"].clone(), home.join("orgtree").join("r")),
        ("ProgramFiles", s.env["ProgramFiles"].clone(), PathBuf::from(&s.env["ProgramFiles"]).join("Orgtree").join("r")),
    ];
    for (var, value, probe) in cases {
        let mut env = Env::new();
        env.insert(var.to_string(), value);
        assert_eq!(code_of(guard::check_location(&probe, &env)), "root.protected", "{var} alone did not protect {}", probe.display());
    }
}

#[test]
fn a_junction_into_live_data_is_refused_after_resolution() {
    let s = Sandbox::new("junction");
    let link = s.safe("link-to-live");
    std::fs::create_dir_all(link.parent().unwrap()).unwrap();
    let st = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(s.live())
        .output()
        .unwrap();
    assert!(st.status.success(), "mklink /J failed: {}", String::from_utf8_lossy(&st.stderr));
    // Typed path is innocent; resolved path is live data.
    assert_eq!(code_of(guard::init_root(&link.join("sub"), &s.env)), "root.protected");
    assert_eq!(code_of(guard::validate_root(&link, &s.env)), "root.protected");
    // Remove the junction itself (not its target) before the sandbox drops.
    std::fs::remove_dir(&link).unwrap();
    assert!(s.live().is_dir(), "junction removal must not touch the target");
}

#[test]
fn a_non_empty_folder_is_not_marked() {
    let s = Sandbox::new("nonempty");
    let p = s.safe("busy");
    std::fs::create_dir_all(&p).unwrap();
    std::fs::write(p.join("somebody-elses-file.txt"), "x").unwrap();
    assert_eq!(code_of(guard::init_root(&p, &s.env)), "root.not_empty");
    assert!(!p.join(MARKER_FILE).exists());
}

#[test]
fn a_copied_marker_is_refused() {
    let s = Sandbox::new("copied");
    let a = s.safe("a");
    guard::init_root(&a, &s.env).unwrap();
    let b = s.safe("b");
    std::fs::create_dir_all(&b).unwrap();
    std::fs::copy(a.join(MARKER_FILE), b.join(MARKER_FILE)).unwrap();
    assert_eq!(code_of(guard::validate_root(&b, &s.env)), "root.moved_or_copied");
}

#[test]
fn marker_fields_are_all_enforced() {
    let s = Sandbox::new("fields");
    let p = s.safe("m");
    guard::init_root(&p, &s.env).unwrap();
    let good = std::fs::read_to_string(p.join(MARKER_FILE)).unwrap();
    let v: serde_json::Value = serde_json::from_str(&good).unwrap();
    let cases = [
        ("schema", serde_json::json!("orgtree.p03.prototype-root/v0"), "root.bad_marker"),
        ("disposable", serde_json::json!(false), "root.not_disposable"),
        ("root_id", serde_json::json!("ABCDEF0123456789ABCDEF0123456789"), "root.bad_marker"),
        ("root_id", serde_json::json!("abc"), "root.bad_marker"),
    ];
    for (field, bad, code) in cases {
        let mut m = v.clone();
        m[field] = bad;
        std::fs::write(p.join(MARKER_FILE), serde_json::to_string(&m).unwrap()).unwrap();
        assert_eq!(code_of(guard::validate_root(&p, &s.env)), code, "field {field}");
    }
    let mut extra = v.clone();
    extra["surprise"] = serde_json::json!(1);
    std::fs::write(p.join(MARKER_FILE), serde_json::to_string(&extra).unwrap()).unwrap();
    assert_eq!(code_of(guard::validate_root(&p, &s.env)), "root.bad_marker");
    std::fs::write(p.join(MARKER_FILE), good).unwrap();
    guard::validate_root(&p, &s.env).unwrap();
}

#[test]
fn shape_rules() {
    let s = Sandbox::new("shape");
    assert_eq!(code_of(guard::check_location(Path::new("relative\\root"), &s.env)), "root.not_absolute");
    assert_eq!(code_of(guard::check_location(Path::new("C:relative"), &s.env)), "root.not_absolute");
    assert_eq!(code_of(guard::check_location(Path::new("C:\\"), &s.env)), "root.too_shallow");
    assert_eq!(code_of(guard::check_location(Path::new("C:\\onlyone"), &s.env)), "root.too_shallow");
    assert_eq!(code_of(guard::check_location(Path::new("\\\\server\\share\\a\\b"), &s.env)), "root.device_or_unc");
    assert_eq!(code_of(guard::check_location(Path::new("\\\\.\\pipe\\x\\y"), &s.env)), "root.device_or_unc");
    assert_eq!(code_of(guard::check_location(Path::new("\\\\?\\UNC\\server\\share\\a"), &s.env)), "root.device_or_unc");
}
