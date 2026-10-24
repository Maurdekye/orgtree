# Mail and hub

## Phone settings compatibility (2026-10-23)

Phone settings parsing discards obsolete preference keys before exposing or
saving retained card/link data. Unknown legacy values must not make startup
fail, and reading alone does not rewrite the user's file. Phone access submits
only its network scope; sleep warnings remain diagnostics. Keep the phone
panel, desktop HTTP contract and glossary inventory in step when removing a
setting. [decided: user 2026-10-23; verified: `phone.rs`, `http/desktop.rs`,
`canvas/phonelink.tsx`]

Org Do not disturb adds an org-local third inbox mode without changing Closed
isolation. Inbound publication, pull and resumption share the org-row lock;
never fan out or create fallback wakes while held. Viewer read state does not
consume held mail. Mode changes remain user-only; extern holders can read/pull.
See [storage, tools and evidence limits](../rust-engine/org-inbox-dnd.md).
[decided: user/coordinator 2026-10-23; verified: `domain/orginbox.rs`,
`tools/org_inbox.rs`, migration0055]

[Repository startup guide](../../AGENTS.md) · [All topics and entries](README.md)

Delivery, mentions, inboxes, outside authority, files, Hubchat and hub transport.

## One-time agent mail (2026-10-24, 4.4.5)

`orgtree_message` and `orgtree_send_notice` accept optional `one_time:false`.
True suppresses the existing deep-descendant reply grant, stores a separate mail
marker and renders the one-time/do-not-reply header even when reply reach already
exists. Keep it across project handoff, replay, reference and inbox content reads.
Existing rights and ordinary false/omitted delivery stay unchanged. True refuses
user/outside destinations after canonical recipient resolution, per recipient;
no outside staging or publication is allowed for that copy. See the
[message guide](../skills/orgtree-working/mail/tool-message/SKILL.md).
[decided: user 2026-10-24; coordinator boundary clarification 2026-10-24;
verified: `tools/mailtools.rs`, `domain/mail.rs`, `runtime/envelope.rs`]

These attributed records were moved from the root guide at `22daffd`; they retain the original substance, dates, verification limits and replacements. They are source evidence, not a declaration that every historical state is current. Read the signed decisions/current source before changing behavior. Inline source paths remain relative to the repository root; Markdown links were rebased. Add current detailed guidance here; preserve replaced records in history and update the coverage destination when moving one.

<a id="e-afee43810f9d96a8"></a>

## @user mentions in agent transcripts, mail, presentations and docket items

Original section: Unsectioned integration notes. Source lines 1–10.

<!-- preserved:e-afee43810f9d96a8 -->
- `@user` mentions in agent transcripts, mail, presentations and docket items
  (outside markdown code spans/blocks via `strip_markdown_code`) raise desktop
  notifications under the `Mentions` (`notifyMentions`) category (default on in
  Runtime > Notifications and tray). Clicking opens the transcript, inbox mail,
  presentation or docket item. Document (`mention:doc:<uid>`) and docket
  (`mention:work:<slug>:<rev>`) notices set `attention: false` so one-time OS
  banners fire without holding the taskbar badge; unfocused open desks defer
  auto-acknowledging `user_mention` until window focus. [decided: user
  2026-10-20 19:18Z; verified: `domain/{notices,mail_attention}.rs`,
  `runtime/convo.rs`, `notifications.ts`, `tests/notificationsettings.test.tsx`]
<!-- /preserved:e-afee43810f9d96a8 -->

## Active unread attention counts

Inbox-summary and native attention aggregates use the existing Rust visible-prose
eligibility function, including Markdown code exclusion and nested quoted prose.
They iterate the complete pending user-mail set by ascending id in bounded
pages, with no page-count cap and no read/delivered history. Inbox summary keeps
its disabled-org-inbox exclusion; native attention keeps its broader existing
mail scope. Urgency remains sufficient regardless of prose. This replaces the
raw SQL token regex that counted code examples. [verified:
`domain/mail_attention.rs`, `domain/notices.rs`, `feed/groups.rs`; 2026-10-21]

<a id="e-b010624f7405c185"></a>

## The shared context-menu renderer puts an Open submenu second at every menu

Original section: Unsectioned integration notes. Source lines 86–90.

<!-- preserved:e-b010624f7405c185 -->
- The shared context-menu renderer puts an Open submenu second at every menu
  level, after copy/mention prefixes and async updates. Other action order,
  callbacks and gates stay unchanged; plain Open actions keep their position.
  [decided: user 2026-10-20 14:55Z; verified: `canvas/contextmenu.tsx`,
  `tests/opensecond.test.tsx`]
<!-- /preserved:e-b010624f7405c185 -->

<a id="e-fba388a03959e3d4"></a>

## Collapsed mail-row tag previews show every matching active filter tag in

