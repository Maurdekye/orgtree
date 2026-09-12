import type { EventReplyWire } from './eventReply'
import type { TypedReplyReceipt } from './generated/events'
// API payload types — the frontend's half of the seam (typing wave, docs/typing-plan.md).
//
// Derived from the BACKEND source, which is the ground truth:
//   - backend/orgtree/schema.py     (TypedDicts for the persisted org document)
//   - backend/orgtree/ledger.py     (Org.tree() — the projection the UI renders)
//   - backend/orgtree/api.py        (endpoint request/response shapes)
//   - backend/orgtree/supervisor.py (read_chat / state — the chat payload)
//
// Ground rules (mirror of schema.py's): describe what the code writes TODAY;
// where a field's type is not provable from the backend, use `unknown` or a
// wider union — never invent. Runtime-inert: types only, no values.

// ---------------------------------------------------------------- primitives
// schema.py: NodeState / DirMode / Visibility / PermissionMode / BearerState
export type NodeState = 'live' | 'archived' | 'unrecoverable'
export type DirMode = 'rw' | 'ro'
export type Visibility = 'self' | 'team' | 'subtree' | 'full'
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions'
// "lost" = a generation whose transcript is gone (schema.py:34, ledger.py:2448)
export type BearerState = 'knowledge' | 'preserving' | 'lost' | null
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Backend-owned, generation-safe forecast for the next provider turn. */
export type CacheForecastState =
  | 'known_incompatible'
  | 'expired_known_entry'
  | 'uncertain'
  | 'compatible_observed'
/** D-226. What the badge RENDERS, as opposed to `state`, which is what was
 * observed. Binary in normal operation; `diagnostic` is grey and is reserved
 * for an enumerated fault that stopped an opinion being formed at all. */
export type Readiness = 'ready' | 'not_ready' | 'diagnostic' | 'none'

export interface CacheForecast {
  generation: string
  state: CacheForecastState
  /** ⚠ OPTIONAL ON THE WIRE ONLY. A payload without it is not "fine by
   * default". A row with NO triple but a recognised `state` is a pre-D-226
   * forecast from an older backend and the badge re-derives its verdict from
   * `state`/`source`/`lane` the way the server would (desk.tsx
   * `legacyReadiness`, mirroring `cachecontinuity.legacy_readiness`). An
   * unrecognised readiness value, a verdict with no cause, or a row with
   * neither a triple nor a known state is the named `internal_error`
   * diagnostic — never green. */
  readiness?: Readiness
  readiness_cause?: string
  readiness_detail?: string
  reason: string
  source: string
  lane: string
  last_receipt_at: string | null
  ttl_seconds: number | null
  expires_at: string | null
  /** Safe component labels only; underlying values/hashes remain backend-only. */
  changed_inputs?: string[]
  precompact_action?: 'will_compact' | 'miss_expected' | 'not_applicable'
  precompact_reason?: string
}

// schema.py DirGrant
export interface DirGrant {
  path: string
  mode: DirMode
}

// schema.py ToolGrant — `mcp` is a sorted server-name list; ["*"] = all
export interface ToolGrant {
  bash: boolean
  web: boolean
  edit: boolean
  subagents: boolean
  mcp: string[]
}

// schema.py NodeScope — permission_mode / org_visibility are `str` there, so
// they stay `string` here (old docs may carry values outside today's literals)
export interface NodeScope {
  permission_mode: string
  add_dirs: DirGrant[]
  tools: ToolGrant
  org_visibility: string
  /** per-agent thinking effort — set/popped by ledger.py update_scope
   *  (ledger.py:2093-2096); absent = CLI default */
  effort?: string
  /** which model VERSION inside the tier (ledger.MODEL_VERSIONS) — a
   *  subcategory of the tier, never a tier of its own. Absent = the tier
   *  default; the ledger re-validates it against the node's current tier. */
  model_version?: string
  /** item 12 (user ruling 2026-09-04): does a luna try the reserve pool
   *  FIRST (true — the default, and what ABSENT means) or its plan pool
   *  first (false)? The other pool is the fallback either way. Stored for
   *  any tier so it survives a switch; only luna acts on it. */
  account_fallback?: boolean
  prefer_reserve?: boolean
}

// schema.py Denial (№7)
export interface Denial {
  tool: string
  arg?: string | null
  /** codex approval seam only (2026-09-05): the working directory the
   *  request named; scrubbed like `arg` on the tree */
  cwd?: string | null
}

// schema.py TurnStat (№15)
export interface TurnStat {
  at: string
  cost: number
  ms?: number | null
  denials: number
  /** codex lane only (2026-09-05): escalations orgtree's approval seam
   *  answered "accept" — APPROVED, not observed to run. Absent on lanes
   *  with no such seam; never read absence as zero. */
  approvals?: number
  /** killed-turn accounting (2026-08-04): output tokens, the kill marker,
   *  and whether the cost is derived rather than API-reported */
  toks?: number
  killed?: boolean
  estimated?: boolean
  cost_complete?: boolean
  cost_source?: string
  cost_unknown_fields?: string[]
  /** OpenRouter lane only (2026-09-05): what the CLI REPORTED about the
   *  messages it delivered this turn — never what SERVED it. On a gateway
   *  lane the reported model is routinely an echo of the id that was
   *  REQUESTED. A summary over the turn: every distinct value, `mixed` when
   *  more than one was seen, `truncated` when the per-message records hit
   *  their cap (the lists are then what was kept). Absent on every other
   *  lane and on every historical row. See `reportedLabel`. */
  reported?: {
    requests: number
    models: string[]
    providers: string[]
    mixed: boolean
    first_id?: string
    first_request_id?: string
    truncated?: boolean
  }
  /** audit C-2, OpenRouter lane only: did the `modelUsage` lookup the cost
   *  path performs — keyed by the id ORGTREE asked for — match a key the CLI
   *  actually wrote? Recorded so a miss stops being indistinguishable from a
   *  hit. Diagnostic only; not rendered. */
  model_usage_key?: { asked: string; matched: boolean; keys?: string[] }
}

// schema.py AudienceGrant (§7.3)
export interface AudienceGrant {
  grantee: string
  grantor: string
  granted_at: string
  reason: string
}

// api.py node_message builds {name, path, bytes}; schema.py only proves
// list[dict[str, Any]] (extern attachments ride other paths) — all optional
export interface MailAttachment {
  name?: string
  path?: string
  bytes?: number
  [k: string]: unknown
}

// schema.py MailEntry (№11/№17)
export interface MailEntry {
  /** Raw wire data is decoded against the generated operator/public schema. */
  ev?: unknown
  ev_public?: unknown
  ev_raw?: unknown
  ev_error?: unknown
  id: string
  from: string
  kind: string
  body: string
  at: string
  relationship?: string | null
  attachments?: MailAttachment[]
  delivering?: boolean
  retracted?: boolean          // api.py node_mail_retract mirrors into the log
  /** D-169: user-bound mail its sender tagged urgent, with the one-line
   *  reason it had to give to do so. Written as a PAIR by ledger.post_mail
   *  or not at all — `urgent` never appears without a non-blank reason.
   *  ⚠ These reach the mailbox by a DIFFERENT route from `urgent_unread`:
   *  GET /api/orgs/{slug}/inbox returns `user_inbox` verbatim, with no
   *  per-entry rebuild, so unlike the tree projection there is no key list
   *  here that could silently drop them. */
  urgent?: boolean
  urgent_reason?: string
  [k: string]: unknown
}

// schema.py OrgInboxEntry — the inter-org bridge log
export interface OrgInboxEntry {
  id: string
  dir: 'in' | 'out'
  peer: string
  body: string
  at: string
  by?: string
  // F-06: @net: outbound delivery ladder (net.py _stamp_row, monotonic)
  state?: 'queued' | 'sent' | 'delivered' | 'read'
  state_at?: string
  net_id?: string
  // §10: per-message delivery failure, copied off the spool entry when a
  // wire try fails (cleared when a later try lands)
  tries?: number
  last_err?: string
  attachments?: { name: string; bytes: number }[]
}

// F-06: net.py status_block — hub config + live connectivity (never secrets)
export interface NetPeer {
  slug: string
  org_name?: string | null
  username?: string | null
  blurb?: string | null
  online: boolean
  last_seen?: string | null
  kind?: 'org' | 'chat'        // FR-06: independent chats are clients too
  /** user spec 2026-08-05: which transports resolve this recipient —
   *  derived server-side from the same data the bare-name resolver uses */
  transports?: string[]
}
export interface NetHub {
  id: string
  address: string
  enabled: boolean
  name?: string | null         // discovered on connect, never typed
  connected: boolean
  /** the implicit local entry before the hub has EVER answered — passive
   *  surfaces (chip, dot, network section, compose roster) render nothing;
   *  the settings tab still shows it (it is config) */
  hidden?: boolean
  last_ok?: string | null
  error?: string | null
  queued: number
  // §10: how many queued entries have a recorded wire failure, + the
  // newest reason — "N stuck, last error: …" on the mailservers tab
  stuck?: number
  stuck_err?: string
  roster: NetPeer[]
}
export interface NetBlock {
  slug: string | null          // this org's network address
  hubs: NetHub[]
}

// ledger.py tree(): last_status/prev_status are dict[str, Any] | None in
// schema.py; orgtree_status (api.py) writes {status, summary, at} today
export interface NodeStatus {
  status?: string
  summary?: string
  at?: string
  [k: string]: unknown
}

// ledger.py tree(): the frozen projection — keys always present (built via
// .get), values nullable; `error` joins error + spend_error (№41)
export interface TreeFrozen {
  at: string | null
  until: string | null
  until_ts: number | null
  error: string | null
  /** multi-account: the REGISTRY ACCOUNT this freeze describes, when the
   *  node is bound — the wait belongs to that account's lane */
  account?: string | null
  /** multi-account: observed|inferred — an inferred (ride-along) park must
   *  render as inferred, never as a measured limit (user ruling 18:18Z) */
  provenance?: string | null
  /** the transient kind (2026-08-06): a network drop, not a usage limit —
   *  same resume machinery, different badge label */
  connection?: boolean | null
  /** D-122: present so the banner can tell a PURE connection freeze (always
   *  self-retries) from a record carrying both kinds (waits on the toggle) */
  limit?: boolean | null
  /** D-156: WHY, when the answer is not "capacity ran out". `"auth"` = the
   *  credential was rejected, so this is a usage-limit freeze in SHAPE only.
   *  The auto-resume timer refuses it; ▶ still resumes it, which is why
   *  `resumable` is true for it and the count includes it.
   *
   *  ⚠ So "usage limit hit — N agents frozen" over-claims whenever one of
   *  the N has `cause === "auth"`: the COUNT is right and the WORDS are not.
   *  This field is what a label branch needs to say so. */
  cause?: string | null
  /** the kiosk SPEND kind (2026-08-26). `hard_freeze` writes this flag and the
   *  org-level `spend_frozen` in the same locked block, so they always coexist
   *  — which is why the org banner was right (it returns early on the org
   *  flag) while the NODE BADGE was wrong: a badge has no org flag to consult,
   *  so a spend-frozen agent wore the words "usage limit". */
  spend?: boolean | null
}

// ledger.py tree(): one entry of the node's lineage stack (§8)
export interface LineageEntry {
  id: string
  generation: number
  state: NodeState
  bearer_state: BearerState
  tier: string
}

// ---------------------------------------------------------------- tree view
// ledger.py Org.tree() build() + api.py org_tree annotate(); _scrub_public
// pops session_id for kiosk visitors, hence optional
// D-234: a model switch asked for while the node was mid-turn, waiting for
// the turn boundary — `switch_model`'s `pending_switch` record, verbatim
export interface PendingSwitch {
  tier: string
  from: string
  by: string
  at: string
  crossing: boolean
}

