"""The org document's shape, in one place (typing wave, docs/typing-plan.md).

One org = one storage document (stored as a SQLite database under
`orgs/<slug>.db`, or historically as a JSON file under `orgs/<slug>.json`;
store.py). Every dict that document contains is declared here as a TypedDict, so
pyright can catch key typos and shape drift — the class of bug the
misleading-reads history is made of. Nothing here exists at runtime beyond the
type objects: importing this module changes no behavior.

Ground rules:
- These types describe what the CODE writes today (Build sources: ledger.py,
  supervisor.py, api.py). Where old docs on disk may lack a key, the reader
  already tolerates it (`.get`) — model that as NotRequired, not as a lie that
  the key is always there.
- Extend this file rather than re-deriving a dict shape in a docstring. If a
  shape is genuinely open (freeform op payloads), say `dict[str, Any]` at the
  use site — never guess a narrower type than the code proves.
- Runtime-inert: `TypedDict` instances are plain dicts; there is no validation
  and none is wanted (store.py loads whatever document is on disk).
"""

from __future__ import annotations

from typing import Any, Literal, Optional

# NotRequired lands in typing on 3.11; fastapi already depends on
# typing_extensions, so this adds no install weight on our 3.10.
from typing_extensions import NotRequired, TypedDict

NodeState = Literal["live", "archived", "unrecoverable"]   # №31
DirMode = Literal["rw", "ro"]
Visibility = Literal["self", "team", "subtree", "full"]     # VIS_LEVELS
PermissionMode = Literal["plan", "default", "acceptEdits", "bypassPermissions"]  # PM_LEVELS
# §8 lineage. "lost" = a generation whose transcript is gone — kept for the
# record, never consultable (Org.reseed writes it; rehire refuses on it).
BearerState = Optional[Literal["knowledge", "preserving", "lost"]]
Effort = Literal["low", "medium", "high", "xhigh", "max"]   # Org.EFFORTS


class DirGrant(TypedDict):
    """One entry of a capability set (№30) — see norm_dirs()."""
    path: str
    mode: DirMode


class ToolGrant(TypedDict):
    """The normalized tool switches — see norm_tools(). `mcp` is a sorted
    server-name list; `["*"]` means every registered server, present and
    future."""
    bash: bool
    web: bool
    edit: bool
    subagents: bool
    mcp: list[str]


class NodeScope(TypedDict):
    """The per-node ⚙ configuration (set_scope), clamped against the parent
    chain and the kiosk ceiling."""
    permission_mode: str
    add_dirs: list[DirGrant]
    tools: ToolGrant
    org_visibility: str
    # thinking-effort dial (one of Effort) — set_scope writes it HERE, not on
    # the node (ledger sc["effort"]; supervisor reads sc.get("effort")).
    # Absent = the CLI default ("" clears by popping the key).
    effort: NotRequired[str]
    # Cache-protective compact override — {enabled?, occ?}. Expiry is derived
    # from authoritative provider receipts, never an operator timeout.
    # merged key-by-key over the org's `auto_cheap_compact`; absent = inherit
    auto_cheap_compact: NotRequired[dict[str, Any]]
    # which model VERSION inside the tier (ledger.MODEL_VERSIONS) — a
    # subcategory of the tier, not a tier of its own. Absent = the tier
    # default. Neither a permission nor a price, so it clamps against nothing,
    # and `Org.model_for` re-validates it against the node's CURRENT tier on
    # every read, so a switch_model can never drag a stale choice with it.
    model_version: NotRequired[str]


class Denial(TypedDict):
    """№7: one headless auto-deny from the CLI result event (_after_turn).

    Also the shape of one APPROVED escalation on the codex lane
    (`last_approvals`) — the same row, kept in a separate list because the
    two mean opposite things. `cwd` is set only by the codex approval seam,
    whose requests name the directory the command would run in.
    """
    tool: str
    arg: NotRequired[str | None]
    cwd: NotRequired[str | None]


class TurnStat(TypedDict):
    """№15: one entry of the per-node turn ring (capped at 20)."""
    at: str
    cost: float
    ms: NotRequired[int | None]
    denials: int
    #: codex lane only: escalations `_approve` ANSWERED "accept". It counts
    #: approvals, not observed executions — the callback answers before
    #: anything runs. Absent on lanes with no such callback. Like `denials`
    #: it is the TRUE count, not the length of the capped detail rows.
    approvals: NotRequired[int]
    # killed-turn accounting (2026-08-04): output tokens ride every entry so a
    # later killed turn can estimate its unreported spend from the node's own
    # $/token history; `killed` marks the kill, `estimated` marks a derived
    # (not API-reported) cost
    toks: NotRequired[int]
    killed: NotRequired[bool]
    estimated: NotRequired[bool]
    cost_complete: NotRequired[bool]
    # How the numeric amount was obtained, and which used price components
    # were unavailable. Additive: historical rows have neither field.
    cost_source: NotRequired[str]
    cost_unknown_fields: NotRequired[list[str]]
    # WHICH ACCOUNT SERVED THIS TURN (2026-08-25) — an account uuid, or a
    # sentinel ("ambient" / "api-key" / "token:unattributed"). Captured at
    # spawn from the resolved env, never from intent, and never a credential.
    # The live `ran_as` on the node payload is in-memory and per-node, so it
    # is overwritten by the next spawn and lost on restart; this is the copy
    # a post-mortem can still read. Absent when the node has not run in this
    # backend process — absent, not "unknown", so it cannot read as a measure.
    ran_as: NotRequired[str]
    #: WHAT THE CLI REPORTED ABOUT THE MESSAGES IT DELIVERED (2026-09-05),
    #: OpenRouter lane only, absent everywhere else and on every historical
    #: row. A SUMMARY over the turn — `models`, `providers`, `requests`,
    #: `first_id`, `first_request_id`, `mixed`, `truncated` — never a single
    #: value chosen as the answer. ⚠ REPORTED, NOT SERVED: on a gateway lane
    #: the reported model is routinely an echo of the id that was REQUESTED,
    #: so this says what the CLI put on the message and nothing about which
    #: machine answered. See `supervisor._note_reported`.
    reported: NotRequired[dict[str, Any]]
    #: audit C-2: did the `modelUsage` lookup key the cost path uses — the id
    #: ORGTREE asked for — match a key the CLI actually wrote? `asked`,
    #: `matched`, and up to four of the CLI's own keys. It records a miss
    #: that was previously indistinguishable from a hit; it does not change
    #: what is charged, and the keys are not read as a served model.
    model_usage_key: NotRequired[dict[str, Any]]