Original section: AGENTS.md — working on Orgtree. Source lines 513–518.

<!-- preserved:e-fba388a03959e3d4 -->
- Collapsed mail-row tag previews show every matching active filter tag in
  filter order before +N; the count and hover list contain only hidden tags.
  Multiple matching tags wrap within the row and keep full labels on hover.
  No-filter and one/two-tag previews keep their existing order.
  [decided: user/coordinator 2026-10-19; verified: `canvas/mail.tsx`,
  `tests/mail-tag-order.test.tsx`]
<!-- /preserved:e-fba388a03959e3d4 -->

<a id="e-94ed8ea77a882f19"></a>

## Enabling a mail-row tag filter opens that row's mail when the previously

Original section: AGENTS.md — working on Orgtree. Source lines 520–526.

<!-- preserved:e-94ed8ea77a882f19 -->
- Enabling a mail-row tag filter opens that row's mail when the previously
  open mail no longer matches. Matching selections and reader-cleared panes
  stay as they are; removing a tag does not select another mail. Remember the
  explicit target before updating tags so user inbox server-filter refreshes
  retain it. Shared user/agent/project lists use the same handler.
  [decided: user 2026-10-19 19:23Z; verified: `canvas/mail.tsx`,
  `tests/{mail-tag-selection,inbox-tag-behavior}.test.tsx`]
<!-- /preserved:e-94ed8ea77a882f19 -->

<a id="e-605ed2872e1627cc"></a>

## Startup tool descriptions retain the 12,000-byte aggregate and 900-byte/card

Original section: AGENTS.md — working on Orgtree. Source lines 882–886.

<!-- preserved:e-605ed2872e1627cc -->
- Startup tool descriptions retain the 12,000-byte aggregate and 900-byte/card
  caps for flat and split mail shapes. Keep concise authority/call cues on cards;
  move full operational detail into the named tool guides. Description-only
  trims must preserve schemas, card order and scope rules.
  [verified: `tools/defs.rs::startup_card_tests`; 2026-10-18]
<!-- /preserved:e-605ed2872e1627cc -->

<a id="e-2abde9bbc264452a"></a>

## Hub-contact chip consumers discover hubchat_pc through one shared full

Original section: AGENTS.md — working on Orgtree. Source lines 1164–1169.

<!-- preserved:e-2abde9bbc264452a -->
- Hub-contact chip consumers discover `hubchat_pc` through one shared full
  desktop phone-status read, independently of the phone panel. The cheap phone
  card omits that fact. Window focus refreshes stale availability after 60s;
  failures/malformed values preserve the known state. Local orgs retain local
  routing; genuinely absent Hubchat chips remain inert. [decided: user 2026-10-18 12:51Z;
  verified: `canvas/agentmentions.tsx`, `tests/hubavailability.test.tsx`]
<!-- /preserved:e-2abde9bbc264452a -->

<a id="e-91f8ee65e63000af"></a>

## Inbox tag popovers close 250ms after the pointer leaves a 100px margin around

Original section: AGENTS.md — working on Orgtree. Source lines 1245–1252.

<!-- preserved:e-91f8ee65e63000af -->
- Inbox tag popovers close 250ms after the pointer leaves a 100px margin around
  trigger and popup; reentry, typed search and held keys protect the picker.
  Filtered mail remembers its selected matching row; only a NEW mail carrying
  ALL selected tags may replace it. The compact hidden-unread entry uses a
  server aggregate, clears tags and opens the global oldest unread message by
  exact id, even beyond loaded pages. See [mail tags](../../docs/rust-engine/mail-tags.md).
  [decided: user 2026-10-18 11:30–11:31Z; verified: `inboxselection.ts`,
  `canvas/{mailtagpicker,tagpointerdismiss,mail}.ts*`, `domain/mail_tags.rs`]
<!-- /preserved:e-91f8ee65e63000af -->

<a id="e-13ae742faf34fc1d"></a>

## Mail hub tests and real registration/poll/file requests try direct transport,

Original section: AGENTS.md — working on Orgtree. Source lines 1588–1604.

<!-- preserved:e-13ae742faf34fc1d -->
- Mail hub tests and real registration/poll/file requests try direct transport,
  then the system/env proxy only on initial connect failure. Never replay an
  accepted request, HTTP rejection, read failure or redirected connection.
  The direct connect deadline is one second, before short request deadlines;
  total request timeouts are not replayed. Hosting's own loopback health check
  remains strictly direct (separate from the connection Test).
  Both direct/proxy mail clients disable automatic redirects: a 3xx response
  becomes an explicit HTTP-status error for every caller (including downloads).
  Configure the final hub URL (including HTTPS). reqwest's
  connect-error URL can remain original after a redirect; URL equality alone
  does not prove an initial connect failure. [verified: reqwest 0.12.28]
  Streaming upload retries reopen their body. Bare hosts discover 7370, 7378, 7371
  and HTTPS concurrently; explicit URLs/ports stay explicit, including :80.
  Test returns the selected endpoint; registration, status and unregister reuse
  only a registered address within the current candidates. Discovery remains
  under org cancellation and rig isolation. [decided: user/coordinator 2026-10-19;
  verified: `net.rs`, `net/transport.rs`, `net/discovery.rs`, `canvas/connections.tsx`]
