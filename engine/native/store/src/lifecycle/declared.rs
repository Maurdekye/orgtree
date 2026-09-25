//! WS3b's DECLARED-CONTACTS table (CONTRACT-M1 §5 r4; brief ruling 9):
//! per verb, every relation it may touch, the modes, and whether EVERY
//! committed attempt touches it (`required`). A relation touched only on
//! some committed branch (a no-op, a payer with no capacity row, a writer
//! that folds only sometimes) is `required: false`. Unsafe-control paths are
//! not declared.
//!
//! `p01_contract` is the P01 contract id (never an `api.py` line), or `null`
//! for a runtime-internal writer (`mark_unrecoverable`, lead ruling
//! 2026-09-25) or the harness-only namesake hire.

use serde_json::{Map, Value};

use crate::island::declared::{entry, receipts, rel, LOCK_W, R, RW, SHARE, SHARE_LOCK_W, W};

const SRC: &str = "engine/native/store/src/lifecycle";

fn put(m: &mut Map<String, Value>, k: &str, v: Value) {
    m.insert(k.to_string(), v);
}

/// The caller anchor and killswitch (`mail::doors::anchor_agent_caller`):
/// present only for agent callers.
fn anchor() -> Vec<(&'static str, Value)> {
    vec![("org_controls", rel(SHARE, false))]
}

/// WS5's P8 helpers' relations.
fn p8_head(required: bool) -> (&'static str, Value) {
    ("mailboxes", rel(&["read", "for_share", "for_update", "write"], required))
}

fn restriction(required: bool) -> Vec<(&'static str, Value)> {
    vec![
        ("org_controls", rel(SHARE, required)),
        ("read_service_registrations", rel(R, required)),
        ("restrictions", rel(W, required)),
        ("restriction_obligations", rel(W, false)),
    ]
}

