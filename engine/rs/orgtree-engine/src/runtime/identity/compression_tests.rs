//! Approved 2026-10-20 wording, rendered through the production builder.
//! All identities, paths and notes here are synthetic; no engine or DB is opened.
use super::*;
use serde_json::json;
use std::collections::BTreeMap;

fn example(coordinator: bool) -> String {
    let name = if coordinator { "coordinator" } else { "fresh-agent" };
    let base = json!({"permission_mode":"acceptEdits",
        "org_visibility":if coordinator {"full"} else {"subtree"}, "add_dirs":[],
        "tools":{"bash":true,"edit":true,"web":true,"subagents":true,"mcp":[],
        "orgtree":{"docket":true,"team":true,"messaging":true,"inspection":true,
        "watchdogs":true,"runtime":true,"user":true,"logo":true}}});
    let teams = crate::domain::teams::workspaces(
        std::path::Path::new("D:/synthetic/data/scratch/example/_teams"), &[(1, name.into())]);
    let scope = crate::domain::scope::with_team_workspaces(
        &crate::domain::scope::with_org_notes(&base, "D:/synthetic/data/scratch/example/_shared"), &teams);
    identity(&Identity {
        name, title:"", org_name:"Example", org_slug:"example",
        scratch:if coordinator {"D:/synthetic/data/scratch/example/coordinator"} else {"D:/synthetic/data/scratch/example/fresh-agent"},
        charter:Some(if coordinator {"[Placeholder coordinator charter.]"} else {"[Placeholder charter.]"}),
        team_charter:None, cascade:&[], superior:None, org_md:Some(""), lane:Lane::Codex,
        scope:&scope, codex_sandbox:Some("workspace-write"), mcp_servers:&[],
        extern_holder:coordinator, folder_notes:&[], own_notes:&[],
        skills_dir:"D:/synthetic/home/.claude/skills", builtin_skills:true, suggest_agent_feedback:true,
    })
}

fn profiles() -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for lane in SKILL_LANES {
        for top in [false, true] {
            for readonly in [false, true] {
                for trimmed in [false, true] {
                    let base = if readonly {
                        json!({"permission_mode":"plan","tools":{"edit":false,
                            "orgtree":{"team":false,"inspection":false,"user":false}}})
                    } else {
                        json!({"permission_mode":"acceptEdits","add_dirs":[{"path":"D:/synthetic/repo","mode":"rw"}]})
                    };
                    let mut teams = crate::domain::teams::workspaces(
                        std::path::Path::new("D:/synthetic/_teams"),
                        &[(1,"worker".into()),(2,"project".into()),(3,"boss".into()),(4,"below".into())]);
                    teams[1].project = true;
                    teams[3].project = true;
                    teams[3].below = true;
                    let scope = crate::domain::scope::with_team_workspaces(
                        &crate::domain::scope::with_org_notes(&base, "D:/synthetic/_shared"), &teams);
                    let notes = vec![("D:/synthetic/AGENTS.md".into(), "Synthetic note — unchanged.".into())];
                    let key = format!("{lane:?}-top{top}-ro{readonly}-trim{trimmed}");
                    let text = identity(&Identity {
                        name:"worker", title:"", org_name:"Proof", org_slug:"proof", scratch:"D:/synthetic/worker",
                        charter:Some("Synthetic charter."), team_charter:Some("Synthetic team charter."),
                        cascade:&[("project".into(),"Synthetic ancestor charter.".into())],
                        superior:if top {None} else {Some("boss")}, org_md:Some("Synthetic org notes."),
                        lane:*lane, scope:&scope, codex_sandbox:Some(if readonly {"read-only"} else {"workspace-write"}),
                        mcp_servers:&["synthetic".into()], extern_holder:!readonly,
                        folder_notes:&notes, own_notes:&notes, skills_dir:"D:/synthetic/skills",
                        builtin_skills:trimmed, suggest_agent_feedback:!readonly,
                    });
                    out.insert(key, text);
                }
            }
        }
    }
    out
}

#[test]
fn approved_examples_match_exact_wording() {
    for (coordinator, expected) in [
        (false, include_str!("../../../testdata/standing-compression/seat-A.txt")),
        (true, include_str!("../../../testdata/standing-compression/seat-B.txt")),
    ] {
        let actual = example(coordinator);
        // Avoid dumping the entire prompt on a regression; the first differing
        // byte and the golden file make the mismatch directly reviewable.
        let mismatch = actual.bytes().zip(expected.bytes()).position(|(a,b)| a != b);
        assert_eq!(mismatch, None, "coordinator={coordinator}: first differing byte");
        assert_eq!(actual.len(), expected.len(), "coordinator={coordinator}: UTF-8 bytes");
    }
}

#[test]
fn legacy_profiles_keep_their_baseline_bytes() {
    use sha2::{Digest, Sha256};
    let expected: Value = serde_json::from_str(include_str!(
        "../../../testdata/standing-compression/legacy-3dc7095.json")).unwrap();
    let mut checked = 0;
    for (key,text) in profiles().into_iter().filter(|(key,_)| key.ends_with("trimfalse")) {
        assert_eq!(json!(text.len()), expected[&key]["bytes"], "{key}: byte length");
        assert_eq!(json!(format!("{:x}", Sha256::digest(text.as_bytes()))),
            expected[&key]["sha256"], "{key}: unchanged legacy text");
        checked += 1;
    }
    assert_eq!(checked, 20);
    assert_eq!(expected.as_object().unwrap().len(), checked);
}

#[test]
fn export_compression_profiles() {
    let texts = profiles();
    assert_eq!(texts.len(), 40);
    if let Some(out) = std::env::var_os("ORGTREE_IDENTITY_RENDER_DIR") {
        let out = std::path::PathBuf::from(out);
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join("profiles.json"), serde_json::to_vec_pretty(&texts).unwrap()).unwrap();
        for (key, coordinator) in [("A",false),("B",true)] {
            std::fs::write(out.join(format!("seat-{key}.txt")), example(coordinator)).unwrap();
        }
    }
    for (key,text) in texts { println!("COMPRESSION_BYTES {key} {}",text.len()); }
}