export interface TreeNode {
  /** §4.8 — `false` means this is an ARCHIVED seat's SUMMARY: its
   *  supervisor-derived runtime fields were refilled from the payload's
   *  `archived_defaults` (api.ts `getTree` → `hydrateTree`), and its per-seat
   *  detail — full `charter`, `team_charter`, `scope`, `lineage`, the whole
   *  `turns` history, `last_denials`, `last_approvals` — is absent until
   *  `useNodeDetail` fetches it.
   *  ABSENT on every live seat and on anything an older engine sent, both of
   *  which are complete. A panel that dereferences one of those fields must go
   *  through `useNodeDetail`/`NodeDetailGate` first — and a CARD, which cannot
   *  await a fetch, must read one of the three summary markers below instead. */
  detail?: boolean
  /** §4.8 — the first line of the charter, which is all the tray tooltip uses.
   *  Only on a summary; the whole charter comes with the detail fetch.
   *  Read it through `charterLine`, never raw. */
  charter_line?: string | null
  /** §4.8 — `lineage.length` for a seat whose `lineage` was omitted. The card
   *  offers "Show lineage" and wears its stacked look off this count, neither
   *  of which can wait for a fetch. Read it through `lineageCount`. */
  lineage_count?: number
  /** §4.8 — `scope.tools.edit === false` for a seat whose `scope` was omitted:
   *  the dashed `ro-agent` border. Read it through `readOnlyAgent`. */
  read_only?: boolean
  /** §4.8 — the backend's hash of the fields it omitted. The detail cache is
   *  keyed on it, so an edit made in ANOTHER window moves it on the next tree
   *  payload and the cached detail is dropped. Absent on a live seat. */
  detail_rev?: string | null
  id: string
  title: string
  tier: string
  model_id: string
  /** multi-account: the bound account id, a missing:<provider> park, or
   *  absent pre-cutover */
  account?: string | null
  account_tint_ordinal?: number
  account_label?: string
  state: NodeState
  seat: number
  grant: number
  free: number | null
  session_id?: string
  scope: NodeScope
  ui_order: number
  cost_usd: number
  cost_usd_unknown?: boolean
  occupancy: number | null
  /** the fill above is a post-compaction ESTIMATE (system prompt + summary):
   *  a compaction reports the drop immediately, but nothing measures the new
   *  session until the agent's next turn, which clears this */
  occupancy_est?: boolean
  /** a §8 split landed and this agent has not run since — its session holds
   *  only the summary, so the compact button is not offered (the endpoint
   *  refuses it) */
  compacted_unrun?: boolean
  context_window: number | null
  charter: string | null
  team_charter?: string | null
  mail_pending: number
  limit_locked: boolean
  /** api.py annotate(): will ▶ resume actually act on this node? Composed in
   *  the backend from `supervisor.resumable` — the ONE expression of that
   *  rule — so the resume banner counts what the button will really do
   *  instead of re-deriving it here. It used to re-derive it here, and
   *  counted retired agents that ▶ has never been willing to touch (user
   *  report 2026-08-26).
   *  ⚠ It means "will ▶ act on this", NOT "is this waiting on capacity". The
   *  two come apart on an auth freeze (D-156): the credential was rejected
   *  rather than the capacity spent, the auto-resume timer refuses it, but ▶
   *  still resumes it — replacing the credential and pressing ▶ is the fix.
   *  Such a node is `resumable` and counts. Ask capacity separately. */
  resumable: boolean
  last_status: NodeStatus | null
  prev_status: NodeStatus | null
  inflight_at: string | null
  /** D-234: the switch queued behind the running turn; null/absent once it
   *  applied, was cancelled, or the node was idle when asked */
  pending_switch?: PendingSwitch | null
  last_denials: Denial[]
  /** codex lane (2026-09-05): last turn's APPROVED escalations, same row
   *  shape as last_denials; absent when the lane cannot report it */
  last_approvals?: Denial[]
  turns: TurnStat[]
  frozen: TreeFrozen | null
  halt?: { phase: 'halting' | 'halted'; requested_at: string; at?: string; by: string } | null
  halt_queued?: number
  audiences_held: string[]
  bearer_state: BearerState
  generation: number
  children: TreeNode[]
  lineage: LineageEntry[]
  // ---- api.py annotate() — live supervisor state layered on the projection
  busy: boolean
  /** D-201: a parked CLI process is ready with this agent's current prompt.
   * False is a normal cold-cache condition, never a health/error signal. */
  proc_warm: boolean
  /** An OS CLI process currently exists for this live seat. Unlike
   * proc_warm, this is also true while that process is serving a turn. */
  proc_live: boolean
  /** The current live process is known not to be reusable for the next turn. */
  proc_relaunch: boolean
  /** Backend-owned explanation for proc_relaunch; never inferred by the UI. */
  proc_relaunch_reason: string | null
  /** Durable per-node manual stop state from warm.flag. */
  proc_paused: boolean
  /** Backend-owned idle/admission gate for the desk process toggle. */
  proc_control_enabled: boolean
  proc_control_action: 'start' | 'stop' | null
  proc_control_reason: string | null
  /** Runtime-observed callable MCP names for the current process generation.
   * null is unknown, never zero. */
  mcp_tool_count: number | null
  /** Authoritative count captured at the last successful completed turn. */
  last_turn_mcp_tool_count: number | null
  mcp_tool_count_provider: string
  mcp_tool_count_source: string | null
  mcp_tool_count_reason: string | null
  mcp_readiness_waiting?: boolean
  mcp_readiness_state?: string | null
  mcp_readiness_reason?: string | null
  /** Optional during the predictor rollout; absent until backend evidence exists. */
  cache_forecast?: CacheForecast | null
  /** effective cheap-compact setting for THIS node (org default merged
   *  with its own scope override) — resolved backend-side, because the
   *  org value alone would be wrong on any node that overrides it. */
  cheap_compact_on?: boolean
  /** the compactor's occupancy threshold (fraction, 0.05..0.95) for THIS
   *  node; null when the compactor is off, absent on a backend that does
   *  not report it. The mid-turn banner gates on it (user ruling
   *  2026-09-02 19:19Z). */
  cheap_compact_occ?: number | null
  waiting: boolean
  responding: boolean
  phase: string | null
  /** api_fallback: this node's IN-FLIGHT turn bills the org's own API key
   *  (captured at spawn, so it holds for the whole turn even once the window
   *  shuts). The card wears the fallback red while it is true. */
  on_fallback?: boolean
  /** WHICH account actually served this node's last turn, captured at spawn
   *  from the RESOLVED environment. "primary", a key row id, "api-key", or
   *  "key:unattributed". ⚠ Never a credential. Backend telemetry only since
   *  the 2026-08-25 machine-local routing redesign — the accounts panel's
   *  per-tier assignments are the user-facing surface, so nothing renders
   *  this field; it stays typed because the wire still carries it. */
  ran_as?: string | null
  /** the same fact, reader-shaped: "fallback 2 · <uuid>" when this turn is
   *  running off a fallback account, null otherwise (the primary login and
   *  the api-key lane say nothing here). Composed server-side — it owns the
   *  registry, and the uuid is omitted for kiosk visitors. User ruling
   *  2026-08-25; this is what the desk badge renders. */
  ran_as_label?: string | null
  /** which POOL a luna is on (item 12) — see `CodexRouteInfo`. The desk's
   *  meta row and the card's badge row render `label` beside the "ran as"
   *  badge. Null for every tier that does not route. */
  codex_route?: CodexRouteInfo | null
  queued: number
  /** concurrently running subagents (Task/Agent calls in flight) — desk
   *  header shows it beside the working clock, only when > 0 */
  tasks?: number
  /** BACKGROUND subagents (api.py annotate: supervisor `bg_tasks`) — they
   *  outlive the turn's reply, which is why a node can sit busy for a long
   *  time with nothing else to show. FR-2's progress panel renders it. */
  bg_tasks?: number
  last_error: string | null
  /** G4: what the agent is doing this instant, derived server-side from the
   *  live tail. The client used to build this itself from websocket events. */
  activity: ActivityInfo
  /** F-04/F-05: the ask card this node's desk shows — open, or freshly
   *  nulled (ledger.node_ask; null once the linger window passes) */
  ask?: AskInfo | null
  /** FR-03: presented documents (metadata; body via getDocument) */
  documents_count?: number
  documents?: { id: string; title: string; at: string; format?: 'markdown' | 'html'; bytes?: number }[] | null
  /** FR-01: parked while the user drives this session from another device */
  remote_controlled?: { at?: string } | null
}

/** 'thinking' | 'writing' | 'tool' — a string rather than a union for the same
 *  reason every other wire enum here is: it arrives as JSON. */
export interface ActivityInfo { phase: string; tool?: string }

// ledger.py credit_requests / audience_requests are
// dict[str, Any] in schema.py — only `status` is provably read on requests
export interface CreditRequest {
  status?: string
  node?: string
  id?: string
  [k: string]: unknown
}

/** ledger.node_ask / tree.asks — one ask card (F-04 question or F-05 credit
 *  request), open or nulled. `status`: open|pending = live; answered/denied/
 *  dismissed/withdrawn/superseded = grey null; interrupted = orange null
 *  (historical — the wake-void was retired 2026-08-06; `reason` says why). */
export interface AskInfo {
  id: string
  node: string
  kind?: string              // "question" | "credit" (credit rows may omit it in credit_requests)
  status: string
  at: string
  /** docket wire contract v3: distinct work-item ids over this ask's tabs
   *  (linkage is PER TAB — one open batch may ask about two items at once;
   *  see each `AskQuestion`/`AskTab`'s own `work_item`). Filter `tree.asks`/
   *  `node.ask` with `work_items.includes(id)`, not equality. Absent/empty
   *  on an ask with no docket linkage. Every open ask stays here uncapped,
   *  so this exact card/answerAsk/resolveBatch route is reused untouched —
   *  never a second answering channel. */
  work_items?: string[]
  resolved_at?: string
  reason?: string
  /** message-visibility invariant (user 2026-09-10): the id of the mail the
   *  answer/decision travelled as, stamped at resolution. The desk keeps the
   *  resolved panel pinned — as the answer's ONE representation — until this
   *  mail id renders in the transcript, and never also shows it as a pending
   *  bubble. Absent on open cards and on rows from older backends. */
  answer_mail?: string
  // question kind — options mirror AskUserQuestion ({label, description?});
  // header is the short chip label (ledger normalizes plain strings away)
  question?: string
  header?: string
  options?: { label: string; description?: string }[]
  multi?: boolean
  answer?: { selected?: string[]; text?: string }
  /** FR-04: the batch — 1-4 tabs; both ask forms normalize to this. The
   *  top-level question/options/header mirror tab 0 for older surfaces. */
  questions?: AskQuestion[]
  /** FR-14 (kind === 'batch'): the COMPOSED card — question tabs + the
   *  credits tab + one tab per scope item, resolved together at one submit.
   *  `revs` carries the per-store CAS stamps the submit must echo. */
  tabs?: AskTab[]
  revs?: { ask?: number; credits?: number; scope?: number }
  /** card revision — bumped on every amend; the answer echoes it (CAS: a
   *  stale submission is refused instead of attaching positionally to
   *  questions the user never saw) */
  rev?: number
  // credit kind (ledger credit_requests shape)
  old?: number
  new?: number
  granted?: number
  notice?: string
  /** scope kind (ledger scope_requests shape): the requested items, each
   *  stamped with its decision once the batch resolves */
  items?: { kind: string; path?: string; mode?: string; tool?: string
    server?: string; decision?: string }[]
  [k: string]: unknown
}

/** FR-04: one tab of a batched ask (ledger `_norm_question_batch`) */
export interface AskQuestion {
  question: string
  header?: string
  options?: { label: string; description?: string }[]
  multi?: boolean
  /** set once answered — the tab's answer (list for a multi tab) */
  answer?: string | string[]
  /** docket wire contract v3: this specific tab's docket linkage (per-tab,
   *  not per-card — one batch may cover two items) */
  work_item?: string
}

