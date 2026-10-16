# Organization profile pictures

User scope (2026-10-12): Hubchat person and organization identities can own a
picture. Direct AI chat identities cannot. Eligible pictures remain visible in
conversation surfaces. Human organization settings edit this organization's
picture. User 2026-10-15 extended this to autonomous org Logo editing through
`orgtree_org_logo`; there is still no per-conversation picture.

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

### Autonomous Logo tool (4.3.1)

Any agent with effective `tools.orgtree.logo` can `set` from a local image in
its own or held folders, or `remove`. It defaults **on** (user 22:10Z) and is
inherited like other tool groups; user/team tools and org-inbox audience are
not prerequisites. A relative path starts in the agent's stored working folder.
Read-only grants suffice. The existing canonical file resolver bounds reads;
reading stops at 5 MiB + 1 byte. Unknown actions/selectors, animated/unsupported
images, directories, invalid crops and revoked grants refuse without mutation.

The tool shares the human native decoder slot, normalization, storage key and
Net feed/kick/publication path. Optional crop coordinates are the editor's
fractions of top-left travel and shorter-side scale; omitted means the largest
centred square. Image reads/decoding happen before a short transaction. Current
agent identity, inherited group and canonical source authority are rechecked
after taking history-head then org locks. Read-committed admission deliberately
sees a scope change that committed while waiting for the org lock.

An accepted tool edit commits the picture and a typed `logo` history entry in
one transaction (migration `0024_logo_undo`). The entry stores numeric agent id,
normalized before/after snapshots, timestamp and set/remove label; no original
file, raw request or credentials. A nonverbose audit line names org/agent/action.
The tool result and public history return metadata only; payload-bearing helpers
are `#[nolog]`, with explicit safe audit after commit. Existing wire omissions
remain. See [undo contract](undo-history.md#logo-history).

Undo/redo restore with a new monotonic revision and the same publisher. Later
independent edits refuse the stale entry without overwriting the new picture.
Consecutive Logo undo/redo rebind only history snapshots of the exact restored
revision. Removal is the existing versioned tombstone/orange-letter fallback.
Local changes remain immediate while hubs are disconnected or outside access is
disabled; supported hubs converge through the existing gate after re-enable.

Focused fixtures are `tools/rig/proofs/org-logo.mjs`, the extended group UI
proof, `scopebody.test.tsx` and native group/input tests. Rig-haiku verified
source `24cc230` on `d4b0889`: engine build/check, group 3/3, tool input 1/1,
picture 3/3, identity prompt 1/1 and skill coverage 9/9. Native Logo proof
passed 43/43 with a matched base red at its first named check; shared human
picture proof passed 21/21. Renderer scopebody passed 6/6, with exactly three
target failures and three passing controls at base, and historyui passed 8/8.
Renderer/test typecheck diagnostics remained the baseline 29/830, with no
added or removed diagnostics. These are isolated component checks; no installed
app, device or pixel acceptance was performed. The hosted hub binary's
provenance against pinned source was not verified.

Review remained open: Windows refused file-symlink creation with `EPERM`,
one test asserted the default-on constant at runtime (one added Clippy warning),
and the packet's original identity filter matched zero tests. The corrected
filter is `runtime::identity::group_tests::prompt_follows_every_combination_of_group_switches`;
Rig's corrected run executed the one test above. A compile-time constant
assertion replaces the warning-producing assertion. The boundary fixture now
requires valid existing images reached by absolute path, relative `..`
traversal and an unprivileged directory junction to be refused by the folder
guard with unchanged picture and journal. An optional symlink reports
`skipped: EPERM` explicitly; errors from the actual boundary check cannot be
mistaken for fixture skips. The junction creation/canonicalization/removal
preflight passed on this host. Fresh native boundary execution and the Clippy
109-warning baseline comparison remain for rig-haiku at the revised tip.

Original human-editor verification below is historical.

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

## Verification checkpoint

The user paused builds/tests at 10:48Z on 2026-10-12, then explicitly restored
focused verification at 10:53Z while retaining the prohibition on publishing.
No verification ran in between. At source `cbbd13b`:

- Native source check passed, exit 0, 7.37 seconds, warning-free. Debug engine
  binaries built in 2m14, exit 0, for the supported isolated rig only.
- Five mounted `orgpicture` cases passed under a kernel Job (2048 MiB/60 s,
  bundling included): numeric owner on removal, late old-org load, oversized
  selection before reading, native preview/original-to-save crop flow, failed
  refresh and retry. TypeScript noEmit passed under the same containment.
- `tools/rig/proofs/profile-pictures.mjs` passed 21 checks using the real engine
  and new hub in their own PostgreSQL/HTTP fixture: native normalization, owner
  refusal, malformed/oversized input and invalid crop, durable tombstones,
  concurrent counters, unchanged mail counts, positive wire-log omission,
  publication, local edit while isolated, re-enable, stale replay and remote
  revision adoption without minting another version. Processes were stopped
  through the supported rig lifecycle.

The first rig run completed 18 passing checks but failed at its 35-second
remote-adoption deadline. Logs showed adoption just after the last sample.
The legacy roster poll can spend 25 seconds parked before the 10-second picture
dispatch floor and pass scheduling; a rerun of the **same binary**, with a
50-second bound, passed (35.6 seconds measured for remote adoption). This was a
fixture deadline correction, not a claimed production fix. No new polling
cadence was added.

These are isolated component/HTTP proofs, not installed desktop, Android
WebView, device or pixel acceptance. Cancellation permit lifetime is supported
by source inspection and compilation, not a forced-cancellation runtime probe.
The separate Hubchat source is now composed onto saved-hub base `acdeab4`,
with bound request and local generation admission checks and focused cancellation
proofs recorded in that repository. Fresh multi-repository independent review
remains outstanding. No release, push or deployment is
authorized by these results.
