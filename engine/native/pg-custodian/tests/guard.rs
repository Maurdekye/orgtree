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
fn spelling_tricks_against_a_protected_folder_that_does_not_exist_yet() {
    // Resolution cannot normalize a missing folder, so the lexical form alone
    // must catch case and trailing-dot variants (the legacy ~/orgtree folder
    // may well not exist on a machine).
    let s = Sandbox::new("missing");
    let home = PathBuf::from(&s.env["USERPROFILE"]);
    assert!(!home.join("orgtree").exists());
    let mut env = Env::new();
    env.insert("ORGTREE_AGENT_LEGACY_DATA".into(), s.env["ORGTREE_AGENT_LEGACY_DATA"].clone());
    for p in [home.join("ORGTREE").join("x"), home.join("orgtree.").join("x"), home.join("OrgTree .").join("x")] {
        assert_eq!(code_of(guard::check_location(&p, &env)), "root.protected", "{}", p.display());
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
    // Loopback host on purpose: under a mutant that stops refusing UNC, the
    // resolve step would touch this path, and it must not leave the machine.
    assert_eq!(code_of(guard::check_location(Path::new("\\\\127.0.0.1\\no-such-share-p03\\a\\b"), &s.env)), "root.device_or_unc");
    assert_eq!(code_of(guard::check_location(Path::new("\\\\.\\pipe\\x\\y"), &s.env)), "root.device_or_unc");
    assert_eq!(code_of(guard::check_location(Path::new("\\\\?\\UNC\\server\\share\\a"), &s.env)), "root.device_or_unc");
}

// ---------------------------------------------------------------- shared-guard rules (lead ruling 09:02Z)

fn junction(link: &Path, target: &Path) {
    std::fs::create_dir_all(link.parent().unwrap()).unwrap();
    let out = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().unwrap();
    assert!(out.status.success(), "mklink /J failed: {}", String::from_utf8_lossy(&out.stderr));
}

/// Write a VALID marker (schema, disposable, id, bound to the canonical path)
/// without going through init_root, as an attacker or a copy would.
fn plant_valid_marker(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    let m = guard::RootMarker {
        schema: guard::MARKER_SCHEMA.into(),
        root_id: "0123456789abcdef0123456789abcdef".into(),
        root_path: guard::canonical(dir).unwrap(),
        disposable: true,
        created_at_unix: 0,
        created_by: "test".into(),
    };
    std::fs::write(dir.join(MARKER_FILE), serde_json::to_string(&m).unwrap()).unwrap();
}

#[test]
fn a_root_containing_a_junction_is_refused_wherever_it_points() {
    let s = Sandbox::new("contains-junction");
    let p = s.safe("r");
    guard::init_root(&p, &s.env).unwrap();
    // Into live data...
    junction(&p.join("pg").join("sneaky"), &s.live());
    assert_eq!(code_of(guard::validate_root(&p, &s.env)), "root.reparse_point");
    std::fs::remove_dir(p.join("pg").join("sneaky")).unwrap();
    guard::validate_root(&p, &s.env).unwrap();
    // ...and anywhere else: a prototype root contains no reparse point at all.
    let elsewhere = s.base.join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    junction(&p.join("deep").join("er").join("link"), &elsewhere);
    assert_eq!(code_of(guard::validate_root(&p, &s.env)), "root.reparse_point");
    std::fs::remove_dir(p.join("deep").join("er").join("link")).unwrap();
    assert!(s.live().is_dir() && elsewhere.is_dir(), "removing the junctions must not touch targets");
}

#[test]
fn a_root_that_is_itself_a_junction_is_refused() {
    let s = Sandbox::new("root-junction");
    let real = s.safe("real");
    guard::init_root(&real, &s.env).unwrap();
    let link = s.safe("link");
    junction(&link, &real);
    let e = guard::validate_root(&link, &s.env).unwrap_err();
    assert!(e.code == "root.reparse_point" || e.code == "root.moved_or_copied", "{e}");
    std::fs::remove_dir(&link).unwrap();
}

#[test]
fn a_valid_marker_planted_in_live_data_never_unlocks_it() {
    let s = Sandbox::new("planted-valid");
    let planted = s.live().join("prototype");
    plant_valid_marker(&planted);
    assert_eq!(code_of(guard::validate_root(&planted, &s.env)), "root.protected");
    // Even pointing ORGTREE_DATA at it does not unlock it: it sits inside
    // %APPDATA%\Orgtree v2, which is unconditional.
    let mut env = s.env.clone();
    env.insert("ORGTREE_DATA".into(), planted.to_string_lossy().into());
    assert_eq!(code_of(guard::validate_root(&planted, &env)), "root.protected");
    assert!(
        guard::protected_locations(&env).iter().any(|(l, _)| l == "ORGTREE_DATA"),
        "ORGTREE_DATA inside an unconditional location must stay on the protected list"
    );
}

#[test]
fn orgtree_data_is_unlocked_only_when_it_is_a_valid_prototype_root() {
    let s = Sandbox::new("host-mode");
    // Host mode: ORGTREE_DATA IS a prototype root outside every live place.
    let proto = s.safe("served");
    guard::init_root(&proto, &s.env).unwrap();
    let mut env = s.env.clone();
    env.insert("ORGTREE_DATA".into(), proto.to_string_lossy().into());
    guard::validate_root(&proto, &env).unwrap();
    assert!(!guard::protected_locations(&env).iter().any(|(l, _)| l == "ORGTREE_DATA"));
    // Not a prototype root (no marker): ORGTREE_DATA stays protected.
    let plain = s.safe("plain");
    std::fs::create_dir_all(&plain).unwrap();
    env.insert("ORGTREE_DATA".into(), plain.to_string_lossy().into());
    assert_eq!(code_of(guard::check_location(&plain.join("x"), &env)), "root.protected");
    // A marker copied from another root (bound elsewhere) does not unlock it.
    std::fs::copy(proto.join(MARKER_FILE), plain.join(MARKER_FILE)).unwrap();
    assert_eq!(code_of(guard::validate_root(&plain, &env)), "root.protected");
    // A spelling variant of the served root is the same root.
    env.insert("ORGTREE_DATA".into(), proto.to_string_lossy().to_uppercase());
    guard::validate_root(&proto, &env).unwrap();
}

#[test]
fn a_protected_location_spelled_through_a_junction_is_still_protected() {
    // The environment names live data by a junction; the candidate names the
    // real folder. Only canonicalizing the PROTECTED side catches this.
    let s = Sandbox::new("protected-via-junction");
    let alias = s.base.join("alias-of-live");
    junction(&alias, &s.live());
    let mut env = Env::new();
    env.insert("ORGTREE_AGENT_PARENT_DATA".into(), alias.to_string_lossy().into());
    assert_eq!(code_of(guard::check_location(&s.live().join("x"), &env)), "root.protected");
    std::fs::remove_dir(&alias).unwrap();
}

/// The 8.3 short name of an existing path, if the volume generates them.
fn short_name(p: &Path) -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;
    // raw_arg: cmd must see the quotes exactly, not Rust's \" escaping.
    let out = std::process::Command::new("cmd")
        .raw_arg(format!("/D /C for %I in (\"{}\") do @echo %~sI", p.display()))
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    println!("short name of {} = {s:?}", p.display());
    let ok = s.len() > 3 && s.as_bytes()[1] == b':' && !s.contains('"') && !s.eq_ignore_ascii_case(&p.to_string_lossy());
    ok.then(|| PathBuf::from(s))
}