/** FR-14: one tab of the composed batch card (ledger node_ask) */
export interface AskTab {
  kind: 'question' | 'credits' | 'scope'
  // question tabs carry AskQuestion's fields
  question?: string
  header?: string
  options?: ({ label: string; description?: string } | string)[]
  multi?: boolean
  // the credits tab
  id?: string
  old?: number
  new?: number
  reason?: string
  // scope tabs: one item each, pre-labeled server-side
  item?: { kind: string; path?: string; mode?: string; tool?: string
    server?: string }
  label?: string
  /** docket wire contract v3: this tab's docket linkage (per-tab) */
  work_item?: string
}

/** FR-18: a watchdog — a free persistent pet (ledger `watchdogs`) */
export interface Watchdog {
  id: string
  owner: string
  name: string
  kind: 'file' | 'command' | 'process' | 'stream'
  target: string
  pattern?: string
  interval_s: number
  state: 'armed' | 'paused' | 'exited' | 'spent'
  at: string
  fired: number
  /**
   * D-200: a ONE-SHOT dog — it fires exactly once and removes itself as part
   * of that fire, so it never appears here again. Sparse on disk, but the
   * backend normalises it to a real boolean in BOTH projections the UI can
   * reach (`tree()` and `wd_list_row`), so it is never undefined — do not
   * infer one-shot-ness from anything else.
   */
  once: boolean
  /**
   * D-200: a TOMBSTONE — this one-shot dog has already fired and is gone from
   * the org's arming state. It appears in `tree().watchdogs` for ~15s after
   * its fire and then never again.
   *
   * It exists so the fire can be DRAWN: the canvas animates a spark from
   * `dog:<id>` to its owner, and `launchSpark` silently draws nothing when
   * an endpoint has no position — positions come from this array, so a dog
   * that vanished the instant it fired would delete its own origin.
   *
   * Render it as departing, not as live: it is armed for nothing, its
   * `state` is `'spent'`, and pause/resume/remove on it are meaningless.
   * Always present (`false` on every live dog), never undefined.
   */
  spent: boolean
  last_check?: string
  last_fired?: string
  events?: { at: string; gist: string }[]
  exit?: { code?: number | null; at?: string }
}

export type AudienceRequest = Record<string, unknown>

// api.py org_tree: the kiosk block (admin fields scrubbed for visitors)
export interface TreeKiosk {
  credits: number | null
  spend_limit: number | null
  storage_limit_mb: number | null
  spend_frozen: boolean
  storage_blocked: boolean
  max_scope?: Record<string, unknown> | null
  auto_raise?: boolean
  /** (max_scope or {}).get("max_tier") (api.py:593) — writes are validated
   *  against TIERS or None (ledger.py:495-502) */
  max_tier: string | null
  enabled: boolean
  sandbox: boolean
  share_url?: string | null
  storage_mb?: number
}

// ledger.py audit()
export interface AuditReport {
  live_nodes: number
  top_level_holds: number
  no_overdraft: boolean
  problems: string[]
}

// GET /api/orgs/{slug} — ledger.py tree() + api.py org_tree additions
/** the toast surface App threads everywhere: lines + an optional 12 s undo.
 *  Callers pass `r.warnings` straight through, so nullish is accepted — the
 *  implementation's `if (!lines || !lines.length) return` is the contract */
export type ToastUndo = (() => void) | { fn: () => void; label: string }
export type ToastFn = (
  lines: string[] | null | undefined, undo?: ToastUndo | null,
) => void

export interface TreeDisk {
  used_mb: number | null
  total_mb: number | null
  blocked: boolean
  full: boolean
  /** staged shrink target — the yellow divergence: requested vs actual */
  pending_mb?: number | null
}

export interface DiskFile {
  path: string
  bytes: number
  class: 'content' | 'reclaimable' | 'blocked'
  reason?: string
}

export interface DiskPayload {
  used: number | null
  total: number | null
  blocked: boolean
  full: boolean
  /** admin only; null = Docker Desktop's VM disk cap is UNSET on the host */
  vm_cap_mib?: number | null
  /** admin only: configured size + staged shrink target (null = none) */
  size_mb?: number
  pending_mb?: number | null
  files: DiskFile[]
  offset: number
  limit: number
}

export interface DiskDeleteResult {
  /** dir deletes report their subtree tally (files, bytes) */
  results: { path: string; ok: boolean; error?: string
             files?: number; bytes?: number }[]
  used: number | null
  total: number | null
  blocked: boolean
  full: boolean
}

/** explorer mode: one directory level, intermixed by size descending */
export interface DiskDirEntry {
  name: string
  path: string
  dir: boolean
  bytes: number
  files: number
  class: 'content' | 'reclaimable' | 'blocked'
  reason?: string
}

export interface DiskDirPayload {
  path: string
  entries: DiskDirEntry[]
  used: number | null
  total: number | null
  blocked: boolean
  full: boolean
  /** admin only; null = Docker Desktop's VM disk cap is UNSET on the host */
  vm_cap_mib?: number | null
  /** admin only: configured size + staged shrink target (null = none) */
  size_mb?: number
  pending_mb?: number | null
}

/** pre-migration backup accounting (admin sweep) */
export interface SweepPreview {
  volumes: string[]
  volumes_bytes: number
  host_dirs: string[]
  host_bytes: number
  total_bytes: number
}

export interface SweepResult {
  removed_volumes: string[]
  removed_dirs: string[]
  failures: string[]
}

export interface TreePayload {
  /** §4.8 — what an archived seat's omitted runtime fields are worth, sent
   *  once per payload instead of 242 times inside it. `hydrateTree` refills
   *  from THIS rather than from a copy of the rule written in TypeScript.
   *  Absent from an older engine, which omitted nothing. */
  archived_defaults?: Partial<TreeNode>
  slug: string
  name: string
  workspace: string | null
  dirs: DirGrant[]
  max_top_grant: number
  default_top_grant: number
  compact_at: number
  default_tools: ToolGrant | null
  default_visibility: string
  /** default provider account ID for new hires (unbound/null = machine default) */
  default_account?: string | null
  /** the mode NEW hires are born with (D-101); existing nodes carry their own
   *  in `scope.permission_mode` and are changed one at a time in the ⚙ */
  permission_mode?: string
  /** org-wide effort fallback ("" = fall through to effort_default) — live
   *  inherit for unset nodes */
  default_effort: string
  /** what "" resolves to, so no UI string hardcodes it (ledger DEFAULT_EFFORT) */
  effort_default?: string
  /** app-wide Luna pool-order default for agents without an individual setting */
  prefer_reserve_default: boolean
  credit_requests: CreditRequest[]
  tiers: Record<string, number>
  /** tier → model id, the org's own add-only table (2026-09-03): how an
   *  OpenRouter tier is named even after its favorite was deselected */
  models?: Record<string, string>
  audiences: AudienceGrant[]
  roots: TreeNode[]
  audit: AuditReport
  cost_usd_total: number
  cost_usd_unknown?: boolean
  /** slice of cost_usd_total billed to the org's key while an api_fallback
   *  window was open — the cost chip's hover split */
  api_cost_usd_total?: number
  /** F-04: every ask card the inbox interleaves (open + recent resolved);
   *  the header ask-icon glows iff asks_open > 0 */
  asks?: AskInfo[]
  asks_open?: number
  /** docket wire contract v3 (confirmed, mail ab255d128712): the toolbar
   *  badge count, riding the same poll as everything else here rather than
   *  a standalone timer — mirrors `asks_open`/`activeDocCount(tree.roots)`.
   *  ALWAYS present (zeros on an org with no docket activity), same numbers
   *  as `counts` on GET .../work-items. `attention` = items (not questions)
   *  with `effective_attention`, over ACTIVE AND ARCHIVED items (an
   *  archived done item with a pending question still counts). `active` =
   *  non-archived items whose status is not done/superseded/dropped, the
   *  muted fallback when attention is zero. */
  work_items_summary: { attention: number; active: number }
  user_inbox_count: number
  /** D-169: how many of those unread mails were tagged urgent by their
   *  sender. Added to `asks_open` it makes the ATTENTION count, which
   *  overrides the ordinary unread number and pulses — see `attentionPip`
   *  in canvas/shared.ts, which is the only place that rule is written.
   *  ⚠ A SUBSET of `user_inbox_count`, never a separate population: both
   *  count entries still sitting in the server's `user_inbox`. */
  urgent_unread?: number
  user_inbox_newest: string | null
  fable_lock: Record<string, unknown> | null
  spend_frozen: boolean
  storage_blocked: boolean
  /** the org's virtual disk (sandboxed, migrated orgs only) — the persistent
   *  hard-full alert and the storage chip render from this state */
  disk?: TreeDisk
  /** FR-18: the org's watchdogs (canvas satellites + detail panels) */
  watchdogs?: Watchdog[]
  /** cache-protective compaction; provider/auth expiry is derived server-side */
  auto_cheap_compact?: { enabled?: boolean; occ?: number } | null
  account_fallback_default?: boolean
  auto_resume: boolean
  /** cheap-compact a limit-frozen node right before its AUTO resume */
  auto_resume_compact?: boolean
  fable_limit_policy: string
  fable_filter_policy: string
  fable_filter_model?: string | null
  cascade_hire: boolean
  cascade_alloc: boolean
  sandboxed: boolean
  audience_requests: AudienceRequest[]
  org_inbox: {
    /** ⚠ A PREVIEW — the newest few only (ledger.ORG_INBOX_PREVIEW). The
     *  canvas renders exactly one of these. The modal fetches the real list
     *  from `getOrgInbox`; the full log was 12% of the tree payload on every
     *  6 s poll for a panel that is usually closed. NEVER derive a count or
     *  an unread boundary from `entries.length` — that is what `total` is. */
    entries: OrgInboxEntry[]
    /** rows in the LOG, not in `entries` — the unread boundary counts on it */
    total?: number
    unread: number
    holders: string[]          // ledger.py extern_holders() -> list[str]
    visible: boolean
  }
  kiosk?: TreeKiosk            // only when the org is a kiosk
  public?: boolean             // only through the public gateway
  net?: NetBlock | null        // F-06 (null for kiosks; absent for visitors)
  headless?: boolean           // §9.6
  api_key_set?: boolean        // §9.5: whether, never the key itself
  /** 2026-08-17: the key is a usage-limit SPARE (subscription-first) */
  api_fallback?: boolean
  /** epoch seconds; the fallback window is open while now < this */
  api_fallback_until?: number | null
  /** 2026-08-23: a TRUSTED weekly Fable-tier hit opens this same window too
   *  (requires api_fallback + a key), instead of only fable_limit_policy */
  fable_api_fallback?: boolean
  /** FR-27 (2026-08-27): a restart armed with orgtree_prime_restart, waiting
   *  for the machine to go quiet. ⚠ MACHINE-WIDE, not org-scoped: api.py
   *  injects the same record into EVERY org's tree, because the restart it is
   *  waiting to fire cuts every org on the box. null = nothing primed. */
  primed_restart?: PrimedRestart | null
}

/** FR-27: what supervisor.primed_restart() projects — see the header chip. */
export interface PrimedRestart {
  /** Missing on pre-transition records, which are treated as armed. */
  state?: 'armed' | 'executing'
  target: 'org' | 'mailhub' | 'both'
  by_org: string
  by_node: string
  /** ISO stamp of the arming */
  at: string
  at_ts: number
  /** the arming agent's one-line why, if it gave one */
  reason?: string
  /** ISO stamp of the armed -> executing transition. */
  triggered_at?: string
}

// ----------------------------------------------------------------- org list
// api.py orgs_list admin branch attaches kiosk_cfg
export interface KioskDashboard {
  enabled: boolean
  token: string | null
  credits: number
  spend_limit: number
  storage_limit_mb: number
  spend_frozen: boolean
  storage_blocked: boolean
  sandbox: boolean
  held: number
  storage_mb: number | null
  share_url: string | null
}

