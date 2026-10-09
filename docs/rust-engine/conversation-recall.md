# Conversation recall (`orgtree_inbox` action=conversation)

The user asked for this on 2026-10-09 (via Hubchat, 00:01Z): after a fresh session or a
compaction, an agent forgets what it was just discussing with someone. Agents now have a tool to
list the mail they exchanged with one correspondent. The fresh-session note tells them to use it.

3.x had no equivalent. Its `orgtree_inbox` listed only waiting mail and refused any peer
argument (`engine/backend/orgtree/inbox.py`, `tests/test_inbox_door.py`). Its cheap-compact
notice named neither correspondents nor a recall tool. So this is a new 4.x feature with no
parity constraint (decision 55).

## The tool

`orgtree_inbox action=conversation peer=<peer> [limit] [cursor]`

- **`peer`**: an agent's name (retired and deleted agents too, since the mail stays the
  caller's), `user`, `@org:<slug>` or `@net:<address>`. A bare name that is no agent resolves as
  outside mail does (an org on this machine, else a unique hub peer). Naming yourself, an
  unknown name or any other argument is refused.
- **What comes back**: mail in both directions, oldest to newest within a page, the newest page
  first. Each message has:
  - `id` (what `fetch` and `reply_to` take), `at`, `direction` (sent or received), `from`,
    `to`, `kind`, `state`, `notice`;
  - a `preview`, `chars` (the whole length) and `cut` when the preview is shorter than the body;
  - `reply_to` ({id, from, gist}) when it answers something, and `attachments` (names only).
- **Paging**: `next_cursor` gives the page before. It is bound to the caller, so another
  agent's cursor is refused. A plain `note` says how many messages the page holds. It says
  whether older mail exists (with the exact next call) or that this is the start, and how to
  fetch a cut message.
- **`fetch`** now returns mail the caller sent too, so a cut preview can be read whole. That
  covers mail to agents, to the user, and outside mail it sent from the org inbox. A sent
  message is marked `direction: sent` with its `to`.

## Caps (so a recall cannot flood a context)

| | |
|---|---|
| Default page | 20 messages |
| Most per call | 100 (a larger `limit` is clamped) |
| Preview | at most 500 characters per body (whitespace collapsed) |
| Page budget | 16,000 characters of previews and reply quotes. The page stops early and says so, but always holds at least one message. |
| Reply quote | 120 characters |

The same caps were passed to mailhub-opus for the hub's `hub_history` (coordinator,
2026-10-09).

## What it reads (no new visibility)

It reads exactly what `reply_to` already accepts:

- mail the caller received (`recipient_agent_id`), excluding mail retracted before it was
  delivered;
- mail the caller sent to an agent or to the user (`sender_agent_id`);
- outside mail the caller sent from the org inbox (`org_inbox` `dir = 'out'` under its name),
  only since the caller was created, so a deleted namesake's mail is not its own.

An org-inbox holder sees the outside mail delivered to it and its own replies. An agent that held
nothing sees none.

## Bounded queries

Migration 0015 adds three indexes so each side of a conversation is one short index range:

- `mail_pair` (recipient, sender, created_at, id): mail between two agents either way, and an
  agent's mail to the user;
- `mail_from_outside`: mail from the user, `@org:` or `@net:`;
- `org_inbox_sent_by`: outside mail an agent sent.

A page reads at most `limit + 1` rows per side, and only the first 2,000 characters of each body.

## The fresh-session note

`convo::handoff_note` covers the cold-cache reset, a cheap compact, a provider switch and an
unrecoverable rehire. It now says: "To recover what you were discussing with someone, use
orgtree_inbox action=conversation peer=<name> before you reply to them …". It then names the six
correspondents the agent exchanged mail with most recently, newest first, with the time of the
latest message. Engine notices and watchdog mail are not correspondents.

## Found on the way: a real message behind 64 notices never started a turn

`start_turn` claimed the 64 oldest waiting mails, and started no turn when all 64 were notices.
Every later wake read the same rows. So an agent with more than 64 unread notices never started a
turn for a new real message, for example a superior collecting status notices, or an org-inbox
holder.

The claim now also takes the oldest real message when the 64 oldest are all notices. The
leftover notices ride the next turns, oldest first (decision 56). The claim is a `UNION` of the
two locked sets, matched by primary key. An `OR` of two `IN` lists planned as a full scan of
`ot.mail`. Measured on 200,000 rows: 28 ms for the `OR` form, 1.3 ms for the `UNION` form.

## Proof

`tools/rig/proofs/conversation-recall.mjs` (with `--hub <orgtree-mailhub.exe>` for the `@net:`
part). 28 checks:

- order, paging, the limit walk, the mirror view and the reply link;
- caps: 100, 20, 500 and 16,000, with the cursor and `fetch`;
- user mail, with an attachment;
- `@org:` and `@net:` mail through a hosted hub, from both holders' sides;
- refusals and visibility;
- the 114-notice backlog: the real message starts its turn with the 64 oldest, the next turn
  takes the rest, and nothing stays waiting;
- the fresh-session hint and the correspondents, in order.

Results: 28/28 on the branch. 1/28 on rust-engine `bc3e6ef`, where there is no `conversation`
action, `fetch` does not find sent mail, and the real message never got a turn (115 mails still
waiting).
