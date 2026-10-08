# Hub mail kind and read receipts

The 4.x hub queue discarded the agent's message kind, and its read receipt was
sent by the human inbox read route. Both differed from 3.x.

## Historical reference

Verified against `origin/release/3.x`:

- `engine/backend/orgtree/net.py`: the outgoing payload uses the spool entry's
  `kind`; `note_read` queues receipts when a turn provably consumed inbound mail.
- `engine/backend/orgtree/supervisor.py`: confirmed opening delivery, committed
  mid-turn delivery and reconciliation call `note_read`.
- `engine/backend/orgtree/api.py`: `org_inbox_read` only clears the person's
  unread state; it sends no hub receipt.
- Inbound net delivery does not pass the hub kind to `deliver_org_inbox` in 3.x.
  Its default `message` kind remains unchanged here.

## Restored behavior

Migration 0013 adds the outbound spool kind and exact inbound hub/message identity
on each holder's mail copy. Delivery acknowledgement and startup recovery queue
read receipts only for rows whose consumption is confirmed. Rejected starts and
unproven recovery handoffs stay unread. Receipt hub IDs remain queued until the
transport has loaded its participants. Human inbox read state stays independent.

The existing renderer label already says that an agent's turn consumed the mail;
no renderer change is needed. Existing outbound rows default to `message` because
their original kind was not stored. Existing inbound agent copies have no hub
identity to recover reliably; this change does not guess links from message text.

## Verification

Run with the agent's debug engine in `CARGO_TARGET_DIR`:

```powershell
node tools/rig/rig.mjs run tools/rig/proofs/hub-mail-parity.mjs --name hub-mail-parity
```

This is a focused engine-level proof. It checks the production spool writer and
wire payload builder for all five agent kinds, the real inbound fan-out and
deduplication, human read separation, fake-Codex opening and mid-turn consumption,
a refused start followed by a successful retry, and restart recovery with and
without durable mail-consumption evidence.

It does **not** register a hub identity, start a hub listener, send an HTTP hub
request, or exercise outbound audience/roster validation. Receipt delivery over
HTTP and a live provider consuming mail remain unmeasured. The receipt HTTP
serialization and retry path are unchanged.