// GET /api/orgs — store.list_orgs() rows + api.py orgs_list decoration.
// cost_usd_total/kiosk_cfg are admin-only and skipped on a LedgerError row.
export interface OrgListEntry {
  slug: string
  name: string
  nodes: number
  live: number
  kiosk: boolean
  created: string | null
  cost_usd_total?: number
  working?: number             // F-09: agents with a running turn (admin list only)
  kiosk_cfg?: KioskDashboard
}

// --------------------------------------------------------------------- chat
// supervisor.py read_chat: tool chip (correlated by tool_use_id)
export interface ToolChip {
  event_id?: string
  result_event_id?: string
  name: string
  arg?: string                 // _tool_arg (supervisor.py:2611) -> str
  id?: string | null
  result?: string
  result_lines?: number
  truncated?: boolean
  error?: string
  images?: number
  file?: MailAttachment & { note?: string }   // orgtree_send_file download card
  presentation?: { id: string; title: string; format?: 'markdown' | 'html' }
  mail?: { id: string; to: string }
  /** a successful `orgtree_work` MUTATION names the item it acted on, so the
   *  chip can offer to open it. Absent on a failed call and on the read
   *  actions, neither of which has an item to open. */
  work?: { slug: string }
  /** Edit chips: the pre-computed structuredPatch (supervisor.py:2912-2915) */
  diff?: { plus: number; minus: number; lines: string[]; truncated?: boolean }
  /** Task/subagent sidecar totals (supervisor.py:2917-2920) — tur.get() may
   *  hand back null for any of them */
  task?: { tools?: number | null; ms?: number | null; tokens?: number | null }
  [k: string]: unknown
}

// supervisor.py read_chat message rows — several producers, optional beyond
// role/text (every producer writes `text`, supervisor.py:2743-2972); `tools`
// interleaves nulls (plumbing markers for user records)
export interface ChatMessage {
  assistant_id?: string
  assistant_ids?: string[]
  assistant_scope?: string
  assistant_revision?: number
  assistant_order?: number
  assistant_state?: 'partial' | 'complete'
  assistant_pending?: boolean
  assistant_materialized?: boolean
  row_id?: string
  /** THE SHARED DURABLE IDENTITY (user ruling 2026-09-11). The CLI/journal
   *  record uuid this row was projected from (supervisor read_chat:
   *  `mrow['native_event_id'] = str(rec['uuid'])`) — the ONE id a live row
   *  and its transcript twin both carry, since the live emitter stamps the
   *  same uuid on its row. `event_id` cannot serve: a transcript row's is a
   *  byte offset into the CLI transcript, which the live side cannot compute.
   *  Absent on rows whose source record had no uuid (legacy journals, the
   *  synthetic steered rows), and the dedup guard simply skips those. */
  native_event_id?: string
  /** every record this row was projected from, primary first — present only
   *  when read_chat MERGED records into it (consecutive thinking-only records
   *  of one message). The merged record's body joins the survivor, so its id
   *  must too, or a live row paired with it could never be retired. */
  native_event_ids?: string[]
  reply_quote?: string
  thinking_reply_quote?: string
  event_id?: string
  reply_to?: EventReplyWire
  /** Validated by the profile-specific segment decoder before rendering. */
  segments?: unknown
  delivery?: unknown
  role: string
  text: string
  ts?: string | null
  /** null plumbing markers are swept SERVER-side before the payload leaves
   *  (supervisor.py read_chat: `[x for x in tools if x]`) — never null here */
  tools?: ToolChip[]
  cmd_out?: string
  summary?: string
  /** pre-slice ordinal — the UI's stable row key (supervisor.py:2963) */
  seq?: number
  /** thinking blocks, joined + capped (supervisor.py:2938) */
  thinking_event_id?: string
  thinking?: string
  /** "thought for Xs" — gap-derived seconds (supervisor.py:2941-2943) */
  think_secs?: number
  /** the block came signature-only: it thought, the plaintext was withheld */
  thinking_sealed?: boolean
  /** preserving-oracle exchange rows (supervisor.py:2969-2973) */
  oracle?: boolean
  /** interleaved from the durable steered log (supervisor.py:2951) */
  steered?: boolean
  /** D1: the evidence a steered row rests on — `recorded` (the CLI's own
   *  transcript holds the hook context), `accepted` (a provider accepted
   *  turn/steer), `handoff` (legacy hook fetch, receipt unconfirmed) — and
   *  the one sentence the server built from it. Rendered verbatim. */
  level?: 'recorded' | 'accepted' | 'handoff' | 'unknown'
  retried?: boolean
  confirmed_duplicate?: boolean
  receipt?: string
  /** the DISPLAY copy was capped (steered-log per-row cap); the delivery
   *  itself was whole — the desk renders a marker saying so */
  truncated?: boolean
  /** FR-17: a Codex `turn/plan/updated` snapshot (supervisor.py read_chat's
   *  `codex_plan_updated` branch) — the durable twin of a live 'plan' row,
   *  same substrate as a Claude TodoWrite tool chip (an ordinary transcript
   *  record), never a fabricated one. */
  codexPlan?: {
    steps: { step: string; status: string }[]
    explanation: string | null
    threadId: string
    turnId: string
  }
  [k: string]: unknown
}

// supervisor.py read_chat st["init"] (system init record excerpt,
// supervisor.py:1188-1194)
export interface ChatInit {
  model?: string | null
  permissionMode?: string | null
  cwd?: string | null
  /** len(ev["tools"]) — the tool COUNT, not a list (supervisor.py:1192) */
  tools?: number
  /** CLI stream-json passthrough (supervisor.py:1193) — shape is the CLI's */
  mcp_servers?: { name?: string; status?: string; [k: string]: unknown }[]
  [k: string]: unknown
}

// api.py node_chat: the durable pending-mail projection (parity №11)
export interface PendingMail {
  event_id?: string
  reply_to?: EventReplyWire
  ev?: unknown
  ev_public?: unknown
  ev_raw?: unknown
  ev_error?: unknown
  delivery?: unknown
  id: string | null
  from: string
  kind?: string
  relationship?: string | null
  body: string
  at: string
  delivering?: boolean
  /** which carrier is in flight: "turn" = drained into the turn's own text,
   *  so the transcript will take over as soon as the CLI echoes it (D-54).
   *  Absent = steered mid-task, which the transcript never carries. */
  via?: 'turn'
  /** the delivery RECEIPT (D-229, supervisor.delivering_mail): where the
   *  drained message is right now. `turn` — riding the running turn's own
   *  text; `steer` — in the steer store of a responding turn, delivered at
   *  its next tool boundary; `queued` — behind a busy turn, delivered at the
   *  next boundary or as the next turn; `stranded` — NO turn owns it and the
   *  node is idle, which the backend now prevents and the desk must never
   *  present as an ordinary "delivering…". Absent on a plain mailbox row. */
  stage?: 'turn' | 'steer' | 'queued' | 'stranded' | 'claimed' | 'acked'
  attachments?: MailAttachment[]
}

// GET /api/orgs/{slug}/nodes/{nid}/chat — read_chat + node_chat additions
/** one row of ChatPayload.live — the shape supervisor.live_row records */
export interface LiveRowPayload {
  event_id?: string
  reply_to?: EventReplyWire
  /** Validated by the profile-specific segment decoder before rendering. */
  segments?: unknown
  delivery?: unknown
  kind: string
  text?: string
  id?: string
  secs?: number
  sticky?: boolean
  /** render-inline-html-custom-responses: a `kind: "text"` row that is
   *  slash-command stdout (supervisor.py's two `local_command` live_row
   *  calls), NOT agent prose — the two share `kind` because that value
   *  also drives durability bookkeeping this must not disturb. The
   *  renderer's html-response grant must read this and stay closed. */
  cmd_output?: boolean
  at?: string
  /** per-node monotonic row id — the render key (see LiveRow.n) */
  n?: number
  /** the live copy was capped at emit time; the durable twin carries it whole */
  truncated?: boolean
  /** FR-2: a TodoWrite row's checklist (supervisor._todo_live_extra) */
  todos?: { content: string; status: string }[]
  /** FR-17: a Codex 'plan' row's checklist (supervisor._apply_plan) */
  plan?: { step: string; status: string }[]
  explanation?: string | null
  threadId?: string
  turnId?: string
}

export interface ChatTransient { reply_quote?: string; event_id: string; role: string; kind: string; text: string }

export interface ChatPayload {
  assistant_identity?: number
  assistant_scope?: string
  order_epoch?: number
  conversation_id?: string
  /** Bounded source projection: seq is an identity, not a row count. */
  windowed?: boolean
  before?: string | null
  has_older?: boolean
  transient?: ChatTransient[]
  busy: boolean
  /** The current busy turn has produced at least one observable event.
   *  Missing on an older backend and therefore treated as false. */
  turn_activity?: boolean
  queued: number
  responding: boolean
  mcp_readiness_waiting?: boolean
  mcp_readiness_state?: string | null
  mcp_readiness_reason?: string | null
  last_error: string | null
  occupancy: number | null
  /** the transcript's own reading is an estimate: this session was compacted
   *  and no turn has measured what the summary left behind yet */
  occupancy_estimated?: boolean
  messages: ChatMessage[]
  /** THE DRAFT'S SUPERSESSION, AS STATE. An opaque token that changes whenever
   *  a turn's streamed text becomes durable (supervisor.draft_epoch). The desk
   *  records the token its draft began in and retires the draft when this
   *  DIFFERS — never by ordering it, never by comparing message text.
   *  Missing on an older backend, which simply leaves the frame path in
   *  charge, exactly as before. */
  draft_epoch?: string
  /** the server-owned live tail: rows this turn produced that the transcript
   *  has not caught up on yet, already swept against it server-side
   *  (supervisor._sweep_live). The client renders these; it does not build
   *  or retire them. */
  live?: LiveRowPayload[]
  init?: ChatInit | null
  mail_pending: number
  /** D-229: how many pending rows carry `stage: 'stranded'` — drained
   *  messages no turn owns. Zero on a healthy backend; absent on an older one.
   *  A DIAGNOSTIC roll-up: the desk renders the per-row `stage` (see
   *  PendingMail), and this number is what the backend suites and an operator
   *  reading the payload check. */
  mail_stranded?: number
  /** D-229: fresh user rows read_chat is HOLDING BACK this poll because their
   *  durable projection has not landed yet — rendering them raw would put the
   *  machine envelope on screen as the user's words. Held ONLY while the
   *  message's pending bubble still covers it, so the desk never shows the
   *  message zero times. Absent on an older backend; diagnostic like
   *  `mail_stranded`. */
  prompts_withheld?: number
  pending_mail: PendingMail[]
  /** FR-17: the currently-running Codex turn's real id, when one is running
   *  (supervisor.py read_chat) — null/absent otherwise, including right
   *  after a backend restart (state() resets). The progress panel prefers
   *  this identity comparison over a timestamp guess for "is this checklist
   *  from an earlier turn". */
  codex_turn_id?: string | null
}

// ------------------------------------------------------------------ inboxes
export type SentMailEntry = MailEntry & { to?: string }

// GET /api/orgs/{slug}/inbox and .../nodes/{nid}/inbox — same shape by user
// ruling (api.py user_inbox docstring)
export interface InboxPayload {
  pending: MailEntry[]
  delivered: MailEntry[]
  sent: SentMailEntry[]
}

// ------------------------------------------------------------------- events
// ledger.py _log via api.py org_events / node_history — detail is open
export interface OrgEvent {
  at: string
  op: string
  actor: string
  detail?: Record<string, unknown>
  warnings?: string[]          // ledger.py _log (№1236-1241): list[str]
  [k: string]: unknown
}

// GET /api/orgs/{slug}/events
export interface EventsPayload {
  total: number
  events: OrgEvent[]
}

// GET /api/orgs/{slug}/nodes/{nid}/history — api.py node_history items
export interface HistoryItem {
  ev?: unknown
  ev_public?: unknown
  ev_raw?: unknown
  ev_error?: unknown
  at: string
  kind: string
  actor: string
  detail: Record<string, string | number | string[]>
  warnings?: string[]          // absent on "notice" rows
}

