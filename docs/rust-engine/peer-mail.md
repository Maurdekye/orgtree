# Direct-child peer mail (4.4.0)

Committee members can be kept on the supervisor route by turning OFF
**Subordinates may message each other** on their manager or project. The setting
is ON by default. The user requested the mail gate at 2026-10-17 11:24Z and hidden
neighbour lines at 11:27Z; the docket `per-manager-project-setting-forbid-peer-to-peer-m`
is authoritative.

## Reach and audiences

Coordinator rulings, 11:26Z: gate only pairs with the same actual non-null
`parent_id`. Projects remain transparent for reporting: pairs in different
physical groups keep existing reporting-peer reach. A directional active,
unpaused audience allows the granted sender-to-recipient route. Requests still
reach their named decider. The nearest agent superior of both endpoints may
grant `from=A target=B` when A and B share an actual parent; all previous grant
cases remain. Reverse mail needs its own audience. Superior, descendant, user,
org-inbox, external, project mailbox/fair-queue, chart and docket rules retain
their previous behavior.

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