fn merge(parts: Vec<Vec<(&'static str, Value)>>) -> Vec<(&'static str, Value)> {
    // later entries win per relation; `required` is OR-ed, modes unioned
    let mut out: Vec<(&'static str, Value)> = Vec::new();
    for part in parts {
        for (k, v) in part {
            if let Some((_, have)) = out.iter_mut().find(|(n, _)| *n == k) {
                let mut modes: Vec<String> = have["modes"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
                for m in v["modes"].as_array().unwrap() {
                    let m = m.as_str().unwrap().to_string();
                    if !modes.contains(&m) {
                        modes.push(m);
                    }
                }
                let req = have["required"].as_bool().unwrap() || v["required"].as_bool().unwrap();
                let refs: Vec<&str> = modes.iter().map(String::as_str).collect();
                *have = rel(&refs, req);
            } else {
                out.push((k, v));
            }
        }
    }
    out
}

/// `"<family>.<verb>" → spec` for every WS3b writer.
pub fn declared() -> Value {
    let mut m = Map::new();
    let edges = |req: bool| ("topology_edges", rel(&["read", "for_share", "for_no_key_update", "write"], req));
    let epoch = || ("authority_epoch", rel(SHARE_LOCK_W, true));

    put(
        &mut m,
        "island.rehire",
        entry(
            merge(vec![
                vec![receipts(), epoch(), edges(true), ("lineage_bearers", rel(RW, true))],
                anchor(),
                vec![
                    ("org_controls", rel(SHARE, false)),
                    ("scope_rows", rel(SHARE, false)),
                    ("funding_edges", rel(R, false)),
                    ("issuer_capacity", rel(LOCK_W, false)),
                    ("seat_config", rel(W, false)),
                    p8_head(false),
                    ("mailbox_messages", rel(RW, false)),
                    ("outgoing_intents", rel(W, false)),
                    // the re-seed branch (rehire of an unrecoverable node)
                    ("agents", rel(RW, false)),
                    ("agent_names", rel(RW, false)),
                    ("mail_sent", rel(R, false)),
                ],
            ]),
            Some("lifecycle.rehire"),
            &format!("{SRC}/rehire.rs rehire_in (S3 §4.8, P2/P3/P5/P6/P8)"),
        ),
    );
    for (verb, p01) in [("retire", "lifecycle.retire"), ("dissolve", "lifecycle.dissolve"), ("rescind", "operator.rescind")] {
        put(
            &mut m,
            &format!("island.{verb}"),
            entry(
                merge(vec![
                    vec![receipts(), epoch(), edges(true)],
                    anchor(),
                    vec![
                        ("runtime_state", rel(SHARE, false)),
                        ("request_batches", rel(RW, false)),
                        ("funding_edges", rel(if verb == "rescind" { RW } else { R }, false)),
                        ("issuer_capacity", rel(LOCK_W, false)),
                    ],
                    restriction(false),
                ]),
                Some(p01),
                &format!("{SRC}/remove.rs archive_in (r7 §6.4 retire/dissolve; C2a P2/P4/P7)"),
            ),
        );
    }
    put(
        &mut m,
        "island.delete",
        entry(
            merge(vec![
                vec![receipts(), ("authority_epoch", rel(&["read", "for_no_key_update", "write"], true)), edges(true), ("lineage_bearers", rel(RW, true))],
                vec![
                    ("folder_move_intents", rel(R, true)),
                    ("runtime_state", rel(SHARE, true)),
                    ("funding_edges", rel(R, true)),
                    ("issuer_capacity", rel(LOCK_W, false)),
                    p8_head(true),
                    ("mailbox_messages", rel(RW, false)),
                    ("audience_grants", rel(RW, true)),
                    ("request_batches", rel(RW, true)),
                    ("agent_names", rel(W, true)),
                    ("seat_config", rel(W, true)),
                    ("scope_rows", rel(W, true)),
                ],
                restriction(true),
            ]),
            Some("operator.delete"),
            &format!("{SRC}/remove.rs delete_in (S3 §3.2 P8 (b); errata A1/A2)"),
        ),
    );
    put(
        &mut m,
        "island.move",
        entry(
            merge(vec![
                vec![receipts(), epoch(), edges(true), ("lineage_bearers", rel(R, true))],
                anchor(),
                vec![
                    ("org_controls", rel(SHARE, false)),
                    ("scope_rows", rel(&["read", "for_share", "for_no_key_update", "write"], false)),
                    ("audience_grants", rel(RW, false)),
                    ("funding_edges", rel(RW, false)),
                    ("issuer_capacity", rel(LOCK_W, false)),
                ],
                restriction(false),
            ]),
            Some("lifecycle.move"),
            &format!("{SRC}/topo.rs move_in (r7 §6.4 move; C2a P1/P2/P3/P5/P6; S3 §3.1 stacks)"),
        ),
    );
    let split_rels = |fold: bool, moot: bool, config: bool| {
        merge(vec![
            vec![receipts(), epoch(), edges(true), ("lineage_bearers", rel(RW, true)), ("agents", rel(RW, true)), ("agent_names", rel(RW, true))],
            anchor(),
            vec![p8_head(true), ("mailbox_messages", rel(RW, false)), ("mail_sent", rel(R, false))],
            if moot { vec![("request_batches", rel(RW, false))] } else { vec![] },
            if config { vec![("seat_config", rel(LOCK_W, true))] } else { vec![] },
            if fold { vec![] } else { vec![] },
        ])
    };
    for (verb, p01, fold, moot, config) in [
        ("cheap_compact", Some("lifecycle.cheap-compact"), true, false, false),
        ("switch_model", Some("lifecycle.switch-model"), true, true, true),
        ("account_split", Some("lifecycle.account-assign"), true, true, true),
        ("compact_split", Some("lifecycle.compact"), false, false, false),
        ("cli_compaction", Some("lifecycle.compact"), false, false, false),
    ] {
        put(&mut m, &format!("island.{verb}"), entry(split_rels(fold, moot, config), p01, &format!("{SRC}/split.rs split_in (S3 §3.1; P8 (c))")));
    }
    put(
        &mut m,
        "island.reseed",
        entry(
            merge(vec![
                split_rels(true, false, false),
                vec![("outgoing_intents", rel(W, false))],
            ]),
            Some("operator.reseed"),
            &format!("{SRC}/split.rs reseed_in (S3 §3.1; P8 (a)(c))"),
        ),
    );
    put(&mut m, "island.mark_unrecoverable", entry(vec![receipts(), ("authority_epoch", rel(LOCK_W, true))], None, &format!("{SRC}/split.rs Lineage (runtime-internal)")));
    put(
        &mut m,
        "island.recover_lost_generation",
        entry(vec![receipts(), ("authority_epoch", rel(&["read", "for_no_key_update"], true)), ("lineage_bearers", rel(RW, true))], Some("lifecycle.lineage-recover"), &format!("{SRC}/split.rs Lineage")),
    );
    put(
        &mut m,
        "island.drop_phantom_generation",
        entry(
            vec![
                receipts(),
                ("authority_epoch", rel(LOCK_W, true)),
                ("lineage_bearers", rel(RW, true)),
                ("audience_grants", rel(W, true)),
                ("agent_names", rel(W, true)),
                ("topology_edges", rel(W, true)),
            ],
            Some("lifecycle.lineage-drop-phantom"),
            &format!("{SRC}/split.rs Lineage"),
        ),
    );
    put(
        &mut m,
        "island.hire",
        entry(
            merge(vec![
                vec![receipts(), ("authority_epoch", rel(&["read", "for_share", "write"], true)), edges(true), ("agents", rel(W, true)), ("agent_names", rel(W, true))],
                vec![("org_controls", rel(SHARE, true)), ("scope_rows", rel(&["read", "for_share", "write"], true)), ("runtime_state", rel(W, true)), ("mailboxes", rel(RW, true))],
            ]),
            None,
            &format!("{SRC}/harness.rs namesake_hire_in (harness-only; WS3a's staffing.hire is the real hire)"),
        ),
    );
    let retool_base = || vec![receipts(), ("authority_epoch", rel(SHARE, true)), ("topology_edges", rel(&["read", "for_share"], true))];
    put(
        &mut m,
        "lifecycle.retool",
        entry(
            merge(vec![retool_base(), anchor(), vec![("scope_rows", rel(&["read", "for_no_key_update", "write"], true))], restriction(true)]),
            Some("lifecycle.retool"),
            &format!("{SRC}/retool.rs set_in (r7 §6.4 retool; P3 rule 2)"),
        ),
    );
    put(
        &mut m,
        "lifecycle.widen",
        entry(
            merge(vec![retool_base(), anchor(), vec![("scope_rows", rel(&["read", "for_share", "for_no_key_update", "write"], true))]]),
            Some("lifecycle.retool"),
            &format!("{SRC}/retool.rs widen_in (D-106; P3 rule 3)"),
        ),
    );
    put(
        &mut m,
        "lifecycle.charter",
        entry(
            merge(vec![retool_base(), anchor(), vec![("charter_heads", rel(LOCK_W, true)), ("charter_versions", rel(W, true))]]),
            Some("lifecycle.retool"),
            &format!("{SRC}/retool.rs charter_in (Q-CR1: pure, no scope/epoch bump)"),
        ),
    );
    Value::Object(m)
}