export interface HistoryPayload {
  items: HistoryItem[]
}

// ------------------------------------------------------------ small payloads
// GET /api/orgs/{slug}/nodes/{nid}/scratch — dir listing or file content
export interface ScratchDirEntry {
  name: string
  dir: boolean
  size: number | null
}

export type ScratchPayload =
  | { dir: string; entries: ScratchDirEntry[] }
  | { file: string; content: string }

// GET /api/fs — api.py fs_list (roots listing carries `home`)
export interface FsPayload {
  path: string
  parent: string | null
  dirs: { name: string; path: string }[]
  home?: string
}

// GET /api/charters
// `chars` is the body's TRUE length before `content` was capped at
// `preset_max`; `truncated` says the cap actually bit. Both exist so the hire
// form can SAY a preset was cut — it used to be cut silently.
// `charter_long` is NOT a limit: charters are uncapped (user ruling
// 2026-09-04). It is the length above which the form mentions that a charter
// rides in the agent's system prompt on every turn, so it costs tokens for
// the life of the agent. Do not reintroduce a cap from it.
export interface ChartersPayload {
  charters: {
    name: string; content: string; path: string
    chars?: number; truncated?: boolean
    // where the document lives: a user file in ~/.orgtree/charters or a
    // preset bundled with the installation (a user file shadows a bundled
    // one with the same filename)
    file?: string; source?: 'user' | 'bundled'
  }[]
  preset_max?: number
  user_dir?: string
  charter_long?: number
}

// GET /api/mcp-servers
export interface McpServersPayload {
  servers: string[]
  sandbox_mcp: boolean
}

// GET /api/host
export interface HostPayload {
  docker: boolean
  sandbox_mcp: boolean
  // the commit (and branch, when not main/detached) the running backend was
  // started from — frozen at process start, so it never goes stale from an
  // on-disk `git pull` alone
  build: { commit: string, branch?: string | null, started_at: string }
  cli_version: string
}

/** GET /api/providers — the provider axis (FR-15 preview): which model
 *  vendors this install knows, each with its tier family and this machine's
 *  install/connect state for its CLI. `reason` is the UI's tooltip/why. */
export interface ProviderTier {
  tier: string
  provider: string
  seat: number
  model: string
  letter: string
  /** the OpenRouter lane (2026-09-02): its tiers are minted at runtime from
   *  the user's favorites, so the payload carries what a static CSS class
   *  would otherwise hold — the canonical chip color — plus the catalog
   *  facts the hire surfaces show in tooltips. Absent on the CLI providers. */
  color?: string
  /** the rim of a DARK chip — the vendor accent the backend serves beside a
   *  dark colour (MiniMax orange-red, Z.AI cyan; brand palette 2026-09-03),
   *  so three dark vendors are not one dark chip. Null/absent on every light
   *  colour and on the xAI black, whose identity is the black itself. */
  accent?: string | null
  /** the display name without its `Vendor: ` prefix (`Claude Sonnet 5`) */
  name?: string
  /** the DISPLAY id — the model id without its vendor namespace
   *  (`claude-sonnet-5`), what every surface prints where it used to print
   *  the tier id; the backend keeps two favorites that would read the same
   *  at their full ids. Absent from an older backend: `modelLabel(model)`. */
  label?: string
  vendor?: string
  /** $ per MILLION tokens, in and out */
  prompt?: number
  completion?: number
  price_unknown?: string[]
  price_source?: string
  context?: number
  /** the OpenRouter catalog's tool DECLARATION for this tier's model:
   *  true/false as declared, null when the catalog entry declared nothing
   *  readable, absent from an older backend. Never an observation - see
   *  `toolsNote`, which is the one place this is turned into words. */
  tools?: boolean | null
  /** the catalog's IMAGE-INPUT declaration (`architecture.input_modalities`
   *  names image), same three states, same caveat: orgtree sends image
   *  blocks to every OpenRouter seat regardless — this only says what the
   *  catalog declared. `capabilityNote` is the one place it becomes words. */
  image?: boolean | null
  /** whether the catalog's `supported_parameters` names the `reasoning`
   *  REQUEST PARAMETER — list membership, not a claim about how the model
   *  thinks, which is why the note says "Reasoning parameter". */
  reasoning?: boolean | null
}
/** GET /api/openrouter — the API-backed lane's credit standing. Every field
 *  is what `GET /api/v1/key` said, or null when it said nothing. */
export interface OpenRouterCredits {
  limit: number | null
  limit_remaining: number | null
  usage: number | null
  usage_daily: number | null
  usage_weekly: number | null
  usage_monthly: number | null
  is_free_tier: boolean | null
  checked_at: string | null
}
/** GET /api/openrouter — secret-free: `key_set` says a key is stored, never
 *  what it is; `connected` says openrouter.ai accepted it. */
export interface OpenRouterDoc {
  installed: boolean
  connected: boolean
  key_set: boolean
  kind: string | null
  label: string | null
  credits: OpenRouterCredits
  reason: string | null
  favorites: number
  favorites_max: number
  tiers: ProviderTier[]
  user_enabled: boolean
}
/** one catalog row as the picker shows it (prices per MILLION tokens) */
export interface OpenRouterModel {
  id: string
  /** without its `Vendor: ` prefix */
  name: string
  /** the id without its vendor namespace (see `ProviderTier.label`) */
  label?: string
  vendor: string
  prompt: number
  completion: number
  cache_read: number
  price_unknown?: string[]
  price_source?: string
  context: number
  /** three-state, as the catalog declared it (see `ProviderTier.tools`);
   *  null is 'declared nothing readable', NOT 'declared no support' */
  tools: boolean | null
  /** image input and the reasoning request parameter, the same three
   *  states (see `ProviderTier.image` / `.reasoning`); optional because an
   *  older backend's rows do not carry them, and absent reads as unknown */
  image?: boolean | null
  reasoning?: boolean | null
  free: boolean
  /** release date, unix seconds; 0 when the catalog did not carry one */
  created: number
  letter: string
  color: string
  /** the rim of a dark card (see ProviderTier.accent); null on a light one */
  accent?: string | null
  /** already a favorite */
  selected?: boolean
}
/** the picker's ordering vocabulary; `relevance` is the id-over-name ranking */
export type OpenRouterSort = 'relevance' | 'input' | 'output' | 'recency'
export interface OpenRouterModelsPage {
  query: string
  offset: number
  limit: number
  total: number
  items: OpenRouterModel[]
  sort: OpenRouterSort
  order: 'asc' | 'desc'
  group_by_vendor: boolean
  /** an explicit sort has displaced relevance ranking for a non-empty query */
  relevance_displaced: boolean
  /** vendor of the row before this page, so a split group heading can say
   *  "continued"; null when grouping is off or this is the first page */
  prev_vendor?: string | null
}
export interface ProviderInfo {
  id: string
  label: string
  cli: string
  tiers: ProviderTier[]
  status: {
    installed: boolean
    version?: string | null
    path?: string | null
    /** how the CLI was found: 'env' | 'pin' | 'path' | '' */
    source?: string
    connected?: boolean
    email?: string | null
    /** 'chatgpt' (subscription login) or 'api-key' */
    kind?: string | null
    codex_home?: string
    /** the OpenRouter entry only: a key is stored (its "installed"), the
     *  key's label at openrouter.ai, the credit standing, favorites count */
    key_set?: boolean
    label?: string | null
    credits?: OpenRouterCredits
    favorites?: number
  }
  hire_enabled: boolean
  reason: string | null
  /** D-203 (`settings-menu`): the user's own on/off switch for this provider,
   *  machine-wide. OMITTED MEANS ON — an old backend must not read as every
   *  provider switched off. Deliberately separate from `status.installed`:
   *  the UI needs to tell "absent" from "turned off". See `HireState`. */
  user_enabled?: boolean
  /** "openai" only (item 12): the reserve POOL a `luna` hire spends first —
   *  granted / spent / when it resets / what a luna turn would be sent as
   *  now. Disclosure, not an offer gate: no tier hides on it. OMITTED on
   *  an old backend. */
  reserve?: ReserveInfo | null
  /** ⚠ DEPRECATED aliases of `reserve.granted` kept for older bundles; they
   *  no longer gate any tier (gpt-reserve is not hireable at all — see
   *  `LEGACY_CODEX_TIERS`). Do not add readers. */
  reserve_hire_enabled?: boolean
  reserve_reason?: string | null
  /** "openai" only: how far the resolved Codex CLI has drifted from what is
   *  available. Nothing in this repo ever refreshes the pin, and OpenAI gates
   *  rollout models on the CLI version — a stale pin HIDES a live tier and
   *  the old refusal message blamed the account for it. OMITTED on an old
   *  backend and on every other provider. */
  cli_version?: CodexCliVersion
}
/** The reserve pool (item 12), as `/api/providers` describes it. Three-valued
 *  on purpose: `granted`/`exhausted` are `null` when the board could not say —
 *  unknown is not withdrawn, and unknown is not spent. */
export interface ReserveInfo {
  pool: 'reserve'
  model: string
  granted: boolean | null
  exhausted: boolean | null
  percent: number | null
  resets_at: string | null
  reason: string | null
  evidence: string
  board_age: number | null
  complete: boolean
  /** what a luna turn would be SENT as right now, by the same resolver the
   *  turn uses (cached evidence only) — a forecast, never a receipt */
  route: { route: 'reserve' | 'direct'; model: string; reason: string } | null
}
/** A routed (luna) node's ACTUAL route — the turn in flight, or the last one
 *  (item 12; user spec 2026-09-04). `live` is the whole difference between
 *  "reserve" and "last: reserve": a token that cannot tell a running turn
 *  from yesterday's would be the stale-state failure the spec names, so the
 *  backend composes `label` from `live` and the desk/card render it verbatim.
 *  `model` is what was SENT; `reported_model` is what the provider echoed
 *  back — never merged, neither is a measurement of which weights answered.
 *  `null` on every tier that does not route and on an old backend. */
export interface CodexRouteInfo {
  route: 'reserve' | 'direct'
  pool: 'reserve' | 'plan'
  model: string
  requested: string
  reason: string
  selection: 'preflight' | 'retry'
  /** the pool the node's checkbox asks for FIRST — recorded apart from
   *  `route`/`pool`, which are what actually ran */
  prefer: 'reserve' | 'plan' | null
  outcome: string | null
  reported_model: string | null
  /** the server's own `model/rerouted` for this turn, when it sent one —
   *  the one case the pool that RAN differs from `pool` (the one selected).
   *  `served_pool` is the destination's pool, or null when the destination
   *  is a model no pool is known for; the backend's `label` already follows
   *  both, these are for the tooltip */
  rerouted?: { fromModel: string | null; toModel: string | null
    reason: string | null } | null
  served_pool?: 'reserve' | 'plan' | null
  live: boolean
  at: string | null
  label: string | null
}
/** ⚠ `update_available` is a TRISTATE: `null` means "cannot tell" (no CLI, no
 *  update check, an unparsable version, or a check too old to be evidence) and
 *  must NOT be rendered as "up to date". `path`/`source` matter because
 *  `codex_path()` resolves env > `<ORGTREE_DATA>/codex` pin > PATH and the pin
 *  lives under the data root — a differently-rooted process runs a different
 *  binary, so a version with no provenance misleads. */
export interface CodexCliVersion {
  path: string | null
  source: string
  version: string | null
  latest: string | null
  checked_at: string | null
  check_age: number | null
  update_available: boolean | null
  evidence: string
}
export interface ProvidersPayload { providers: ProviderInfo[] }

/** GET/PUT /api/app-settings/runtime — machine behavior, never org state. */
export interface RuntimeSettingsPayload {
  git_periodic_fetch_enabled: boolean
  warming_enabled: boolean
  /** Default on: real 20-minute checkups replace disposable cache reads. */
  working_checkups_enabled: boolean
  /** Default off: preserve no-wait startup until the operator opts in. */
  wait_for_mcp_tools_enabled: boolean
  /** Default off: nudge an idle agent about the unfinished items it owns. */
  idle_docket_reminders_enabled: boolean
}

