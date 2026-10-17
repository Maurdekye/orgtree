//! Snapshot retention deals only in paths and ownership metadata, never skill text.
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Default)]
pub struct References {
    pub paths: Vec<PathBuf>,
    pub uncertain: bool,
}

#[nolog]
fn session_references(_session: Option<&str>, _generation: i32, _record: &serde_json::Value) -> References {
    References::default()
}

#[nolog]
fn prune(_data: &Path, _current: &str, _refs: &References, _observed: SystemTime, _now: SystemTime) -> anyhow::Result<()> {
    // Red control: current materialization never removes old snapshots.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use std::fs::{self, File, FileTimes};

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("orgtree-skills-prune-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(p.join("shared-skills")).unwrap();
            Self(p)
        }
        fn root(&self) -> PathBuf { self.0.join("shared-skills") }
        fn snapshot(&self, n: u8) -> PathBuf {
            let p = self.root().join(format!("{n:064x}"));
            fs::create_dir(&p).unwrap();
            fs::write(p.join(".orgtree-skill.json"), br#"{"owner":"orgtree-skills-v1"}"#).unwrap();
            fs::write(p.join("complete.json"), format!(r#"{{"digest":"{n:064x}"}}"#)).unwrap();
            fs::write(p.join("asset.txt"), "retain or remove the whole owned snapshot").unwrap();
            set_age(&p.join("complete.json"), 100 - u64::from(n));
            p
        }
        fn stage(&self, name: &str, age: u64, marker: bool) -> PathBuf {
            let p = self.root().join(format!(".stage-{name}"));
            fs::create_dir(&p).unwrap();
            if marker { fs::write(p.join(".orgtree-skill.json"), br#"{"owner":"orgtree-skills-v1"}"#).unwrap(); }
            set_age(&p, age);
            p
        }
        fn prune(&self, refs: References) {
            prune(&self.0, &format!("{:064x}", 4), &refs, SystemTime::now(), SystemTime::now()).unwrap();
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) { fs::remove_dir_all(&self.0).unwrap(); }
    }
    fn set_age(p: &Path, seconds: u64) {
        let f = if p.is_dir() {
            #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; fs::OpenOptions::new().access_mode(0x100).custom_flags(0x02000000).open(p).unwrap() }
            #[cfg(not(windows))] { File::open(p).unwrap() }
        } else { fs::OpenOptions::new().write(true).open(p).unwrap() };
        f.set_times(FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(seconds))).unwrap();
    }

    #[test]
    fn skills_prune_removes_old_and_keeps_current_previous() {
        let t = Temp::new();
        let old = t.snapshot(1);
        let second = t.snapshot(2);
        let previous = t.snapshot(3);
        let current = t.snapshot(4);
        t.prune(References::default());
        assert!(!old.exists(), "unreferenced old snapshot was not pruned");
        assert!(!second.exists());
        assert!(previous.join("asset.txt").is_file());
        assert!(current.join("asset.txt").is_file());
    }

    #[test]
    fn skills_prune_keeps_nested_grants_and_unknown_use() {
        let t = Temp::new();
        let used = t.snapshot(1);
        let unused = t.snapshot(2);
        t.snapshot(3); t.snapshot(4);
        t.prune(References { paths: vec![used.join("skills")], uncertain: true });
        assert!(used.exists() && unused.exists(), "unknown managed use must retain all candidates");
        t.prune(References { paths: vec![used.join("asset.txt")], uncertain: false });
        assert!(used.exists(), "a nested granted folder protects its snapshot");
        assert!(!unused.exists(), "one referenced snapshot must not suppress other cleanup");
    }

    #[test]
    fn skills_prune_stages_require_marker_and_one_hour() {
        let t = Temp::new(); t.snapshot(4);
        let abandoned = t.stage("old", 7200, true);
        let fresh = t.stage("fresh", 1, true);
        let foreign = t.stage("foreign", 7200, false);
        let unowned = t.snapshot(1);
        fs::remove_file(unowned.join(".orgtree-skill.json")).unwrap();
        let incomplete = t.root().join(format!("{:064x}", 9));
        fs::create_dir(&incomplete).unwrap();
        fs::write(incomplete.join(".orgtree-skill.json"), br#"{"owner":"orgtree-skills-v1"}"#).unwrap();
        t.prune(References::default());
        assert!(!abandoned.exists(), "abandoned owned staging directory was not pruned");
        assert!(fresh.exists() && foreign.exists() && unowned.exists() && incomplete.exists());
    }

    #[test]
    fn skills_prune_session_bindings_survive_idle_and_reject_stale_records() {
        use serde_json::json;
        let record = json!({"session":"thread-a","generation":2,"paths":["snapshot/old"],"known":true});
        let idle = session_references(Some("thread-a"), 2, &record);
        assert_eq!(idle.paths, vec![PathBuf::from("snapshot/old")]);
        assert!(!idle.uncertain);
        assert!(session_references(Some("thread-b"), 2, &record).uncertain);
        assert!(session_references(Some("thread-a"), 3, &record).uncertain);
        assert!(session_references(Some("legacy"), 1, &json!(null)).uncertain);
        assert!(!session_references(None, 1, &json!(null)).uncertain);
        assert!(session_references(Some("thread-a"), 2,
            &json!({"session":"thread-a","generation":2,"known":true,"paths":[42]})).uncertain);
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn skills_prune_rejects_snapshot_and_nested_links() {
        let t = Temp::new(); t.snapshot(3); t.snapshot(4);
        let nested = t.snapshot(1);
        let outside = t.0.join("outside"); fs::create_dir(&outside).unwrap();
        fs::write(outside.join("canary"), "untouched").unwrap();
        let link = t.root().join(format!("{:064x}", 2));
        let inner = nested.join("link");
        super::super::tests::directory_link(&outside, &link);
        super::super::tests::directory_link(&outside, &inner);
        t.prune(References::default());
        assert!(nested.exists() && link.exists());
        assert_eq!(fs::read_to_string(outside.join("canary")).unwrap(), "untouched");
        #[cfg(windows)] { fs::remove_dir(&link).unwrap(); fs::remove_dir(&inner).unwrap(); }
        #[cfg(unix)] { fs::remove_file(&link).unwrap(); fs::remove_file(&inner).unwrap(); }
    }
}
