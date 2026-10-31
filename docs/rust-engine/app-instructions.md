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
  the GET returns the user's text as `content` and the Connect your phone
  note apart as `managed` (null while no phone is linked), with `rev`,
  `chars`, `prompt_chars`, `edit_max` 200,000 and `prompt_max` 16,000. A PUT
  carries only the user's text and the loaded `base_rev`; a stale revision
  is refused (409), text with the note's markers is refused (400), and the
  current note stays on top. A change sends `Reconfigured` to every live
  agent of every org.

## In the prompt

`identity_parts` adds `## Instructions for all orgs (app-wide)` right before
`## Organization notes (org.md)`, on all five lanes (they share
`plan.identity`). Blank text adds nothing, byte for byte. Delivery has org.md's
16,000-character cap and cut notice. The block sits in the rules part, so the
startup fingerprint's `system_prompt` covers it: an edit means a fresh CLI at
each agent's next turn, never mid-turn, and a new prompt prefix (one cold
cache read each). `orgtree_next_turn` lists it as source `app_instructions`,
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
- The editor shows the note read-only above the text.
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

Limits: after a downgrade to 4.5.2 or earlier the old org.md notes are gone,
so the user relinks (ruling 5; also for the 4.5.3 release notes). Hand-written
text in org.md or in a template that names an address without the markers is
still trusted org configuration, as before.
