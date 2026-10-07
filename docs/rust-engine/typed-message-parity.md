# Typed message parity inventory

Reference: local Rust `ed49c8a`, frozen Python `events_table.py` / `events_render.py`, and the renderer's canonical event schema. The coordinator's 2026-10-07 ruling is to restore tags for retained operations, keep decoding old history, and leave PLAN section 10 removals removed.

The baseline had 13 named event builders. This change restores the ordinary envelope at the central send path, structured linked replies, retained docket review cards, resource decisions, passive lifecycle fanout, runtime alerts and direct-user-contact notices. Every mail's `ev` now also reaches the agent formatter. Canvas owns the MAIL / ORG NOTICES formatter and its 3.x wording. Compaction and cross-provider messages use accurate 4.0 bodies: old session IDs are history references, never rehireable agents. Review outcomes describe actual status rather than falsely claiming a landing.

The inventory distinguishes a flattened producer from a detector or workflow which never existed in this Rust baseline. The latter are **remaining parity work**, not approved removals. Parity-astra inventoried the runtime gaps; agents-md-opus now owns their detectors in parity batch 4a (P33/P34/P35/P36/P39). Outage-astra is implementing queued switches. The table does not claim those mechanisms are delivered by this change.

| Variant | 3.x | 4.0 before | 4.0 after |
| --- | --- | --- | --- |
| `ordinary.message` | Canonical `ordinary.message` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `ordinary.question` | Canonical `ordinary.question` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `ordinary.request` | Canonical `ordinary.request` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `ordinary.decision` | Canonical `ordinary.decision` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `ordinary.status` | Canonical `ordinary.status` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `ordinary.notice` | Canonical `ordinary.notice` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `reply.docket` | Canonical `reply.docket` | Typed producer existed | Preserved through full mail transport |
| `reply.document` | Canonical `reply.document` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `reply.mail` | Canonical `reply.mail` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `docket.assigned` | Canonical `docket.assigned` | Typed producer existed | Preserved through full mail transport; approved is accepted as a 4.0 status |
| `docket.review_requested` | Canonical `docket.review_requested` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `docket.review_seat_requested` | Canonical `docket.review_seat_requested` | PLAN F4: no review seats or candidate verdicts | Legacy decoder/card retained; removed operation stays removed |
| `docket.review_seat_decided` | Canonical `docket.review_seat_decided` | PLAN F4: no review seats or candidate verdicts | Legacy decoder/card retained; removed operation stays removed |
| `docket.review_changes` | Canonical `docket.review_changes` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `docket.review_approved` | Canonical `docket.review_approved` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `docket.review_approved_stage` | Canonical `docket.review_approved_stage` | PLAN F4: no review seats or candidate verdicts | Legacy decoder/card retained; removed operation stays removed |
| `status.report` | Canonical `status.report` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `answer.ask` | Canonical `answer.ask` | Typed producer existed | Preserved through full mail transport |
| `answer.batch` | Canonical `answer.batch` | Typed producer existed | Preserved through full mail transport |
| `decision.credit` | Canonical `decision.credit` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `decision.audience` | Canonical `decision.audience` | Typed producer existed | Preserved through full mail transport; granted request now emits decision as well as access notice |
| `decision.attention_dismissed` | Canonical `decision.attention_dismissed` | Typed producer existed | Preserved through full mail transport |
| `ask.routed` | Canonical `ask.routed` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `access.scope_requested` | Canonical `access.scope_requested` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `access.audience_requested` | Canonical `access.audience_requested` | Typed producer existed | Preserved through full mail transport |
| `access.audience_changed` | Canonical `access.audience_changed` | Typed producer existed | Preserved through full mail transport |
| `access.grant_changed` | Canonical `access.grant_changed` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `access.scope_changed` | Canonical `access.scope_changed` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `lifecycle.kickoff` | Canonical `lifecycle.kickoff` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `lifecycle.hired` | Canonical `lifecycle.hired` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `lifecycle.retired` | Canonical `lifecycle.retired` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `lifecycle.rescinded` | Canonical `lifecycle.rescinded` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `lifecycle.rehired` | Canonical `lifecycle.rehired` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `lifecycle.dissolved` | Canonical `lifecycle.dissolved` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `lifecycle.deleted` | Canonical `lifecycle.deleted` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `lifecycle.compacted` | Canonical `lifecycle.compacted` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained; same-session CLI compaction, no invented generation |
| `lifecycle.cheap_compacted` | Canonical `lifecycle.cheap_compacted` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `lifecycle.reseeded` | Canonical `lifecycle.reseeded` | PLAN B1: no knowledge-bearer nodes | Legacy decoder/card retained; removed operation stays removed |
| `lifecycle.recovered` | Canonical `lifecycle.recovered` | PLAN B1: no knowledge-bearer nodes | Legacy decoder/card retained; removed operation stays removed |
| `lifecycle.phantom_removed` | Canonical `lifecycle.phantom_removed` | PLAN B1: no knowledge-bearer nodes | Legacy decoder/card retained; removed operation stays removed |
| `lifecycle.unrecoverable` | Canonical `lifecycle.unrecoverable` | PLAN B1: no knowledge-bearer nodes | Legacy decoder/card retained; removed operation stays removed |
| `lifecycle.bearer_lost` | Canonical `lifecycle.bearer_lost` | PLAN B1: no knowledge-bearer nodes | Legacy decoder/card retained; removed operation stays removed |
| `lifecycle.bearer_exhausted` | Canonical `lifecycle.bearer_exhausted` | PLAN B1: no knowledge-bearer nodes | Legacy decoder/card retained; removed operation stays removed |
| `lifecycle.handoff_record` | Canonical `lifecycle.handoff_record` | PLAN B1: no knowledge-bearer nodes | Legacy decoder/card retained; removed operation stays removed |
| `lifecycle.model_switched` | Canonical `lifecycle.model_switched` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `lifecycle.session_rebound` | Canonical `lifecycle.session_rebound` | No corresponding queued/rebound producer | Typed mapping supplied for a real session replacement; baseline account update retains its session, so no false rebound is emitted |
| `lifecycle.switch_queued` | Canonical `lifecycle.switch_queued` | No corresponding queued/rebound producer | Typed mapping supplied in lifecycle::record; real pending-switch machinery belongs to outage-astra P30 |
| `lifecycle.switch_cancelled` | Canonical `lifecycle.switch_cancelled` | No corresponding queued/rebound producer | Typed mapping supplied in lifecycle::record; real pending-switch machinery belongs to outage-astra P30 |
| `lifecycle.switch_dropped` | Canonical `lifecycle.switch_dropped` | No corresponding queued/rebound producer | Typed mapping supplied in lifecycle::record; real pending-switch machinery belongs to outage-astra P30 |
| `lifecycle.seat_swapped` | Canonical `lifecycle.seat_swapped` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `lifecycle.subtree_promoted` | Canonical `lifecycle.subtree_promoted` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `lifecycle.moved` | Canonical `lifecycle.moved` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `lifecycle.inserted` | Canonical `lifecycle.inserted` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `lifecycle.renamed` | Canonical `lifecycle.renamed` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `policy.fable_flagged` | Canonical `policy.fable_flagged` | PLAN B9: Fable policy removed | Legacy decoder/card retained; removed operation stays removed |
| `policy.weekly_limit` | Canonical `policy.weekly_limit` | PLAN B9: Fable policy removed | Legacy decoder/card retained; removed operation stays removed |
| `policy.unstuck` | Canonical `policy.unstuck` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `policy.unlocked` | Canonical `policy.unlocked` | PLAN B9: Fable policy removed | Legacy decoder/card retained; removed operation stays removed |
| `policy.limit_reset` | Canonical `policy.limit_reset` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `monitor.watchdog_fired` | Canonical `monitor.watchdog_fired` | Typed producer existed | Preserved through full mail transport |
| `monitor.watchdog_quiet` | Canonical `monitor.watchdog_quiet` | Typed producer existed | Preserved through full mail transport |
| `runtime.turn_failed_terminal` | Canonical `runtime.turn_failed_terminal` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained; system transcript rows now use EventCard |
| `runtime.turn_failed_repeated` | Canonical `runtime.turn_failed_repeated` | Detector/classifier absent | No corresponding runtime detector/classifier in the baseline; reported to parity-astra and assigned to agents-md-opus batch 4a; legacy card retained |
| `runtime.report_stalled` | Canonical `runtime.report_stalled` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `runtime.report_parked` | Canonical `runtime.report_parked` | Detector/classifier absent | No corresponding runtime detector/classifier in the baseline; reported to parity-astra and assigned to agents-md-opus batch 4a; legacy card retained |
| `runtime.report_limited` | Canonical `runtime.report_limited` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `runtime.subagent_died` | Canonical `runtime.subagent_died` | Detector/classifier absent | No corresponding runtime detector/classifier in the baseline; reported to parity-astra and assigned to agents-md-opus batch 4a; legacy card retained |
| `runtime.background_task_stopped` | Canonical `runtime.background_task_stopped` | Detector/classifier absent | No corresponding runtime detector/classifier in the baseline; reported to parity-astra and assigned to agents-md-opus batch 4a; legacy card retained |
| `runtime.restart_notice` | Canonical `runtime.restart_notice` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `runtime.token_expiry` | Canonical `runtime.token_expiry` | PLAN H3: legacy setup-token account path not retained | Legacy decoder/card retained; removed operation stays removed |
| `runtime.delivery_unread` | Canonical `runtime.delivery_unread` | Detector/classifier absent | No corresponding runtime detector/classifier in the baseline; reported to parity-astra and assigned to agents-md-opus batch 4a; legacy card retained |
| `runtime.ui_crash_report` | Canonical `runtime.ui_crash_report` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `runtime.external_unroutable` | Canonical `runtime.external_unroutable` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `reminder.working_checkup` | Canonical `reminder.working_checkup` | Typed producer existed | Preserved through full mail transport |
| `reminder.idle_docket` | Canonical `reminder.idle_docket` | Typed producer existed | Preserved through full mail transport |
| `docket.participant_added` | Canonical `docket.participant_added` | Typed producer existed | Preserved through full mail transport |
| `context.deep_reach` | Canonical `context.deep_reach` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `context.notice_digest` | Canonical `context.notice_digest` | Inline prompt context or legacy protocol | Turn-envelope ownership: canvas-opus; legacy renderer leaf retained |
| `context.org_state` | Canonical `context.org_state` | Inline prompt context or legacy protocol | Turn-envelope ownership: canvas-opus; legacy renderer leaf retained |
| `context.provider_usage` | Canonical `context.provider_usage` | Inline prompt context or legacy protocol | Turn-envelope ownership: canvas-opus; legacy renderer leaf retained |
| `context.cache_continuity` | Canonical `context.cache_continuity` | Inline prompt context or legacy protocol | Turn-envelope ownership: canvas-opus; legacy renderer leaf retained |
| `context.org_charter` | Canonical `context.org_charter` | Inline prompt context or legacy protocol | Turn-envelope ownership: canvas-opus; legacy renderer leaf retained |
| `context.command` | Canonical `context.command` | Inline prompt context or legacy protocol | Turn-envelope ownership: canvas-opus; legacy renderer leaf retained |
| `context.drive_mail_pointer` | Canonical `context.drive_mail_pointer` | Inline prompt context or legacy protocol | Legacy file-backed mail-carrier pointer; Rust passes mail inline (PLAN C3); decoder retained |
| `context.drive_restart_interrupted` | Canonical `context.drive_restart_interrupted` | Plain message, untyped row or missing notice | Typed producer restored; canonical card and Mail.ev retained |
| `context.drive_restart_wake` | Canonical `context.drive_restart_wake` | PLAN P: restart-wake tool removed | Legacy decoder/card retained; removed operation stays removed |