class FrozenInfo(TypedDict, total=False):
    """№41 freeze marker. Kinds are commutative — `error` and `spend_error`
    coexist without overwriting each other. Kind FLAGS (e.g. `spend`) are
    `True` when that freeze kind is active (Org.__init__ retags pre-№41
    spend freezes; supervisor.hard_freeze writes them)."""
    at: str
    until: str | None
    until_ts: float | None
    error: str | None
    # connection kind only: a copy of the node's `net_fail_since_ms` at freeze
    # time. `resume_frozen` lists the operation receipts this seat filed at or
    # after it inside the retry banner (Phase 2 of w71d69aac).
    receipts_since_ms: int
    # connection kind only: the retry banner's OWN parts — {index, head,
    # payload} — so resume can recompose it with the receipt list without
    # parsing the replay text (the payload is the agent's message and may
    # contain any marker). `index` is the position in `resume_texts`.
    retry: dict[str, Any]
    # `limit` is the usage-limit kind flag, and it exists to be a POSITIVE
    # marker. The pre-№41 retag in Org.__init__ matches on shape — error, no
    # until, no resume_texts, no kind flag True — and a genuine usage-limit
    # freeze hits that shape exactly whenever the reset time is unparseable AND
    # no replay text was kept (a /command turn, or an unconfirmed batch). It
    # was then rewritten as a SPEND freeze, which resume_frozen skips forever:
    # ▶ resume silently did nothing and the agent could never be woken. Caught
    # live 2026-08-04 by the turn-lifecycle suite. Setting this flag takes the
    # retag's `not any(v is True …)` guard out of the picture by construction.
    limit: bool
    # Non-secret serving namespace captured by the failed turn.  These fields
    # keep automatic probes scoped to one provider account and resource pool;
    # old records omit them and are grouped conservatively as unknown.
    provider: str
    account: str
    resource_pool: str
    # `observed-deadline` is the latest observed active constraint, not a
    # promise of capacity. `probe` is explicitly only a time to re-check.
    schedule_kind: str
    # where `until_ts` came from (user ruling 2026-08-18): "text" (parsed out
    # of the CLI's error prose), "usage:<lane>" (looked up in the account's
    # own usage readout — see limits.reset_for), "probe" (nothing could
    # answer, so it carries the blind 5-minute floor), "capped" (an untrusted
    # run was cut off and `until_ts` deliberately REMOVED — there is no number
    # left for a provenance to describe), or "inherited" (a re-freeze kept the
    # previous record's still-plausible horizon; the provenance of THAT number
    # belonged to the earlier freeze, so this one does not claim it), or
    # "provider" (D-209 — a NON-claude lane handed us a machine reset out of
    # band: the codex app-server's `account/rateLimits/updated` carries a
    # `resetsAt` on the exhausted window, and it is exact where that lane's
    # error prose usually names a date no reset parser here can read).
    # Diagnostic: a freeze that opened an api_fallback window records what the
    # window was priced on. ⚠ On an `untrusted` freeze it records where the
    # NUMBER came from and nothing more — no window was priced at all.
    reset_src: str
    # the transient/connection kind (user report 2026-08-06): a network drop
    # freezes with a short exponential until_ts; ▶/auto-resume own it like
    # `limit` (resume_frozen's owned-kinds exemption names both)
    connection: bool
    spend: bool
    spend_error: str | None
    # the limit was reported by NOBODY BUT THE AGENT (2026-08-18): the
    # clean-result gate promotes a short final answer that names a limit into
    # a freeze, and that text is the agent's own. Such a freeze still carries
    # a timestamp and still wakes — but it may not open an api_fallback
    # window (the org's key would bill for a wall that need not exist), and
    # after UNTRUSTED_LIMIT_RUNS consecutive ones the node waits for a person.
    # ⚠ read it beside `reset_src`: on an untrusted freeze that field says
    # where the NUMBER came from, not that the number priced anything.
    untrusted: bool
    # api_fallback (2026-08-17): this limit freeze was recorded while the
    # org's fallback window was already OPEN — i.e. the KEY lane hit a wall,
    # not the subscription. Readiness must not insta-wake it into the same
    # wall; it waits for its own until_ts like any limit freeze.
    # (⚠ exempted in supervisor._resumable's other-kind test, like the kinds.)
    on_fallback: bool
    # ── D-156, and note that BOTH are strings on purpose ──────────────────
    # WHY this freeze happened, when the answer is not "capacity ran out":
    # "auth" = the turn was rejected with a 401, so the record is a
    # usage-limit freeze in shape only. The auto-resume timer refuses it
    # (re-probing a rejected credential is D-149's routed-around shape on a
    # timer), and no api_fallback window opens for it (that one spends money).
    # ⚠ A STRING, NEVER `auth: True`. `supervisor._resumable` refuses a record
    # carrying any True key outside its allowlist, which would make ▶ skip the
    # node FOREVER — and ▶ is exactly what an operator needs after replacing
    # the credential. `untrusted` fell into that trap the day it was added.
    # "balance" = an OpenRouter 402 (2026-09-05): the gateway refused the
    # request against the key's credit — NOT proof the balance is exhausted,
    # so the timer probes it a bounded number of times (`balance_probe_run`,
    # NET_RETRY_MAX) and then parks it with `until_ts: None`; ▶ resumes it.
    cause: str
    # what `accounts.resolve` said about this tier AT FREEZE TIME: "dry"
    # (nowhere had capacity) or "open" (capacity was standing available and
    # this froze for another reason — the switch counter, or a resolver that
    # named the serving account back). ABSENT means the freeze never asked —
    # the 401 branch and the api-key/no-tier branch both skip the resolver.
    # Readiness may wake a node on "capacity has appeared" ONLY from "dry":
    # from "open" or absent, the capacity was already there when we froze, so
    # waking on it re-drives into the same wall every tick.
    pool: str
    # prompts to replay when the freeze lifts (supervisor queues them)
    resume_texts: list[str]
    # Human-visible projections paired positionally with ``resume_texts``.
    # The raw prompt is replayed to the provider; this copy is only what the
    # chat renderer may show.  Older records legitimately omit it.
    resume_views: list[str]