/** one bar of the host subscription's rate-limit standing (GET /api/usage —
 *  the same readout Claude Code shows under /usage). `model` is the display
 *  name on scoped limits ("Fable"); null on the account-wide ones. */
export interface UsageLimit {
  kind: string
  group: string
  percent: number | null
  severity: string | null
  resets_at: string | null
  is_active: boolean
  model: string | null
  /** Provider-supplied display label. Claude's established kinds omit it;
   *  Codex uses it for named quota buckets and their actual window lengths. */
  label?: string | null
}

export interface UsagePayload {
  available: boolean
  error?: string
  /** D-231 expansion: a REAL, structured "this login is no good" signal —
   *  never inferred from `error`'s wording, which can be reworded any time.
   *  Claude: a 401/403 from the usage API that survived throttle
   *  discrimination (see limits.py's `_is_credential_rejection`). Absent
   *  means "no", not "unknown" — omitted rather than false so an older
   *  backend cannot be mistaken for "definitely fine". */
  reauth_required?: boolean
  /** WHICH fact produced `reauth_required` — kept distinct on purpose
   *  (root's review ruling): `'measured_403'` is a server-rejected
   *  credential (Claude); `'not_connected'` is a LOCAL observation
   *  (Codex/Antigravity — their usage read never touches a raw HTTP
   *  endpoint, so there is no 403 to measure). Never flatten these into
   *  one undifferentiated "needs sign-in" fact. */
  reauth_evidence?: 'measured_403' | 'not_connected'
  limits?: UsageLimit[]
  plan?: string
  /** The signed-in profile's address (show-the-claude-account-email-in-
   *  usage) — the same identity metadata `/api/providers` already shows in
   *  App settings; Codex/Antigravity carry the equivalent on `label`. Empty
   *  or absent when unknown, never a stale value from a previous sign-in. */
  email?: string
  /** Time of the provider observation, not merely when the UI read it. */
  observed_at?: string | null
}

/** GET /api/accounts — machine-local account routing (user redesign
 *  2026-08-25). One panel truth: the PRIMARY row is whoever Claude Code is
 *  signed in as on this machine (not switchable from the UI — the CLI login
 *  is the only mover), `keys` are the registered fallback rows in priority
 *  order, and `assignments` says which row each model tier's prompts
 *  currently go to. NO token material in any payload: a pasted key crosses
 *  the wire once, inward, and every response speaks in opaque row ids. */
export interface AccountsPayload {
  version: number
  primary: { signed_in: boolean; email: string | null }
  /** priority order after primary. (No `duplicate` flag: greying a key that
   *  resolved to the login's own account was retired 2026-08-25 by the user —
   *  a setup-token key can never resolve its account, so the check could only
   *  ever fire for v1-migrated rows. See accounts.py's module docstring.) */
  keys: {
    id: string
    /** 1-based position among the key rows — the "fallback N" the usage
     *  modal and the desk's serving label both cite. Server-counted, so the
     *  three surfaces cannot disagree after a delete. */
    ordinal: number
    /** the account this key resolved to. IDENTITY, never credential — null
     *  while the profile lookup has not succeeded yet (it retries lazily). */
    account_uuid: string | null
    /** Observed when this backend registered the paste: a lower bound on
     *  survival, not a claim about when an external CLI minted the key. */
    registered_at?: string | null
    /** Optional operator-supplied external mint-session provenance. */
    mint_config_dir?: string | null
    /** The backend registration session's config directory, deliberately
     *  distinct from the external mint-session directory. */
    registered_from_config_dir?: string | null
    /** Last decisive isolated probe result; null means legacy or unknown. */
    liveness?: 'alive' | 'limited' | 'dead' | null
    /** Last probe attempt, including UNKNOWN attempts retained for cadence. */
    liveness_checked_at?: string | null
  }[]
  /** tier → where its prompts go. `account` is "primary", a key id, or null
   *  (no usable account at all). `available: false` means nothing has
   *  capacity: the chip sits dimmed on the row that refreshes soonest,
   *  `refresh_at` (ISO) saying when. */
  assignments: Record<string, {
    account: string | null
    available: boolean
    refresh_at: string | null
  }>
  /** POST /api/accounts/keys only: the row the pasted key landed on. */
  registered?: string
  /** DELETE /api/accounts/keys/{id} only. */
  removed?: boolean
}

/** one account's marks-derived standing (registry rows and the per-account
 *  usage endpoint both carry it): per-pool "limited until", each mark naming
 *  whether it was observed or inferred — never summed across accounts. */
export interface AccountStanding {
  auth: string
  state: string
  marks: Record<string, { until: number; provenance: string; window?: string }>
}

/** GET /api/accounts — one row of the symmetric account REGISTRY (multi-
 *  account D5; distinct from the legacy key readout at /api/accounts/readout).
 *  `ambient` says this row's usage is already the host board a provider lane
 *  of the usage modal shows (the primary Claude login, the ambient Codex
 *  home) — the modal renders every row where it is false, so each registered
 *  account's standing appears exactly once. */
export interface AccountRegistryRow {
  /** Compatibility API field: managed ID or provider/primary. The UI derives
   * identity from id/ambient and email, never from a mutable name or label. */
  name?: string
  id: string
  provider: string
  harness: string
  label: string
  credential: { kind: string; path?: string; token_ref?: string
                default_config?: boolean }
  identity: Record<string, string>
  auth: string
  tint_ordinal: number
  origin_org?: string
  registered_from?: string
  ambient?: boolean
  standing: AccountStanding
  bound: { org: string; node: string; state: string }[]
}

export interface AccountRegistryPayload {
  accounts: AccountRegistryRow[]
  primary: string
  /** Who each provider's HOST login — the `provider/primary` selector shown
   *  as `default` — is signed in as. It rides BESIDE the rows because that
   *  login often has no registry row at all, and every account surface reads
   *  its address from here so none of them can disagree. Absent from an older
   *  backend, which reads as "nothing observed", never as an error. */
  host_identity?: Record<string, { email?: string | null } | undefined>
}

/** GET /api/accounts/{id}/usage — a REGISTRY account's own usage: the same
 *  bars/tiers shape as AccountUsage, plus the row's marks-derived standing. */
export type RegisteredAccountUsage = AccountUsage & {
  standing?: AccountStanding
}

/** GET /api/accounts/usage[/{account}] — one account's usage standing, the
 *  same normalized bars as UsagePayload plus which row it describes.
 *  `plan` is the subscription tier, read from THAT ROW'S OWN credentials
 *  file. It used to ride only the primary entry, because the sole reader was
 *  the host-store one — so a second signed-in Claude Code account rendered
 *  its bars with no tier beside them. Absent still means the provider
 *  reported none; it is never defaulted. */
/** one model tier's standing ON ONE ACCOUNT — `available` is "this account
 *  still has capacity for this tier", NOT "this tier runs here" (the panel's
 *  gutter chips answer that, and the two legitimately differ). `pool` names
 *  the tiers that share this one's capacity, itself included, and is null for
 *  a tier that stands alone — haiku/sonnet/opus are one subscription bucket,
 *  so a limit on any of them marks all three.
 *
 *  ⚠ `pool: null` does NOT mean "never marked alongside the others". Since
 *  D-152 fable RIDES ALONG with a subscription limit — it can show as waiting,
 *  at the same time as the bucket, while still reporting no pool of its own.
 *  Nothing renders `pool` today; read it as "shares the same capacity", never
 *  as "these are the only tiers that move together". */
export interface TierStanding {
  tier: string
  available: boolean
  refresh_at: string | null
  pool: string[] | null
}

export interface AccountUsage {
  account: string
  label: string
  /** Observed login email. Older host payloads carried this in label. */
  email?: string | null
  /** Present for a non-Claude provider section in the combined usage modal. */
  provider?: string
  available: boolean
  /** a KEY row's answer in place of percentages, which it can never have
   *  (user ruling 2026-08-25): the internal routing state we hold for this
   *  account — which models it still has capacity for, and when the spent
   *  ones come back. Absent on the primary, which reports real usage. */
  tiers?: TierStanding[]
  /** ⚠ this account CANNOT report usage, ever — not an outage. A
   *  `claude setup-token` key is inference-only and the usage endpoint needs
   *  a scope it never carries (D-147), so the server answers from local state
   *  without a request. Rendered as a settled note rather than an error,
   *  because a blank meaning "impossible" and a blank meaning "unknown" must
   *  not look the same. */
  unsupported?: boolean
  /** ⚠ WHAT A PERSON READS, and nothing else (user ruling 2026-09-11 —
   *  "usage unavailable; start a turn on this account to see usage"). A raw
   *  `HTTP 403 error code: 1010` here told the user nothing they could act
   *  on and read as "your account is broken" when it was not. The technical
   *  line moved to `detail`. */
  error?: string
  /** The technical line behind `error`, for diagnosis — never the headline.
   *  Present when we have one; absent is normal, not an omission. */
  detail?: string
  /** D-231 expansion: see UsagePayload's own field — same trigger (the
   *  panel shows a sign-in button either way), but `reauth_evidence` keeps
   *  Codex/Antigravity's LOCAL "installed but not signed in" observation
   *  distinct from Claude's server-measured 401/403 — never relabel one as
   *  the other.
   *
   *  ⚠ `reauth_required` is set ONLY when something actually JUDGED the
   *  credential. A refresh that never reached the OAuth server — an edge/WAF
   *  block, a throttle, a moved endpoint, a dropped connection — leaves it
   *  absent however authoritative its status code looked. That distinction
   *  is the whole of the 2026-09-11 fix: subproxy's `403 error code: 1010`
   *  was a Cloudflare block on a scripting User-Agent, and showing a sign-in
   *  button for it sent the user at a ritual that could not help. */
  reauth_required?: boolean
  /** `'measured_refresh_rejected'`: the OAUTH TOKEN endpoint refused the
   *  refresh token itself (an `invalid_grant`, or a bare 401/403 carrying no
   *  edge marker). Distinct from `'measured_403'`, which is the USAGE API
   *  rejecting an access token, and from `'not_connected'`, a purely local
   *  observation that no credential is present to try. */
  reauth_evidence?: 'measured_403' | 'measured_refresh_rejected' | 'not_connected'
  limits?: UsageLimit[]
  plan?: string
  /** Time of the provider observation, not merely when the UI read it. */
  observed_at?: string | null
}

/** GET /api/accounts/usage — every account, primary first then keys in
 *  priority order (user ruling 2026-08-25: the overall usage button shows
 *  them all). */
export interface UsageAllPayload {
  accounts: AccountUsage[]
}

/** GET /api/usage/peek — the same standing read from the server's cache
 *  ALONE, so the header button's near-the-wall glow can poll continuously
 *  without ever costing an upstream request. `available: false` means "do not
 *  glow": no readout yet, no subscription on this host, or one too old to be
 *  a claim about now (the modal still shows those bars, dated). */
export interface UsagePeek {
  available: boolean
  /** Defaults to Claude for the established endpoint. */
  provider?: string
  error?: string
  limits?: UsageLimit[]
  /** seconds since the cached readout was fetched */
  age?: number
}

// GET /api/defaults — _DEFAULTS_BASE merged with the stored overrides
export interface DefaultsPayload {
  max_top_grant: number
  default_top_grant: number
  compact_at: number
  fable_limit_policy: string
  fable_filter_policy: string
  fable_filter_model?: string | null
  cascade_hire: boolean
  cascade_alloc: boolean
  auto_resume: boolean
  auto_resume_compact?: boolean
  default_tools?: ToolGrant
  default_visibility?: string
  default_effort?: string
  /** app-wide Luna default for agents without an individual preference */
  prefer_reserve?: boolean
  [k: string]: unknown         // defaults.json is stored org-doc-shaped
}