#[test]
fn forbidden_characters_and_malformed_protected_values_are_refused() {
    let s = Sandbox::new("bad-names");
    let base = s.safe("x").to_string_lossy().to_string();
    for bad in [format!("{base}\\\"C:\\y"), format!("{base}\\data:stream"), format!("{base}\\a*b"), format!("{base}\\a?b"), format!("{base}\\a|b")] {
        assert_eq!(code_of(guard::check_location(Path::new(&bad), &s.env)), "root.bad_name", "{bad}");
    }
    // A protected variable holding a malformed value fails closed and names itself.
    let mut env = Env::new();
    env.insert("ORGTREE_AGENT_PARENT_DATA".into(), format!("\"{}\"", s.live().display()));
    let e = guard::check_location(&s.live().join("x"), &env).unwrap_err();
    assert_eq!(e.code, "guard.bad_protected_location");
    assert!(e.message.contains("ORGTREE_AGENT_PARENT_DATA"), "{e}");
}

#[test]
fn eight_dot_three_spellings_of_live_paths_are_refused() {
    let s = Sandbox::new("short-names");
    // "Orgtree v2" has a space, so it gets an 8.3 alias where the volume makes them.
    let Some(short_live) = short_name(&s.live()) else {
        println!("NOT EXERCISED: this volume generates no 8.3 names; case variants are covered elsewhere");
        return;
    };
    assert_ne!(guard::lexical(&short_live).unwrap(), guard::lexical(&s.live()).unwrap(), "the short spelling must differ lexically");
    // Candidate spelled short, environment spelled long.
    assert_eq!(code_of(guard::check_location(&short_live.join("x"), &s.env)), "root.protected");
    // Environment spelled short, candidate spelled long.
    let mut env = Env::new();
    env.insert("ORGTREE_AGENT_PARENT_DATA".into(), short_live.to_string_lossy().into());
    assert_eq!(code_of(guard::check_location(&s.live().join("x"), &env)), "root.protected");
    println!("EXERCISED: 8.3 alias {}", short_live.display());
}