<!-- /preserved:e-13ae742faf34fc1d -->

<a id="e-20e9660ea3a2f836"></a>

## User-mail custom tags (4.4.0): at most eight trimmed 1-32-character tags,

Original section: AGENTS.md — working on Orgtree. Source lines 1671–1690.

<!-- preserved:e-20e9660ea3a2f836 -->
- User-mail custom tags (4.4.0): at most eight trimmed 1-32-character tags,
  normalized by lowercase key in an org dictionary with first committed spelling.
  User mail and normalized memberships commit atomically; tagged non-user routes
  refuse before attachments/transport, including mixed fan-out. Tag filtering
  precedes bounded cursor windows: all selected toggles must match (AND). Used
  tags cursor-page indexed memberships; a dedicated UserMail revision refreshes
  filtered mail/catalogs even after deletion outside the visible windows. Chips hash
  the normalized name to a stable hue; `--mail-tag-*` (one palette per contrast
  family) makes them in-sRGB tints with AA text on every surface, which
  `tests/mail-filter-bar.test.tsx` recomputes (replaced the opaque, gamut-clipped
  L .88 fill, user 2026-10-18 11:32Z). Every mail/filter/popover tag chip toggles
  its normalized key. Picking closes the popover and returns focus to its trigger;
  reopening preserves multi-tag AND selection. The inbox filter bar is ONE 24px
  border-box field, also inside `.settings`: tag-icon trigger, chips, the text
  filter (MailTagPicker `children`) and clear sit inside it (replaced three
  separate 24px boxes). The fixed tag popover must override the modal's
  centering transform and takes the field's width, 240-320px.
  [decided: user 2026-10-18; verified: `canvas/mail.tsx`, `canvas/mailtagpicker.tsx`, `canvas/mailtags.ts`, `styles.css`]
  See [mail tags](../../docs/rust-engine/mail-tags.md). [decided: user/coordinator
  2026-10-17; verified: `domain/mail_tags.rs`, `usemailtags.ts`, `canvas/mailtags.ts`]
<!-- /preserved:e-20e9660ea3a2f836 -->

<a id="e-26e9bb995adba344"></a>

## User inbox deletion (4.4.0) is available only from a received-message row

Original section: AGENTS.md — working on Orgtree. Source lines 1692–1697.