class OracleExchange(TypedDict):
    """One Q&A with a preserving-oracle bearer (supervisor logs on the node)."""
    q: str
    a: str
    at: str


class InflightInfo(TypedDict):
    """The turn currently running (supervisor): prompt tail + start stamp."""
    at: str
    text: str
    # Structured human projection of ``text``.  Machine-added context is
    # deliberately absent; raw replay text remains untouched above.
    view: NotRequired[str]
    cmd: NotRequired[bool]
    # The secret-free prefix/namespace record of the request this turn was
    # launched with (`supervisor._cache_persistable`, the same shape as the
    # continuity book's `last_turn`). It rides THIS marker so it lives exactly
    # as long as the turn: every turn exit and the startup reconcile pop the
    # marker, and the mid-turn cache projection compares against it (D-235).
    cache_attempt: NotRequired[dict[str, Any]]


class NodeDoc(TypedDict):
    """One agent seat. Created by Org._new_node (hire); the NotRequired tail
    is runtime bookkeeping the supervisor adds as turns happen."""
    session_id: str
    model: str                      # tier key into OrgDoc["tiers"]
    parent: str | None              # None = top level (§7.4: the user is root)
    # WHOLE in every saved doc and in everything the user or an agent asks
    # for. Typed float because `switch_model`'s melt lands a SEAT DIFFERENCE
    # here, and seats are fractional below $1/M (ledger.TIERS, 2026-09-03).
    grant: float
    state: NodeState
    title: str
    charter: str | None
    created: str
    archived_at: str | None
    # FR-22: set by rescind() — archived AND the superior's grant clawed
    # back; the marker makes a second rescind a no-op instead of a
    # double-subtraction
    rescinded_at: NotRequired[str]
    pid: int | None
    ui_order: float
    scope: NodeScope
    # external response handles (panel hires — e.g. the in-game Prompt Wizard,
    # 2026-08-20): outward @mcp:<peer> addresses THIS node may post_mail
    # directly, at any depth, without the org-inbox audience. Each send is
    # scoped to exactly these addresses and attributed by=node in the
    # org_inbox row; the grant rides the seat (survives retire/rehire).
    external_handles: NotRequired[list[str]]
    # §8 lineage axis — second axis, never an org edge. FR-24's cheap-compact
    # replacement uses the same pair: `predecessor` on the replacement points
    # at the archived original (whose scratch the supervisor grants read-only
    # each turn, transcript copy included), and f327b39 sets the `successor`
    # backlink + bearer_state so rehire recognises it as the replacement's
    # own consultable bearer — a lineage generation, not a retired sibling
    lineage: str
    generation: int
    predecessor: str | None
    successor: str | None
    bearer_state: BearerState
    # ---- runtime bookkeeping (supervisor / api) ----
    # (NB: `effort` lives in NodeScope, not here — sc["effort"].)
    team_charter: NotRequired[str | None]
    cost_usd: NotRequired[float]
    # At least one future turn booked a numeric estimate with unresolved used
    # price components. The numeric lifetime total remains API-compatible.
    cost_usd_unknown: NotRequired[bool]
    # Latest observed backwards move in Codex's thread-cumulative token
    # counter. The adapter books the new snapshot whole and records the old
    # and new values here instead of silently clamping a negative delta.
    codex_usage_reset: NotRequired[dict[str, Any]]
    # Last raw thread-cumulative Codex token snapshot. It baselines the next
    # resumed turn; a new provider thread ignores it and establishes its own.
    codex_usage_total: NotRequired[dict[str, Any]]
    # None = explicitly unknown (no session record has ever measured it)
    occupancy: NotRequired[int | None]
    # …and this says the figure above was ESTIMATED, not measured: a compaction
    # rewrites occupancy at once (user bug 2026-08-20 — it used to keep
    # reporting the pre-compaction fill until the next turn), but the true
    # post-compaction size is not knowable until a turn assembles the prompt.
    # Dropped by the first turn that measures one.
    occupancy_est: NotRequired[bool]
    # a §8 split landed and the successor has not run since, so its session
    # holds only the summary — the compact button and its endpoints refuse on
    # THIS rather than on the estimate flag above, because the refusal guards a
    # billed CLI fork and must not depend on how a number was arrived at
    compacted_unrun: NotRequired[bool]
    context_window: NotRequired[int]
    last_status: NotRequired[dict[str, Any] | None]
    prev_status: NotRequired[dict[str, Any] | None]
    # Last successful disposable request made only to extend this session's
    # Claude prompt-cache lifetime while the agent reported `working`.
    # Separate from `turns`: this request is billed, but is not agent work.
    cache_keepalive_at: NotRequired[str]
    # Generation-owned private evidence plus a credential-free `public`
    # projection for the next-turn cache-continuity forecast.
    cache_continuity: NotRequired[dict[str, Any]]
    # Latest durable wake/status/checkup-reservation boundary while the node
    # reports `working`. It is the restart-safe 20-minute checkup clock and
    # failed-wake cooldown; cleared when status leaves working.
    working_activity_at: NotRequired[str]
    # Runtime-observed MCP tool count captured at the last authoritative,
    # successful turn boundary.  Current live inventory is generation-owned
    # in supervisor state and never persisted here.
    last_turn_mcp_tool_count: NotRequired[int]
    # Canonical runtime MCP identities and the effective launch-surface digest
    # for that same successful boundary. The digest contains no raw config.
    last_turn_mcp_tools: NotRequired[list[str]]
    last_turn_mcp_fingerprint: NotRequired[str]
    inflight: NotRequired[InflightInfo | None]
    pending_switch: NotRequired[dict[str, Any] | None]   # D-234 {tier, from, by, at, crossing}
    last_denials: NotRequired[list[Denial]]
    #: codex lane (2026-09-05): the escalations `_approve` APPROVED on the
    #: node's last turn — same row shape and same cap as `last_denials`, and
    #: scrubbed the same way on the tree. Approved, not "ran": see TurnStat.
    last_approvals: NotRequired[list[Denial]]
    turns: NotRequired[list[TurnStat]]
    frozen: NotRequired[FrozenInfo | None]
    remote_controlled: NotRequired[dict[str, Any] | None]  # FR-01 {at, pid} — the node is parked while the user drives its session directly
    limit_locked: NotRequired[bool]
    oracle_exchanges: NotRequired[list[OracleExchange]]
    # CLI-side compact boundaries seen in this node's session JSONL (1b,
    # 2026-08-06): absent = never observed (the first observation baselines
    # WITHOUT minting); each later increment mints a lost-generation record
    # None means "re-baseline me": the session id was just reassigned, so the
    # count belongs to a file this node no longer owns (compact_split's fork
    # already carries its own /compact boundary; cheap_compact and reseed mint
    # an empty session). _after_turn re-reads the true count WITHOUT minting.
    cli_compactions: NotRequired[int | None]
    # the line offset of the boundary a LOST row was minted against, so a
    # later recovery reads its cut point instead of re-deriving it — deriving
    # it is only sound while every boundary still has its row (2026-08-20)
    cli_boundary_offset: NotRequired[int]
    # WHY a row is bearer_state="lost", because the two reasons want opposite
    # treatment and the row alone cannot be told apart. "cli_compaction": the
    # CLI compacted in place and the pre-compaction records may still be above
    # a boundary in a session somebody else holds — recoverable. "reseed": the
    # session was declared unrecoverable and a fresh one minted, so the row has
    # no boundary of its own at all, and any cut point inferred for it is
    # another generation's (redteam 2026-08-20). Absent on rows minted before
    # this, which is why the inference branch also refuses on shape.
    lost_reason: NotRequired[str]
    # consecutive network-classified turn failures (user report 2026-08-06);
    # reset by any completed turn, capped at NET_RETRY_MAX then manual
    net_fail_run: NotRequired[int]
    # when the FIRST attempt of the current network-failure run began (ms,
    # this process's wall clock, stamped at `_run_one_turn` entry). Kept across
    # the run's later attempts and popped with `net_fail_run`. It is the lower
    # bound the retry banner filters operation receipts by — never `frozen.at`,
    # which is when the turn DIED (Phase 2 of w71d69aac).
    net_fail_since_ms: NotRequired[int]
    # consecutive TERMINAL turn failures — the ones nothing retries: a turn
    # killed by the watchdog or the budget, a CLI that died before the model
    # spoke, an exit carrying a real error. Cleared by any completed turn,
    # like net_fail_run. ⚠ ONE counter across BOTH doors deliberately: a node
    # flapping between causes must announce ONCE, not once per kind.
    hard_fail_run: NotRequired[int]
    # consecutive limit freezes whose only evidence was the agent's own final
    # answer (see FrozenInfo.untrusted). Cleared by any completed turn, like
    # net_fail_run — the count is CONSECUTIVE, and it is what stops a node
    # that keeps answering "usage limit reached" from waking itself forever.
    untrusted_limit_run: NotRequired[int]
    # cheap-compact marker (user feature 2026-08-17; narrowed by D-201/S1,
    # coordinator-ruled 2026-08-30): the CURRENT session was minted by
    # cheap_compact — it started EMPTY (no CLI summary), so the supervisor
    # splices breadcrumbs.md into the identity prompt FOR THE SUCCESSOR'S
    # FIRST TURN. The first SUCCESSFUL turn retires it durably (claude lane:
    # at the result boundary, before the queue-feed decision; provider
    # lanes: in _after_turn) — after that the content is in the conversation
    # history, and re-splicing a file the agent appends every turn re-dirtied
    # the prompt per turn (S1 in the D-201 audit). A FAILED first turn
    # retains it. A normal compaction (whose successor carries its own
    # summary) clears it as before.
    cheap_compacted: NotRequired[bool]
    # user bug 2026-08-18: the CURRENT session id was MINTED (cheap_compact,
    # reseed) and has never been handed to the CLI — so no transcript for it
    # exists yet, and that is normal, not damage. №31's startup reconcile
    # condemns a live node whose transcript is missing, judging "has it ever
    # run" by the node-lifetime `cost_usd`; a minted session inherits that
    # cost while owning none of the history, so cheap-compacting an agent and
    # closing orgtree before messaging it marked the agent UNRECOVERABLE (it
    # then refuses mail — the seat needs a re-seed to come back). This marker
    # makes the "has it run" question SESSION-scoped. Cleared by the first
    # completed turn, and self-healed by reconcile the moment a transcript
    # for the session id does exist.
    session_unrun: NotRequired[bool]
    # ⭐ the user-override record (ruling 2026-08-06): Org.unstick moves the
    # released freeze here {by, at, was} — evidence, never erasure
    unstuck: NotRequired[dict[str, Any]]


