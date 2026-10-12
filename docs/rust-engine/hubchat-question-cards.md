# Hubchat question cards from agents

Docket item `hubchat-question-messages-carry-preset-answers-y`. Hubchat shows a
question with preset answers as a card the person can answer with one tap
(user 2026-10-11 13:01-13:27Z). The user ruled (22:42Z) that agents send such
cards through `orgtree_message`; Hubchat has no question composer and nothing
relays `orgtree_ask`. The whole contract between the mail hub, Orgtree and
Hubchat is Hubchat's `docs/question-cards.md`. This page is Orgtree's part.

## The tool

`orgtree_message` with `kind: "question"` takes two optional parameters:

- `options`: 2-10 preset answers. Each is one line of 1-100 characters
  (surrounding spaces are dropped); they must all be different, ignoring case.
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
same value, and a question without a well-formed final list carries no `meta`.
Orgtree sends `meta` to every hub; a hub without the `meta` feature drops
unknown keys, and the plain list still reaches the person.

## What comes back

The person's answer is an ordinary reply: `> ` and the question's first line,
then `Answer: <picked options>` or `Skipped` (a reply with no text), then any
text. A reply to several cards at once quotes each of them. Orgtree delivers
it as hub mail like any other; it does not track whether a card is settled,
and a later reply cannot change Hubchat's settled card. To ask again, the
agent sends a new question.
