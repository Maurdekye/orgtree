# Compact choice (4.4.0)

User 2026-10-17 17:15Z requested plain Halt when it acts immediately and a
Compact… menu entry that opens a normal/cheap choice. Coordinator 17:18Z
confirmed actual harness capability and truthful refusal messages. User and
coordinator 2026-10-18 11:18Z/11:20Z replaced cheap-only bulk scopes with the
shared bulk confirmation below; this adds no harness compaction support.

The shared agent menu shows Halt or Unhalt without dots for a direct action.
When an actual team submenu exists, it keeps the ellipsis. Compact… opens the
same choice modal as the desk context wheel. Each option has one explanation:
normal uses the harness's existing conversation compaction; cheap starts a fresh
session with a summary handoff on the same agent, keeping settings and team.
Cancel takes initial focus, Tab stays inside and Escape restores the opener.
The modal also retains the next-turn cache forecast warning when backend
state is known_incompatible or expired_known_entry, including its supplied
reason. Ready, uncertain or absent evidence never becomes cold merely because
the last turn is old; the warning makes no fork or pricing claims.

The modal reads GET /api/orgs/{slug}/nodes/{nid}/compact. This read resolves the
same effective OpenRouter stamp/account setting or language-server route as the
actor, without starting a process. Native Claude, Muse and explicit Claude Code
routes support the existing normal action; Codex, Antigravity, OpenCode and
unknown routes show the normal option disabled with a reason. Read failure or
pending capability disables normal only. Live/busy/session/bearer gates remain;
POST still rechecks admission and its started:false response is a refusal, never
a started-compaction toast. Cheap uses the existing cheap_compact operation.

## Bulk actions (2026-10-18)

Managers offer Compact subtree and Compact all subordinates (with ellipses),
projects offer Compact all agents under it, and the org-root eye offers Compact
all agents. Every door opens BulkCompactConfirm before any action. Cheap
and Normal each have a counted confirm button, plus Cancel. User 2026-10-18
14:29-14:30Z replaced the radio choice with these two actions. The single-agent
modal is unchanged. Cancel performs no compaction.

Both mode descriptions and acting counts stay visible together. Each acting
or skipped-reason count has a hover tooltip listing every covered agent name;
names do not appear in the body. Mid-turn and no-measured-context count lines
appear under both Cheap and Normal, each with its complete hover name list
(user clarification 2026-10-19 11:47Z). Other shared reasons appear once below
the modes, and Normal-only reasons stay under Normal. Unsupported harnesses share
one count; unknown refusal reasons retain a short count line. There are no
chips, expanders or repeated per-agent prose. The footer is one short line.
[User 2026-10-18 17:28-17:30Z; coordinator 17:58Z m589667bd7538.] Buttons read compact N agents and cheap-compact
N agents; zero-target actions are disabled. Both
choices retain the existing live-seat, idle, measured-context and already-reset
bulk plan. Cheap retains cheap_compact with if_idle per target. Opening the dialog reads
each candidate's actual Normal capability, without starting a process; pending
reads disable only Normal confirmation while eligible Cheap remains available. Unsupported,
no-session and unreadable-capability seats are skipped with reasons. An all-skip
Normal plan cannot confirm and never falls back to Cheap.

Runs share one overlap guard and issue requests sequentially. Normal uses the
existing per-agent POST and the actor rechecks admission. A started:false result
is refused, a transport error is failed, and started:true is reported as started,
never completed. The summary names every outcome; one refusal does not abort the
rest. No backend authority or harness support is widened.

The bulk-only confirmation is capped at min(620px, viewport minus 40px).
The count-only common case fits at1000x700 without body scrolling. Large or
narrow cases retain the independently scrolling body and visible footer, with
wrapping buttons. Single-agent layout is unchanged.
[Coordinator approved 2026-10-18 14:36Z m839abac337e2.]

## Focused evidence

Engine red at 5894d94: four cases, two intended failures (OpenCode/unknown
routes falsely supported) and two passing controls. Corrected renderer red at
2d8cdd7: nine cases, six intended failures and three controls, raw exit1; the
first modal fixture's invalid portal queries are retained separately. Author
green results and exact SHA are recorded in the docket/hand-in after execution.

## Agent normal-compaction tool (G7)

orgtree_compact accepts one node and action capability or compact (default).
Effective team scope and the same strict descendant boundary as cheap compact
apply, including to top-level callers. Self, projects and bulk are refused.
The HTTP capability read and tool share domain::compaction::node_capability;
capability never creates an actor. Native actor admission rechecks tool scope
and hierarchy, preserves busy/session/runtime refusals, and uses Agent origin.
Only User-origin admitted commands perform user-contact/deep-reach notices.
The result node/supported/started/reason never reports completion; unsupported
routes have supported:false and started:false. There is no cheap fallback.
See the orgtree-tool-compact glossary page for parameters and examples.