// GET /api/orgs/{slug}/orgmd
// `chars` is the file's TRUE length; `read_truncated` says `content` is only
// the first `edit_max` of it — and a truncated read MUST NOT be saved back or
// it rewrites the file short. `prompt_max` is how much of org.md actually
// reaches an agent's system prompt: a file can be saved whole and still be
// DELIVERED short, which is the thing the operator was never told.
export interface OrgMdPayload {
  path: string | null
  content: string
  chars?: number
  read_truncated?: boolean
  edit_max?: number
  prompt_max?: number
}

// GET /api/orgs/{slug}/audiences
export interface AudiencesPayload {
  audiences: AudienceGrant[]
  requests: AudienceRequest[]
}

// ---------------------------------------------------------------- requests
// api.py KioskSpec (all fields have server defaults → optional here)
export interface KioskSpecRequest {
  credits?: number
  spend_limit?: number
  storage_limit_mb?: number
  sandbox?: boolean
  max_scope?: Record<string, unknown> | null
  auto_raise?: boolean
}

// api.py Op — the ledger op envelope (POST /api/orgs/{slug}/ops)
export interface OpRequest {
  op: string
  actor?: string
  node?: string | null
  parent?: string | null
  tier?: string | null
  /** multi-account: the account chosen WITH a cross-provider switch_model
   *  (required when the node is bound; validated at the door) */
  account?: string | null
  grant?: number | null
  name?: string | null
  charter?: string | null
  add_dirs?: unknown[] | null  // [{path, mode}] or bare paths (api.py: list)
  tools?: Partial<ToolGrant> | null
  org_visibility?: string | null
  effort?: string | null
  /** hire — item 12: a luna's pool order, applied WITH the hire (omitted =
   *  reserve first, the default) */
  prefer_reserve?: boolean | null
  /** hire — FR-25 insert superior: the anchor node; the server splices the
   *  fresh hire in as its superior atomically (same save as the hire) */
  above?: string | null
  delta?: number | null
  new_parent?: string | null
  dir?: string | null
  raise_ceiling?: boolean
}

// api.py Scope (POST .../nodes/{nid}/scope)
export interface ScopeRequest {
  add_dirs?: DirGrant[] | null
  tools?: Partial<ToolGrant> | null
  org_visibility?: string | null
  permission_mode?: string | null
  charter?: string | null
  team_charter?: string | null
  effort?: string | null
  model_version?: string | null
  /** item 12: reserve-first (true) or plan-first (false); omitted = unchanged */
  prefer_reserve?: boolean | null
  /** clear the individual value so this node follows the app-wide default */
  clear_prefer_reserve?: boolean
  account_fallback?: boolean | null
  clear_account_fallback?: boolean
  /** per-node cache-protection override; {} clears back to org inherit */
  auto_cheap_compact?: { enabled?: boolean; occ?: number } | null
  raise_ceiling?: boolean
}

// api.py Settings — shared by /api/defaults and /api/orgs/{slug}/settings
export interface SettingsRequest {
  account_fallback_default?: boolean | null
  org_dirs?: DirGrant[] | null
  max_top_grant?: number | null
  default_top_grant?: number | null
  compact_at?: number | null   // percent, 50..95
  clear_fable_lock?: boolean
  fable_limit_policy?: string | null
  fable_filter_policy?: string | null
  fable_filter_model?: string | null
  default_tools?: Partial<ToolGrant> | null
  default_visibility?: string | null
  default_account?: string | null
  /** D-101 — the mode NEW hires are born with; admin-only (this endpoint is
   *  frozen for kiosk visitors, unlike /defaults) */
  permission_mode?: string | null
  default_effort?: string | null
  /** app-wide Luna default; not copied into individual org settings */
  prefer_reserve?: boolean | null
  auto_resume?: boolean | null
  /** cheap-compact a limit-frozen node right before its AUTO resume wakes it */
  auto_resume_compact?: boolean | null
  /** known-cold pre-turn compaction (org level; disabled by default) */
  auto_cheap_compact?: { enabled?: boolean; occ?: number } | null
  cascade_hire?: boolean | null
  cascade_alloc?: boolean | null
  // F-06
  net_hub_address?: string | null      // global defaults only
  net_autoconnect?: boolean | null     // per-org: keep/join the local hub
  net_hubs?: { id?: string; address: string; enabled?: boolean }[] | null
  headless?: boolean | null            // §9.6 (server enforces the couplings)
  api_key?: string | null              // §9.5 (write-only)
  clear_api_key?: boolean
  /** the key as a usage-limit SPARE — server enforces the couplings */
  api_fallback?: boolean | null
  /** also spend that spare on a trusted weekly Fable-tier hit (requires
   *  api_fallback already on) — server enforces the coupling */
  fable_api_fallback?: boolean | null
}

// F-06: GET /api/orgs/{slug}/net — loopback-admin reveal (the ONE place the
// secret is returned)
export interface OrgNetReveal {
  identity: { secret: string; fingerprint: string; slug: string;
              minted_at: string } | null
  hubs: { id: string; address: string; enabled: boolean;
          name?: string | null }[]
  autoconnect: boolean
}

// api.py HireDefaults (POST /api/orgs/{slug}/defaults)
export interface HireDefaultsRequest {
  default_tools?: Partial<ToolGrant> | null
  default_visibility?: string | null
  default_effort?: string | null
  default_account?: string | null
  raise_ceiling?: boolean
}

// api.py KioskCfg (POST /api/orgs/{slug}/kiosk)
export interface KioskCfgRequest {
  enabled?: boolean | null
  credits?: number | null
  spend_limit?: number | null
  storage_limit_mb?: number | null
  rotate_token?: boolean
  max_scope?: Record<string, unknown> | null
  auto_raise?: boolean | null
}

// api.py Reorder (POST .../nodes/{nid}/reorder)
export interface ReorderRequest {
  before?: string | null
  after?: string | null
}

// ---------------------------------------------------------------- responses
// Ledger op results are op-specific dicts (hire → {node, ...}, dissolve →
// {freed, nodes}, …) — only `warnings` is a cross-op convention
export interface OpResult {
  warnings?: string[]
  /** the one-action kiosk-ceiling bridge (ledger.py:714-715): present when
   *  something was clamped and re-sending with raise_ceiling would fit it */
  bridge?: { raise_ceiling?: boolean }
  /** D-106: agents whose permissions this grant raised on its way down the
   *  chain (ledger.set_scope). The ledger is the authority — the panel's
   *  pre-save preview is a courtesy, this is what actually happened. */
  cascaded?: string[]
  [k: string]: unknown
}

// POST .../settings
export interface SettingsResult {
  dirs: DirGrant[]
  warnings: string[]
}

// POST .../kiosk
export interface KioskSaveResult {
  kiosk: Record<string, unknown>
  share_url: string | null
  freezes_cleared: string[]
  warnings?: string[]
}

// POST .../nodes/{nid}/message — several branches (api.py node_message):
// mail accept, /compact start, immediate command, or send_message's result
export interface SendMessageResult extends Partial<TypedReplyReceipt> {
  accepted?: boolean
  deferred?: boolean | string
  queued?: number
  frozen?: boolean
  halted?: boolean
  halting?: boolean
  compacting?: boolean
  command?: boolean
  immediate?: boolean
  /** delivered mid-task via the steering hook (supervisor.py:1643) */
  steering?: boolean
  warnings?: string[]
  [k: string]: unknown
}

// -------------------------------------------------------------- work docket
// LOCKED wire contract v3 (luna-reserve, backend owner — mail 1f11803a2ea0,
// doc luna-reserve/evidence/docket-wire-contract-v3.md). Field names/shapes
// below mirror that document verbatim; do not rename without telling them.

/** Who did something to a work item: a node at a generation. The user is the
 *  literal string "user" wherever an actor is accepted.
 *
 *  The last two fields are WRITTEN only onto a HOLDER reference — `owner` and
 *  `reviewer`, the two that say who has the item NOW and so have to keep
 *  resolving to a live agent (backend `ledger._work_holder`). The authored
 *  actor fields — `created_by`, `last_updater`, the `by` of a `WorkItem`
 *  history row (typed `unknown[]` here) and a delivery stage's `claimed_by` —
 *  name who acted THEN and never carry either.
 *
 *  A history row's `from`/`to` are the exception: an assign or reviewer row
 *  records the holder references themselves, so those slots are SNAPSHOTS of
 *  this shape and may carry `born`, and `from` may carry `deleted` when that
 *  holder had already been invalidated before the handover. They are history,
 *  not live pointers — never resolve one against the current agent list.
 *
 *  Both fields are also absent on every reference written before 2026-09-12,
 *  so treat absence as "not known", never as false.
 *
 *  Nothing in the UI needs to read either one: `owner_current` and
 *  `owner_state` on the item already carry the conclusion the backend draws
 *  from them. They are declared because this file mirrors what the writers
 *  write. */
export interface WorkActor {
  node: string
  generation: number
  /** the holder's own mint id (`NodeDoc.seat_id`) — one uuid per agent, fixed
   *  at hire, which is what makes the reference name an AGENT rather than a
   *  name a later hire could be given. */
  born?: string
  /** set by a node `delete` on the holder references it strands: the agent
   *  this named is gone, so whoever wears the name now never held the item.
   *  Present only when true. */
  deleted?: boolean
}

/** One asker's OPEN question(s) attached to this item — the item's own view
 *  of the same data `tree.asks`/`node.ask` carries (one entry per asker,
 *  open only; closed asks drop out automatically). Render the "who is
 *  asking" list and `effective_attention` from THIS; answer by finding the
 *  matching real AskInfo in `tree.asks` by `ask_id` and rendering the
 *  existing AskCard — never a second answering channel. */
export interface WorkItemQuestion {
  ask_id: string
  node: string
  rev: number
  at: string
  tabs: {
    index: number
    question: string
    header?: string
    options?: { label: string; description?: string }[]
    multi?: boolean
  }[]
}

/** An agent-set manual attention flag plus its required reason. `set_rev`
 *  bumps every time this is (re)set — a dismiss must echo it, so a delayed
 *  click can't clear a newer reason it never actually saw. */
export interface WorkManualAttention {
  reason: string
  at: string
  by: WorkActor
  set_rev: number
}

/** One recorded user dismissal of a manual attention flag (kept, newest
 *  last) — history, not live state; `manual_attention` is null after one. */
export interface WorkDismissal {
  at: string
  by: 'user' | '@user'
  set_rev: number
  reason: string
}

/** A durable unit of work in the org document. Only the fields the docket UI
 *  actually renders or mutates are typed strictly; delivery/evidence/
 *  acceptance/dependencies/history ride along unread (spec: "preserve useful
 *  backend delivery/evidence metadata without adding crowded UI"). */
/** one file attached TO a work item — `name` is the stored, de-duplicated
 *  filename (what you see listed is exactly what is stored) */
export interface WorkItemAttachment {
  id: string
  at: string
  by: WorkActor | string
  name: string
  bytes: number
  /** storage-internal relative path; the UI addresses bytes by `id` */
  path?: string
}

/** W08 — HOW a check reached its conclusion. The distinction is a reviewer's,
 *  not a formality: an approval reading "tests pass" when the reviewer read
 *  somebody else's log overstates its own scope. */
export type WorkExecution = 'independent' | 'owner_report' | 'source_inspection'

/** W08 — WHAT CAME BACK. Five values, because collapsing any two of them is
 *  how a suite reports green while a negative control never fired.
 *  `expected_negative` is a PASS (it failed as designed); `crashed` reached no
 *  verdict at all; `not_executed` never ran and must never read as a pass. */
export type WorkResult =
  'passed' | 'expected_negative' | 'failed' | 'crashed' | 'not_executed'

/** W08 — the state of the tree a receipt was measured in. `unresolved` is a
 *  tree mid-rebase (or one git could not read): it is neither the recorded
 *  commit nor a clean edit of it, so any number taken from it describes a
 *  mixture of two commits. */