class AudienceGrant(TypedDict):
    """§7.3 — a standing speak-directly grant. `delegated_by` marks a
    DELEGATED grant (an agent opened someone else's ear); the sweep anchors
    such a grant on the delegator, not the grantor."""
    grantee: str
    grantor: str
    granted_at: str
    reason: str
    delegated_by: NotRequired[str]


class NoticeEntry(TypedDict):
    """One queued org-change notice in OrgDoc["notices"][<node>] — delivered
    at the node's next turn boundary (Org._notify)."""
    at: str
    text: str
    # Canonical typed event (events.py); absent on a legacy notice — see MailEntry.ev
    ev: NotRequired[dict[str, Any]]


class NoticeLogEntry(TypedDict):
    """One row of the org-wide notice audit trail (capped at 800)."""
    node: str
    at: str
    text: str
    # Canonical typed event (events.py); absent on a legacy notice — see MailEntry.ev
    ev: NotRequired[dict[str, Any]]


# One entry of the user's inbox (OrgDoc["user_inbox"]). Functional form:
# "from" is a keyword. `id` is NotRequired because one writer
# (audience_forward) omits it — Org.__init__ backfills ids on next load.
UserMailEntry = TypedDict("UserMailEntry", {
    "id": NotRequired[str],
    "from": str,
    "kind": str,
    "body": str,
    "at": str,
    # FR-21: download-card metas [{name, path, bytes}], path relative to the
    # SENDER's scratch (its outbox/ — _agent_send_file's card shape); the
    # inbox renders them with fileUrl keyed on `from`
    "attachments": NotRequired[list[dict[str, Any]]],
    # D-171: what the sender named and could not send. On THIS entry it is a
    # record only — the inbox UI renders `attachments` and not this — because
    # the sending AGENT is told via post_mail's `warnings`, and on this path
    # a bad path is already refused outright by _agent_send_file, so the only
    # cause that reaches here is the sender's own overflow.
    "attachments_missing": NotRequired[list[str]],
    # D-169: the sender asked for the user's attention NOW. Absent on
    # ordinary mail — presence is what the pulse, the count and the row
    # styling all key on, and it stops mattering the moment the entry leaves
    # `user_inbox` for `user_mail_log` (which is what "read" means here).
    "urgent": NotRequired[bool],
    # …and WHY, in one line, written for the USER to read. Required whenever
    # `urgent` is set — post_mail refuses the pair otherwise, so the two are
    # written together or not at all. It is displayed, not logged: an
    # unshown reason would be a pure tax on the sender, while a shown one
    # makes the claim accountable to the person it interrupted.
    "urgent_reason": NotRequired[str],
    # Canonical typed message (events.py, design typed-message-architecture-backend.md v5):
    # the discriminated union {v, variant, actor, object, engine_authored, ...fields}.
    # ABSENT on a legacy row — such a row is rendered as ordinary text in full and is
    # never classified. Stored via events.encode_row_ev (ordinary/reply bodies elided on
    # the row, restored by decode_row_ev). Unknown/malformed values are kept and reported
    # by events.decode as unsupported/malformed; never raised on load.
    "ev": NotRequired[dict[str, Any]],
})


