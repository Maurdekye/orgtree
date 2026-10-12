// A native executable stand-in for the desktop in observer launch proofs.
// No network/credentials; bounded lifetime and cooperative stop in its own rig.
use std::{env, fs, path::PathBuf, thread, time::{Duration, Instant}};
fn main() {
    let root = PathBuf::from(env::var("ORGTREE_RECOVERY_FIXTURE_ROOT").expect("isolated root"));
    assert!(root.join(".orgtree-rig-root").is_file());
    let recovered = env::args().any(|s| s == "--core-recovered");
    let label = if recovered { "recovered".to_string() } else { env::args().nth(1).unwrap_or("desktop".into()) };
    assert!(["desktop", "engine", "recovered"].contains(&label.as_str()));
    fs::write(root.join(format!("{label}.pid")), std::process::id().to_string()).unwrap();
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(180) && !root.join("fixture-stop").is_file() {
        thread::sleep(Duration::from_millis(50));
    }
}
