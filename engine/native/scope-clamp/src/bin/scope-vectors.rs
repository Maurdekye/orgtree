//! Local test driver: check a vectors file against this crate and print a
//! JSON report. It reads one file, writes to stdout only, and opens no
//! socket. Exit code 0 means every row of every required section matched;
//! 1 means a mismatch or a missing section; 2 means bad usage.
//!
//! Usage: scope-vectors [PATH]   (default: the committed vectors)

use orgtree_backend_codec::json::python_ascii_string as json_str;
use orgtree_scope_clamp::vectors::{run, COMMITTED};
use orgtree_scope_clamp::Rules;

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
            eprintln!("usage: scope-vectors [PATH]");
            std::process::exit(2);
        }
    };
    let report = run(&text, &Rules::LEGACY);
    let sections: Vec<String> = report
        .checked
        .iter()
        .map(|(name, n)| format!("{}:{}", json_str(name), n))
        .collect();
    let failures: Vec<String> = report.failures.iter().map(|f| json_str(f)).collect();
    println!(
        r#"{{"source":{},"rows":{},"sections":{{{}}},"failures":[{}]}}"#,
        json_str(&source),
        report.total(),
        sections.join(","),
        failures.join(",")
    );
    if !report.failures.is_empty() {
        std::process::exit(1);
    }
}
