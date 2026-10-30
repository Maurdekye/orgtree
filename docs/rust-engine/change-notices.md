# Change notices name what changed

USER 2026-10-30 17:16:01Z mc5d2672d3cc9 (`change-notices-permissions-changed-audience-chan`), verbatim: "the
"permission changed " / "audience chsnged" etc. status update messagss should show inline what exactly chsnged:
what in the system prompt (a diff), which foldeds were sdded / removed / chsnged, which tools weee added, etc.";
17:16:14Z meeff02af965d "same for all similar update messages". @coordinator-opus macb41248ab05 approved the
design: every settings change writes a row (effort, fast mode, account, harness, model version, team
instructions, descendants whose scope a change narrows), a notice with no permission part is titled "Settings
changed", and the settings dialog's false "charter" rows end.

## What a notice carries

A change notice is passive system mail with a typed event (`domain/lifecycle.rs` `record`). Every settings change
is one kind, `access.scope_changed`, whose optional members name what changed, read from the stored before and
after inside the change's transaction (`domain/settings_notice.rs`), never from the request:

- `folders` `{added, changed, removed}` (`scope::dirs_diff`), `tools` `{added, removed}` (`bash`, `web`, `edit`,
  `subagents`, `orgtree_disabled`, `mcp:<server>`, `orgtree:<group>`).
- `values` `[{key, from, to}]` for `org_visibility`, `permission_mode`, `effort` (the effective levels),
  `fast_mode`, `model_version`, `account`, `account_fallback`, `harness`, `session`, `peer_mail`,
  `auto_cheap_compact`; null is the default. `pending` (`queued`, `cancelled`, `dropped`, with `reason`) marks an
  account change waiting on the current turn.
- `charter` and `team_charter` as line diffs in the Edit tool call's shape `{plus, minus, lines, truncated?}`
  (3 lines of context, 200 lines kept, like `runtime/actor.rs` `patch_of`).
- `cascade_for`: whose change this one follows (an ancestor raised to cover a grant, an agent below whose effective
  scope narrowed, every agent below an agent whose team instructions changed).

Only those keys can enter an event, so nothing from accounts, credentials or MCP configurations does. A change that
changed nothing writes no notice: the settings dialog sends its whole form, the unchanged instructions included
(`canvas/modals.tsx` `scopeBody`), and its key alone used to write "Permissions changed (charter)". The parts go to
the notice only: `ops.rs` `event()` strips them from the `ot.events` row the feed and history read.

Producers: `ops.rs` `retool` (its speed-only path, raised ancestors, team instructions and every agent below whose
effective scope the call changed), `account` (applied, queued, cancelled), a rehire's account, `apply_pending`
(dropped), `set_harness`, and `switch_model` (an account that moved with the switch gets its own notice right after
the switch's, as the switch's text says); `http/nodes.rs` `apply_user_scope_in_tx` (the settings dialog: its
speed-only and peer-mail-only paths, raised ancestors, and every agent below whose effective scope changed). Both
paths compare the agents below by effective scope before and after (`settings_notice::effective_below`, without row
locks), so a clamp that only stores a loss already in effect reports nothing again. Account moves the engine makes
itself (a limit fallback, a removed account) keep their own plain-text notices, which already name the new
account. Not covered: a project's Summary (its members' standing charter) and agents outside the saved agent's
subtree whose retained grants an org folder expansion unmasks.

## How it reads

The agent reads one line in `[ORG NOTICES]` (`runtime/event_text.rs` `r_scope_changed`, through
`settings_notice::agent_line`), in its tools' words: `folders + D:\x (rw), − E:\y; tools − web; effort high → max;
charter edited (+3 −1 lines)`. The diff itself stays out of the prompt: the new text is in its system prompt.

The desktop draws every change kind through one table (`events/change.ts`): one line right under the card's
header, and anything longer (more than three folders or tools, a dropped change's reason, an instructions diff)
in a closed fold beneath it. The diff draws as an Edit tool call's (`pre.filepre.diffpre`). Settings read in the
settings dialog's own words (`canvas/settinglabels.ts`). The other change kinds (audiences, credits, model
switches, renames, moves, hires, retirements, compactions and the rest) already stored their values; their line
reads them, and header fields that only restated the change moved into Context. The card is the same on the desk
transcript, the mailbox reader, the history view and popped-out desks. A system notice's inbox row stays one line
with no preview (D-173); a row that draws a preview, such as a decision, reads the same line (`noticeSummary`), and
a folded run of notices lists each line in its tooltip. A notice stored before
2026-10-30 shows only the categories it recorded ("Changed: folders, tools").

Tests: `apps/desktop/renderer/tests/changenotices.test.tsx` (one case per kind), `domain/settings_notice.rs` tests.
