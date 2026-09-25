//! Lead condition on `Statement.sql`: statement text never carries a value
//! built from arguments. `Tx::exec` takes `&'static str`, so `format!`-built
//! SQL does not compile (doctest in `exec`); this test closes the escape
//! hatch of leaking a runtime string to `'static`.

#[test]
fn no_source_leaks_a_runtime_string_to_static() {
    let src = concat!(env!("CARGO_MANIFEST_DIR"), "/src");
    let mut scanned = 0;
    for e in std::fs::read_dir(src).unwrap() {
        let p = e.unwrap().path();
        if p.extension().and_then(|x| x.to_str()) != Some("rs") {
            continue;
        }
        let text = std::fs::read_to_string(&p).unwrap();
        scanned += 1;
        for bad in ["Box::leak", ".leak()", "String::leak", "transmute"] {
            assert!(!text.contains(bad), "{} contains {bad}", p.display());
        }
    }
    assert!(scanned >= 10, "scanned only {scanned} files: the check did not run");
}
