//! The instructions for all orgs in the prompt: one block, the same in every
//! org and on every harness, right before the org's own org.md (USER
//! 2026-10-31 m187a259a848d/mda4f6d7961a4; docs/rust-engine/app-instructions.md).
use super::*;
use serde_json::json;

const LANES: [Lane; 5] = [Lane::Claude, Lane::Codex, Lane::Antigravity, Lane::Muse, Lane::OpenCode];
const HEADER: &str = "## Instructions for all orgs (app-wide)";
const ORG_HEADER: &str = "## Organization notes (org.md)";

#[nolog]
fn prompt(lane: Lane, org: &str, org_md: Option<&str>, app_md: Option<&str>) -> String {
    identity(&Identity {
        name: "worker", title: "", org_name: org, org_slug: org, scratch: "D:/fixture/worker",
        charter: Some("Fixture charter."), team_charter: None, cascade: &[], superior: Some("lead"),
        org_md, app_md, lane, scope: &json!({}), codex_sandbox: None, mcp_servers: &[], extern_holder: false,
        folder_notes: &[], own_notes: &[], skills_dir: "D:/fixture-skills", builtin_skills: builtin_skills_lane(lane),
        suggest_agent_feedback: false,
    })
}

#[test]
fn the_block_sits_right_before_org_md_on_every_lane() {
    for lane in LANES {
        let s = prompt(lane, "first-org", Some("ORG_NOTES_SENTINEL"), Some("APP_WIDE_SENTINEL"));
        let app = s.find(HEADER).unwrap_or_else(|| panic!("{lane:?}: no section for the instructions for all orgs"));
        let org = s.find(ORG_HEADER).unwrap();
        let charter = s.find("Your charter: Fixture charter.").unwrap();
        assert!(charter < app && app < org, "{lane:?}: the charter, then the block, then org.md");
        assert_eq!(s.matches("APP_WIDE_SENTINEL").count(), 1, "{lane:?}: delivered once");
        // nothing but the block's own text sits between its header and org.md
        assert_eq!(s[app..org].trim_end(), format!("{HEADER}\n\nAPP_WIDE_SENTINEL"), "{lane:?}");
    }
}

#[test]
fn two_orgs_each_get_the_block_and_only_their_own_org_md() {
    for lane in LANES {
        let first = prompt(lane, "first-org", Some("FIRST_ORG_NOTES"), Some("APP_WIDE_SENTINEL"));
        let second = prompt(lane, "second-org", Some("SECOND_ORG_NOTES"), Some("APP_WIDE_SENTINEL"));
        for (s, own, other) in [(&first, "FIRST_ORG_NOTES", "SECOND_ORG_NOTES"), (&second, "SECOND_ORG_NOTES", "FIRST_ORG_NOTES")] {
            assert!(s.contains(HEADER) && s.contains("APP_WIDE_SENTINEL"), "{lane:?}: every org gets the block");
            assert!(s.contains(own) && !s.contains(other), "{lane:?}: and only its own org.md");
        }
        let bare = prompt(lane, "third-org", None, Some("APP_WIDE_SENTINEL"));
        assert!(bare.contains(HEADER) && bare.contains("APP_WIDE_SENTINEL") && !bare.contains(ORG_HEADER),
            "{lane:?}: an org without an org.md still gets the block");
    }
}

#[test]
fn a_blank_block_adds_nothing_and_leaves_the_prompt_byte_for_byte() {
    for lane in LANES {
        let before = prompt(lane, "first-org", Some("ORG_NOTES"), None);
        assert!(!before.contains(HEADER), "{lane:?}");
        for blank in ["", "  \n\t", "\r\n"] {
            assert_eq!(prompt(lane, "first-org", Some("ORG_NOTES"), Some(blank)), before, "{lane:?}: {blank:?}");
        }
    }
}

#[test]
fn the_block_is_capped_like_org_md() {
    let kept = "é".repeat(crate::http::settings::ORGMD_PROMPT_MAX);
    let long = format!("{kept}TAIL_PAST_THE_CAP");
    for lane in LANES {
        let s = prompt(lane, "first-org", None, Some(&long));
        assert!(s.contains(&format!("{HEADER}\n\n{kept}\n… (the instructions for all orgs continue; ask your superior for the rest)\n")),
            "{lane:?}: the first 16,000 characters, then the cut");
        assert!(!s.contains("TAIL_PAST_THE_CAP"), "{lane:?}");
    }
}