# One queued message in OrgDoc["mail"][<node>] (№11/№17: durable pending copy,
# retractable by id until delivery). Functional form: "from" is a keyword.
MailEntry = TypedDict("MailEntry", {
    "id": str,
    "from": str,
    # message|question|request|decision|status — or "notice"
    # (orgtree_send_notice): minted ONLY by that tool, the single marker the
    # whole feature keys on (envelope styling, no-wake drives: Org.waking_mail)
    "kind": str,
    "body": str,
    "at": str,
    "relationship": NotRequired[Optional[str]],
    "attachments": NotRequired[list[dict[str, Any]]],
    # D-171: attachments the sender NAMED that never became files — an
    # unresolved path, or one past ATTACHMENT_MAX. Sanitised display strings,
    # NOT metas, and deliberately a SEPARATE key: `attachments` above is what
    # the chat renders as download cards and images, so a placeholder in that
    # list would put a dead card in the user's own chat. _mail_block prints
    # one [ATTACHMENT NOT DELIVERED] line per entry.
    "attachments_missing": NotRequired[list[str]],
    "delivering": NotRequired[bool],
    "retracted": NotRequired[bool],   # api node_mail_retract tombstones in place
    # Internal context delivered to the model but intentionally absent from
    # the human chat projection (automatic checkups and future lifecycle
    # plumbing).  Genuine mail never sets this flag.
    "model_only": NotRequired[bool],
    "net_id": NotRequired[str],       # F-06: hub message id — _confirm_delivered
                                      # turns it into a READ receipt
    "reply_to": NotRequired[dict[str, Any]],  # FR-05: SNAPSHOT of the mail
                                      # this replies to ({id, from, at, gist}
                                      # captured at send — quoted by
                                      # _mail_block; no lookup needed)
    # Canonical typed message (events.py, design typed-message-architecture-backend.md v5):
    # the discriminated union {v, variant, actor, object, engine_authored, ...fields}.
    # ABSENT on a legacy row — such a row is rendered as ordinary text in full and is
    # never classified. Stored via events.encode_row_ev (ordinary/reply bodies elided on
    # the row, restored by decode_row_ev). Unknown/malformed values are kept and reported
    # by events.decode as unsupported/malformed; never raised on load.
    "ev": NotRequired[dict[str, Any]],
})


class OrgInboxEntry(TypedDict):
    """The inter-org bridge log (capped at 200): one inbound or outbound
    message on the org's single outside face."""
    id: str
    dir: Literal["in", "out"]
    peer: str
    body: str
    at: str
    by: NotRequired[str]     # internal attribution — outbound speaks as the org
    # held-handle send (external_handles): the sender spoke to ITS OWN outside
    # channel, not for the org — _extern_scan exposes `by` to the peer for
    # exactly these rows and no others
    attributed: NotRequired[bool]
    # ---- F-06 @net: delivery states (outbound rows only) ----
    state: NotRequired[str]         # queued → sent (hub custody = "received")
                                    # → delivered (peer org inbox) → read
                                    # (a peer agent's turn consumed it)
    state_at: NotRequired[str]
    net_id: NotRequired[str]        # hub message id — the state-update lookup
                                    # key (tolerant of 200-cap-trimmed rows)
    attachments: NotRequired[list[dict[str, Any]]]   # [{name, bytes}] display


