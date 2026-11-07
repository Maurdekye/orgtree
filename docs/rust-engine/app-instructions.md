# Instructions for all orgs

One Markdown block, edited in **App settings > Runtime > Instructions for all
orgs**, that every agent in every org receives on every harness, right before
its own org's org.md. The user asked for "a single app-wide instructions block,
that all orgs here receive" (USER 2026-10-31 10:07:16Z m187a259a848d, "yes
please" 10:08:14Z mda4f6d7961a4), and for it to hold the Connect your phone
note ("and make that the location where the hubchat mobile link block goes",
10:08:26Z m8a14bc89054c; "Yes, all orgs", 10:20:31Z m4322b3a92f0c). The
coordinator's rulings 1-10 (2026-10-31 10:20Z mdd81da812d3b) decide the gaps
below. Docket `app-wide-instructions-one-instructions-for-all-o`.

## Storage and writers

- One `ot.kv` row, `app_instructions`: `{text, phone_notes_moved, seq}`
  (`app_instructions.rs`). It belongs to no org, so creating and deleting orgs
  leaves it alone. It is not a file: no folder an agent holds, and no
  full-disk seat's file write, can change it. Readers use an `ArcSwap`
  snapshot; each committed write bumps `seq`, and a slower writer never
  publishes an older row over a newer one.
- Only two modules write it: the desktop editor (`http::settings::
  put_app_instructions`) and Connect your phone (`phone::link`, `unlink`,
  `migrate`). The unit test `only_the_editor_and_connect_your_phone_write_the_block`
  audits the crate's sources for any other writer and checks that agent
  tools, templates and importers never name it.
- `GET/PUT /api/app-settings/instructions` mirror org.md's editor endpoints:
  the GET returns the whole block as `content`, the Connect your phone note
  included, with `rev`, `chars`, `prompt_chars`, `edit_max` 200,000 and
  `prompt_max` 16,000. A PUT carries the whole block and the loaded
  `base_rev`, and is stored as sent; a stale revision is refused (409). A
  change sends `Reconfigured` to every live agent of every org.

## In the prompt

`identity_parts` adds `## Instructions for all orgs (app-wide)` right before
`## Organization notes (org.md)`, on all five lanes (they share
`plan.identity`). Blank text adds nothing, byte for byte. Delivery has org.md's
16,000-character cap and cut notice. The block sits in the rules part, so the
startup fingerprint's `system_prompt` covers it. For Claude an edit no longer
restarts the CLI (a resumed session cannot reload it; see Resumed Claude
sessions below); other lanes get a fresh CLI at each agent's next turn, never
mid-turn, and a new prompt prefix (one cold cache read each).
`orgtree_next_turn` lists it as source `app_instructions`,
path label `Instructions for all orgs (App settings > Runtime)`; the entry is
always present, so clearing the text reads as a change.

## The Connect your phone note

- Link writes the marked note (unchanged markers and wording) at the top of
  the block and removes notes from every org.md; one link carries the user's
  authority in every org, including orgs that never had one. Unlink removes
  it from the block and from every org.md.
- The EXTERNAL MAIL AUTHORITY rule names both trusted sources: the current
  instructions for all orgs (every org) and this org's current org.md (this
  org only). Exact envelope sender, the note's scope, ending by Unlink or
  removal, and never system or developer authority are unchanged.
- The note is ordinary editable text in the block, as in org.md (USER
  2026-10-31 13:59:20Z md088b15466fa, "this should be part of the editable
  charter, just like the org.md prompt"). Link puts it on top, replacing
  every marked note; Unlink removes every marked note; a save may keep,
  edit or drop it. The one-time move matches only the exact note
  (`note_address`). A start marker without its end makes Link and Unlink
  refuse, naming App settings, until the user repairs it.
- Templates never carry it: export drops it from `org_md`, and import drops
  it with a template warning.

## The one-time move (upgrade)

At engine start, after the orgs load and before the scheduler admits any
turn, `phone::migrate` runs once (the `phone_notes_moved` flag). Only the note
naming phone.json's linked address moves: the block gains it first, then each
org.md loses it, then the flag is set, so the delegation never lapses. A crash
in between finishes at the next start without a duplicate. Notes for other
addresses stay org-scoped and are logged; broken notes (a start marker
without its end) stay put; a link record without any note moves nothing.
Only the note leaves an org.md: text above and below it stays byte for byte
(`the_move_keeps_an_org_md_s_other_text_byte_for_byte`). An org.md that held
only the note is left empty, as on alpha.3's first start, where all four
orgs' org.md were exactly the note (measured from the engine's logged
`org_charter` arguments).

Limits: after a downgrade to 4.5.2 or earlier the old org.md notes are gone,
so the user relinks (ruling 5; also for the 4.5.3 release notes). Hand-written
text in org.md or in a template that names an address without the markers is
still trusted org configuration, as before.

## Resumed Claude sessions (4.5.8)

MEASURED 2026-11-07 (docket `4-5-8-resumed-claude-sessions-keep-a-stale-syste`;
USER md53ba71edd88): Claude Code writes a `prompt_snapshot` attachment of the
appended system prompt into the session transcript when the session is
created and, on `--resume`, restores THAT copy; the `--append-system-prompt-file`
the engine writes at every launch is ignored. A seat whose session predates
a rule-text, app-wide instructions, org.md or charter change kept the old
text for the session's life (the coordinator of a long-lived org refused the
user's authority this way). The engine's fingerprint and respawn were correct.

`runtime/prompt_sections.rs` delivers the change in the next turn instead
(coordinator ruling 2026-11-07 22:49Z):

- Sections: the engine rules text (the identity without the parts below),
  the seat's charter, its team and standing charters, the app-wide block,
  org.md, and the standing notes (own/folder AGENTS.md and the global ones).
  The org's shared notes folder is not a section (ruling (b), 2026-10-13).
- Record: `agents.extra.envelope.prompt_sections` = {sid, digest per section}.
  A new Claude session records the text it launched with (`install_claude`);
  each delivery records the new digests once the turn was accepted.
- A turn whose current digests differ gets ONE `[SYSTEM PROMPT UPDATE ...]`
  block ahead of the org state, naming only the changed sections with their
  full current text, marked as superseding the earlier text; a cleared section
  says so. Unchanged text adds nothing; the next turn adds nothing. The block
  is sent in full (it is not spilled to a file like the org state). It is its
  own extra ("System prompt update") in the token parts.
- A session with no record for its id (older than this mechanism) has an
  unknown baseline: every non-empty section is delivered once.
- No restart: when the only fingerprint part that differs for a warm Claude
  CLI is `system_prompt`, the CLI stays (`Fingerprint::same_but_prompt_text`,
  `ensure_claude`, the `Reconfigured` handler), and the forecast and next-turn
  reasons ignore it for Claude. Any other part (tools, folders, model,
  account, startup files) still respawns.
- Other lanes: Codex passes `developerInstructions` on `thread/resume` as well
  as `thread/start`; Muse and Antigravity regenerate their identity file at each
  launch. From the code alone they pass fresh text on every launch; whether the
  vendor honours it on resume was not measured (no live CLI), so they are
  unchanged.
