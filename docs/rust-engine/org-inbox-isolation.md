# Org-inbox isolation: transport prerequisite

User decisions, 2026-10-12: mail aimed at a disabled inbox must fail; history is hidden until re-enabled. Same-org agent/user mail remains outside this boundary. Preserve records, configuration and audiences. A failed attempt must not revive automatically.

## Source audit of pinned mail hub 2.1.1

Inspected exact hub commit `2c22e3d241169aac06f60ca90821bafe7b81131d`; no runtime proof is claimed here.

- `hub/src/api/mail.rs::send` locks the destination identity row, checks registration, then accepts/queues a message. Its HTTP 200 is the received receipt. Identity has no org-inbox availability control.
- `receipts` accepts only delivered/read; other values are ignored. Poll receipts expose received/fetched/delivered/read, not rejection.
- `unregister` removes the roster identity. Queued mail remains until retention; re-registering can expose it again. This is not the requested reversible inbox policy.
- Orgtree `net::queue` commits a durable outgoing row and reports queued success before hub admission. `drain` retries 422 responses, and `apply_receipts` does not recognize a terminal rejected state.

Simply skipping receiver polling or publication cannot satisfy sender-visible failure: the hub can still accept a disabled target's message and retain it for re-enable. A local Orgtree-only patch cannot promise the requested all-transports behavior against this protocol.

## Proposed prerequisite, awaiting coordinator ruling

An authenticated, capability-versioned per-identity inbox availability operation at the hub; admission serialized on the recipient row; explicit disabled-target send rejection; terminal rejection receipts for affected undelivered queued messages; sender-side durable terminal failure handling that is not revived by re-enable. Preserve message records. Define explicit behavior for older/unreachable hubs instead of silently claiming full isolation.

Already-dispatched requests retain the agreed best-effort cancellation limit: remote acceptance cannot be undone retrospectively. New local publication must serialize with the org-setting save. The prepared setting/canvas commits are not complete isolation enforcement and must not be shipped alone.