class WorkActor(TypedDict):
    """Who did something to a work item: a node AT A GENERATION. A compaction
    or rehire bumps the generation, so the record keeps naming the process
    that acted even after the seat is a different session. The user is the
    literal string "user" wherever a WorkActor is accepted."""
    node: str
    generation: int


class WorkStage(TypedDict, total=False):
    """One delivery stage of a work item (docs/work-items.md). A CLAIM is
    written by an agent/user: claimed_*, ref. VERIFICATION fields are written
    ONLY by the backend from `workitems.evaluate` — a caller supplying any of
    them is refused, not silently overwritten. `implemented` and `deployed`
    are claim-only stages and keep method "self-report"."""
    claimed_at: str
    claimed_by: WorkActor | str
    ref: str | None                 # sha for committed/pushed/in_build; a note/log path otherwise
    note: str | None
    verified: bool | None           # True/False only when git answered; None = unknown, with detail
    method: str                     # self-report | unverified | object-exists | tracking-ref-ancestry | boot-ancestry
    detail: str
    resolved_oid: str | None        # the exact commit the sha resolved to in REPO_ROOT
    target: str                     # identity compared against: tracking-ref OID or "<boot>[+dirty]"
    ref_as_of: str
    fetched_at: None                # never derived — git keeps no fetch time
    observed_at: str


class WorkAcceptance(TypedDict):
    text: str
    checked: dict[str, Any] | None  # {at, by, evidence_ref, note} — acceptance evidence, distinct from delivery


class WorkItem(TypedDict):
    """A durable unit of work in the org document (`OrgDoc.work_items`,
    archived ones in `OrgDoc.work_items_archive`). Survives retirement,
    compaction and reassignment because nothing about it lives on a node.
    Bodies are user/agent content and may contain secrets: served only on
    the user route and to agents with read right; never in prompt blocks."""
    # THE ONLY KEY, and it is readable (user 2026-09-05: "uniquely and solely
    # identifiable by their readable slugs, no more ids of any sort"). Derived
    # from the title, unique across active+archive, assigned ONCE and never
    # re-derived from a later title edit — a name already written down in mail
    # must not start pointing at nothing. Every stored reference uses it:
    # `dependencies`, `superseded_by`, ask `work_item`. The retired `w########`
    # key is gone; `Org.work_identity_migrate` converts an old document once,
    # and `OrgDoc["work_identity"]` records that it has been converted.
    slug: str
    rev: int                        # bumped by every mutation; verify revalidates against it
    kind: str                       # "code" | "non-code" (non-code: delivery is None)
    title: str
    objective: str                  # the DESCRIPTION: problem faced first, then proposed solution (mandatory)
    status: str                     # backlogged | open | in_progress | blocked | waiting | review | done | superseded | dropped
    # state information, one field per state that owes it (user 2026-09-05).
    # Required on entry to that state, cleared on the way out.
    blocked_reason: NotRequired[str | None]   # what blocks, what would unblock, who can act
    waiting_reason: NotRequired[str | None]   # the external event, and how the agent hears of it
    dropped_reason: NotRequired[str | None]   # why the work ended: cancelled, or failed unrecoverably
    owner: WorkActor | None         # identity + generation at assignment
    participants: list[str]         # collaborator node ids: read + status update + evidence + attach a question
    created_by: WorkActor | str
    at: str
    updated_at: str                 # ANY mutation (never the row's age — see docket_at)
    # ---- the docket status (docket-final-spec.md): the latest two lists, who
    # wrote them and when. `docket_at` is the clock the UI row and the
    # one-hour auto-archive run on; a question attachment, a user dismissal or
    # a delivery claim moves `updated_at` but NOT this.
    done_so_far: list[str]
    working_on_next: list[str]
    docket_at: str | None
    # WHEN THE STATUS VALUE LAST CHANGED — the third clock, and the only one
    # that answers "what has actually MOVED?". Absent on items written before
    # the field existed; those derive it from retained history and fall back
    # to `at`, never to a clock that moves for edits (see _work_status_at).
    status_at: NotRequired[str | None]
    last_updater: WorkActor | None  # author of the latest STATUS UPDATE — history, not the reply recipient
    # THE NAMED REVIEWER (user ruling 2026-09-05 21:23), set on the update that
    # puts the item at `review` and readable as the agent answerable for the
    # CHECK. It is not ownership: the owner keeps the work, and a reviewer gets
    # read, evidence and one decision. ⚠ NotRequired AND nullable, in that
    # order: items that were already at `review` when this shipped are NOT
    # back-filled, so absent and null both mean "nobody was named" and neither
    # may be invented into a name nobody chose.
    reviewer: NotRequired[WorkActor | None]
    manual_attention: dict[str, Any] | None   # {reason, at, by, set_rev} — set_rev is the dismiss CAS stamp
    manual_attention_rev: int       # monotonic; every (re)set of the flag mints the next set_rev
    dismissals: list[dict[str, Any]]          # {at, by: "user", set_rev, reason} — every user dismissal, kept
    archived_at: str | None         # instant of the physical move into work_items_archive
    acceptance: list[WorkAcceptance]
    dependencies: list[str]         # work item NAMES in this org (active or archived)
    # SUB-ITEMS (user 2026-09-05): the parent's NAME, or absent/None at the
    # top. A tree, not a graph — one parent, cycles refused on write. A child
    # is an independent item: its own owner, status, name and authority.
    # Nesting says how work is ORGANISED; it is not a permission edge and not
    # a lifecycle edge.
    parent: NotRequired[str | None]
    evidence: list[dict[str, Any]]  # {at, by, kind: note|link|file|commit|log, ref, note?} — cap by refusal, never truncated
    delivery: dict[str, WorkStage | None] | None   # keys = workitems.STAGES
    accepted: dict[str, Any] | None  # {at, by, note} — set only by work_accept (user or an ancestor of the owner)
    history: list[dict[str, Any]]   # {at, by, field, from, to}; oldest fold into ONE {kind: "folded", ...} row past the cap
    superseded_by: str | None