<!-- preserved:e-26e9bb995adba344 -->
- User inbox deletion (4.4.0) is available only from a received-message row
  context menu and requires confirmation. The engine deletes only a user-recipient
  copy, prunes unused tag labels in the same transaction, then publishes
  `Change::UserMail`; sender history, other mailbox copies and attachment files
  remain. See [mail tags](../../docs/rust-engine/mail-tags.md#deleting-a-user-inbox-message-440).
  [decided: user 2026-10-17; verified: `http/mailbox.rs`, `canvas/mail.tsx`, `App.tsx`]
<!-- /preserved:e-26e9bb995adba344 -->

<a id="e-fb8637c898f64232"></a>

## The user inbox remembers the last opened received mail per org for the current

Original section: AGENTS.md — working on Orgtree. Source lines 1706–1710.

<!-- preserved:e-fb8637c898f64232 -->
- The user inbox remembers the last opened received mail per org for the current
  app session. On reopening, it restores and scrolls to that row only when no
  new inbox message arrived and the row is still retained and included by the
  active filters. See [inbox screens](../../docs/skills/orgtree-app/desk/inbox-screens/SKILL.md).
  [decided: user 2026-10-17; verified: `App.tsx`, `canvas/mail.tsx`]
<!-- /preserved:e-fb8637c898f64232 -->

<a id="e-aee6090276bf3143"></a>

## Native Muse metadata refreshes cached display identity even when quota is

Original section: AGENTS.md — working on Orgtree. Source lines 1989–1993.

<!-- preserved:e-aee6090276bf3143 -->
- Native Muse metadata refreshes cached display identity even when quota is
  absent or unchanged. The overlay preserves quota age and auth evidence;
  unknown identity clears the prior email and never enters durable quota.
  [decided: coordinator 2026-10-17; verified: `usage.rs`; contract:
  `docs/rust-engine/muse-usage-cache.md`]
<!-- /preserved:e-aee6090276bf3143 -->

<a id="e-e4b5ac735f1b4290"></a>

## Antigravity admission/launch repeats an inconclusive silent check once after

Original section: AGENTS.md — working on Orgtree. Source lines 2381–2387.

<!-- preserved:e-e4b5ac735f1b4290 -->
- Antigravity admission/launch repeats an inconclusive silent check once after
  500 ms (Unavailable/Timeout only), reacquiring metadata and the guard each
  time. SignedOut, NotIsolated and OutputLimit never retry; exhausted admission
  leaves mail pending without signed-out evidence. Diagnostics name fixed
  stages/reasons only, never captured output. [decided: coordinator 2026-10-17;
  verified: `providers/agy_auth.rs`, `runtime/actor.rs`; contract:
  `docs/rust-engine/antigravity-background-auth.md`]
<!-- /preserved:e-e4b5ac735f1b4290 -->

<a id="e-f9750e44713295b9"></a>

## Transfers starts collapsed in every new mail view. Keep expansion while that

Original section: AGENTS.md — working on Orgtree. Source lines 2447–2451.

<!-- preserved:e-f9750e44713295b9 -->
- Transfers starts collapsed in every new mail view. Keep expansion while that
  view stays open, including transfer polls; reset on mailbox org/agent changes.
  Org inbox and user/agent/desk inboxes share TransferPanel. Preserve unfinished
  counts, polling, progress, history, paging and engine jobs; no persisted flag.
  [decided: user/coordinator 2026-10-14; docs/rust-engine/transfers-default.md]
<!-- /preserved:e-f9750e44713295b9 -->

<a id="e-e387190e2e84ac8f"></a>

## Organization settings calls its Hubchat account image Logo. The avatar

Original section: AGENTS.md — working on Orgtree. Source lines 2602–2609.

<!-- preserved:e-e387190e2e84ac8f -->
- Organization settings calls its Hubchat account image **Logo**. The avatar
  opens the existing chooser; pencil is always bottom-right and a separate X
  removes an existing logo. Preserve numeric-owner/intent guards, crop and API
  semantics. Empty fallback copies Hubchat org orange/initials independent of
  provider accents; the requested round shape is editor-local. Scope avatar/X
  chrome with two classes to outrank `.settings button` padding/radius/colors.
  See [Logo editor](../../docs/rust-engine/org-logo-editor.md).
  [decided: user 2026-10-13; verified: `canvas/orgpicture.tsx`, `orglogo.css`, `App.tsx`]
<!-- /preserved:e-e387190e2e84ac8f -->

<a id="e-21addef93d80e64c"></a>

## Recommend each developer installs Orgtree and Hubchat, both connected to a shared standalone mailhub on a company-access

Original section: AGENTS.md — working on Orgtree. Source lines 2716–2716.

<!-- preserved:e-21addef93d80e64c -->
- Recommend each developer installs Orgtree and Hubchat, both connected to a shared standalone mailhub on a company-accessible private server. The built-in Orgtree mailhub is for individuals and small teams. This is deployment guidance, not a size cutoff, migration or runtime default change. Keep person and organization identities separate; human hub mail uses Hubchat. See [team setup](../../docs/team-setup.md). [decided: user 2026-10-12 10:11–10:13Z]
<!-- /preserved:e-21addef93d80e64c -->

<a id="e-8c61a2eb68eabebb"></a>

## Human hub mail is composed in Hubchat. The Orgtree org-inbox window is a viewer: no compose/reply/upload controls or ded

Original section: AGENTS.md — working on Orgtree. Source lines 2718–2718.

<!-- preserved:e-8c61a2eb68eabebb -->
- Human hub mail is composed in Hubchat. The Orgtree org-inbox window is a viewer: no compose/reply/upload controls or dedicated send/staging HTTP routes. Retired staging file bodies stay omitted before authentication/404; legacy cleanup notices describe the upload failure and point to Hubchat, without asserting message admission. Keep agent mail, retained history/quotes/files, transfer custody and partial-upload cleanup. See [viewer contract](../../docs/rust-engine/org-inbox-viewer.md). [decided: user 2026-10-12 08:41Z; verified: 2026-10-12 `canvas/mail.tsx`, `http/orginbox.rs`, `http/mod.rs`, `net/failures.rs`]
<!-- /preserved:e-8c61a2eb68eabebb -->

<a id="e-c2f741691526d825"></a>

## Org inbox isolation is an org-local, default-on boundary: org_inbox_enabled=false rejects new external sends before queu

Original section: AGENTS.md — working on Orgtree. Source lines 2720–2720.

<!-- preserved:e-c2f741691526d825 -->
- Org inbox isolation is an org-local, default-on boundary: `org_inbox_enabled=false` rejects new external sends before queue admission or hub contact, including local `@org:` delivery, and hides retained inbox/copies until re-enabled. Desk counts/pages, state-inspection pending counts and new quote lookups filter hidden copies; file access gates the canonical inbox path owner even through another org route. Internal agent/user mail stays usable. Publication locks org IDs in ascending order; per-org I/O cancellation never unregisters an identity or recalls remote acceptance. See [isolation boundaries and proof limits](../../docs/rust-engine/org-inbox-isolation.md). [decided: user 2026-10-12; verified: `domain/orginbox.rs`, `net/isolation.rs`, `http/settings.rs`]
<!-- /preserved:e-c2f741691526d825 -->

<a id="e-c824b3c327871cc1"></a>

## Lifecycle invalidations read mailbox/history bodies only for ready matching

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 2737–2746.

<!-- preserved:e-c824b3c327871cc1 -->
- Lifecycle invalidations read mailbox/history bodies only for ready matching
  socket windows; initial reads and in-flight subscription dirty recovery keep
  their own snapshot rules. Card pending counts still invalidate independently.
  Feed metadata changes rebuild that node only; scope/placement changes cascade,
  and audience refresh rebuilds only identities whose effective routes changed.
  Migration 0048 indexes outstanding mail and slot leases by holder, so stop/
  retire rechecks do not scan retained history. Hot projection/catalog helpers
  use `#[nolog]`; request/operation diagnostics remain logged. [verified:
  `feed/mod.rs`, `migrations/0048_active_claim_holder.sql`,
  `tools/rig/proofs/hire-retire-cost.mjs`; user/coordinator 2026-10-20]
<!-- /preserved:e-c824b3c327871cc1 -->

<a id="e-d7fb75f5e03bf14b"></a>

## orgtree_message/orgtree_send_notice take {metadata, body}. Metadata

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 2802–2824.

<!-- preserved:e-d7fb75f5e03bf14b -->
- `orgtree_message`/`orgtree_send_notice` take `{metadata, body}`. Metadata
  holds every former argument, is listed first and is described as written
  first. The handler (`mailtools::flat_args`) reads it in any order and still
  takes the flat shape. Keep metadata first: the API sends each top-level
  argument whole, so `runtime::actor` sees it early and `net::typing` sends
  the hub a typing heartbeat every 500 ms (no start, no stop on the wire;
  user 2026-10-13 22:34Z) after the send's own read-only checks
  (`orginbox::may_send_extern`, never `ensure_holders`). They stop when the
  call's block ends, its tool returns, the turn or process ends, or the cap
  (120 s); Hubchat drops the row a second after the last. Never send
  content, never set the fine-grained streaming switch. The probe shares
  `on_stream_event`'s `content_block_start`/`content_block_stop` arms with
  the tool-writing clock: one arm per event type (a second is unreachable,
  and its code silently never runs). Antigravity seats
  keep the flat cards (`defs::MailShape::Flat` through `bridge::serve` /
  `serve_observed`; byte-identical to before, so their prefix is unchanged) until a no-spend
  check passes on that CLI; every other agent's tool prefix changed: one cold
  turn after the update. Measured 116/116 metadata first (bound <2.6%, not
  zero); Claude Code, Codex, Muse and opencode pass the nested shape. See
  [agent typing](../../docs/rust-engine/agent-typing.md).
  [decided: user 2026-10-13 20:01-20:05Z and 22:34Z, coordinator
  20:23Z/20:27Z/21:36Z; verified: `tools/defs.rs`, `tools/mailtools.rs`, `net/typing.rs`,
  `runtime/actor.rs`, `bridge.rs`, 2026-10-14]
<!-- /preserved:e-d7fb75f5e03bf14b -->

<a id="e-69fa8324222c1ccc"></a>

## External mail is untrusted by default, but generated instructions honor an

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 2904–2912.

<!-- preserved:e-69fa8324222c1ccc -->
- External mail is untrusted by default, but generated instructions honor an
  explicit exact-sender delegation in the current org's trusted `org.md`, including
  Connect your phone. Body/forwarded claims and other orgs cannot confer trust;
  Unlink/replacement removes the old delegation on configuration refresh. Never
  promote it to system/developer authority or relabel all hub mail as user mail.
  Keep identity instructions and turn/replay/mid-turn framing consistent. See
  [phone-link authority](../../docs/rust-engine/phone-link-authority.md).
  [decided: user 2026-10-13 08:35UTC; verified: `runtime/identity.rs`,
  `runtime/envelope.rs`, `phone.rs`]
<!-- /preserved:e-69fa8324222c1ccc -->

<a id="e-83cd4b7f38d03e8d"></a>

## Organization profile pictures use a dedicated bounded ot.meta record,

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3029–3037.

<!-- preserved:e-83cd4b7f38d03e8d -->
- Organization profile pictures use a dedicated bounded `ot.meta` record,
  not the net/tree payload. Human settings edits carry the numeric org owner;
  incoming hub merges preserve logical revisions and removal tombstones.
  Optional publication uses the org-inbox isolation gate and enabled memberships.
  Image HTTP bodies are omitted before authentication and decoder slots stay
  with blocking tasks after cancellation. See the isolated proofs and remaining
  acceptance limits in [the contract](../../docs/rust-engine/profile-pictures.md).
  [decided: user 2026-10-12; verified from source: `profile_pictures/`,
  `http/pictures.rs`, `net/pictures.rs`; focused proof limits documented, 2026-10-12]
<!-- /preserved:e-83cd4b7f38d03e8d -->

<a id="e-b85669a82f77be89"></a>

## Continue-on resolves primary, default and matching native

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3039–3049.

<!-- preserved:e-b85669a82f77be89 -->
- Continue-on resolves `primary`, `default` and matching native
  `<provider>/primary` (Claude/OpenAI/Google) in the shared runtime, storing NULL.
  Revalidate org/auth/activation/tier usage and ambient marks; no probe or mark
  clearing. Binding, freeze/pending release, audit and replay mail commit together.
  Native and explicit ambient-home cache aliases all constrain eligibility;
  Latest genuine auth observation wins across physical native aliases; transient
  failures/cooldown never refresh auth or last-good bars. Automatic fallback
  skips candidates failing shared eligibility, retaining order/switches/proven room.
  Explicit registry targets and automatic fallback retain their policies. See
  [primary continuation](../../docs/rust-engine/continue-primary.md).
  [verified: `runtime/freeze.rs`, `runtime/freeze/continuation.rs`, `usage.rs`, 2026-10-12]
<!-- /preserved:e-b85669a82f77be89 -->

<a id="e-80925030192802f7"></a>

## Desk pending mail folds at six rendered rows per run, after event deduplication.

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3136–3141.

<!-- preserved:e-80925030192802f7 -->
- Desk pending mail folds at six rendered rows per run, after event deduplication.
  Keep current-turn input above its response and later mail below; optimistic and
  failed sends stay outside. Disclosure is local and retains mounted cards; reveal
  a pending reply target before scrolling. Mailbox/Attention grouping is unchanged.
  [decided: user 2026-10-11 22:33Z; verified: renderer `canvas/pendingrun.tsx`,
  `canvas/desk.tsx`; scope and proof: `docs/rust-engine/pending-mail-collapse.md`]
<!-- /preserved:e-80925030192802f7 -->

2026-10-23 update: every nonempty queue group now exposes Show/Hide. Six rows
remains the automatic threshold until a manual choice; either choice survives
count changes while the run is mounted. Run/desk/generation teardown resets it.
The preserved entry above describes the original threshold contract. See
[current disclosure behavior](../rust-engine/pending-mail-collapse.md).

<a id="e-7985d55df47f12a0"></a>

## Bare mail recipients preserve 3.x precedence: internal agent, exact local

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3374–3379.

<!-- preserved:e-7985d55df47f12a0 -->
- Bare mail recipients preserve 3.x precedence: internal agent, exact local
  org slug, then a unique hub full slug or first name segment. Ambiguity names
  candidates; resolution never bypasses org-inbox authority. Discovery includes
  the current org (`you`) and `transports`, with hub peers in `orgs` and the
  retained 4.0 `remote` alias. [verified-from-source: 2026-10-07; F03;
  `docs/rust-engine/bare-mail-routing.md`]
<!-- /preserved:e-7985d55df47f12a0 -->

<a id="e-5654d6e0baa7183e"></a>

## Agent unread mail is pending plus unacknowledged delivering, shared by

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3583–3589.

<!-- preserved:e-5654d6e0baa7183e -->
- Agent unread mail is `pending` plus unacknowledged `delivering`, shared by
  tree badges, jump cards, desk tabs and mailbox folders. Counts are totals,
  never lengths of bounded display windows. Exact provider/hook receipts settle
  only their claimed batch; startup repair requires a same-agent, current-turn
  conversation receipt for each mail ID. Human/org inbox read state is separate.
  [verified from source and disposable-DB/renderer smoke: 2026-10-07;
  `docs/rust-engine/unread-mail.md`]
<!-- /preserved:e-5654d6e0baa7183e -->

<a id="e-4e05ddb51d643308"></a>

## Staffing composites use ops::run_in_tx and publish deferred Effects only

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3693–3697.

<!-- preserved:e-4e05ddb51d643308 -->
- Staffing composites use `ops::run_in_tx` and publish deferred `Effects` only
  after the caller commits. Busy model/account switches persist intents and
  apply at settlement; admission locks the agent row before claiming mail.
  Abandoned-owner recovery selects bounded policy rows, never an entire archive.
  [verified from source: 2026-10-07; `docs/rust-engine/parity-staffing.md`]
<!-- /preserved:e-4e05ddb51d643308 -->

<a id="e-0500b134b88d286e"></a>

## Accounts: every account has its own active checkbox in App settings › Providers, the

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3753–3755.

<!-- preserved:e-0500b134b88d286e -->
- Accounts: every account has its own active checkbox in App settings › Providers, the
  native sign-in included; an inactive account serves no new turn and its agents' mail waits.
  [decided: user 2026-10-07, DECISIONS 41]
<!-- /preserved:e-0500b134b88d286e -->

<a id="e-13b6405a255a9f2d"></a>

## End-of-turn mail: pending waking mail follows through ordinary admission on

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3815–3820.

<!-- preserved:e-13b6405a255a9f2d -->
- End-of-turn mail: pending waking mail follows through ordinary admission on
  every provider, including error exits with new mail. An unemitted Antigravity
  handoff is returned before delivery settlement; confirmed boundary mail is
  not replayed. Merely requeuing a failed opening prompt must not create a retry
  loop. Follow-up IDs are logged only after the next prompt is accepted.
  [verified from source: 2026-10-07, `src/runtime/actor.rs`]
<!-- /preserved:e-13b6405a255a9f2d -->

<a id="e-e4231286a204e361"></a>

## Typed mail (2026-10-07). Retained operations mint canonical ev at their producer;

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3861–3868.

<!-- preserved:e-e4231286a204e361 -->
**Typed mail (2026-10-07).** Retained operations mint canonical `ev` at their producer;
never recover an event type by matching prose. Carry it unchanged through inbox/chat and
`prompt::Mail.ev`; passive lifecycle/access/policy notices use `@system` plus `notice=true`.
Keep legacy decoders even for removed operations. In 4.0, review outcomes are statuses and
old sessions are not rehireable bearers, so their agent text must not offer removed actions.
The renderer assignment status now includes `approved`; do not overwrite that extension
with the frozen Python generator. [verified from source / recorded coordinator ruling:
2026-10-07; inventory and remaining parity gaps: `docs/rust-engine/typed-message-parity.md`]
<!-- /preserved:e-e4231286a204e361 -->

<a id="e-7ae4c9739e416232"></a>

## Mail and artifact parity (2026-10-07). File reads fold every ancestor's folder

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3880–3890.

<!-- preserved:e-7ae4c9739e416232 -->
**Mail and artifact parity (2026-10-07).** File reads fold every ancestor's folder
ceiling; user attachments and deliveries copy into a fresh outbox directory. Hub attachments
must start in the sender's scratch and fit 25 MB. Org-inbox delivery uses live holders only;
automatic and explicit grants enforce single-holder mode, and disabling multi-holder with
multiple holders refuses. Manual inbox reads page waiting mail and expose complete UTF-8
chunks without altering automatic delivery. Delivery retry IDs are scoped to the sender.
HTML presentations capture a bounded local asset bundle for ZIP download and an offline
preview; a vanished staged hub attachment is dropped with a durable event, not a blocked
message. [verified from source: `domain/docs.rs`, `domain/orginbox.rs`, `domain/html_bundle.rs`,
`tools/mailtools.rs`, `net.rs`; details and verification limits:
[`docs/rust-engine/mail-artifact-parity.md`](../../docs/rust-engine/mail-artifact-parity.md)]
<!-- /preserved:e-7ae4c9739e416232 -->

<a id="e-2eab11bd027a9f20"></a>

## Agent mail requests and fan-out (2026-10-16). orgtree_message accepts

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3899–3910.

<!-- preserved:e-2eab11bd027a9f20 -->
**Agent mail requests and fan-out (2026-10-16).** `orgtree_message` accepts
`kind: request` as a separately displayed request; local-agent attachments are
validated and shared as absolute paths; multi-recipient replies are filtered
per recipient conversation. `user` and `@net:` attachment uploads are unchanged.
In 4.4.0, message and project-broadcast replies also accept identity-only
document/presentation, docket-item and transcript-event targets; the engine
resolves quote snapshots and filters transcript context to the matching
recipient. Callers do not supply quoted prose. [verified: `domain/replies.rs`,
`tools/mailtools.rs`, `tools/defs.rs`, `http/nodes.rs`; see
[orgtree_message](../../docs/skills/orgtree-working/mail/tool-message/SKILL.md) and
[orgtree_project](../../docs/skills/orgtree-working/team/tool-project/SKILL.md)]
See [DECISIONS.md](../../docs/rust-engine/DECISIONS.md).
<!-- /preserved:e-2eab11bd027a9f20 -->

<a id="e-568c26a256dcaf98"></a>

## Direct user messages/replies to nested agents atomically grant @user reply

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 4111–4116.

<!-- preserved:e-568c26a256dcaf98 -->
- Direct user messages/replies to nested agents atomically grant `@user` reply
  access with the mail and canonical access/chain notices; repeat active grants
  are idempotent and revoked grants return on new contact. Successful user commands
  include `/compact` and Muse; automatic/refused commands are excluded. See
  [typed-message parity](../../docs/rust-engine/typed-message-parity.md).
  [verified 2026-10-13: `domain/runtime_notices.rs`, `domain/mail.rs`, `runtime/actor.rs`]
<!-- /preserved:e-568c26a256dcaf98 -->

<a id="e-3405212ec38e4ef6"></a>

## main is public. Never put secrets, tokens, email addresses, user names, personal paths

Original section: Keep this file current. Source lines 4168–4169.

<!-- preserved:e-3405212ec38e4ef6 -->
- `main` is public. Never put secrets, tokens, email addresses, user names, personal paths
  or live data in this file.
<!-- /preserved:e-3405212ec38e4ef6 -->

<a id="e-7a054db8ea0afafe"></a>

## Mailbox delivery stages are host-clock overlays, retained only for subscribed

Original section: Background work, the feed and turns. Source lines 4566–4582.

<!-- preserved:e-7a054db8ea0afafe -->
- **Mailbox delivery stages** are host-clock overlays, retained only for subscribed
  mailboxes and refreshed from changed snapshot inputs. Late HTTP/join workers trim
  against live subscriptions before publishing; retained drain timestamps schedule grace
  expiry without an org read, and unsubscribe/identity replacement cancel stale deadlines.
  A deadline crossed between projection and scheduling still receives one immediate refresh.
  Subscription readiness is false
  until the current generation's final page; a reset or renewal clears it. Known record
  capability suppresses legacy polling even before the session controller is installed.
  Failed panel name lookups expose Retry and recover on surface focus at the same revision.
  Chat uses
  identity-fenced `after` cursors on agent frames/focus, with assistant revisions separate
  from new messages; direct file delivery emits its invalidation only after commit, while
  attachment helpers do not. In 4.4.0, scratch folders open in the OS file explorer from
  the agent menu or settings header; agent desks have no Files tab, and their History view
  is in agent settings when records exist. The separate `read_scratch` agent tool remains.
  [verified 2026-10-05: `record_host.py`, `chat_after.py`, `api.py`, renderer `recordfeed.ts`,
  `convo.ts`; decided: user 2026-10-17]
<!-- /preserved:e-7a054db8ea0afafe -->

<a id="e-b0bd19a8c2de0ac5"></a>

## : Logo cropping uses a pointer/keyboard square over the native preview; x/y remain fractions of available top-left trave

Original section: Where the detail lives. Source lines 5148–5148.

<!-- preserved:e-b0bd19a8c2de0ac5 -->
- 2026-10-14: Logo cropping uses a pointer/keyboard square over the native preview; x/y remain fractions of available top-left travel. Keep native decoding and original-byte save semantics. Hubchat carries the matching editor. Source-only verification handoff: [crop contract](../../docs/rust-engine/crop-square.md). [decided: user 2026-10-14; verified from source: canvas/SquareCrop.tsx, cropmath.ts]
<!-- /preserved:e-b0bd19a8c2de0ac5 -->

<a id="e-29cf67edb8ef554b"></a>

## Waiting mail is bounded before opening/steering/hook delivery: rendered items

Original section: Shared skills and installed plugin imports (2026-10-15). Source lines 5203–5211.

<!-- preserved:e-29cf67edb8ef554b -->
- Waiting mail is bounded before opening/steering/hook delivery: rendered items
  over 64 KiB become inbox fetch/chunk references, and final text is split into
  ordered batches (Codex 1,000,000 UTF-8 bytes; unknown lanes conservatively
  256 KiB). Only already-admitted deferred notices can continue a budget tail;
  unrelated passive notices remain passive. Original mail stays unchanged.
  Length refusals report sizes on each actual attempt without self-retry.
  Generated oversized org/usage context stays in own scratch; handoff history is
  referenced, not copied. Limits and verification: [mail input budgets](../../docs/rust-engine/mail-input-budgets.md).
  [decided: coordinator 2026-10-15; verified: `engine/rs/orgtree-engine/src/runtime/prompt.rs`]
<!-- /preserved:e-29cf67edb8ef554b -->

<a id="e-2df3546f707ac625"></a>

## Codex MCP elicitation uses independent human-only AskInfo cards and the

Original section: Shared skills and installed plugin imports (2026-10-15). Source lines 5240–5246.

<!-- preserved:e-2df3546f707ac625 -->
- Codex MCP elicitation uses independent human-only AskInfo cards and the
  existing answer route, never ordinary ask parts or agent mail. Five-minute
  expiry declines; disconnect/shutdown cancels. URL mode is user-open only;
  typed answers stay ephemeral and unlogged. No saved provider permission is
  written. See [elicitation](../../docs/rust-engine/codex-elicitation.md).
  [decided: user/coordinator 2026-10-19; verified: runtime/elicitation.rs,
  runtime/codex.rs, http/asks.rs, canvas/elicitation.tsx]
<!-- /preserved:e-2df3546f707ac625 -->
