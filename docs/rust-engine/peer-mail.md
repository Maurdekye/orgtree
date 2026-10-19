# Direct-child peer mail (4.4.0)

Committee members can be kept on the supervisor route by turning OFF
**Subordinates may message each other** on their manager or project. The setting
is ON by default. The user requested the mail gate at 2026-10-17 11:24Z and hidden
neighbour lines at 11:27Z; the docket `per-manager-project-setting-forbid-peer-to-peer-m`
is authoritative.

## Reach and audiences

User ruling, 2026-10-19 20:35–20:38Z (replaces the 2026-10-17 cross-project
reporting-peer rule): default coworker mail requires the same physical parent.
Projects are real boundaries for coworker mail, including root projects and
self-wraps. Nearest-agent superior and descendant reach still skips projects.
OFF gates physical siblings unless an active directional audience permits them.

A project-to-project audience also connects the two projects' direct live
members in its granted direction. Both projects' peer-mail switches must be ON;
revoking or pausing the audience removes that route. Nested members do not inherit
it. Ordinary agent audiences retain their directional override. These routes use
the existing `effective_audiences` expansion, not copied grants. Requests still
reach their named decider. The nearest agent superior may delegate between
physical siblings; an agent may grant its reports an audience with its own
physical coworker or nearest agent superior. Reverse mail needs its own audience.

`domain/mail::authorize` reads both physical parents, nearest agent superiors
and the actual parent's saved policy on each send, then calls the tested
`domain/peer_mail` policy. The common path covers messages, questions, requests
and notices. A refusal names the parent and setting. Existing distant-superior
reply-audience grants and active audience lookup stay directional.

## Storage and settings

The boolean is `ot.agents.scope.peer_mail`; absence means ON. It is read from
the node's configured scope, not its clamped effective scope, and is not a
child permission or inherited override. Moving an agent applies its new
parent's current setting; the agent retains the setting for its own children.
Retirement, restoration and restart retain the scope.

A peer-only user save uses the existing settings/undo transaction, validates a
boolean, changes just this property and publishes the node. It does not
normalize/cascade default tool grants through a transparent project or restart
agents. Undo captures the default as ON and restores the original raw scope
through the existing side snapshots. Mixed agent settings continue using the
ordinary save path.

Agent Settings places the control with Instructions. Projects have Settings in
their card and list menus. The node's chart/team line shows ON/OFF. Each turn's
live org-state text reports its actual parent's current policy outside the
suppressed chart, so static prompt/cache state cannot silently keep an old rule.
The message/audience tool text and glossary describe the same boundary.

## Canvas

The parent's boolean filters `OrgCanvas.peerLinks` before geometry is built.
GL uploads and SVG rendering consume that same wire list: row/circular layout,
near/far zoom and renderer fallback therefore share one rule. Hierarchy and
explicit audience links keep their existing paths. ON restores lateral links.

## Author verification

Red checkpoint 036db25 executed 8 engine tests (4 expected failures/4 unchanged
controls) and 12 renderer cases (all expected failures: 4 missing toggles,
8 retained peer lines). Every wire case reached an ON positive control before
failing OFF; fake GL recorded actual handover. The run completed and released
the lock before the subsequent engine restart; raw receipts/logs were recovered.

Focused policy tests cover refused sends, directional audiences, unchanged
superior/descendant reach, projects, cross-project peers, default ON, moves and
the narrow delegation rule. Additional tests cover transparent project scope,
live policy text and undo payloads. Mounted controls check default/saved states
and boolean saves; mounted canvas cases cover SVG/fake-GL, both layouts and two
zooms, with OFF/ON transitions and preserved hierarchy links.

The GL tests verify the production wire list using a fake GL backend, not real
shaders or pixels. Engine unit tests verify the policy used by production
queries; SQL/settings transaction wiring is source-checked. No provider calls,
live writes, install or restart is used by author checks.
