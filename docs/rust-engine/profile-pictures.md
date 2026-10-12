# Organization profile pictures

User scope (2026-10-12): Hubchat person and organization identities can own a
picture. Direct AI chat identities cannot. Eligible pictures remain visible in
conversation surfaces. Human organization settings edit this organization's
picture; no agent editing tool or per-conversation picture is introduced.

## Image and storage boundary

The desktop sends a selected static PNG/JPEG/WebP through authenticated bounded
HTTP, never a filesystem path or remote image URL. Input is at most 5 MiB and
16 megapixels. Native decoding applies orientation, supplies a stripped preview,
and applies the editor's square crop. Output is RGB/RGBA PNG containing only
IHDR/IDAT/IEND, at most 512 square and 256 KiB. Animation and SVG are refused.
One decoder slot covers preview and save. The blocking task retains the slot
even if its HTTP caller is cancelled. Image bodies are omitted by the wire
middleware before authentication/404 as well as on successful responses.

An existing `ot.meta` record `org.picture.<org-id>` owns the normalized picture.
It is separate from the organization net document and tree; only its revision
is projected into the settings refresh payload. The editor sends the numeric
organization owner returned by GET, so reusing a slug cannot redirect an old
edit to a new organization. The active organization row serializes local edits,
remote merges and the initially missing record. No decoding or external I/O
holds that transaction. Organization trash retains the record with the org.

## Cross-hub convergence

The additive hub capability is `profile_pictures`; unsupported hubs retain the
usual fallback. Hub and Hubchat changes are separate repository landings. No
migration is needed: reserved hub schema 10 and Hubchat SQLite migration 16 are
untouched.

The shared record contains revision, sha256, width, height, bytes and data.
Removal has null data/hash and zero dimensions/bytes. Revision is a 20-digit
positive counter followed by a hyphen and 32 lowercase random operation-ID
digits. An explicit edit increments the greatest observed counter atomically.
Automatic publication reuses it. Lexicographically greatest revision wins;
concurrent unseen edits use the operation ID as their deterministic tie-break.
Removal is a durable versioned record, never absence. Cached older images cannot
replace a learned removal. New explicit edits are intentionally allowed later.

The existing network pass dispatches at most four optional picture jobs,
deduplicated per organization/hub. Attempts are at least ten seconds apart;
capability readings expire after five minutes. Removed memberships prune their
retry/ack/capability entries. Picture I/O does not block the mail pass. Each
request is bounded, refuses redirects, and holds the existing org-inbox
isolation gate; cancellation stops the request when the policy changes. Current
organization identity and enabled hub membership are rechecked before each
request and merge. Local edits remain possible while outside access is disabled.

Synchronization reads the remote version before publishing the local winner.
Per-hub acknowledgements and roster revisions avoid repeatedly transferring
unchanged bytes. Incoming updates do not mint a new revision. The older state
retained at a disconnected hub cannot overwrite a newer locally learned state.

## Checkpoint and unrun verification

The first native source checkpoint passed `cargo check --locked -j2 -p
orgtree-engine --bin orgtree-engine`, exit 0, without warnings. That check
predates the settings revision projection, editor, middleware omission,
decoder-cancellation retention and retry-cache cleanup changes.

The user stopped all builds and tests at 10:48Z on 2026-10-12 pending completion
of paused Claude work. No verification was started after that gate. This source
checkpoint is **not verified or ready to integrate**. Outstanding: final native
check, supported isolated HTTP/store/publication/isolation and log-secrecy proof,
bounded mounted editor/crop/identity tests, renderer TypeScript check and fresh
independent review. Existing hub and Hubchat component receipts do not prove this
organization path, installed desktop, Android WebView, device or live hub behavior.
