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
fn legacy_profiles_change_only_approved_mentions_and_claude_loading() {
    use sha2::{Digest, Sha256};
    let expected: Value = serde_json::from_str(include_str!(
        "../../../testdata/standing-compression/legacy-3dc7095.json")).unwrap();
    let mut checked = 0;
    for (key,text) in profiles().into_iter().filter(|(key,_)| key.ends_with("trimfalse")) {
        // The 21:44Z follow-up changes the two mention passages on legacy
        // profiles too. Also undo the 2026-10-23 Claude loading correction
        // and the custom apps tool (cf463f4, USER 2026-10-25): orgtree_apps
        // shares Logo's org-modifying group, on by default, so read-only
        // scopes list it. Unrelated wording remains pinned to the original
        // fingerprint.
        let text = text.replace(
            "MENTIONS: whenever you name an agent, project, docket item or presentation in text a person or agent will read (your replies, mail, docket descriptions, presentations), write @name, @item:<org>/<slug> or @doc:<org>/<slug> as plain text, never in backticks or code spans. A bare name is wrong. Point the user at an app or one of its panels with @app:<org>/<app-id> or @panel:<org>/<panel-id>.",
            "MENTIONS: whenever you name an agent, project or docket item in text a person or agent will read (your replies, mail, docket descriptions, presentations), write it as a mention: `@name`, or `@item:<org>/<slug>`. A bare name is wrong. Don't put mentions inside code spans.",
        ).replace(
            "Write @user (plain text, never in backticks) in replies, mail, presented documents or docket updates to notify the user: 'I need you to see this'. Anything needing an answer still goes by mail or question.",
            "Write `@user` in your reply for 'I need you to see this'; anything needing an answer still goes by mail or question.",
        ).replace(
            "Act on the org with the orgtree tools, named mcp__orgtree__orgtree_status and so on. Some load up front; others are deferred. Fetch them with ToolSearch by full name. ",
            "Act on the org with the orgtree tools. Their full names carry the server prefix — mcp__orgtree__orgtree_status and so on — and they are always loaded, never deferred. ",
        ).replace(
            "orgtree_session, orgtree_apps, orgtree_org_logo",
            "orgtree_session, orgtree_org_logo",
        ).replace(
            // Fewer failed docket calls (USER 2026-10-27 m3f52496b06f6,
            // proposals A and B): keep/append need no revision, and
            // expected_rev guards only the fields a call replaces.
            "On a long item, use `keep_done`/`keep_next` to carry a stored list forward, or `done_append`/`next_append` to add to one: the backend merges and stores the COMPLETE list either way, skips an appended entry the list already holds, and returns exactly what it stored. Pass `expected_rev` (the rev you read) when you replace something: if somebody has since changed a field your call replaces (a whole list, the status, the scope, the reviewer or attention), your whole call is refused before anything changes rather than overwriting theirs; other changes since then let it apply, with a note.",
            "On a long item, pass `expected_rev` (the rev you read) with `keep_done`/`keep_next` to carry a stored list forward, or `done_append`/`next_append` to add to one: the backend merges and stores the COMPLETE list either way and returns exactly what it stored. `expected_rev` is compare-and-set — if somebody wrote to the item since you read it, your whole call is refused before anything changes rather than interleaving with theirs — and it is required with any keep or append, because those are statements about a list you have actually read.",
        );
        assert_eq!(json!(text.len()), expected[&key]["bytes"], "{key}: byte length");
        assert_eq!(json!(format!("{:x}", Sha256::digest(text.as_bytes()))),
            expected[&key]["sha256"], "{key}: unchanged legacy text outside approved mentions/loading/apps");
        checked += 1;
    }
    assert_eq!(checked, 20);
    assert_eq!(expected.as_object().unwrap().len(), checked);
}

#[test]
fn orgtree_loading_guidance_matches_the_native_harness() {
    for (key, text) in profiles() {
        assert!(!text.contains("always loaded, never deferred"), "{key}: false eager-only claim");
        let loading = "Some load up front; others are deferred. Fetch them with ToolSearch by full name.";
        if key.starts_with("Claude-") {
            assert!(text.contains(loading), "{key}: missing deferred-tool discovery");
            assert!(text.contains("mcp__orgtree__orgtree_status"), "{key}: missing full-name example");
        } else {
            assert!(!text.contains(loading), "{key}: Claude-only ToolSearch guidance");
        }
    }
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
