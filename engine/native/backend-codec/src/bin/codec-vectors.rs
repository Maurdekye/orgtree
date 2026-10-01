//! Local test driver: check a vectors file against this crate and print a
//! JSON report. It reads one file, writes to stdout only, and opens no
//! socket. Exit code 0 means every row matched; 1 means a mismatch.
//!
//! Usage: codec-vectors [PATH]   (default: the committed vectors)

use orgtree_backend_codec::vectors::{run, Implementation, COMMITTED};
use orgtree_backend_codec::UNRESOLVED;

fn json_str(s: &str) -> String {
    orgtree_backend_codec::json::python_ascii_string(s)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (source, text) = match args.as_slice() {
        [] => ("<committed>".to_owned(), COMMITTED.to_owned()),
        [path] => match std::fs::read_to_string(path) {
            Ok(t) => (path.clone(), t),
            Err(e) => {
                eprintln!("cannot read {path}: {e}");
                std::process::exit(2);
            }
        },
        _ => {
            eprintln!("usage: codec-vectors [PATH]");
            std::process::exit(2);
        }
    };
    let report = run(&text, &Implementation::REFERENCE);
    let sections: Vec<String> =
        report.checked.iter().map(|(name, n)| format!("{}:{}", json_str(name), n)).collect();
    let failures: Vec<String> = report.failures.iter().map(|f| json_str(f)).collect();
    let unresolved: Vec<String> = UNRESOLVED.iter().map(|u| json_str(u.id)).collect();
    println!(
        "{{\"source\":{},\"rows\":{},\"sections\":{{{}}},\"failures\":[{}],\"unresolved\":[{}]}}",
        json_str(&source),
        report.total(),
        sections.join(","),
        failures.join(","),
        unresolved.join(",")
    );
    std::process::exit(if report.failures.is_empty() { 0 } else { 1 });
}
