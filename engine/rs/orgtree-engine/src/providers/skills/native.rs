//! Native discovery is profile-specific. Do not serialize private skill text.

#[cfg(test)]
mod tests {
    use super::super::*;
    use crate::runtime::{identity::Lane, startup::Inputs};

    fn input(home: &Path, config: &Path, cwd: &Path) -> Inputs {
        Inputs::Claude { home: home.into(), config: config.into(), cwd: cwd.into(), add_dirs: vec![] }
    }
    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path,text).unwrap();
    }
    fn bundle(name: &str, source: &str, resource: &str) -> Bundle {
        bundle_from_files(BTreeMap::from([
            (PathBuf::from("SKILL.md"),format!("---\nname: {name}\ndescription: Native availability fixture\n---\nBody\n").into_bytes()),
            (PathBuf::from("data.txt"),resource.as_bytes().to_vec()),
        ]),source,name).unwrap()
    }
    fn materialize(root: &Path,b: &Bundle) {
        for (file,bytes) in b.files.iter() {
            let dest=root.join(file);std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
            std::fs::write(dest,bytes).unwrap();
        }
    }
    const ORG: &str="11111111-1111-4111-8111-111111111111";

    #[test]
    fn native_catalog_active_synced_bucket_suppresses_only_matching_content() {
        let tmp=super::super::tests::Temp::new();
        let home=&tmp.0;let config=home.join(".claude");let cwd=home.join("work");
        write(&home.join(".claude.json"),&json!({"oauthAccount":{"organizationUuid":ORG}}).to_string());
        let bucket=config.join("skills/synced").join(format!("{ORG}_account"));
        write(&bucket.join(".last-complete-round"),"complete fixture");
        let native=bundle("pdf","claude","native");
        materialize(&bucket.join("pdf"),&native);
        let custom=bundle("pdf","workspace","custom");
        let registry=merge(vec![native,custom]);
        let selected=registry.for_startup(Lane::Claude,&input(home,&config,&cwd));
        assert_eq!(selected.bundles.len(),1,"native namespace supplies identical skill, but a distinct resource tree survives");
        assert_eq!(selected.bundles[0].files[Path::new("data.txt")],b"custom");
        let other=home.join("other-profile");
        write(&other.join(".claude.json"),&json!({"oauthAccount":{"organizationUuid":"22222222-2222-4222-8222-222222222222"}}).to_string());
        assert!(!registry.for_startup(Lane::Claude,&input(home,&other,&cwd)).bundles.is_empty(),"another account keeps its fallback");
        assert!(!registry.for_startup(Lane::Codex,&input(home,&config,&cwd)).bundles.is_empty(),"native Claude discovery never removes another lane's copy");
    }

    #[test]
    fn native_catalog_installed_plugins_need_exact_profile_enablement() {
        let tmp=super::super::tests::Temp::new();let home=&tmp.0;
        let config=home.join(".claude");let cwd=home.join("work");let plugin=home.join("plugin");
        let original=bundle("typesafe-ai","claude-plugin","same");
        materialize(&plugin.join("skills/typesafe-ai"),&original);
        write(&plugin.join(".claude-plugin/plugin.json"),"{\"name\":\"typesafe\"}");
        write(&config.join("plugins/installed_plugins.json"),&json!({"version":2,"plugins":{"typesafe@test":[{"scope":"user","installPath":plugin}]}}).to_string());
        let registry=merge(vec![original]);
        let inputs=input(home,&config,&cwd);
        assert_eq!(registry.for_startup(Lane::Claude,&inputs).bundles.len(),1,"installation alone is not enabled-native evidence");
        write(&config.join("settings.json"),"{\"enabledPlugins\":{\"typesafe@test\":true}}");
        assert!(registry.for_startup(Lane::Claude,&inputs).bundles.is_empty(),"enabled plugin supplies the identical skill");
        write(&cwd.join(".claude/settings.local.json"),"{\"enabledPlugins\":{\"typesafe@test\":false}}");
        assert_eq!(registry.for_startup(Lane::Claude,&inputs).bundles.len(),1,"local disable preserves the bare fallback");
        assert_eq!(registry.for_startup(Lane::Claude,&input(home,&home.join("unknown-profile"),&cwd)).bundles.len(),1);
    }

    #[test]
    fn native_catalog_claude_omits_codex_only_but_keeps_unpaired_portable_skills() {
        let registry=merge(["openai-docs","imagegen","skill-installer","portable-helper"].into_iter().map(|name|bundle(name,"codex","r")).collect());
        let inputs=Inputs::None;
        assert_eq!(registry.for_startup(Lane::Claude,&inputs).names(),["portable-helper"]);
        assert_eq!(registry.for_startup(Lane::Codex,&inputs).bundles.len(),4);
        assert_eq!(registry.for_startup(Lane::Muse,&inputs).bundles.len(),4);
    }
}