class KioskCfg(TypedDict, total=False):
    """Kiosk is a TYPE (user ruling): limits bind whether or not the public
    URL is enabled — `enabled` only gates the token gateway."""
    enabled: bool
    token: str
    credits: int
    spend_limit: float
    storage_limit_mb: int
    sandbox: bool
    sandbox_secret: str
    api_key: str                        # per-kiosk key (creation form / dashboard)
    auto_raise: bool
    max_scope: dict[str, Any] | None    # the permission ceiling (ceiling spec)


class OrgDoc(TypedDict):
    """The whole persisted document — Org.d. Org.create() writes the required
    keys; everything later code `setdefault`s is NotRequired."""
    version: int
    slug: str
    name: str
    created: str
    # seat cost per tier. Fractional below $1/M (ledger.TIERS, user ruling
    # 2026-09-03); every tier at or above $1 stays the whole number it was.
    tiers: dict[str, float]
    models: dict[str, str]
    workspace: str | None
    dirs: list[DirGrant]
    permission_mode: str
    default_tools: ToolGrant
    default_visibility: str
    # org-wide effort fallback for nodes with no scope effort ("" = CLI
    # default, no flag) — resolved LIVE in supervisor._build_cmd
    default_effort: NotRequired[str]
    max_top_grant: int
    default_top_grant: int
    credit_requests: list[dict[str, Any]]
    compact_at: float
    fable_limit_policy: str
    fable_filter_policy: str
    fable_filter_model: NotRequired[str | None]
    nodes: dict[str, NodeDoc]
    audiences: list[AudienceGrant]
    audience_requests: list[dict[str, Any]]
    events: list[dict[str, Any]]
    # ---- setdefault'd / optional org state ----
    cascade_hire: NotRequired[bool]         # §4.6 cost-bubbling toggles
    cascade_alloc: NotRequired[bool]
    max_depth: NotRequired[int]             # №34 runaway insurance (read w/ defaults)
    max_children: NotRequired[int]
    mail: NotRequired[dict[str, list[MailEntry]]]
    mail_log: NotRequired[dict[str, list[MailEntry]]]   # full-body archive, cap 100/node
    user_inbox: NotRequired[list[UserMailEntry]]
    user_outbox: NotRequired[list[dict[str, Any]]]      # MailEntry + "to" (user's Sent)
    user_mail_log: NotRequired[list[UserMailEntry]]     # api: dismissed-inbox archive
    notices: NotRequired[dict[str, list[NoticeEntry]]]
    notice_log: NotRequired[list[NoticeLogEntry]]
    delivering: NotRequired[dict[str, list[dict[str, Any]]]]  # supervisor in-flight mail batches
    steered_log: NotRequired[dict[str, list[dict[str, Any]]]]  # per-NODE steer history, org-keyed
    turn_error_log: NotRequired[dict[str, list[dict[str, Any]]]]  # per-NODE turn failures {at, text, ran_as?} — the durable half of last_error
    # (`account_token_uuid` — the per-org account selection — lived here
    # until 2026-08-25. Account routing is machine-local and per model tier
    # now (accounts.py); Org.__init__ pops the stale key from old docs.)
    asks: NotRequired[list[dict[str, Any]]]  # F-04 questions-to-the-user {id, node, kind, question, options?, multi?, questions?, at, status, reason?, answer?, resolved_at?}
    # FR-13: pending permission-scope requests {id, node, items: [{kind:
    # dir|tool|mcp|permission_mode, ...}], reason, at, rev, status} — one
    # pending entry per node (items merge by identity); a tab family of the
    # FR-14 batch beside asks + credit_requests
    scope_requests: NotRequired[list[dict[str, Any]]]
    # Cache-protective cheap compaction: {enabled: bool, occ: float 0..1}.
    # The only numeric operator value is minimum measured context occupancy;
    # provider/auth TTL is derived from positive inference receipts.
    auto_cheap_compact: NotRequired[dict[str, Any]]
    # FR-18: watchdogs — persistent pets {id, owner, name, kind:
    # file|command|process|stream, target, pattern?, interval_s, state:
    # armed|paused|exited, high_water?, fired, last_check?, last_fired?,
    # events: [{at, gist}], exit?}. Free by ruling; engine =
    # supervisor.start_watchdog_engine
    watchdogs: NotRequired[list[dict[str, Any]]]
    documents: NotRequired[list[dict[str, Any]]]  # FR-03 presented documents {id, node, title, body, at} — newest 10/node, 100/org
    # Durable work items — the docket (docs/work-items.md). Both are `doc`
    # blobs under SQLite and plain keys under JSON — no DDL, no migration
    # marker; an old document without them reads as an empty docket. The
    # active list is capped by REFUSING creation (Org.WORK_ACTIVE_MAX); the
    # archive is unbounded and written only by the archive sweep (done items
    # whose docket update is over an hour old) or an explicit archive action.
    # Nothing in either list is deleted automatically.
    work_items: NotRequired[list[WorkItem]]
    work_items_archive: NotRequired[list[WorkItem]]
    # "slug" once this document's items are keyed by their readable name. Its
    # ABSENCE is what marks a document as still needing the one-shot identity
    # migration, so it is written exactly once, in the same save.
    work_identity: NotRequired[str]
    # Durable operation receipts (opreceipts.py, docs/op-receipts.md). One row
    # per mutating agent call that carried an `op_key` and whose document
    # transaction committed — appended inside that same transaction, so the
    # receipt and the effect commit together or neither does. An APPEND-ONLY
    # log section (store.LIST_LOGS): lazily materialised, so a call without a
    # key never pays for it. Rows carry a full fingerprint and identity-shaped
    # arguments only — never a body, a charter or a kickoff.
    op_receipts: NotRequired[list[dict[str, Any]]]
    # {schema, coverage, bootstrap_ms, from_ms, horizon_ms, ceiling, trim_to,
    # evicted}. `from_ms` is the WATERMARK: a key minted at or after it with
    # no receipt was never applied, and it only ever increases. Eager (small)
    # on purpose — the admission path reads it before deciding whether the
    # log is worth materialising.
    op_receipts_meta: NotRequired[dict[str, Any]]
    org_inbox: NotRequired[list[OrgInboxEntry]]
    org_inbox_read: NotRequired[int]
    kiosk: NotRequired[KioskCfg | None]
    sandbox: NotRequired[dict[str, Any]]    # api: {enabled, secret, limit_mb?}
    # Frozen per-org bridge credential rotation state. Both are non-secret;
    # the host-only signing key is a separate install file.
    bridge_credential_generation: NotRequired[int]
    bridge_credential_rotated_at: NotRequired[str]
    sandbox_vols_base: NotRequired[int]     # HISTORICAL (pre-disk legacy
                                            # enforcement, retired D-063) —
                                            # system-volume image seed (bytes);
                                            # storage accounting charges growth only
    fable_lock: NotRequired[dict[str, Any] | None]
    spend_frozen: NotRequired[bool]
    storage_frozen: NotRequired[bool]   # HISTORICAL (pre-disk legacy breach) —
                                        # never set since D-063; cleared at
                                        # disk migration
    storage_blocked: NotRequired[bool]  # ACL block (legacy) / turn pause (disk ≥90%)
    storage_full: NotRequired[bool]     # disk ≥99% — the persistent UI alert state
    disk: NotRequired[dict[str, Any]]   # {size_mb, migrated_at,
                                        #  pending_size_mb?} — org rides its
                                        # virtual disk (sandbox.migrate_to_disk);
                                        # pending = staged shrink, applied when
                                        # the org's container is next down
    storage_warned: NotRequired[bool]
    auto_resume: NotRequired[bool]
    auto_resume_last: NotRequired[float]
    # user option 2026-08-17: cheap-compact a limit-frozen node right before
    # the auto-resume timer wakes it — the freeze outlived the cache TTL, so
    # the swap dodges the cold transcript reload (D-114's arithmetic).
    # Auto-path only; the manual ▶ resumes sessions as they are.
    auto_resume_compact: NotRequired[bool]
    # ---- @net: mail-hub client (F-06) — net.py owns these ----
    net_identity: NotRequired[dict[str, Any]]   # {secret, fingerprint, slug,
                                                # minted_at} — the SECRET lives
                                                # here and ONLY here; never in
                                                # tree payloads or agent context
    net_hubs: NotRequired[list[dict[str, Any]]]  # [{id, address, enabled,
                                                 #   name?}] — name discovered
                                                 # on connect, never typed
    net_autoconnect: NotRequired[bool]      # default True: local hub auto-joins
    net_state: NotRequired[dict[str, Any]]  # per HUB ID: {registered_at,
                                            #   last_ok, seen_ids ring}
    net_spool: NotRequired[dict[str, Any]]  # per HUB ID: [SpoolEntry] outbound
                                            # SpoolEntry = {id (32-hex hub msg
                                            # id, idempotency key), to (bare
                                            # net slug), body, kind, at, oid
                                            # (org_inbox row id), tries,
                                            # last_err?, attachments: [abs]}
    _migrations: NotRequired[dict[str, Any]]  # one-shot data-heal markers
                                              # (D-219): key = heal name,
                                              # value = {at, healed: [...]};
                                              # presence means "never again"
    headless: NotRequired[bool]             # §9.6: no user present; user-bound
                                            # asks auto-deny (requires api_key)
    api_key: NotRequired[str]               # §9.5: per-org ANTHROPIC_API_KEY
    # api-key FALLBACK (user feature 2026-08-17): with this ON the stored
    # api_key is a SPARE, not the lane — routine turns bill the subscription,
    # and only while a usage-limit freeze holds the subscription lane does
    # spawn_env / the bridge proxy switch to the key. The window closes at
    # the limit's own reset time; reverting is expiry alone (no writer).
    api_fallback: NotRequired[bool]
    api_fallback_until: NotRequired[float]  # epoch; window open while now < it
    api_fallback_since: NotRequired[float]  # when the current window opened
    # fable-tier weekly quota as a billing event too (user feature 2026-08-23):
    # off by default (D-130 still holds — that lane is fable_limit_policy's).
    # ON, and with api_fallback + api_key both already held, a TRUSTED
    # fable-tier hit opens the same api_fallback window a normal usage limit
    # does instead of invoking fable_limit_policy — no org-wide fable_lock,
    # no per-node limit_locked. Requires api_fallback; cleared with it.
    fable_api_fallback: NotRequired[bool]
    cred_warned_at: NotRequired[str]        # §9.2 watcher: last credential-
                                            # expiry warning (≤1/day survives
                                            # restarts — redteam finding)
    deleted_cost_usd: NotRequired[float]    # tombstone burn accumulator (cost_total)
    deleted_cost_usd_unknown: NotRequired[bool]
    api_cost_usd: NotRequired[float]        # lifetime burn billed to the key while
                                            # an api_fallback window was open — the
                                            # hover split on the UI cost card.
                                            # Org-level and monotonic: node deletion
                                            # never has to re-bank it.
    _actors_typed: NotRequired[bool]        # one-shot @-sentinel migration marker
    # ---- legacy keys old docs may still carry (popped/rewritten on load) ----
    default_dirs: NotRequired[list[Any]]    # superseded by `dirs` with modes