export interface WorkTreeState {
  checkout: string
  commit: string | null
  base: string | null
  state: 'clean' | 'dirty' | 'unresolved'
  dirty_paths: string[]
  dirty_count: number
  /** '' or the git operation half-applied there (rebase, merge, cherry-pick…) */
  in_progress: string
  fingerprint: string
  observed_at: string
  detail: string
}

/** W08 — one immutable record of an observation. Never refreshed: the read
 *  path compares it against the tree NOW and discloses the difference, which
 *  is what keeps a passing log from before an edit from reading as evidence
 *  for after it. */
export interface WorkReceipt {
  schema: string
  candidate: string
  base: string | null
  tree: WorkTreeState
  execution: WorkExecution
  result: WorkResult
  green: boolean
  command: string[]
  runner: Record<string, unknown>
  logs: { text: string; encoding: string; had_bom: boolean
    replacements: number; bytes: number; sha256: string; path?: string
    unreadable?: string }[]
  replay: { candidate: string; checkout_flag: string; portable: boolean
    steps: string[]; detail: string }
  note: string
  observed_at: string
  fingerprint: string
  /** present on a `rangediff` receipt: all four endpoints of the comparison,
   *  because "the rebase was clean" is unfalsifiable without them */
  range_diff?: { old_base: string; old_tip: string; new_base: string
    new_tip: string; identical: boolean | null; detail: string
    output: string; observed_at: string }
}

/** W08 — an immutable evidence file on the item. The bytes are addressed by
 *  record id and their sha256 is recorded, so a download can be checked
 *  against what was registered. `named` scope is readable only by the
 *  recorder, its explicit grantees and the user. */
export interface WorkItemArtifact {
  id: string
  seq: number
  at: string
  by: WorkActor | string
  name: string
  bytes: number
  sha256: string
  scope: 'item' | 'named'
  note?: string
  visible: true
  /** agents holding a live (unrevoked) grant — server-derived */
  grants_live: string[]
  grants?: { at: string; by: WorkActor | string; to: string
    revoked_at: string | null; note?: string }[]
  path?: string
}

/** W08 — a defect with a citable id and an append-only record of what was
 *  decided about it, so a later review round can read the ruling instead of
 *  re-arguing ground an earlier round settled. */
export interface WorkFinding {
  id: string
  seq: number
  at: string
  by: WorkActor | string
  title: string
  detail?: string
  severity?: string
  evidence_ref?: string
  disposition: 'open' | 'fixed' | 'rejected' | 'deferred' | 'duplicate'
  /** every decision in order — earlier ones are never overwritten */
  decisions: { at: string; by: WorkActor | string; disposition: string
    note?: string }[]
}

export interface WorkItem {
  /** THE ONLY IDENTIFIER (user 2026-09-05: "uniquely and solely identifiable
   *  by their readable slugs, no more ids of any sort"). Derived from the
   *  title, unique across active+archive, fixed at creation — it does NOT
   *  follow a later title edit, so a name already written down keeps working.
   *  Every reference uses it: React keys, selection, `dependencies`,
   *  `superseded_by`, and the routes. The retired opaque `w########` key is
   *  gone from the wire; a document still holding one is converted by
   *  POST /api/orgs/{slug}/migrate-work-identity, and until it is, the list
   *  and item routes answer 409 rather than serve two kinds of name. */
  slug: string
  rev: number
  kind: 'code' | 'non-code'
  title: string
  objective: string
  /** backlogged | open | in_progress | blocked | review | deploy_ready |
   *  done | superseded | dropped. `backlogged` = not yet approached or
   *  approved: served in its own group behind its own toggle and never
   *  counted as active. `blocked` = cannot move until an answer or event
   *  outside the item happens: it counts as active, stays on the desk, and
   *  is never nudged by the idle reminder (user 2026-09-07). There is no
   *  `waiting` state any more (user 2026-09-07): a row recorded as waiting is
   *  SERVED as blocked, with `legacy_status` saying so. `deploy_ready`
   *  (2026-09-08) = implementation is complete and awaiting deployment or
   *  publication — not blocked (nothing outside the item is stuck) and not
   *  done (not live yet): it counts as active and IS nudged, unlike blocked.
   *  `dropped` = the terminal NON-SUCCESS outcome (cancelled, or failed
   *  unrecoverably): it is closed, it archives AT ONCE (user 2026-09-07),
   *  and it is never Done. */
  status: string
  /** the word a row was STORED under when `status` is a read-time mapping of
   *  a removed state (today only "waiting" → blocked); null/absent otherwise.
   *  Optional on the wire: an older backend does not send it. */
  legacy_status?: string | null
  /** the state's own information, required on ENTRY to that state and cleared
   *  on the way out, so at most one of them is ever set. For a legacy waiting
   *  row `blocked_reason` is served from the recorded waiting reason.
   *  `waiting_reason` and `dropped_reason` are optional on the wire because
   *  an older backend does not send them. */
  blocked_reason: string | null
  waiting_reason?: string | null
  dropped_reason?: string | null
  /** DERIVED on every read: (physically archived OR done/waiting && docket_at
   *  older than 3600s, strictly, OR dropped — at once) AND NOT
   *  effective_attention (Astra correction
   *  2026-09-05) — an item with a pending question or manual flag is NEVER
   *  in the archived group, even one that would otherwise qualify, so the
   *  UI needs no special "attention item hidden behind Show archived" case:
   *  trust this field directly for active/archived grouping and styling.
   *  `archived_at` may still be non-null on such a row from an earlier
   *  archival; ignore it whenever `archived` reads false. */
  archived: boolean
  archived_at: string | null
  owner: WorkActor | null
  owner_current: boolean
  owner_state: 'live' | 'retired' | 'missing' | 'generation moved' | null
  /** the agent named to CHECK this work while it sits at `review` — read,
   *  evidence and the one review decision, never ownership. Null on every item
   *  that has not entered review since the field shipped; nothing back-fills
   *  it, because a reviewer nobody chose is not a reviewer. */
  reviewer: WorkActor | null
  participants: string[]
  /** Server-derived destinations; tree roots omit some archived predecessors. */
  reply_recipients?: { node: string; role: 'owner' | 'participant';
    state: 'live' | 'retired' | 'missing' }[]
  created_by: WorkActor | 'user' | '@user'
  at: string
  updated_at: string
  /** nonblank entries only; both this and working_on_next empty is a
   *  server-rejected status update. Arrays of individual items, never a
   *  markdown string to be parsed. */
  done_so_far: string[]
  working_on_next: string[]
  /** time of the LATEST DOCKET UPDATE — the row's age and the archive rule
   *  both read THIS, not `updated_at` (any mutation moves that). Null
   *  before the item's first status update. */
  docket_at: string | null
  /** when the STATUS VALUE last changed — the third clock, and the only one
   *  that answers "what has actually moved?". A progress note, a retitle or
   *  an attention flag advances the other two without a state changing.
   *  Served for every item: the server derives it for items written before
   *  the field existed, from retained history, falling back to creation.
   *  Optional only because an older BACKEND may not send it at all. */
  status_at?: string | null
  /** Author of the latest status update; replies use owner/participants. */
  last_updater: WorkActor | null
  manual_attention: WorkManualAttention | null
  dismissals: WorkDismissal[]
  questions: WorkItemQuestion[]
  /** manual_attention != null OR questions.length > 0 */
  effective_attention: boolean
  attention_sources: ('manual' | 'question')[]
  acceptance: { text: string; checked: null | { at: string; by: string; evidence_ref?: string; note?: string } }[]
  /** ⚠ AN UNREADABLE DEPENDENCY IS ANONYMOUS. It used to arrive as
   *  `{id, visible:false}` — safe, because an opaque id carried no title.
   *  The name is DERIVED from the title, so it is withheld entirely from a
   *  viewer who may not read the item: they learn a dependency exists and
   *  nothing else. `superseded_by` is null for the same reason. */
  dependencies: ({ slug: string; visible: true; title: string; status: string }
    | { visible: false })[]
  /** SUB-ITEMS: the parent's name, or null at the top level. Null is also
   *  what a viewer who may not READ the parent sees — `parent_visible` is the
   *  difference, and it is false in that case rather than null, so the row can
   *  say a parent exists without naming it. A child is an independent item:
   *  its own owner, status and authority. */
  parent: string | null
  parent_visible?: boolean | null
  evidence: { at: string; by: string; kind: string; ref?: string; note?: string
    /** W08: HOW this row was reached. Absent on every row written before the
     *  field existed and on every row whose author did not say — and absent
     *  means UNSTATED, never "independently executed". */
    execution?: WorkExecution
    execution_means?: string
    /** W08: provenance captured BY THE BACKEND (never by the caller). Present
     *  only on rows recorded through the `receipt`/`rangediff` actions. */
    receipt?: WorkReceipt }[]
  /** W08 artifacts: immutable evidence files. A `named` artifact the viewer
   *  holds no grant on arrives as `{visible: false}` — the row stays (so the
   *  absence of evidence is never implied) and the filename is withheld (a
   *  filename says what was measured). */
  artifacts?: (WorkItemArtifact | { visible: false; scope: string })[]
  findings?: WorkFinding[]
  findings_summary?: { total: number; by_disposition: Record<string, number>
    open: string[] }
  /** files/images attached TO the item itself (user feature 2026-09-10) —
   *  distinct from reply attachments, which are mail. The bytes are served
   *  by GET /work-items/{wid}/attachments/{id}. Optional on the wire: an
   *  older backend does not send the field. */
  attachments?: WorkItemAttachment[]
  delivery: Record<string, unknown> | null
  accepted: { at: string; by: string; note?: string } | null
  /** Nonterminal exact-candidate review, distinct from accepted completion. */
  candidate_verdict?: {
    candidate: string
    decision: 'approve' | 'changes'
    evidence: { kind: string; ref: string; note?: string }[]
    note?: string | null
    next_actor: WorkActor | 'user'
    by: WorkActor | 'user'
    at: string
  } | null
  candidate_verdicts?: unknown[]
  /** Packet supplied atomically with the review transition. */
  review_packet?: {
    candidate?: string | null
    evidence: { kind: string; ref: string; note?: string }[]
    note?: string | null
    next_actor?: WorkActor | 'user'
    by?: WorkActor | 'user'
    at?: string
  } | null
  review_packets?: unknown[]
  superseded_by: string | null
  superseded_by_visible?: boolean | null
  history: unknown[]
  [k: string]: unknown
}

// GET /api/orgs/{slug}/work-items[?archived=1][&backlogged=1]
export interface WorkItemsPayload {
  items: WorkItem[]
  /** present only when asked for; each is APPENDED below `items`, never
   *  merged into it — revealing a group must not re-sort the main list */
  archived?: WorkItem[]
  backlogged?: WorkItem[]
  /** `active` excludes backlogged AND closed items; `attention` does not, so
   *  a flagged backlog row still lights the badge (and the backend keeps such
   *  a row in `items`, so the badge always opens onto a visible row) */
  counts: {
    attention: number; active: number; archived: number; backlogged: number
  }
  now: string
}

// GET /api/orgs/{slug}/work-items/{id}
export interface WorkItemPayload { item: WorkItem }

// POST /api/orgs/{slug}/work-items/{id}/dismiss-attention — 409 (thrown by
// req()) on a null flag or a stale set_rev; success returns the updated item
export interface DismissAttentionResult { item: WorkItem }

// POST /api/orgs/{slug}/work-items/{id}/reply — failures are explicit HTTP
// errors (422 nothing to reply to, 404 recipient gone), never a reroute;
// req() throws those as Error(detail)
export interface WorkItemReplyResult extends Partial<TypedReplyReceipt> {
  accepted: true
  role?: 'owner' | 'participant'
  to: string
  /** the recipient is archived — mail waits for rehire; say so in the UI */
  deferred: boolean
  delivery?: unknown
  /** allow-attachments-in-contextual-reply-composers: D-171 — a caller-
   *  supplied attachment path that never resolved to a real staged file,
   *  same rule as SendMessageResult.warnings. */
  warnings?: string[]
}

export interface UploadResult {
  path: string
  bytes: number
}