## Other cards and boundaries

| Surface | 3.x | 4.0 before | 4.0 after |
| --- | --- | --- | --- |
| Question, credit and scope request cards | Separate request-card inventory | Retained request cards; answers already typed except direct credit path | Direct credit and routed requests typed; batch answer shape retained |
| File / image deliveries | Tool card and attachment fields, no extra event leaf | Tool-card and attachment projection retained | Preserved; no invented event kind |
| Presentations | Document card and reply.document | Document gallery retained, reply plain | Structured presentation replies restored |
| Org inbox / @net | Outside sender plus ordinary message, attachments | Sender and attachments retained, forwarded tag absent | Forwarded ordinary envelope uses external actor; no trust of remote event payloads |
| Tool results | Native tool result/card, not mail event | Runtime tool-chip projection retained | Preserved |
| Halt | State/controls, not lifecycle.halted | Retained state | No invented halt event; thaw emits existing policy variants |
| Docket handoff and attention | Linked request, item attention state and typed dismissal | Item state and dismissal retained, handoff generic mail | Central ordinary envelope restored; no removed review-seat operation |

## Verification and limits

Measured: `cargo check --offline -j 2` passes. A small standalone Rust smoke emitted 36 samples from production builders / unchanged lifecycle JSON expressions, then 11 additional runtime/review samples: the actual renderer `decodeEventRow` and `projectEvent` accepted all 47 (44 distinct variants). The same decoder/projector accepted all 86 checked-in legacy fixtures. The modified desktop source bundled successfully. A server-render smoke timed out during module initialization before its first render; it is **not** a passed visual test. No unit-test suite, live database, provider call, installer or live app was run.

Source checked: `mail::send -> ot.mail.ev -> feed::compute::mail_entry -> runtime::actor::mail_row -> SegmentList / EventCard`; pending inbox cards use the same feed projection. System transcript rows now choose EventCard when typed, preserving SysLine for legacy rows. `prompt::Mail.ev` crosses the separate agent-facing formatter seam.

The generated renderer contract intentionally adds `approved` to the assignment status union for PLAN F4. The frozen Python generator still knows the old statuses; do not regenerate over this Rust-era extension. All old variants remain accepted. Old generic history is not reclassified from text; only authoritative new producer metadata mints tags.

No claim is made of live end-to-end fanout, a renderer screen check, or the absent runtime mechanisms listed above. These are explicitly separate from the measured envelope and projection checks.
