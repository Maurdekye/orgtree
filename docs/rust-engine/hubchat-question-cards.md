# Hubchat question cards from agents

Docket item `hubchat-question-messages-carry-preset-answers-y`. Hubchat shows a
question with preset answers as a card the person can answer with one tap
(user 2026-10-11 13:01-13:27Z). The user ruled (22:42Z) that agents send such
cards through `orgtree_message`; Hubchat has no question composer and nothing
relays `orgtree_ask`. The whole contract between the mail hub, Orgtree and
Hubchat is Hubchat's `docs/question-cards.md`. This page is Orgtree's part.

## The tool

`orgtree_message` with `kind: "question"` takes two optional parameters:

- `options`: 2-10 preset answers (user 2026-10-12 21:12Z). Each is one line
  of 1-100 characters (surrounding spaces are dropped); they must all be
  different, ignoring case.
- `multiple`: with `options`, true lets the person pick one or more (a
  multiple-choice card). Absent or false: pick one.

Refused, in plain words, before anything is queued: `options` on another
kind, `options` to anything but `@net:` addresses (every recipient of a list
must be one), a blank question body, a bad option list, and `multiple`
without `options`.

## What goes out

The body is the question, a blank line, `Pick one:` or `Pick one or more:`,
and the options numbered from 1, one per line. Every client, including
Orgtree itself and older Hubchat, reads that.

```
Which channel should rc4 go to?

Pick one:
1. Beta
2. Stable
```

`outgoing_payload` (net.rs) adds `meta` to a `question` whose body ends with
such a list: `{"question": {"options": [...], "multiple": bool},
"fallback": [start, end]}`, where the byte range is the list (a suffix of the
body) that Hubchat leaves out when it draws buttons. It is computed from the
stored body (`net_cards::meta`) on every send attempt, so a retry carries the
same value. The list's options must pass the same check as the tool's
`options`, exactly as written (no spaces around a label). A question without
such a final list carries no `meta`, so an agent's own text ending in, say,
`1. Same` / `2. same` stays whole in Hubchat instead of losing the list.
Orgtree sends `meta` to every hub; a hub without the `meta` feature drops
unknown keys, and the plain list still reaches the person.

## What comes back

The person's answer is an ordinary reply: `> ` and the question's first line,
then `Answer: <picked options>` or `Skipped` (a reply with no text), then any
text. A reply to several cards at once quotes each of them. Orgtree delivers
it as hub mail like any other; it does not track whether a card is settled,
and a later reply cannot change Hubchat's settled card. To ask again, the
agent sends a new question.

## Measured verification (2026-10-13, after reviews R1 to R4)

On `hubchat-opus/question-options`, rebased on rust-engine `67fc92e`, under
the machine build lock inside the repository's kernel Job runner (6144 MB,
600 s per step). The tests, build and proof below ran again after that
rebase; the red controls ran before it, on `9fc30fb`. Reviews R2 to R4
changed nothing in Orgtree.

- `cargo test --locked -j2 -p orgtree-engine net::cards::` passes all three
  `net_cards` tests (the tool's option checks; the list in the body becoming
  `meta`, the last list counting, malformed lists carrying none; a list the
  tool would refuse, such as `Same` / `same`, carrying none). Red control:
  with `meta` as reviewed, the refused-list test fails.
- `cargo build --locked -j2 -p orgtree-engine` (debug) passes with no warning.
- Rig proof `tools/rig/proofs/question-options.mjs` passes 18 of 18 with a
  scratch database, the fake CLI and a hosted hub built from the mail hub's
  `hubchat-opus/hub-meta` branch (listing `meta`). The real agent tool queues
  the numbered list; the payload builder adds `meta`; the real sender
  delivers single-choice, multiple-choice and free-response questions to a
  person registered over HTTP, whose client receives the body, `kind` and
  `meta` (none on the free-response one, none on a question ending in a
  refused list, which arrives whole); every refusal is in plain words and
  queues nothing. Red control: the reviewed engine fails only the refused
  list (17 of 18), sending it with `meta`.

## Limits

No live hub, real chat, installed app, Hubchat build or device was used.
Hubchat's side (cards, picks, answers, settling) is verified in the Hubchat
repository: core tests, a round trip through the same hub branch, and a
browser proof. Orgtree does not track whether a card is settled; an answer
reaches the agent as plain hub mail.
