# Agent typing in Hubchat

Docket: `show-agent-typing-in-hubchat-using-ordered-messa`. While an agent
writes mail to a Hubchat user (an `@net:` address), the user's Hubchat shows
"<org> is typing…" in that chat. It starts as soon as the call's recipients
are known and stops when the call ends.

## The message tools take metadata first, then body

`orgtree_message` and `orgtree_send_notice` take two arguments:

```json
{ "metadata": { "to": "@net:alice.k3x9", "kind": "message", "notice": false },
  "body": "The nightly build passed." }
```

- `metadata` holds every argument the tools had before, unchanged: `to`,
  `kind`, `notice`, `attachments`, `urgent`, `urgent_reason`, `reply_to`,
  `options`, `multiple`. `orgtree_send_notice` holds only `to`.
- `metadata` is listed first in `properties` and `required`, and the tool and
  argument descriptions say to write it first. The engine's `serde_json` keeps
  insertion order (`preserve_order`), so the schema reaches the model in that
  order.
- The handler (`tools::mailtools::flat_args`) reads the split shape in any key
  order and still accepts the flat shape, for older transcripts and any
  harness that keeps it. It refuses, saying what is wrong: `metadata` that is
  not an object, a metadata field beside it instead of inside, `body` inside
  it, and an unknown field inside it.
- Transcript references (`runtime::convo::tool_refs`) read `to` from either
  shape.

**Cache cost.** The change alters every agent's tool prefix, so each agent's
first turn after the update is a cold one. No other tool definition changed.

## Why the order works (measured 2026-10-13)

- **The model keeps the order.** In 116 real calls through the installed
  Claude Code (opus-5-5 at low and high effort, sonnet-5-5, haiku-5-5; with
  and without the order wording; 12 scenarios covering every metadata field),
  metadata came first every time. That bounds the inversion rate below 2.6%
  (95% confidence). It is not proven to be zero.
- **The API buffers per top-level argument.** By default the Claude API sends
  each top-level tool argument as one burst once it is complete. So
  `metadata` arrives as soon as the model has written it: a median 0.45 s
  into long calls, and a median 5 s before the body. In the earlier
  single-argument shape `{"message": [metadata, body]}`, the metadata only
  arrived together with the body.
- **No streaming switch.** Claude Code's `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING`
  is not set: the split shape doesn't need it, and the switch isn't publicly
  documented. The engine strips inherited `CLAUDE_CODE_*` variables anyway.
- **Claude Code passes the schema through unchanged and validates nothing.**
  Malformed calls reach the engine, which validates them as above.

Evidence: hubchat-opus's rig, `D:\orgtree-work\rig\hubchat-opus\typing\`
(`runs\results.md` for the fake model, `runs-real\results-real.md` for the
real model).

## How the engine shows it (`net::typing`)

1. **Probe.** `runtime::actor` (`on_stream_event`) watches the arguments of an
   `mcp__orgtree__orgtree_message` or `..._send_notice` call as they stream
   in, at most 64 KB. Once `metadata` is whole as the first argument
   (`net::typing::leading_metadata`), it calls `net::typing::begin`. If
   something else comes first, there is no indicator for that call, and the
   send is unaffected.
2. **The send's own checks, changing nothing.**
   - `tools::typing_peers`: the metadata would pass the handler's checks, and
     it names `@net:` peers.
   - `orginbox::may_send_extern`: the org inbox is enabled, and the agent
     holds its audience or is a live top-level agent. This is a read-only
     twin of `ensure_holders`, which grants.
   - Safe start is not on.
   - The peer is in a cached hub roster. Typing never fetches one.
   - The hub is the one the send would use (`pick_hub`), and the org is
     registered there.
3. **Signal.** `POST /api/typing` with the org's credentials, keyed by the
   call's tool-use id. It is refreshed every 8 s with a hub TTL of 20 s, and
   kept for at most 120 s.
4. **Stop.** Typing stops on whichever comes first:
   - the MCP call with that id returns, sent or refused (`tools::call`);
   - 30 s after the call's block ended without a call (a permission refusal,
     a cancelled turn);
   - the agent's turn ends or its CLI exits;
   - the cap.
   A stop that arrives before the start finished its checks keeps the start
   from happening (a tombstone kept for 10 minutes).
5. **Hubs without the feature.** A hub that answers 404 is not asked again
   for 10 minutes.

Only addresses and the call id leave the engine, never content. There is no
push and no notification. Codex, Muse, Antigravity and language-server lanes
get the same tool shape and validation, but no indicator: only the Claude
stream is probed.

## The other two parts

- **Mail hub** (`orgtree-mailhub`, feature `typing`): `POST /api/typing`,
  kept in memory only, never mail, ending by its TTL. A sync that sends
  `"typing"` gets who is writing to it. Only a device in use is woken, and
  only when the set of writers changes. See the hub's `docs/v2-additions.md`.
- **Hubchat:** the core asks hubs with the feature and emits
  `Event::Typing`. The chat shows "<name> is typing…" under the newest
  message, and the chat list's preview reads "typing…". A message from that
  peer in the same answer wins over its typing row. Never a notification.
