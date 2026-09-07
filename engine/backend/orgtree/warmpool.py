"""D-201: the warm CLI process pool.

Orgtree historically started a brand-new CLI process for every single turn,
which made everything an interactive harness reads once at startup — the MCP
handshake, the system prompt, the working-directory scan — into something
re-read and re-sent per turn. Measured cost (cache-misses' audit, 2026-08-30):
agents cold on 44.3% of quiet turns vs 0.2% interactive, ~200k tokens re-sent
per cold resume.

This module keeps ONE parked CLI process per eligible live agent, spawned at
boot and on hire, and hands it to `_run_one_turn` when a turn arrives. It owns
both Claude's stream-json process and Codex's app-server process; Antigravity stays
excluded pending its unresolved persistent-session probe. The rules are the
user's, verbatim where it matters:

  · processes only end on RETIREMENT, an explicit SYSTEM-PROMPT CHANGE, or
    orgtree SHUTDOWN (the job-object leash covers shutdown). No idle reaping,
    no cap eviction, no tidiness. Anything else killing a parked process is a
    defect.
  · a prompt change respawns the process IMMEDIATELY, in the background —
    never "mark dirty and fix it when a turn comes". The one exception: an
    agent MID-TURN is never disturbed; its re-warm happens at turn end.
  · CLAUDE adds no explicit MCP-handshake barrier (user ruling 2026-08-30).
    The CLI's `alwaysLoad` setting can nevertheless hold a cold or too-young
    process's turn-1 prompt for its connection timeout; the production audit
    measured that wait and the retain/revert policy is still open.
  · CODEX prewarming is FULL (user-authorized change, 2026-09-01): a parked
    app-server completes its bounded idempotent `initialize()` handshake and
    obtains its MCP inventory/readiness (ready, or explicitly degraded)
    BEFORE the seat is marked warm — asynchronously, after parking, so the
    keeper never blocks and a racing first claim still reuses the exact PID
    exactly as before. Prewarm sends NO thread/start, NO thread/resume, NO
    developer instructions and NO turn/start; it is local process readiness,
    never a provider call, and provider cache/session evidence is untouched.
    A failed or timed-out initialize kills and reaps that generation
    (`prewarm-failed`) and the seat falls back to spawn-per-turn.

THE WARM PROCESS IS A CACHE, NEVER THE SOURCE OF TRUTH. Every caller falls
back to today's spawn-per-turn when the pool has nothing valid, and the agent
notices nothing. Correctness over speed: a process whose rendered identity
hash no longer matches is killed, not served — a stale system prompt would
mean a retool or grant silently not applying.

INVALIDATION IS A HASH, NOT AN EVENT LIST (coordinator ruling). We hash each
provider's exact process-scoped inputs: rendered identity, native startup
instructions where applicable, spawn argv (including launch-scoped MCP
configuration), credential identity and explicit environment. An enumerated
list of invalidating events is exactly what goes stale when someone adds a
surface; the audit found surfaces nobody had enumerated.

KILL SWITCH (cache-misses' A/B requirement): ORGTREE_WARM env sets the
default — which is ON (user ruling 2026-08-30). The file
<ORGTREE_DATA>/warm.flag overrides the env AT RUNTIME without a rebuild —
write "0"/"1", or JSON {"enabled": bool, "exclude": ["slug/nid"]} for
per-agent arms; the D-203 settings toggle writes the same file through
set_enabled(). Checked cheaply (mtime cache) on every decision.

TELEMETRY: append-only JSONL at <ORGTREE_DATA>/journals/warm.jsonl, in the
exact shape cache-misses registered (admit / proc / pool / cache-break lines).
Deliberately NOT in the org document (DOC_LOCK contention) and NOT in scratch
or transcripts (which would dirty the very prompts being measured).
"""
from __future__ import annotations

import collections
import hashlib
import json
import os
import queue
import re
import subprocess
import threading
import time
from typing import Any, Iterator

from . import store

# ── knobs ──────────────────────────────────────────────────────────────────
# how often the keeper re-checks every live agent's hash even with no poke.
# File-borne surfaces (a granted or native CLAUDE.md edited, the MCP registry
# changed) never call store.save_org, so polling is what catches them;
# org-borne changes arrive faster via the save-hook poke.
WARM_POLL = float(os.environ.get("ORGTREE_WARM_POLL", "20"))
# cascade pacing: one team_charter edit can dirty a whole subtree at once, and
# this machine already has port contention — at most this many spawns run
# concurrently; the rest queue behind the gate, still "immediate" per agent.
SPAWN_PACE = max(1, int(os.environ.get("ORGTREE_WARM_SPAWN_PACE", "2")))
# pool snapshot cadence for the telemetry journal
POOL_SNAP_EVERY = 60.0
# bound on the prewarm-time Codex `initialize()` exchange. Generous against a
# busy machine, small against the keeper's world: the finisher runs OFF the
# keeper thread, so this bounds only how long a broken app-server may sit in
# the pool unready before it is reaped and the seat falls back to cold spawns.
CODEX_PREWARM_INIT_TIMEOUT_S = float(
    os.environ.get("ORGTREE_WARM_CODEX_INIT_S", "45"))

_FLAG_CACHE: dict[str, Any] = {"at": 0.0, "mtime": None, "val": None}
_FLAG_TTL = 2.0
_FLAG_LOCK = threading.RLock()  # atomic read/modify/write for runtime controls


class WarmFlagError(RuntimeError):
    """The durable warm.flag exists but is not safe to modify."""


def _flag_path() -> str:
    return os.path.join(store.DATA_ROOT, "warm.flag")


def _read_flag_unlocked() -> dict[str, Any] | None:
    """The runtime override: {enabled, exclude, malformed} — or None when no
    flag file exists. A file that exists but cannot be parsed (empty,
    truncated mid-write, bad JSON) comes back {"malformed": True}: what the
    system DOES with that (fall to the env) and what the measurement RECORDS
    (arm unknown, never guessed) are two separate questions — cache-misses'
    contract, coordinator-backed. Cached ~2 s by mtime so per-decision reads
    cost a stat, not a parse."""
    now = time.time()
    if now - _FLAG_CACHE["at"] < _FLAG_TTL:
        return _FLAG_CACHE["val"]
    p = _flag_path()
    try:
        mt = os.path.getmtime(p)
    except OSError:
        _FLAG_CACHE.update(at=now, mtime=None, val=None)
        return None
    if mt == _FLAG_CACHE["mtime"]:
        _FLAG_CACHE["at"] = now
        return _FLAG_CACHE["val"]
    val: dict[str, Any]
    try:
        raw = open(p, encoding="utf-8").read().strip()
        if raw in ("0", "false", "off"):
            val = {"enabled": False, "exclude": [], "malformed": False}
        elif raw in ("1", "true", "on"):
            val = {"enabled": True, "exclude": [], "malformed": False}
        elif not raw:
            # an EMPTY file is a torn write, not an opinion
            val = {"malformed": True}
        else:
            d = json.loads(raw)
            val = {"enabled": bool(d.get("enabled", True)),
                   "exclude": [str(x) for x in (d.get("exclude") or [])],
                   "malformed": False}
    except OSError:
        val = {"malformed": True}       # unreadable ≠ absent: arm unknown
    except ValueError:
        val = {"malformed": True}
    _FLAG_CACHE.update(at=now, mtime=mt, val=val)
    return val


def _read_flag() -> dict[str, Any] | None:
    """A coherent flag observation across an internal concurrent write."""
    with _FLAG_LOCK:
        return _read_flag_unlocked()


def set_flag(content: str) -> None:
    """Atomic flag write (temp + replace) for anything that flips the switch
    programmatically — a reader can never observe a torn write through this
    path. Hand-edits remain possible; the malformed handling above is what
    covers those."""
    with _FLAG_LOCK:
        p = _flag_path()
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, p)
        _FLAG_CACHE["at"] = 0.0   # the very next decision sees this write


def warm_decision() -> tuple[bool, bool | None]:
    """ONE flag read → (what the system does, what the measurement records).
    The label is the enabled value when the source was trustworthy, and None
    when the flag file was malformed — the behaviour falls to the env there,
    but labelling that arm would be a guess, and a guessed arm is silent
    misattribution in the A/B. Callers journal THIS label, never a re-read:
    the flag can flip between a decision and a later read, and an admit row
    labelled with an arm the turn was not served under is worse than no row."""
    # ⚠ THE DEFAULT IS ON (user ruling at merge, 2026-08-30: "warming on by
    # default, though if you like, toggleable in the new app-wide
    # settings"). A fresh deploy warms every eligible agent at boot. The
    # runtime flag below is therefore the ONLY control arm for the A/B and
    # the only back-out that needs no redeploy — and the user-facing
    # settings toggle (D-203) is THE SAME UNDERLYING VALUE, written through
    # set_enabled(): the preference and the lever are deliberately one
    # piece of state, so do not "deduplicate" them apart later. A flip
    # takes effect at the next keeper pass — within ORGTREE_WARM_POLL
    # seconds, or immediately on any org activity.
    f = _read_flag()
    if f is None:
        env_on = os.environ.get("ORGTREE_WARM", "1") != "0"
        return env_on, env_on
    if f.get("malformed"):
        return os.environ.get("ORGTREE_WARM", "1") != "0", None
    return bool(f["enabled"]), bool(f["enabled"])


def set_enabled(on: bool) -> None:
    """THE ONE WRITE PATH for the on/off half of the flag — the D-203
    settings toggle and any operator flip both come through here. Preserves
    the per-node exclude list (cache-misses' A/B arms): a bare "0"/"1" write
    would clobber it. The toggle is a user preference and the flag is the
    A/B control and back-out lever — SAME VALUE, on purpose; splitting them
    would let the off-arm measurement and the user's setting disagree."""
    with _FLAG_LOCK:
        # A toggle is a read/modify/write because it must preserve the A/B
        # exclude list. Bypass the 2 s decision cache here: another atomic
        # writer may have replaced the durable list inside that TTL, and
        # writing our cached view back would silently resurrect stale arms.
        _FLAG_CACHE["at"] = 0.0
        f = _read_flag()
        exclude = list(f.get("exclude") or []) \
            if f and not f.get("malformed") else []
        if exclude:
            set_flag(json.dumps({"enabled": bool(on), "exclude": exclude}))
        else:
            set_flag("1" if on else "0")
    poke()


def warm_enabled() -> bool:
    return warm_decision()[0]


def node_excluded(slug: str, nid: str) -> bool:
    f = _read_flag()
    return bool(f and not f.get("malformed")
                and f"{slug}/{nid}" in f["exclude"])


def set_node_excluded(slug: str, nid: str, excluded: bool) -> bool:
    """Atomically add/remove one node's persistent warm-process exclusion.

    The list shares ``warm.flag`` with the machine-wide warming switch.  A
    read/modify/write under the flag lock is important here: writing a bare
    ``0``/``1`` would either erase another node's manual stop or make a later
    global toggle silently resurrect it.  ``True`` is the durable manual-stop
    arm; ``False`` is the matching manual-start operation.
    """
    key = f"{slug}/{nid}"
    changed = False
    with _FLAG_LOCK:
        # Do not let a stale two-second cache overwrite a hand-edited list.
        _FLAG_CACHE["at"] = 0.0
        f = _read_flag_unlocked()
        if f and f.get("malformed"):
            raise WarmFlagError(
                "warm.flag is malformed; repair it before changing a "
                "node's process setting")
        if f is None:
            enabled = os.environ.get("ORGTREE_WARM", "1") != "0"
            excludes: list[str] = []
        else:
            enabled = bool(f.get("enabled", True))
            # Preserve other exclusions, while normalising duplicates of the
            # target touched by this operation.
            excludes = [str(x) for x in (f.get("exclude") or [])]
        had = key in excludes
        if excluded:
            if not had:
                excludes.append(key)
                changed = True
        elif had:
            excludes = [x for x in excludes if x != key]
            changed = True
        if changed:
            # The compact 0/1 form is the established representation when no
            # per-node arm remains; JSON is required whenever exclusions do.
            content = (json.dumps({"enabled": enabled,
                                   "exclude": excludes})
                       if excludes else ("1" if enabled else "0"))
            set_flag(content)
    if changed:
        poke()
    return changed


# ── the pool ───────────────────────────────────────────────────────────────
class WarmProc:
    """One parked (or claimed) CLI process. The stdout PUMP thread owns
    proc.stdout for the process's whole life — a turn reads lines through
    `lines_iter()`, never from the pipe directly — because a turn ends at a
    result boundary while the process lives on, and a second turn must be
    able to attach where the first detached."""

    def __init__(self, slug: str, nid: str, proc: subprocess.Popen[str],
                 sid: str, ihash: str, env_id: str,
                 ident_components: dict[str, str] | None = None) -> None:
        self.slug, self.nid = slug, nid
        self.proc = proc
        self.sid = sid
        self.hash = ihash
        self.env_id = env_id
        # D-206 attribution: the four digests that produced `hash`, captured
        # at the same time as the combined hash. Raw prompt/argv/credential
        # values never enter telemetry. A process created before this field
        # existed has no baseline, which is recorded as incomplete rather
        # than guessed.
        self.ident_components = (dict(ident_components)
                                 if ident_components is not None else None)
        self.identity_change: dict[str, Any] | None = None
        self.spawned_at = time.time()
        self.parked_at = time.time()
        self.claimed = False
        # delivery gate (process-cache-2's probe, 2026-08-30): lines reach a
        # turn ONLY between activate() — called right after the turn's first
        # stdin write — and park/detach. Everything else is dropped (newest
        # init excepted). Two measured hazards force this: a straggler result
        # from the PREVIOUS turn arriving after re-claim would read as the new
        # turn's boundary, and any non-system event delivered before the
        # stdin write would satisfy the C1 delivery-confirm for mail the
        # process never read. attach() also swaps in a FRESH queue, so
        # nothing queued at detach can survive into the next claim.
        self.active = False
        self.dead = threading.Event()
        # process-cumulative dollars already BOOKED by earlier turns on this
        # process. `total_cost_usd` accumulates across the process's life, and
        # every booking site in supervisor assumed one process per turn — a
        # warm process serving its second turn would re-book the first turn's
        # spend without this baseline (found in review of supervisor.py:6901
        # before it could ship, 2026-08-30).
        self.cost_base = 0.0
        # …and the same baseline for the result event's cumulative
        # usage.output_tokens (rides the per-turn stats ring)
        self.out_base = 0
        # WHY this process is ending, noted by the turn AT THE DECISION
        # (boundary decline, bg-children drain, limit freeze, timeout kill)
        # and journaled exactly once at true EOF — a serving process that
        # ended without parking used to leave ZERO exit rows, so E3's table
        # could be green while a primary serving death was invisible
        # (process-cache-2's serving-exit probe). `exit_journaled` is the
        # once-guard shared by every journaling path.
        self.exit_reason: str | None = None
        self.exit_journaled = False
        self.lines: "queue.Queue[str | None]" = queue.Queue()
        self.init_line: str | None = None   # latest system/init seen inactive
        self.dropped_inactive = 0           # probe counter (process-cache-2)
        self.err_tail: collections.deque[str] = collections.deque(maxlen=200)
        self._lk = threading.Lock()
        threading.Thread(target=self._pump_out, daemon=True,
                         name=f"warmpump-{slug}-{nid}").start()
        threading.Thread(target=self._pump_err, daemon=True,
                         name=f"warmerr-{slug}-{nid}").start()

    # — pumps —
    def _pump_out(self) -> None:
        try:
            for line in self.proc.stdout:      # pyright: ignore[reportOptionalIterable]
                line = line.rstrip("\n")
                with self._lk:
                    if self.active:
                        self.lines.put(line)
                        continue
                # INACTIVE lines (parked, or claimed but the turn has not yet
                # written stdin) are dropped, except the newest init event,
                # which is replayed to the next claiming turn (it carries the
                # tool/MCP resolution st["init"] wants; init is type=system,
                # which the C1 confirm explicitly refuses as consumption
                # proof). See the `active` field note for why dropping is
                # load-bearing, not tidiness.
                s = line.strip()
                if '"init"' in s:
                    try:
                        ev = json.loads(s)
                        if ev.get("type") == "system" \
                                and ev.get("subtype") == "init":
                            with self._lk:
                                self.init_line = line
                            try:
                                from . import supervisor as sup  # noqa: PLC0415
                                sup._mcp_tool_count_names(
                                    self.slug, self.nid, self.proc,
                                    ev.get("tools") or [], "claude",
                                    "system/init.tools")
                            except Exception:                    # noqa: BLE001
                                pass
                    except ValueError:
                        pass
                else:
                    with self._lk:
                        self.dropped_inactive += 1
        except (OSError, ValueError):
            pass
        self.dead.set()
        with self._lk:
            self.lines.put(None)                # EOF marker for any reader
        _on_proc_exit(self)

    def _pump_err(self) -> None:
        try:
            for line in self.proc.stderr:      # pyright: ignore[reportOptionalIterable]
                raw = line.rstrip("\r\n")
                self.err_tail.append(raw)
                journal_cache_break_lines(
                    self.slug, self.nid, self.sid,
                    getattr(self.proc, "pid", None), "warm-stderr", raw)
        except (OSError, ValueError):
            pass

    # — the turn-side surface —
    def attach(self) -> None:
        with self._lk:
            self.claimed = True
            self.active = False
            # a FRESH queue per claim: nothing queued at a previous detach
            # (a late straggler result, most dangerously) can be replayed
            # into this turn as if it were its own event
            self.lines = queue.Queue()
            # replay the parked-period init so st["init"] is still populated
            if self.init_line is not None:
                self.lines.put(self.init_line)
                self.init_line = None
            if self.dead.is_set():
                self.lines.put(None)     # died before the claim: EOF at once

    def activate(self) -> None:
        """Open the delivery gate — called by the turn immediately after its
        first stdin write+flush. Only lines the pump reads after this point
        reach the turn, so no pre-write event can confirm delivery of a
        payload the process has not read."""
        with self._lk:
            self.active = True

    def lines_iter(self) -> Iterator[str]:
        """Line source for the turn loop. Ends on process EOF (None marker),
        exactly like iterating proc.stdout on the cold path — the idle
        watchdog still bounds a wedged process by killing it, which lands
        here as EOF."""
        q = self.lines            # this claim's queue, pinned
        while True:
            line = q.get()
            if line is None:
                q.put(None)              # stay terminated for any re-reader
                return
            yield line

    def err_text(self) -> str:
        return "\n".join(self.err_tail)

    def alive(self) -> bool:
        return self.proc.poll() is None and not self.dead.is_set()


class CodexWarmProc:
    """A parked Codex app-server in the same seat registry as Claude.

    The wire reader belongs to ``AppServerClient`` rather than to WarmProc's
    stream-json pump, but the keeper needs the same identity, ownership and
    death bookkeeping surface for both provider processes.
    """

    def __init__(self, slug: str, nid: str, client: Any, sid: str,
                 ihash: str, components: dict[str, str] | None = None) -> None:
        self.slug, self.nid = slug, nid
        self.client = client
        self.proc = client.proc
        self.sid = sid
        self.hash = ihash
        self.ident_components = dict(components or {})
        self.claimed = False
        self.active = False
        # full-prewarm truth: "initializing" until the finisher completes the
        # bounded initialize() + MCP inventory, then "ready" or "degraded".
        # `proc_warm` mirrors this — the seat is only CALLED warm afterward,
        # though a racing claim may reuse the process at any point.
        self.warm_state = "initializing"
        self.parked_at = time.time()
        self.cost_base = 0.0
        self.out_base = 0
        self.exit_reason: str | None = None
        self.exit_journaled = False
        self.identity_change: dict[str, Any] | None = None
        self._lk = threading.RLock()

    def attach(self) -> None:
        with self._lk:
            self.claimed = True
            self.active = False

    def alive(self) -> bool:
        return self.proc.poll() is None


WarmProcess = WarmProc | CodexWarmProc


_pool: dict[tuple[str, str], WarmProcess] = {}
# warm-origin processes CURRENTLY SERVING a turn (claimed out of _pool).
# Tracked so the pool snapshot sees peak memory — parked-only counting
# structurally hid every serving process, which corrupts the ceiling figure
# the user asked for (cache-misses contract, coordinator-backed). ONLY
# telemetry and exit bookkeeping read this: kill_node/kill_org deliberately
# do not — a mid-turn process is never disturbed, tracked or not.
_serving: dict[tuple[str, str], WarmProcess] = {}
_pool_lock = threading.RLock()
_spawn_gate = threading.Semaphore(SPAWN_PACE)
_poke = threading.Event()
_started = False
# test seam (process-cache-2's contract): patch this to fake the CLI process
# factory without touching subprocess itself
_POPEN = subprocess.Popen


# ── telemetry ──────────────────────────────────────────────────────────────
_J_LOCK = threading.Lock()
CACHE_BREAK_MARKER = "[PROMPT CACHE BREAK]"
CACHE_BREAK_LINE_MAX = 4096


def _journal(kind: str, **fields: Any) -> None:
    rec = {"kind": kind,
           "at": time.strftime("%Y-%m-%dT%H:%M:%S.", time.gmtime())
                 + f"{int(time.time() * 1000) % 1000:03d}Z",
           **fields}
    try:
        d = os.path.join(store.DATA_ROOT, "journals")
        os.makedirs(d, exist_ok=True)
        with _J_LOCK, open(os.path.join(d, "warm.jsonl"), "a",
                           encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass                     # telemetry must never cost a turn


def journal_cache_break_lines(slug: str, nid: str, sid: str,
                              pid: int | None, source: str,
                              text: str) -> None:
    """Persist only the CLI's cache-break sentinel from stderr.

    General stderr may contain sensitive material and stays in the existing
    private tail. The raw sentinel line is the diagnoser's evidence, so keep
    it verbatim apart from line terminators and a deterministic 4096-character
    cap. This helper is shared by BOTH stderr owners: WarmProc._pump_err and
    read_cold_stderr. Missing either owner removes exactly the population this
    instrument is meant to explain. `_journal`'s `at` is COLLECTION time, not
    an API request timestamp; consumers join by session/order plus the raw
    line's call/read/create tuple (the warning carries no requestId).
    """
    for raw in text.splitlines() or [text.rstrip("\r\n")]:
        if CACHE_BREAK_MARKER not in raw:
            continue
        _journal("cache-break", slug=slug, nid=nid, session_id=sid,
                 pid=pid, source=source, line=raw[:CACHE_BREAK_LINE_MAX],
                 raw_length=len(raw),
                 truncated=len(raw) > CACHE_BREAK_LINE_MAX)


def limit_cache_usage_fields(usage: dict[str, Any]) -> dict[str, int]:
    """The accepted numeric counters from one Claude result usage object.

    The caller uses positive values from this whitelist as its evidence
    predicate. Explicit zeros still belong in the journal, but a synthetic
    limit result made entirely of zeros cannot consume the resume marker.
    """
    out: dict[str, int] = {}
    for key in ("input_tokens", "cache_read_input_tokens",
                "cache_creation_input_tokens", "output_tokens"):
        value = usage.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) \
                and value >= 0:
            out[key] = int(value)
    creation = usage.get("cache_creation")
    if isinstance(creation, dict):
        for key in ("ephemeral_5m_input_tokens",
                    "ephemeral_1h_input_tokens"):
            value = creation.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool) \
                    and value >= 0:
                out[key] = int(value)
    return out


def journal_limit_cache_usage(
        slug: str, nid: str, sid: str, pid: int | None, account: str,
        usage: dict[str, Any], *, phase: str, limited: bool,
        prior_sid: str = "", prior_pid: int | None = None,
        prior_account: str = "", freeze_s: float | None = None,
        resume_wait_s: float | None = None) -> None:
    """Record the two boundaries needed to attribute a limit -> wake miss.

    This consumes the result event Orgtree already received; it never probes
    Claude or mutates a prompt.  Only the limit result and the first result
    after ``resume_frozen`` call this helper.  The whitelist is intentional:
    result/error text and unknown provider fields do not belong in the shared
    warm journal.
    """
    if phase not in ("limit", "first-after-resume"):
        return
    rec: dict[str, Any] = {
        "slug": slug, "nid": nid, "session_id": sid, "pid": pid,
        "account": account, "phase": phase, "limited": bool(limited),
        **limit_cache_usage_fields(usage),
    }
    if phase == "first-after-resume":
        rec["process_respawned"] = True
        if prior_sid:
            rec["prior_session_id"] = prior_sid
            rec["same_session"] = prior_sid == sid
        if prior_pid is not None:
            rec["prior_pid"] = prior_pid
            rec["pid_changed"] = prior_pid != pid
        if prior_account:
            rec["prior_account"] = prior_account
            rec["same_account"] = prior_account == account
        if freeze_s is not None:
            rec["freeze_s"] = round(max(0.0, freeze_s), 3)
        if resume_wait_s is not None:
            rec["resume_wait_s"] = round(max(0.0, resume_wait_s), 3)
    _journal("limit-cache", **rec)


def read_cold_stderr(proc: subprocess.Popen[str], slug: str, nid: str,
                     sid: str) -> str:
    """The non-pooled stderr owner, with the same cache-break observation as
    the warm pump. Kept as one helper so a cold success cannot read and then
    silently discard the very warning that explains its cache miss."""
    err = proc.stderr.read()     # pyright: ignore[reportOptionalMemberAccess]
    journal_cache_break_lines(slug, nid, sid, getattr(proc, "pid", None),
                              "cold-stderr", err)
    return err


def journal_admit(slug: str, nid: str, sid: str, served: str, reason: str,
                  ihash: str, warm_age_s: float | None, spawn_ms: int,
                  warm_label: bool | None, slot_wait_s: float = 0.0) -> None:
    """One line per turn ADMISSION, written before the turn runs (a crash
    mid-turn cannot lose it). `session_id` is cache-misses' join key against
    the CLI transcript.

    `warm_label` is THE FLAG OBSERVATION FROM THE DECISION THAT ADMITTED
    THIS TURN, threaded through by the caller — never re-read here. The flag
    can flip between the decision and this write, and an admit row labelled
    with an arm the turn was not served under is silent misattribution in
    the A/B (process-cache-2's alternating-flag probe measured exactly
    that). None = the flag file was malformed at decision time: the arm is
    UNKNOWN and recorded as such, never guessed.

    `slot_wait_s` is how long this admission waited to acquire the
    machine-wide `_turn_slots` seat (0.0 for a boundary-feed, which rides a
    seat the turn already holds rather than acquiring a new one). A stuck-mail
    incident (user report 2026-08-30) traced to a window this journal could
    not explain either way — a slot wait leaves no OTHER trace anywhere, so
    without this field the next occurrence would be just as unexplainable.

    ⚠ THERE IS DELIBERATELY NO `handshake_ms` FIELD IN ADMIT ROWS. One used
    to be written here as the literal `0`, and cache-misses measured it
    vacuous (2026-08-30): 0 in all 46 admit rows, cold spawns included. What
    makes that a finding rather than a guess is the control — `spawn_ms` in
    the SAME rows varies 0–483ms, so the journal does record varying values
    and that field specifically was dead.

    It stays removed because NOTHING AT THIS SEAM observes a handshake:
    Claude admissions still never wait for one (user ruling, module
    docstring), and the Codex prewarm handshake completes elsewhere — its
    real, measured interval is journaled by the finisher's own
    `prewarm-ready`/`prewarm-degraded`/`prewarm-failed` rows as
    `elapsed_ms`, against the process it actually timed.

    A MISSING FIELD IS HONEST; A PERMANENTLY-ZERO ONE LIES — and this one sat
    in the journal this whole effort steers by, where `handshake_ms=0` on a
    cold spawn reads as evidence the handshake was free, which is the
    opposite of what the audit found. Do not re-add it without a proof that
    it can be non-zero (coordinator-ruled 2026-08-30)."""
    _journal("admit", slug=slug, nid=nid, session_id=sid, served=served,
             reason=reason, ident_hash=ihash,
             warm_age_s=round(warm_age_s, 1) if warm_age_s is not None else None,
             spawn_ms=spawn_ms, warm_enabled=warm_label,
             slot_wait_s=round(slot_wait_s, 1))


def _journal_proc(event: str, slug: str, nid: str, reason: str,
                  ihash: str = "", elapsed_ms: int = 0,
                  session_id: str | None = None,
                  pid: int | None = None,
                  identity_change: dict[str, Any] | None = None) -> None:
    try:
        from . import supervisor as sup             # noqa: PLC0415
        with sup._state_lock:
            qd = len(sup._state.get((slug, nid), {}).get("queue") or [])
    except Exception:                               # noqa: BLE001
        qd = 0
    rec: dict[str, Any] = dict(slug=slug, nid=nid, event=event, reason=reason,
                               ident_hash=ihash, queue_depth=qd,
                               elapsed_ms=elapsed_ms)
    if session_id is not None:
        rec["session_id"] = session_id
    if pid is not None:
        rec["pid"] = pid
    if identity_change is not None:
        rec.update(identity_change)
    if event == "exit":
        # every death names its class, so the closed-death-list invariant is
        # checkable from the journal alone
        rec["reason_class"] = _classify_kill(slug, nid, reason)
    _journal("proc", **rec)


# ── identity hash ──────────────────────────────────────────────────────────
def _argv_normalized(cmd: list[str]) -> list[str]:
    """The spawn argv with ONE normalization: the trailing session flag NAME.
    `_build_cmd` emits `--session-id <sid>` before a transcript exists and
    `--resume <sid>` after — the first real turn flips it, and treating that
    flip as an identity change would respawn every agent right after its
    first turn for no reason. The SID ITSELF STAYS IN THE HASH: a cheap
    compact mints a new session, and a parked process holding the old one
    must be invalidated."""
    out = list(cmd)
    for i, a in enumerate(out):
        if a in ("--session-id", "--resume"):
            out[i] = "<session>"
    return out


_STARTUP_IMPORT_RE = re.compile(r"(?<![\w@])@([^\s`\"'<>]+)")
_RULE_PATHS_RE = re.compile(r"(?m)^paths\s*:")


def _memory_prefix(data: bytes) -> bytes:
    """The exact documented auto-memory startup ceiling: first 25 KiB or
    first 200 lines, whichever comes first."""
    data = data[:25 * 1024]
    return b"".join(data.splitlines(keepends=True)[:200])


def _startup_rule(data: bytes) -> bool:
    """A path-scoped rule is lazy, not a session-start input."""
    text = data.decode("utf-8", "replace")
    if not text.startswith("---"):
        return True
    end = text.find("\n---", 3)
    frontmatter = text[3:end if end >= 0 else len(text)]
    return _RULE_PATHS_RE.search(frontmatter) is None


def native_startup_context_digest(org: Any, nid: str) -> str:
    """Digest Claude's file-borne, once-per-session instruction inputs.

    Claude Code loads these before turn 1 and holds them in the process. A
    warm process therefore becomes correctness-stale when one changes unless
    the file participates in the identity hash. This deliberately excludes
    global skills: the pinned CLI watches skill directories live, so hashing
    them would manufacture respawns rather than prevent stale instructions.

    Instruction files arrive from TWO directions and both are covered: the
    cwd parent chain (an agent's own scratch notes) and the roots of its
    GRANTED directories, because the CLI reads a CLAUDE.md from every working
    directory it is given. Missing the second half is what let the org-charter
    field write a file nothing ever re-read.

    The manifest contains paths and content hashes, never raw instruction
    text. CLAUDE.md imports are followed to the CLI's documented five-hop
    ceiling; auto memory is hashed only through the prefix the CLI loads.
    """
    from . import supervisor as sup                 # noqa: PLC0415

    cwd = os.path.abspath(sup.scratch_dir(org.d["slug"], nid))
    home = os.path.abspath(os.path.expanduser("~"))
    manifest: dict[str, str] = {}
    seen: set[str] = set()

    def add(path: str, depth: int = 0, *, memory: bool = False,
            rule: bool = False) -> None:
        path = os.path.abspath(os.path.expanduser(path))
        key = os.path.normcase(os.path.realpath(path))
        if key in seen:
            return
        try:
            with open(path, "rb") as f:
                data = f.read()
        except (OSError, ValueError):
            return
        if rule and not _startup_rule(data):
            return
        seen.add(key)
        if memory:
            data = _memory_prefix(data)
        label = os.path.normcase(path)
        manifest[label] = hashlib.sha256(data).hexdigest()
        if depth >= 5:
            return
        text = data.decode("utf-8", "replace")
        for match in _STARTUP_IMPORT_RE.finditer(text):
            token = match.group(1).rstrip(".,;:!?)]}")
            if not token:
                continue
            imported = (os.path.expanduser(token) if token.startswith("~")
                        else token if os.path.isabs(token)
                        else os.path.join(os.path.dirname(path), token))
            add(imported, depth + 1)

    # Managed policy, then user instructions.
    if os.name == "nt":
        add(os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"),
                         "ClaudeCode", "CLAUDE.md"))
    else:
        add("/etc/claude-code/CLAUDE.md")
        add("/Library/Application Support/ClaudeCode/CLAUDE.md")
    add(os.path.join(home, ".claude", "CLAUDE.md"))

    # Project instructions: root -> cwd, then the project-local .claude
    # form. The cwd is outside a git tree for normal orgtree seats, so it is
    # the project root; walking parents is still required by Claude Code.
    chain: list[str] = []
    at = cwd
    while True:
        chain.append(at)
        parent = os.path.dirname(at)
        if parent == at:
            break
        at = parent
    for directory in reversed(chain):
        add(os.path.join(directory, "CLAUDE.md"))
        add(os.path.join(directory, "CLAUDE.local.md"))
    add(os.path.join(cwd, ".claude", "CLAUDE.md"))

    # GRANTED DIRECTORIES (2026-09-04). Every `--add-dir` root contributes its
    # own CLAUDE.md: the CLI loads instruction files from each working
    # directory it is handed, not only from the cwd chain above. MEASURED, not
    # assumed — an agent with NO CLAUDE.md anywhere in its cwd chain and none
    # at ~/.claude/CLAUDE.md still had the granted workspace file's text in
    # its context.
    #
    # THIS IS WHAT MAKES `org.md` APPLY. The org-charter editor writes
    # <workspace>/CLAUDE.md, and the workspace is a SIBLING of scratch, never
    # an ancestor, so the walk above cannot reach it. Without this block an
    # org.md edit moved no hash and killed no process: it silently did not
    # apply to any parked agent until some unrelated respawn happened to pick
    # it up. That is precisely the defect D-206 closed for the scratch
    # CLAUDE.md, one grant surface over, and it read as "the setting does
    # nothing" from the outside.
    #
    # Deliberate exclusions, none of them oversights:
    #  * GLOBAL_SKILLS, the standing skills --add-dir — the module's existing
    #    skills exclusion holds; the pinned CLI watches that tree live.
    #  * the fixed scratch-root --add-dir (D-201/S2a) — already hashed, it IS
    #    an ancestor of cwd and the chain walk covers it.
    #  * the cheap-compact predecessor read-down — a transient splice artifact
    #    whose own seat rehashes when the splice retires.
    #
    # ⚠ getattr, not `org.nodes` — this function takes `org: Any` and is
    # reached from rigs that pass a MINIMAL org fake (test_d206_env builds a
    # SimpleNamespace with only `.d`). A real Org always has `.nodes`, so this
    # degrades only for a shape that has no grants to read anyway; it does NOT
    # paper over a real org whose lookup failed.
    nodes = getattr(org, "nodes", None)
    node = (nodes.get(nid) or {}) if isinstance(nodes, dict) else {}
    for grant in (node.get("scope") or {}).get("add_dirs") or []:
        root = str((grant or {}).get("path") or "")
        if not root:
            continue
        add(os.path.join(root, "CLAUDE.md"))
        add(os.path.join(root, "CLAUDE.local.md"))

    # Unscoped rules load at session start; path-scoped rules load lazily when
    # a matching file is read and therefore must not dirty an idle process.
    for rules_root in (os.path.join(home, ".claude", "rules"),
                       os.path.join(cwd, ".claude", "rules")):
        try:
            for root, dirs, files in os.walk(rules_root):
                dirs.sort()
                for name in sorted(files):
                    if name.endswith(".md"):
                        add(os.path.join(root, name), rule=True)
        except OSError:
            pass

    # Auto memory is another documented session-start input. Topic files are
    # lazy; only MEMORY.md's bounded prefix belongs here.
    memory = os.path.join(home, ".claude", "projects",
                          sup._cli_project_dir(cwd), "memory", "MEMORY.md")
    add(memory, memory=True)

    encoded = json.dumps(manifest, sort_keys=True, separators=(",", ":"),
                         ensure_ascii=False).encode("utf-8", "replace")
    return hashlib.sha256(encoded).hexdigest()


# Codex's project-doc discovery, MEASURED against the pinned codex 0.150.1
# with `codex debug prompt-input` (renders the model-visible prompt, no API
# call). Do NOT copy the Claude list across — the loaders differ, and hashing
# a file codex ignores would respawn agents for edits that change nothing.
#
# What the probe established, planting distinctive markers and reading back
# which ones reached the prompt:
#   * <cwd>/AGENTS.md            LOADED
#   * <cwd>/AGENTS.override.md   LOADED, and it SUPPRESSES AGENTS.md in the
#                                same directory (the managed identity vanished
#                                from the prompt when an override was planted)
#   * <cwd>/CLAUDE.md            NOT loaded. `project_doc_fallback_filenames`
#                                defaults to `[]` in the binary's own embedded
#                                defaults; codex's CLAUDE.md strings belong to
#                                its Claude-session IMPORT feature, not to
#                                project-doc loading.
#   * ancestors' AGENTS.md       loaded ONLY up to a `.git` project root
#                                (`project_root_markers = [".git"]`). With no
#                                marker anywhere the walk collapses to cwd —
#                                which is every orgtree seat today, since
#                                nothing above the scratch root is a repo.
#   * $CODEX_HOME/AGENTS.md      LOADED (verified with an isolated CODEX_HOME;
#                                the real one was never written to).
#
# ⚠ KNOWN BOUNDARY: a non-default `project_doc_fallback_filenames` in codex
# config would add filenames this digest does not know about. Not covered,
# deliberately — the proven default set is what gets hashed, and inventing
# coverage for unmeasured config is the failure this comment exists to stop.
_CODEX_DOC_NAMES = ("AGENTS.override.md", "AGENTS.md")


def codex_startup_context_digest(
        org: Any, nid: str, *, cwd: str | None = None,
        codex_home: str | None = None) -> str:
    """Digest the instruction files a Codex app-server reads at session start.

    The Claude lane's counterpart is `native_startup_context_digest`; this is
    deliberately a SEPARATE function rather than a shared one, because the two
    CLIs read different file sets and a single list would be wrong for both.

    The managed `<cwd>/AGENTS.md` is included even though it is written from
    `identity_prompt`, which the `prompt` component already hashes. That is
    not double counting: derived content moves exactly when the prompt moves,
    so it adds no churn — and it buys real tamper detection, because an agent
    that hand-edits its own AGENTS.md (or plants an AGENTS.override.md, which
    SUPPRESSES the managed identity entirely) would otherwise keep serving
    from a parked process with instructions orgtree never wrote.
    """
    from . import supervisor as sup                 # noqa: PLC0415

    # A supplied launch spec is authoritative. In particular, a caller may
    # resolve CODEX_HOME/cwd and then the ambient environment may move before
    # this projection is consumed. Re-reading ambient paths here used to hash
    # files the captured app-server would not read.
    cwd = os.path.abspath(
        cwd if cwd is not None else sup.scratch_dir(org.d["slug"], nid))
    codex_home = os.path.abspath(
        codex_home if codex_home is not None else
        (os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")))
    manifest: dict[str, str] = {}

    def add(path: str) -> None:
        try:
            with open(path, "rb") as f:
                data = f.read()
        except (OSError, ValueError):
            return
        manifest[os.path.normcase(path)] = hashlib.sha256(data).hexdigest()

    add(os.path.join(codex_home, "AGENTS.md"))

    # Walk up for a `.git` root. Absent one, codex reads the cwd alone — so an
    # unfound marker must NOT degrade into "hash every ancestor", which would
    # hash files codex never opens.
    chain: list[str] = []
    at = cwd
    while True:
        chain.append(at)
        if os.path.exists(os.path.join(at, ".git")):
            break
        parent = os.path.dirname(at)
        if parent == at:
            chain = [cwd]
            break
        at = parent
    for directory in reversed(chain):
        for name in _CODEX_DOC_NAMES:
            path = os.path.join(directory, name)
            if os.path.isfile(path):
                add(path)
                break            # an override replaces AGENTS.md in its dir

    encoded = json.dumps(manifest, sort_keys=True, separators=(",", ":"),
                         ensure_ascii=False).encode("utf-8", "replace")
    return hashlib.sha256(encoded).hexdigest()


def _part(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()[:12]


IDENTITY_COMPONENTS = ("prompt", "argv", "cred", "envov")


def identity_snapshot(org: Any, nid: str, *,
                      cmd: list[str] | None = None,
                      env: dict[str, str] | None = None,
                      overrides: dict[str, str] | None = None,
                      provider_spec: dict[str, Any] | None = None,
                      codex_manifest: dict[str, Any] | None = None,
                      ) -> tuple[str, dict[str, str]]:
    """One combined identity hash plus independently verifiable components.

    Optional cmd/env/overrides are the values an actual spawn is about to
    receive. Supplying them is important: resolving the credential a second
    time can choose another account and falsely dirty (or falsely admit) a
    parked process. Raw inputs never leave this function; journals receive
    only the short SHA-256 component digests.
    """
    from . import providers                         # noqa: PLC0415
    from . import supervisor as sup                 # noqa: PLC0415
    prompt = sup.identity_prompt(org, nid)
    model = str(org.node(nid).get("model") or "")
    if model in providers.CODEX_TIERS:
        # Codex's process-scoped identity is not Claude's `_build_cmd`.
        # External MCP servers are app-server argv and the managed identity is
        # AGENTS.md written before launch. Resolve the whole manifest once so
        # keeper, turn admission and cache recording cannot disagree.
        manifest = codex_manifest or sup._codex_startup_manifest(
            org, nid, write_ident=False, provider_spec=provider_spec)
        # The projection keeps the stable four-component vocabulary; Codex's
        # different native file set is folded into `prompt` there.
        raw = sup._codex_process_identity_inputs(manifest, model)
        h = hashlib.sha256()
        for i, name in enumerate(IDENTITY_COMPONENTS):
            if i:
                h.update(b"\x00")
            h.update(raw[name])
        return h.hexdigest()[:32], {
            name: _part(raw[name]) for name in IDENTITY_COMPONENTS}
    if cmd is None:
        cmd = sup._build_cmd(org, nid, write_ident=False)
    if overrides is None:
        overrides = sup.env_overrides(org.d["slug"], nid)
    if env is None:
        env = sup.spawn_env(org,
                            tier=str(org.node(nid).get("model") or ""),
                            nid=nid)
    native = native_startup_context_digest(org, nid)
    raw = {
        # Keep the fixed four-component vocabulary cache-misses approved:
        # native instructions are prompt input, not a fifth identity class.
        "prompt": (prompt.encode("utf-8", "replace")
                   + b"\x00native-startup\x00" + native.encode("ascii")),
        "argv": json.dumps(_argv_normalized(cmd), ensure_ascii=False)
                    .encode("utf-8", "replace"),
        "cred": sup.identity_in_env(env).encode("utf-8", "replace"),
        "envov": json.dumps(overrides, sort_keys=True, ensure_ascii=False)
                     .encode("utf-8", "replace"),
    }
    h = hashlib.sha256()
    for i, name in enumerate(IDENTITY_COMPONENTS):
        if i:
            h.update(b"\x00")
        h.update(raw[name])
    return h.hexdigest()[:32], {name: _part(raw[name])
                                for name in IDENTITY_COMPONENTS}


def ident_hash(org: Any, nid: str) -> str:
    """The invalidation hash. Pure — writes nothing."""
    return identity_snapshot(org, nid)[0]


def ident_parts(org: Any, nid: str) -> dict[str, str]:
    """The four short component digests, mainly for diagnostics/tests."""
    return identity_snapshot(org, nid)[1]


def identity_change_fields(previous_hash: str,
                           previous_components: dict[str, str] | None,
                           next_hash: str,
                           next_components: dict[str, str] | None,
                           ) -> dict[str, Any]:
    """A falsifiable attribution record: consumer can recompute the changed
    names from the two digest maps instead of trusting the producer's label."""
    prev_ok = (isinstance(previous_components, dict)
               and all(isinstance(previous_components.get(k), str)
                       for k in IDENTITY_COMPONENTS))
    next_ok = (isinstance(next_components, dict)
               and all(isinstance(next_components.get(k), str)
                       for k in IDENTITY_COMPONENTS))
    complete = bool(prev_ok and next_ok)
    previous = ({k: previous_components[k] for k in IDENTITY_COMPONENTS}
                if prev_ok and previous_components is not None else None)
    nxt = ({k: next_components[k] for k in IDENTITY_COMPONENTS}
           if next_ok and next_components is not None else None)
    changed = ([k for k in IDENTITY_COMPONENTS
                if previous[k] != nxt[k]]
               if complete and previous is not None and nxt is not None
               else None)
    return {
        "previous_ident_hash": previous_hash,
        "next_ident_hash": next_hash,
        "previous_components": previous,
        "next_components": nxt,
        "changed_inputs": changed,
        "attribution_complete": complete,
    }


def _record_identity_change(wp: WarmProcess, next_hash: str,
                            next_components: dict[str, str] | None,
                            ) -> dict[str, Any]:
    fields = identity_change_fields(
        wp.hash, wp.ident_components, next_hash, next_components)
    with wp._lk:
        wp.identity_change = fields
    return fields


def eligible(org: Any, nid: str, *, ignore_exclusion: bool = False,
             ) -> tuple[bool, str]:
    """May this node hold a warm process at all? Everything outside this set
    keeps today's spawn-per-turn behaviour, which is also the universal
    fallback. The sandbox remains excluded (its spawn is a docker exec whose
    parking is untested), as do Antigravity (its print-mode process is one
    turn long by construction) and preserving oracles (each consult is a
    --fork-session).
    Codex app-server persistence is measured and shares this keeper."""
    from . import supervisor as sup                 # noqa: PLC0415
    from . import providers                         # noqa: PLC0415
    n = org.nodes.get(nid)
    if not n or n.get("state") != "live":
        return False, "not-live"
    # A terminally failed process with NO transcript is evidence that this
    # exact launch shape died before delivery.  Do not eagerly reproduce it in
    # the background: the parked copy would be claimed by the next real
    # message and could fail the same way before its folded-back mail reaches
    # the model.  The recovery turn takes the ordinary cold-spawn fallback;
    # `_after_turn` clears `hard_fail_run` only after that turn completes.
    # Deliberately keep warming when the transcript exists: delivery already
    # has durable evidence, and the post-echo crash path stays unchanged.
    sid = str(n.get("session_id") or "")
    if (n.get("hard_fail_run")
            and sup.transcript_path(sid, sup._transcript_root(org)) is None):
        return False, "terminal-failure-before-transcript"
    if not ignore_exclusion and node_excluded(org.d["slug"], nid):
        return False, "excluded-by-flag"
    if sup.sbx.is_sandboxed(org):
        return False, "sandboxed"
    model = str(n.get("model") or "")
    if model in providers.ANTIGRAVITY_TIERS:
        return False, "provider-lane"
    if n.get("bearer_state") == "preserving":
        return False, "preserving-oracle"
    return True, ""


def _warm_eligible(org: Any, nid: str, *, ignore_exclusion: bool = False,
                   ) -> tuple[bool, str]:
    """The manual-control lifecycle gate, including non-turn exclusions.

    ``eligible`` remains the process-admission predicate used by a real turn;
    this stricter companion lets manual start refuse a frozen, remotely
    controlled, or otherwise administratively blocked seat. The keeper keeps
    its established ``eligible`` gate because it must preserve the existing
    warm-process fallback semantics. Manual start uses ``ignore_exclusion``
    only to test the seat behind its own persistent stop flag.
    """
    from . import supervisor as sup                 # noqa: PLC0415
    ok, why = (eligible(org, nid, ignore_exclusion=True)
               if ignore_exclusion else eligible(org, nid))
    if not ok:
        return False, why
    n = org.nodes.get(nid)
    if n is None:
        return False, "not-live"
    if n.get("frozen"):
        return False, "frozen"
    if n.get("limit_locked"):
        return False, "limit-locked"
    if n.get("remote_controlled"):
        return False, "remote-controlled"
    if n.get("bearer_state"):
        return False, "bearer-state"
    if org.d.get("spend_frozen"):
        return False, "spend-frozen"
    if n.get("inflight"):
        return False, "inflight"
    if (org.d.get("delivering") or {}).get(nid):
        return False, "delivery-in-progress"
    if org.d.get("storage_blocked") and sup.sbx.on_disk(org.d["slug"]):
        return False, "storage-blocked"
    try:
        sup._deployment_org_gate(org)
    except RuntimeError:
        return False, "deployment-gate"
    return True, ""


def _control_runtime(slug: str, nid: str) -> dict[str, Any]:
    """Snapshot the ephemeral turn and pool state without nested lock order."""
    from . import supervisor as sup                 # noqa: PLC0415
    st = sup.state(slug, nid)
    with sup._state_lock:
        state_part = {
            "busy": bool(st.get("busy")),
            "waiting": bool(st.get("waiting")),
            "responding": bool(st.get("responding")),
            "queued": bool(st.get("queue")),
            "steer": bool(st.get("steer")),
            "phase": st.get("phase"),
            "cache_keepalive": bool(st.get("cache_keepalive")),
            "mcp_readiness_waiting": bool(st.get("mcp_readiness_waiting")),
            "tasks": bool(st.get("tasks")),
            "bg_tasks": bool(st.get("bg_tasks")),
            "proc": bool(st.get("proc") or st.get("codex_turn")
                         or st.get("antigravity_turn")),
            "proc_live": bool(st.get("proc_live")),
            "proc_warm": bool(st.get("proc_warm")),
            "proc_relaunch": bool(st.get("proc_relaunch")),
            "proc_control": st.get("proc_control") is not None,
        }
    # Never hold supervisor._state_lock while taking _pool_lock: lifecycle
    # publication takes the inverse pool -> state path.
    with _pool_lock:
        pooled = _pool.get((slug, nid))
        serving = _serving.get((slug, nid))
        parked = bool(pooled and not pooled.claimed and pooled.alive())
        claimed = bool((pooled and pooled.claimed) or serving)
    return {**state_part, "parked": parked, "claimed": claimed}


def _control_busy_reason(runtime: dict[str, Any]) -> str | None:
    """Human-readable reason a node is not fully idle/admissible."""
    if runtime["proc_control"]:
        return "process control is already in progress"
    if runtime["phase"] == "compacting":
        return "the agent is compacting"
    if runtime["mcp_readiness_waiting"]:
        return "the process is waiting for provider readiness"
    if runtime["waiting"]:
        return "the agent is waiting for a turn slot"
    if runtime["queued"]:
        return "the agent has queued work"
    if runtime["responding"]:
        return "the agent is responding"
    if runtime["busy"] or runtime["proc"]:
        return "the agent has an active turn"
    if runtime["steer"]:
        return "the agent has pending mid-turn delivery"
    if runtime["cache_keepalive"]:
        return "the process is being checked for cache continuity"
    if runtime["tasks"] or runtime["bg_tasks"]:
        return "the agent still has running tasks"
    if runtime["proc_relaunch"]:
        return "the process is awaiting replacement"
    if runtime["claimed"]:
        return "the process is being claimed for a turn"
    return None


def _control_eligibility_text(reason: str) -> str:
    return {
        "frozen": "the agent is frozen",
        "limit-locked": "the agent is limit-locked",
        "remote-controlled": "the agent is under remote control",
        "bearer-state": "the agent is in a bearer lifecycle state",
        "spend-frozen": "organization spending is frozen",
        "inflight": "the agent has a turn pending recovery",
        "delivery-in-progress": "the agent has a delivery in progress",
        "storage-blocked": "the organization storage gate is closed",
        "deployment-gate": "the current deployment profile blocks this org",
        "provider-lane": "this provider lane cannot keep a parked process",
        "sandboxed": "sandboxed process warming is unavailable",
        "preserving-oracle": "preserving oracle processes are not reusable",
        "not-live": "the agent is not live",
        "excluded-by-flag": "the agent is manually stopped",
    }.get(reason, "the agent is not eligible for process warming")


def process_control_status(org: Any, nid: str, *, public: bool = False,
                           ) -> dict[str, Any]:
    """Return the backend-owned control state shown in the desk tooltip."""
    slug = str(org.d.get("slug") or "")
    n = org.nodes.get(nid)
    paused = node_excluded(slug, nid)
    runtime = _control_runtime(slug, nid)
    action: str | None = "start" if paused else (
        "stop" if runtime["parked"] else None)
    result: dict[str, Any] = {
        "paused": paused, "enabled": False, "action": action,
        "reason": None, "runtime": runtime,
    }
    if public:
        result["reason"] = "process controls are available on admin desks only"
        return result
    if n is None:
        result["action"] = None
        result["reason"] = "the agent no longer exists"
        return result
    if n.get("state") != "live":
        result["action"] = None
        result["reason"] = "the agent is not live"
        return result
    blocked = _control_busy_reason(runtime)
    if blocked:
        result["reason"] = blocked
        return result
    if action == "start":
        on, _label = warm_decision()
        if not on:
            result["reason"] = "warming is disabled globally"
            return result
        ok, why = _warm_eligible(org, nid, ignore_exclusion=True)
        if not ok:
            result["reason"] = _control_eligibility_text(why)
            return result
        result["enabled"] = True
        result["reason"] = "click to clear the manual stop and pre-warm"
        return result
    if action == "stop":
        if not runtime["parked"]:
            result["reason"] = "the process is transitioning; wait for it to park"
            return result
        result["enabled"] = True
        result["reason"] = "click to stop this parked process"
        return result
    on, _label = warm_decision()
    if not on:
        result["reason"] = "warming is disabled globally"
    else:
        ok, why = _warm_eligible(org, nid)
        result["reason"] = (_control_eligibility_text(why)
                            if not ok else
                            "no idle parked process to control")
    return result


class ProcessControlRefused(RuntimeError):
    """A stale or unsafe process-control request."""


def _audit_process_control(slug: str, nid: str, action: str, result: str,
                           reason: str, wp: WarmProcess | None = None,
                           ) -> None:
    fields: dict[str, Any] = {
        "slug": slug, "nid": nid, "action": action,
        "result": result, "reason": reason,
    }
    if wp is not None:
        fields.update({"session_id": wp.sid,
                       "pid": getattr(wp.proc, "pid", None),
                       "ident_hash": wp.hash})
    _journal("control", **fields)


def _control_result(slug: str, nid: str, action: str, *,
                    already: bool = False) -> dict[str, Any]:
    from . import supervisor as sup                 # noqa: PLC0415
    st = sup.state(slug, nid)
    with sup._state_lock:
        warm = bool(st.get("proc_warm"))
        live = bool(st.get("proc_live"))
    return {"ok": True, "action": action, "already": already,
            "paused": action == "stop", "proc_warm": warm,
            "proc_live": live}


def _release_process_control(slug: str, nid: str, token: object) -> None:
    """Release the admission reservation and hand off mail that arrived in it."""
    from . import supervisor as sup                 # noqa: PLC0415
    first: str | dict[str, Any] | None = None
    try:
        st = sup.state(slug, nid)
        with sup._state_lock:
            if st.get("proc_control") is not token:
                return
            st.pop("proc_control", None)
            if (not st.get("busy") and not st.get("waiting")
                    and not st.get("steer") and not st.get("cache_keepalive")
                    and st.get("queue")):
                first = st["queue"].pop(0)
                st["busy"] = True
        sup.notify(slug, nid, "proc_control")
        # The first poke may have been consumed while the reservation marker was
        # still set. Wake again after releasing it so a manual start pre-warms
        # immediately instead of waiting for the keeper's polling interval.
        poke()
        if first is not None:
            threading.Thread(target=sup._run_turn,
                             args=(slug, nid, first), daemon=True).start()
    except Exception:                               # noqa: BLE001
        # The marker must never strand a node if a test seam or a shutting-down
        # supervisor disappears while the control request is finishing.
        try:
            st = sup.state(slug, nid)
            with sup._state_lock:
                if st.get("proc_control") is token:
                    st.pop("proc_control", None)
        except Exception:                           # noqa: BLE001
            pass


def process_control(slug: str, nid: str, action: str,
                    ) -> dict[str, Any]:
    """Stop/start one parked process with a durable, generation-safe CAS."""
    if action not in ("start", "stop"):
        raise ProcessControlRefused("action must be 'start' or 'stop'")
    from . import supervisor as sup                 # noqa: PLC0415
    token: object | None = None
    expected: WarmProcess | None = None
    killed = False
    try:
        # DOC_LOCK serializes this admission with retire/rename/freeze writes;
        # state is then reserved before the flag or pool is changed. A turn
        # that reached the state lock first wins and this request refuses.
        with store.DOC_LOCK:
            org = store.load_org(slug)
            n = org.node(nid)
            status = process_control_status(org, nid)
            paused = bool(status["paused"])
            if (action == "stop" and paused) or (
                    action == "start" and not paused and
                    not status["enabled"]):
                _audit_process_control(slug, nid, action, "already",
                                       "manual state already applied")
                return _control_result(slug, nid, action, already=True)
            if not status["enabled"] or status["action"] != action:
                reason = str(status.get("reason") or "process control is unavailable")
                _audit_process_control(slug, nid, action, "refused", reason)
                raise ProcessControlRefused(reason)
            st = sup.state(slug, nid)
            with sup._state_lock:
                # Recheck every gate while reserving the operation. This is
                # the atomic half of stale-UI/racing-turn safety.
                runtime = {
                    "busy": bool(st.get("busy")),
                    "waiting": bool(st.get("waiting")),
                    "responding": bool(st.get("responding")),
                    "queued": bool(st.get("queue")),
                    "steer": bool(st.get("steer")),
                    "phase": st.get("phase"),
                    "cache_keepalive": bool(st.get("cache_keepalive")),
                    "mcp_readiness_waiting": bool(
                        st.get("mcp_readiness_waiting")),
                    "tasks": bool(st.get("tasks")),
                    "bg_tasks": bool(st.get("bg_tasks")),
                    "proc": bool(st.get("proc") or st.get("codex_turn")
                                 or st.get("antigravity_turn")),
                    "proc_relaunch": bool(st.get("proc_relaunch")),
                    "proc_control": st.get("proc_control") is not None,
                    "claimed": False,
                }
                blocked = _control_busy_reason(runtime)
                if blocked:
                    _audit_process_control(slug, nid, action, "refused", blocked)
                    raise ProcessControlRefused(blocked)
                token = object()
                st["proc_control"] = token
            # The pool check is deliberately after releasing state lock: the
            # lifecycle owner may publish a late EOF in pool -> state order.
            with _pool_lock:
                current = _pool.get((slug, nid))
                if _serving.get((slug, nid)) is not None \
                        or (current is not None and current.claimed):
                    reason = "the process is being claimed for a turn"
                    _audit_process_control(slug, nid, action, "refused", reason)
                    raise ProcessControlRefused(reason)
                if action == "stop":
                    if current is None or not current.alive():
                        reason = "the process is transitioning; wait for it to park"
                        _audit_process_control(slug, nid, action, "refused", reason)
                        raise ProcessControlRefused(reason)
                    expected = current
            # Persist the stop BEFORE killing so every keeper pass observes
            # the exclusion. Start rechecks all start-only gates under the same
            # reservation before clearing it.
            if action == "stop":
                set_node_excluded(slug, nid, True)
            else:
                on, _label = warm_decision()
                ok, why = _warm_eligible(org, nid, ignore_exclusion=True)
                if not on:
                    reason = "warming is disabled globally"
                    _audit_process_control(slug, nid, action, "refused", reason)
                    raise ProcessControlRefused(reason)
                if not ok:
                    reason = _control_eligibility_text(why)
                    _audit_process_control(slug, nid, action, "refused", reason)
                    raise ProcessControlRefused(reason)
                set_node_excluded(slug, nid, False)
            _audit_process_control(slug, nid, action, "accepted",
                                   "manual stop" if action == "stop"
                                   else "manual start", expected)
        if action == "stop" and expected is not None:
            killed = kill_node(slug, nid, "excluded-by-flag", expected=expected)
        # Start's flag write wakes the keeper; this second poke closes the
        # reservation window and requests immediate prewarm after release.
        poke()
        result = _control_result(slug, nid, action)
        result["paused"] = action == "stop"
        result["killed"] = killed if action == "stop" else False
        return result
    except WarmFlagError as e:
        _audit_process_control(slug, nid, action, "refused", str(e))
        raise ProcessControlRefused(str(e)) from e
    finally:
        if token is not None:
            _release_process_control(slug, nid, token)


def boundary_check(slug: str, nid: str,
                   want_hash: str | None,
                   wp: WarmProcess | None = None,
                   ) -> tuple[bool, bool | None, str]:
    """The result-boundary decision, with ONE flag read shared between the
    behaviour and the label → (may this process keep serving, the label for
    any admit row this boundary writes, WHY when it may not — the exit
    reason the turn notes on the process so its death row is classified).
    False whenever the switch is off, the node is excluded, eligibility
    lapsed, or the identity hash moved. The boolean answers whether this
    process is current enough to PARK/REUSE, not whether its already-open
    stdin may finish draining queued mail. The supervisor normally treats the
    explicit ``identity-changed`` reason as relaunch-after-drain; every other
    false reason closes delivery immediately. The one semantic exception is
    retirement of a cheap-compact breadcrumb splice, whose contract is that it
    serves exactly one turn. Keeping those state transitions separate prevents
    an ordinary prompt refresh from becoming a mail-delivery gate."""
    on, label = warm_decision()
    if not on:
        return False, label, "disabled"
    if want_hash is None:
        return False, label, "stdin-closed"
    if node_excluded(slug, nid):
        return False, label, "excluded-by-flag"
    try:
        org = store.load_org(slug)
        ok, why = eligible(org, nid)
        if not ok:
            return False, label, why or "not-eligible"
        next_hash, next_components = identity_snapshot(org, nid)
        if next_hash == want_hash:
            return True, label, ""
        fields = identity_change_fields(
            want_hash, wp.ident_components if wp is not None else None,
            next_hash, next_components)
        if wp is not None:
            _record_identity_change(wp, next_hash, next_components)
        # The boundary can beat the save-hook keeper. Delivery may continue
        # on this dirtied process, but it is already known unable to park, so
        # publish the scheduled replacement for the remainder of the busy
        # chain now. `owner` prevents a late boundary from tagging a newer
        # process generation for the same seat.
        _set_proc_lifecycle(
            slug, nid, live=True, relaunch=True,
            reason=_relaunch_text("identity-changed",
                                  fields.get("changed_inputs")),
            owner=wp)
        return False, label, "identity-changed"
    except Exception:                               # noqa: BLE001
        return False, label, "stdin-closed"


def current_hash(slug: str, nid: str) -> str | None:
    """Fresh-off-disk hash for boundary/park-time revalidation; None = 'this
    seat has no valid warm identity RIGHT NOW', which callers must treat as
    'do not feed, do not park'. THE KILL SWITCH IS AUTHORITATIVE HERE TOO
    (process-cache-2 finding, coordinator-ruled): flipping warm.flag off
    mid-turn must stop the very next queued boundary message from riding the
    warm process, or the A/B's off arm is partly on and the back-out lever
    only half works."""
    if not warm_enabled() or node_excluded(slug, nid):
        return None
    try:
        org = store.load_org(slug)
        ok, _why = eligible(org, nid)
        if not ok:
            return None
        return ident_hash(org, nid)
    except Exception:                               # noqa: BLE001
        return None


# ── state mirror for the UI (styling contract: proc_warm boolean) ─────────
def _set_proc_warm(slug: str, nid: str, val: bool) -> None:
    try:
        from . import supervisor as sup             # noqa: PLC0415
        ent = sup.state(slug, nid)      # allocates; takes _state_lock itself
        with sup._state_lock:
            ent["proc_warm"] = val
        sup.notify(slug, nid, "proc_warm" if val else "proc_cold")
    except Exception:                               # noqa: BLE001
        pass


_RELAUNCH_LABELS = {
    "disabled": "warming was disabled",
    "excluded-by-flag": "this agent was excluded from warming",
    "not-live": "the agent is no longer live",
    "provider-lane": "the agent changed provider lane",
    "sandboxed": "the agent changed to sandboxed execution",
    "preserving-oracle": "the agent changed to a preserving oracle",
    "frozen": "the agent is frozen",
    "limit-locked": "the agent is limit-locked",
    "remote-controlled": "the agent is under remote control",
    "bearer-state": "the agent is in a bearer lifecycle state",
    "spend-frozen": "organization spending is frozen",
    "not-eligible": "the agent is no longer eligible for process reuse",
}
_IDENTITY_LABELS = {
    "prompt": "system prompt changed",
    "argv": "CLI launch arguments changed",
    "cred": "CLI credential changed",
    "envov": "CLI environment overrides changed",
}


def _relaunch_text(reason: str,
                   changed: list[str] | None = None) -> str:
    """Reader-shaped, backend-owned reason for replacing a live process."""
    if reason == "identity-changed":
        labels = [_IDENTITY_LABELS.get(x, x) for x in (changed or [])]
        return "identity-changed — " + (", ".join(labels)
                                       if labels else "process identity changed")
    return f"{reason} — {_RELAUNCH_LABELS.get(reason, reason)}"


def _set_proc_lifecycle(slug: str, nid: str, *, live: bool,
                        relaunch: bool = False,
                        reason: str | None = None,
                        owner: Any | None = None,
                        adopt: bool = False) -> None:
    """Mirror one concrete process generation into supervisor/UI state.

    ``owner`` is the WarmProc/Popen/provider-turn object whose liveness this
    transition describes. A late EOF or kill from an older generation may
    journal its own exit, but must not clear a newer generation's live flag.
    ``adopt`` is reserved for the sites that actually install a newly current
    process (claim/spawn/park). Observations from an older owner cannot replace
    the token merely because they arrived later. Calls without an owner retain
    the current token (the cold boundary path, where supervisor owns it).
    """
    try:
        from . import supervisor as sup             # noqa: PLC0415
        ent = sup.state(slug, nid)
        changed = False
        with sup._state_lock:
            current_owner = ent.get("proc_lifecycle_owner")
            if owner is not None:
                if not live and current_owner is not owner:
                    return
                if live and not adopt and current_owner is not None \
                        and current_owner is not owner \
                        and ent.get("proc_live"):
                    # A stale observation cannot mark OR clear the newer live
                    # process. Only an installing site may adopt a new owner.
                    return
            nxt = (bool(live), bool(relaunch), reason if relaunch else None)
            cur = (bool(ent.get("proc_live")), bool(ent.get("proc_relaunch")),
                   ent.get("proc_relaunch_reason"))
            if cur != nxt:
                ent["proc_live"], ent["proc_relaunch"], \
                    ent["proc_relaunch_reason"] = nxt
                changed = True
            if live and owner is not None:
                ent["proc_lifecycle_owner"] = owner
            elif not live:
                ent.pop("proc_lifecycle_owner", None)
        if changed:
            sup.notify(slug, nid, "proc_lifecycle")
    except Exception:                               # noqa: BLE001
        pass


def publish_observed_exit(slug: str, nid: str, owner: Any, *,
                          exited: bool) -> None:
    """Clear liveness only when the caller observed exit.

    The existing lifecycle setter enforces ownership; this helper returns no
    publication result.
    """
    if not exited:
        return
    _set_proc_lifecycle(slug, nid, live=False, owner=owner)


def is_warm(slug: str, nid: str) -> bool:
    with _pool_lock:
        wp = _pool.get((slug, nid))
        return bool(wp and not wp.claimed and wp.alive())


# ── spawn / kill ───────────────────────────────────────────────────────────
# THE CLOSED DEATH LIST, made structural (coordinator ruling 2026-08-30,
# after four separate probes found teardowns outside it), reconciled against
# the user's ruling which names exactly THREE ways a process may end:
# retirement, an explicit system-prompt change, and orgtree shutdown.
#
# How this table maps onto those three — the authoritative statement lives
# in the D-201 register entry; this is its enforcement:
# · retirement, prompt-change — the user's first two, verbatim.
# · SHUTDOWN IS DELIBERATELY NOT A ROW. It is enforced by the OS job object
#   (`_leash` at spawn: KILL_ON_JOB_CLOSE), not by any code path here —
#   which is the only shape that cannot be skipped by a hard kill of the
#   backend. No Python runs when orgtree dies, so a vocabulary row would be
#   a row nothing could ever consult. Pinned by the suite's leash check.
# · kill-switch — an ADDITION to the user's list, coordinator-ordered: the
#   A/B measurement arm and the production back-out lever. A lever that
#   cannot kill is not a lever.
# · duplicate-resolution — an engineering artifact, not a seat death: the
#   hire-kickoff/keeper race can briefly make TWO processes for one seat
#   (the alternative was holding a global lock across Popen on the turn
#   path); the redundant one is killed and THE SEAT KEEPS WARM COVERAGE
#   throughout. Journaled every time, so "rare" stays checkable.
# · observed-death — NOT A KILL AT ALL: bookkeeping for a process found
#   already dead (crash). It is in this table so every pool EXIT carries a
#   class, but it grants nobody permission to end anything.
#
# Every deliberate kill must carry a reason from this table; a reason it
# does not know is journaled as UNLISTED and printed loudly, because an
# unenumerated teardown is exactly the defect family this exists to catch.
KILL_REASON_CLASS = {
    "retired": "retirement", "org-deleted": "retirement",
    "not-live": "retirement",
    "identity-changed": "prompt-change",
    "renamed": "prompt-change",          # a rename changes nid → prompt+argv
    "provider-lane": "prompt-change",    # eligibility flips are model/scope
    "sandboxed": "prompt-change",        # changes, i.e. identity changes
    "preserving-oracle": "prompt-change",
    "frozen": "prompt-change",           # lifecycle gate closed
    "limit-locked": "prompt-change",
    "remote-controlled": "prompt-change",
    "bearer-state": "prompt-change",
    "spend-frozen": "prompt-change",
    "disabled": "kill-switch",           # the coordinator-ordered A/B and
    "excluded-by-flag": "kill-switch",   # back-out lever, sanctioned
    "superseded": "duplicate-resolution",  # the seat KEEPS a warm process
    "crash": "observed-death",           # the process died; we only noticed
    "not-eligible": "prompt-change",     # eligibility lapse = scope change
    # a SERVING process that could not park and drained to exit — today's
    # turn machinery ending a process the old way, journaled so the death
    # is visible, distinct from the pool's own deliberate kills:
    "turn-timeout": "turn-machinery",    # the idle/budget watchdog killed it
    "limit-frozen": "turn-machinery",    # usage limit froze the seat
    "background-children": "turn-machinery",  # lives on till bg agents land
    "stdin-closed": "turn-machinery",    # generic non-park drain-to-exit
    # a Codex app-server whose bounded prewarm initialize() failed, timed out
    # or died is reaped rather than parked-unready forever (user-authorized
    # full-prewarm contract, 2026-09-01). The seat keeps today's retry and
    # cold-fallback semantics: the next keeper pass respawns, turns spawn
    # cold meanwhile, and a process CLAIMED mid-initialize is never touched —
    # its turn owns the aftermath.
    "prewarm-failed": "prewarm-abort",
    "suite-teardown": "test",
}


def _journal_exit_once(wp: WarmProcess, reason: str | None = None) -> None:
    """EXACTLY ONE classified exit row per warm-origin process, whoever gets
    there first — the deliberate-kill paths write it at the kill, the pump's
    EOF writes it for every non-park end the turn only annotated (or for a
    true crash nobody annotated, the observed-death fallback)."""
    with wp._lk:
        if wp.exit_journaled:
            return
        wp.exit_journaled = True
        r = reason or wp.exit_reason or "crash"
        change = (dict(wp.identity_change)
                  if r == "identity-changed" and wp.identity_change else None)
    _journal_proc("exit", wp.slug, wp.nid, r, wp.hash,
                  session_id=wp.sid, pid=getattr(wp.proc, "pid", None),
                  identity_change=change)


def _classify_kill(slug: str, nid: str, reason: str) -> str:
    cls = KILL_REASON_CLASS.get(reason)
    if cls is None:
        print(f"[orgtree] warmpool ⚠ UNLISTED KILL REASON {reason!r} for "
              f"{slug}/{nid} — a warm process is being torn down outside "
              f"the closed death list; this is a defect to report, not a "
              f"style issue")
        return "UNLISTED"
    return cls


def _kill_proc(wp: WarmProcess) -> None:
    """Tree kill: on Windows proc.kill() alone leaves the MCP servers alive
    (see _wd_kill_tree's note) — the CLI's children must die with it."""
    try:
        from . import supervisor as sup             # noqa: PLC0415
        sup._wd_kill_tree(wp.proc)
    except Exception:                               # noqa: BLE001
        try:
            wp.proc.kill()
        except Exception:                           # noqa: BLE001
            pass


# kill → reap bound. NOT a readiness timer and not a new one: it is the same
# bound `codexrun.AppServerClient._kill_tree` already waits on after its own
# taskkill (codexrun.py:522), for the same reason.
_REAP_TIMEOUT_S = 5.0


def _reap(proc: Any) -> None:
    """Wait for a process we just killed, so the death bookkeeping that
    follows OBSERVES an exit instead of racing the kill.

    `_wd_kill_tree` returns before the OS has necessarily reaped anything, and
    `_mcp_tool_count_end` decides what to publish from `poll()`. Without this
    wait a deliberate teardown can publish `loading` for a process it has just
    destroyed — and on the paths that drop the pool entry BEFORE killing there
    is no later observer to correct it. If the wait times out the process
    really is still alive, and `loading` is then the honest answer.
    """
    try:
        proc.wait(timeout=_REAP_TIMEOUT_S)
    except Exception:                               # noqa: BLE001
        pass


def _on_proc_channel_eof(wp: WarmProcess) -> bool:
    """The output channel closed. Free the seat; assert NOTHING about the
    process. Returns whether this generation is ours to journal an exit for.

    Stdout EOF does not prove an exit — a CLI whose MCP children still hold
    the pipe is a measured case on this machine, and it is the case unit 2
    exists for. What EOF DOES prove is that the seat is unusable: nothing can
    be read from a closed channel, so the registries drop it now and a
    replacement may spawn. The death bookkeeping — the exit row, `proc_live`,
    `process-ended` — is deliberately NOT done here. It belongs to
    `_finalize_proc_exit`, which runs only after `proc.wait()` has returned.

    While the process is still OS-live (or cannot be observed) the MCP
    surface is published as channel-closed/LOADING: G1 binds a live process
    to `loading | loaded`, and this is the window an unpublished surface used
    to strand in. When the exit is ALREADY observable at EOF the publish is
    skipped and the finalizer's sequence is byte-for-byte the one this
    function was split out of.

    THAT SKIP IS RARER THAN IT LOOKS, and the honest version is worth stating:
    `poll()` lags the EOF by about a millisecond on this machine, so an
    ORDINARY death usually arrives here still reading as live and does publish
    a transient `loading` — measured at 15/15 immediate deaths, roughly 1ms
    before `process-ended`. That is a cosmetic extra stream event, not a wrong
    state: at the instant it is published the OS genuinely has not yet
    reported the exit, and publishing anything else would be guessing. Do not
    "fix" it with a sleep, a retry or a poll loop; the correction arrives on
    its own, from an observation, which is the entire principle here.
    """
    was_tracked = False
    with _pool_lock:
        if _serving.get((wp.slug, wp.nid)) is wp:
            del _serving[(wp.slug, wp.nid)]
            was_tracked = True
        cur = _pool.get((wp.slug, wp.nid))
        if cur is wp and not wp.claimed:
            del _pool[(wp.slug, wp.nid)]
            was_tracked = True
            _set_proc_warm(wp.slug, wp.nid, False)
    try:
        from . import supervisor as sup                 # noqa: PLC0415
        if sup._mcp_owner_ended(wp.proc) is not True:
            sup._mcp_tool_count_end(wp.slug, wp.nid, wp.proc)
    except Exception:                                   # noqa: BLE001
        pass
    return was_tracked or wp.claimed


def _finalize_proc_exit(wp: WarmProcess, tracked: bool) -> None:
    """The exit was OBSERVED. The one place a warm-origin death is published.

    THE EXIT ROW keeps the registry gate it has always had, and the
    journal-once guard makes this the backstop rather than a duplicate: a
    deliberate kill already wrote its row and this no-ops; a serving process
    that drained to exit carries the reason its turn noted; a true crash falls
    back to observed-death. (A process that already left both registries —
    claimed out and discarded — journaled at the discard.)

    LIFECYCLE AND MCP are published unconditionally, and that is the change,
    not an oversight. Both carry a generation-identity check of their own —
    `proc_lifecycle_owner is owner` (`_set_proc_lifecycle`) and
    `mcp_tool_owner is owner` (`_mcp_tool_count_end`) — which is a strictly
    stronger guard than registry membership and the only one that actually
    protects a SUCCESSOR. Gating them on the registry is what let the
    teardown paths that drop `_pool` BEFORE they kill (`kill_node`,
    `_codex_prewarm_finish`'s abort) leave a killed generation published as
    `loading` with nobody left in the world to finalize it.
    """
    if tracked:
        _journal_exit_once(wp)
    _set_proc_lifecycle(wp.slug, wp.nid, live=False, owner=wp)
    try:
        from . import supervisor as sup                 # noqa: PLC0415
        sup._mcp_tool_count_end(wp.slug, wp.nid, wp.proc)
    except Exception:                                   # noqa: BLE001
        pass


def _on_proc_exit(wp: WarmProcess) -> None:
    """A warm-origin process's own reader thread, at EOF: free the seat, then
    WAIT for the real exit and publish it.

    THE WAIT IS THE UNIT. `_mcp_tool_count_end` refuses to reap a generation
    whose exit it has not observed, and names the lifecycle owner as the thing
    that later confirms it. That confirmation existed on exactly one path —
    a serving turn waits (`supervisor.py:9766`/`:9770`) and ends
    (`:9787`) — and did not exist here. A PARKED process that closed its
    channel while alive therefore kept a live owner published as `loading`
    forever: this callback fired once, at EOF, and nothing observed the death
    that followed. Now it does, on the one thread that is guaranteed to be
    present for the process's whole life and has nothing left to do.

    Blocking is safe and is the point. Both callers reach here having already
    finished their read loop — the stdout pump's `finally` and
    `codexrun.AppServerClient._pump`'s — and both threads are daemon;
    `_kill_tree` does its own bounded wait and joins neither.

    NO timer, transport probe, readiness-layer kill or admission wait is
    introduced: the only thing that moves a generation to `process-ended` is
    still an observed process death, and stdout silence is never an input.
    """
    tracked = _on_proc_channel_eof(wp)
    try:
        wp.proc.wait()
    except Exception:                                   # noqa: BLE001
        pass
    _finalize_proc_exit(wp, tracked)


def _spawn_for(org: Any, nid: str, why: str) -> WarmProcess | None:
    """Spawn and park one CLI process, exactly the shape a turn spawn uses
    (production argv, leashed to the backend's job object). NO prompt is
    written, NO thread is created or resumed, and NO turn is started — a
    parked process makes no API call (parkprobe.py: 2/2 survived, 0
    transcripts, 0 tokens). Claude additionally awaits no handshake (user
    ruling 2026-08-30). A Codex spawn is followed by the keeper's async
    prewarm finisher, which completes initialize()+MCP readiness before the
    seat is called warm — see `_codex_prewarm_finish`."""
    from . import supervisor as sup                 # noqa: PLC0415
    from . import providers                         # noqa: PLC0415
    slug = org.d["slug"]
    t0 = time.time()
    ih = ""
    try:
        model = str(org.node(nid).get("model") or "")
        if model in providers.CODEX_TIERS:
            from . import codexrun                  # noqa: PLC0415

            manifest = sup._codex_startup_manifest(
                org, nid, write_ident=True)
            spec = manifest["provider_spec"]
            sup._codex_require_manifest_account_current(
                manifest, "before prewarm launch")
            ih, components = identity_snapshot(
                org, nid, codex_manifest=manifest)
            _journal_proc("respawn-start", slug, nid, why, ih,
                          session_id=org.node(nid)["session_id"])
            client = codexrun.AppServerClient(
                list(spec["argv_head"]), cwd=str(spec["cwd"]),
                codex_home=str(spec["codex_home"]),
                config_overrides=list(spec["config_overrides"]),
                env_extra=dict(spec["env_extra"]))
            proc = client.proc
            try:
                sup._codex_require_manifest_account_current(
                    manifest, "immediately after prewarm launch")
            except Exception:
                client.close()
                raise
            sup._mcp_tool_count_begin(
                slug, nid, proc, "codex", "mcpServerStatus/list",
                "Codex app-server is initializing (prewarm)",
                org.node(nid).get("last_turn_mcp_tool_count"))
            try:
                sup._leash(proc)
                wp = CodexWarmProc(
                    slug, nid, client, org.node(nid)["session_id"], ih,
                    components)
                client.on_exit = lambda: _on_proc_exit(wp)
                # While parked, MCP startup events refresh the planted
                # inventory the same way a live turn's handler would; a
                # claim's bind() replaces this handler with the turn's own.
                client.on_event = _codex_prewarm_events(wp)
            except Exception:
                # KILL, REAP, THEN END — in that order. This path has NO exit
                # observer at all: the WarmProc that would have carried the
                # pump is exactly what failed to be built, so whatever is
                # published here is final. Ending first would publish
                # `loading` for a child about to be destroyed, and nothing
                # would ever correct it.
                try:
                    sup._wd_kill_tree(proc)
                except Exception:                   # noqa: BLE001
                    try:
                        proc.kill()
                    except Exception:               # noqa: BLE001
                        pass
                _reap(proc)
                sup._mcp_tool_count_end(slug, nid, proc,
                                        "process setup failed")
                raise
            _journal_proc("respawn-done", slug, nid, why, ih,
                          elapsed_ms=int((time.time() - t0) * 1000),
                          session_id=wp.sid,
                          pid=getattr(proc, "pid", None))
            return wp

        cmd = sup._build_cmd(org, nid)
        env = sup.spawn_env(org, tier=str(org.node(nid).get("model") or ""),
                            nid=nid)
        ov = sup.env_overrides(slug, nid)
        ih, components = identity_snapshot(
            org, nid, cmd=cmd, env=env, overrides=ov)
        env_id = sup.identity_in_env(env)
        env["ORGTREE_ORG"], env["ORGTREE_NODE"] = slug, nid
        env["ORGTREE_PORT"] = os.environ.get("ORGTREE_PORT", "7360")
        env["PYTHONPATH"] = (sup.BACKEND_DIR + os.pathsep
                             + env.get("PYTHONPATH", ""))
        _journal_proc("respawn-start", slug, nid, why, ih)
        # D-218: identity hashed the INLINE argv above; the OS gets the
        # settings parked in a file, or Windows' 32,767-char CreateProcess
        # cap kills every pre-warm of a broad-ro-grant node ([WinError 206])
        proc = _POPEN(
            sup.spawn_argv(org, nid, cmd),
            cwd=sup.scratch_dir(slug, nid), env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8",
            errors="replace",
            creationflags=(subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
                           if os.name == "nt" else 0))
        try:
            sup._leash(proc)
            sup._mcp_tool_count_begin(
                slug, nid, proc, "claude", "system/init.tools",
                "Claude process is starting; runtime tools are not resolved yet",
                org.node(nid).get("last_turn_mcp_tool_count"))
            wp = WarmProc(slug, nid, proc,
                          org.node(nid)["session_id"], ih, env_id,
                          components)
        except Exception:
            # setup died AFTER the child existed: reap it or every keeper
            # retry leaks a CLI+MCP tree while turns stay correct — the
            # silent-fallback shape (process-cache-2's spawn-cleanup probe).
            # KILL, REAP, THEN END: `WarmProc.__init__` is what starts the
            # pump, so a failure here leaves the process with no exit observer
            # and this the last word on it. Ending before the kill would
            # publish `loading` for a doomed child forever.
            try:
                sup._wd_kill_tree(proc)
            except Exception:                       # noqa: BLE001
                try:
                    proc.kill()
                except Exception:                   # noqa: BLE001
                    pass
            _reap(proc)
            sup._mcp_tool_count_end(slug, nid, proc,
                                    "process setup failed")
            raise
        _journal_proc("respawn-done", slug, nid, why, ih,
                      elapsed_ms=int((time.time() - t0) * 1000))
        return wp
    except Exception as e:                          # noqa: BLE001
        # a failed pre-warm is a non-event for the agent: the next turn just
        # spawns cold, exactly like today. Log it — silently degrading to
        # 100% cold with every test green is this feature's failure mode.
        print(f"[orgtree] warmpool: pre-warm of {slug}/{nid} failed "
              f"({type(e).__name__}: {e}) — the agent falls back to "
              f"spawn-per-turn and notices nothing")
        # …and JOURNAL it (D-218): the print alone proved invisible in
        # practice — 2026-09-01's [WinError 206] spawn deaths repeated for
        # hours while warm.jsonl showed ZERO prewarm-failed rows, because a
        # spawn the OS refuses (no PID, no process) never reached any journal
        # writer. The flight recorder must see the failures it exists for.
        try:
            sid = str(org.node(nid).get("session_id") or "") or None
        except Exception:                           # noqa: BLE001
            sid = None
        _journal_proc("prewarm-failed", slug, nid,
                      f"spawn: {type(e).__name__}: {e}"[:300], ih,
                      elapsed_ms=int((time.time() - t0) * 1000),
                      session_id=sid)
        return None


def _codex_prewarm_events(wp: CodexWarmProc) -> Any:
    """A parked-period on_event handler: MCP startup transitions re-list the
    runtime inventory so the planted surface tracks servers as they connect.
    The refresh runs OFF the wire-reader thread (a request from the reader
    would deadlock against itself), one at a time, and stands down the moment
    the process is claimed — the turn installs its own handler via bind()."""
    gate = threading.Lock()

    def _refresh() -> None:
        from . import supervisor as sup             # noqa: PLC0415
        with gate:
            if wp.claimed:
                return
            try:
                names = wp.client.mcp_tool_names()
            except Exception as e:                  # noqa: BLE001
                sup._mcp_tool_count_unknown(
                    wp.slug, wp.nid, wp.proc, "codex", "mcpServerStatus/list",
                    f"Codex runtime inventory unavailable: {type(e).__name__}")
                return
            sup._mcp_tool_count_names(
                wp.slug, wp.nid, wp.proc, names, "codex",
                "mcpServerStatus/list")

    def _on_event(msg: dict[str, Any]) -> None:
        if wp.claimed:
            return
        if str(msg.get("method") or "") in (
                "mcpServer/startupStatus/updated",
                "mcpServer/event/stream/notification"):
            threading.Thread(target=_refresh, daemon=True,
                             name=f"warmmcp-{wp.slug}-{wp.nid}").start()

    return _on_event


def _codex_prewarm_finish(org: Any, nid: str, wp: CodexWarmProc) -> None:
    """Complete a parked app-server's LOCAL readiness, then call it warm.

    Runs off-keeper after the process is parked (already claimable, so a
    racing first claim keeps its exact-PID-reuse contract and simply finds
    initialize() already done or in flight — the client's initialize lock
    keeps it once-per-process either way). Sends no thread or turn traffic
    and reads no provider cache: this is process/MCP readiness only.

      · initialize() failure/timeout/death → kill and reap THIS generation
        (`prewarm-failed`), unless a turn claimed it meanwhile — then the
        turn owns the process and its own initialize tells the story.
      · MCP inventory is planted from mcpServerStatus/list; an unanswerable
        inventory is an EXPLICIT degraded outcome, not a lie and not a kill.
      · the bounded readiness gate then runs exactly as a turn would run it;
        `timed-out` degrades, `cancelled`/`generation-changed` abort quietly
        (someone else owns the seat's story), every fail-open outcome is
        ready.
    Only after that is `proc_warm` raised — the UI's initializing→ready/
    degraded transitions are the true process story, not a claimable flag.
    """
    from . import supervisor as sup                 # noqa: PLC0415
    slug = wp.slug
    t0 = time.time()

    def _ours_and_parked() -> bool:
        with _pool_lock:
            return _pool.get((slug, nid)) is wp and not wp.claimed
    try:
        wp.client.initialize(timeout=CODEX_PREWARM_INIT_TIMEOUT_S)
    except Exception as e:                          # noqa: BLE001
        with _pool_lock:
            ours = _pool.get((slug, nid)) is wp
            claimed = wp.claimed
            if ours and not claimed:
                del _pool[(slug, nid)]
        if claimed:
            return          # the turn owns this process and its story
        # the attribution row is written even when the EOF pump already
        # reaped the corpse (its exit row says crash; this one says WHOSE
        # handshake it was that failed, and how long it was given)
        _journal_proc("prewarm-failed", slug, nid,
                      f"initialize: {type(e).__name__}: {e}"[:300], wp.hash,
                      elapsed_ms=int((time.time() - t0) * 1000),
                      session_id=wp.sid, pid=getattr(wp.proc, "pid", None))
        if not ours:
            return          # already reaped/replaced; nothing left to clean
        _kill_proc(wp)
        # the pool entry went above, BEFORE the kill, so the wire reader's
        # `on_exit` will find this generation untracked; reap it here so the
        # end below observes the corpse rather than racing the kill
        _reap(wp.proc)
        _set_proc_warm(slug, nid, False)
        _set_proc_lifecycle(slug, nid, live=False, owner=wp)
        try:
            sup._mcp_tool_count_end(slug, nid, wp.proc,
                                    "prewarm initialize failed")
        except Exception:                           # noqa: BLE001
            pass
        _journal_exit_once(wp, "prewarm-failed")
        return
    degraded_reason = ""
    try:
        names = wp.client.mcp_tool_names()
        sup._mcp_tool_count_names(slug, nid, wp.proc, names, "codex",
                                  "mcpServerStatus/list")
    except Exception as e:                          # noqa: BLE001
        degraded_reason = (f"Codex runtime inventory unavailable: "
                           f"{type(e).__name__}")
        try:
            sup._mcp_tool_count_unknown(slug, nid, wp.proc, "codex",
                                        "mcpServerStatus/list",
                                        degraded_reason)
        except Exception:                           # noqa: BLE001
            pass
    if not _ours_and_parked():
        return              # a turn took it; nothing left to mark here
    gate = "unavailable"
    try:
        fingerprint = sup._mcp_infrastructure_fingerprint(org, nid)
        gate = sup._mcp_wait_for_surface(org, nid, wp.proc, "openai",
                                         fingerprint)
    except Exception:                               # noqa: BLE001
        pass
    if gate in ("cancelled", "generation-changed"):
        return
    if gate == "timed-out" and not degraded_reason:
        degraded_reason = "MCP readiness timed out during prewarm"
    outcome = "degraded" if degraded_reason else "ready"
    with _pool_lock:
        current = (_pool.get((slug, nid)) is wp and not wp.claimed
                   and wp.alive())
        if current:
            with wp._lk:
                wp.warm_state = outcome
    if not current:
        return
    if outcome == "degraded":
        try:
            sup._mcp_readiness_set(slug, nid, wp.proc, waiting=False,
                                   state_name="degraded",
                                   reason=degraded_reason)
        except Exception:                           # noqa: BLE001
            pass
    _set_proc_warm(slug, nid, True)
    _journal_proc(f"prewarm-{outcome}", slug, nid,
                  degraded_reason or gate, wp.hash,
                  elapsed_ms=int((time.time() - t0) * 1000),
                  session_id=wp.sid, pid=getattr(wp.proc, "pid", None))


def kill_node(slug: str, nid: str, reason: str,
              expected: WarmProcess | None = None) -> bool:
    """Immediate teardown for a node's warm process (retire, dissolve,
    rename — a parked process's cwd would block the scratch move). A CLAIMED
    process is mid-turn and is NOT touched: the turn owns it, and the keeper
    handles the aftermath at turn end."""
    with _pool_lock:
        wp = _pool.get((slug, nid))
        if wp is None or wp.claimed \
                or (expected is not None and wp is not expected):
            return False
        del _pool[(slug, nid)]
    _kill_proc(wp)
    # same reason as `_codex_prewarm_finish`: the pool entry is already gone,
    # so the pump's EOF callback finds this generation untracked and cannot be
    # relied on to close it out. Observe the death here before publishing it.
    _reap(wp.proc)
    _set_proc_warm(slug, nid, False)
    _set_proc_lifecycle(slug, nid, live=False, owner=wp)
    try:
        from . import supervisor as sup                 # noqa: PLC0415
        sup._mcp_tool_count_end(slug, nid, wp.proc)
    except Exception:                                   # noqa: BLE001
        pass
    _journal_exit_once(wp, reason)
    return True


def kill_org(slug: str, reason: str) -> None:
    with _pool_lock:
        keys = [k for k in _pool if k[0] == slug]
    for _s, nid in keys:
        kill_node(slug, nid, reason)


# ── the turn-side API ──────────────────────────────────────────────────────
_CLAIM_SNAPSHOT = threading.local()


def claim_snapshot(slug: str, nid: str, want_hash: str,
                   want_components: dict[str, str] | None,
                   ) -> tuple[WarmProcess | None, str]:
    """Carry the turn's exact component snapshot into the stable 3-argument
    claim seam. The thread local avoids cross-turn races and deliberately
    calls `claim` by name so the suite's death-between-claim-and-write mutant
    can still wrap that seam without learning a new signature."""
    _CLAIM_SNAPSHOT.value = (slug, nid, want_hash, want_components)
    try:
        return claim(slug, nid, want_hash)
    finally:
        _CLAIM_SNAPSHOT.value = None


def claim(slug: str, nid: str,
          want_hash: str) -> tuple[WarmProcess | None, str]:
    """Hand the pooled process to a starting turn IFF it is alive and holds
    the current identity hash. A mismatch is killed on the spot (stale prompt
    = correctness hazard, never served) and the caller spawns cold. The
    second return is the admit-journal reason when no process is served.

    A CLAIMED process moves from the pool to the SERVING registry — the turn
    owns it, and `park_back` is the only way back in. The pool therefore
    holds parked processes only, which is also exactly what `proc_warm`
    means; the serving registry exists so telemetry still sees the process.

    THE CALLER OWNS THE FLAG DECISION: this function does not consult
    warm_enabled() — the spawn site read the flag exactly once and only
    calls here when that read said on. A second read here could disagree
    with the label the admit row carries (cache-misses' misattribution
    hazard)."""
    snap = getattr(_CLAIM_SNAPSHOT, "value", None)
    want_components = (snap[3]
                       if snap and snap[:3] == (slug, nid, want_hash) else None)
    with _pool_lock:
        wp = _pool.get((slug, nid))
        if wp is None:
            return None, "no-process"
        was_alive = wp.alive()          # decided BEFORE any kill, or the
        del _pool[(slug, nid)]          # journal always says "crash"
        if was_alive and wp.hash == want_hash:
            wp.attach()
            _serving[(slug, nid)] = wp
            _set_proc_warm(slug, nid, False)   # claimed = no longer parked
            _set_proc_lifecycle(slug, nid, live=True, owner=wp, adopt=True)
            return wp, "warm-hit"
    # (outside the lock) the mismatched/dead one dies now
    if was_alive:
        _record_identity_change(wp, want_hash, want_components)
    _kill_proc(wp)
    _set_proc_warm(slug, nid, False)
    _set_proc_lifecycle(slug, nid, live=False, owner=wp)
    _journal_exit_once(wp, "identity-changed" if was_alive else "crash")
    return None, ("identity-changed" if was_alive else "crashed")


def _mcp_reclaim_from_loser(winner: WarmProcess, loser: WarmProcess) -> None:
    """A double-spawn is resolved in favour of the process that ran the turn —
    but the LOSER may hold the seat's MCP ownership, because it spawned second
    and its `_mcp_tool_count_begin` therefore adopted last. Killing it then
    publishes `process-ended` and clears the surface, and the survivor — parked,
    OS-LIVE, the seat's only process — is left with no surface at all. That is
    the G1 violation stated exactly: an active process whose MCP state is
    neither loading nor loaded.

    Ownership moves to the winner here, through the ordinary adoption path:
    unknown count, no names, readiness `initializing`. The loser's inventory is
    deliberately NOT inherited — a corpse's tools wearing a live process's name
    is the defect `_mcp_tool_count_begin` documents at length — and the durable
    `last_turn_mcp_tool_count` is read and handed back, because passing None
    there POPS it, which would discard a measured-earlier value this race has
    no business touching.

    THE CONDITION IS ABOUT THE WINNER, NOT THE LOSER, and that is load-bearing:
    the loser's own pump is racing this call, and if its finalizer lands first
    the seat is ALREADY cleared — asking "does the loser still own it?" then
    answers no and adopts nothing, which is the very hole this closes (measured:
    the race is lost about as often as it is won). Asking "does the WINNER own
    it?" is correct from either side of that race, and if the winner already
    owns it `_mcp_tool_count_begin`'s same-owner early return makes this a
    no-op rather than a surface reset. The loser's finalizer, arriving after,
    fails its own owner check and cannot take the seat back.

    Confined to the double-spawn branch: on an ordinary park there is no loser
    and this is never reached.
    """
    try:
        from . import supervisor as sup                 # noqa: PLC0415
        ent = sup.state(winner.slug, winner.nid)
        with sup._state_lock:
            if ent.get("mcp_tool_owner") is winner.proc:
                return                          # already the seat's surface
            last = ent.get("last_turn_mcp_tool_count")
        codex = getattr(winner, "client", None) is not None
        sup._mcp_tool_count_begin(
            winner.slug, winner.nid, winner.proc,
            "codex" if codex else "claude",
            "mcpServerStatus/list" if codex else "system/init.tools",
            "a double-spawn was resolved in favour of this process; its "
            "runtime tools are not resolved yet",
            last if isinstance(last, int) and not isinstance(last, bool)
            else None)
    except Exception:                                   # noqa: BLE001
        pass


def park_back(wp: WarmProcess, cost_base: float, out_base: int = 0) -> bool:
    """A turn finished on this process and nothing dirtied it: return it to
    the pool. If the pool already holds a DIFFERENT process for the seat (the
    hire-kickoff race can double-spawn), prefer THIS one — it holds the
    conversation hot and its next request is a pure cache extension — and
    kill the other."""
    if not wp.alive() or not warm_enabled():
        return False
    other: WarmProcess | None = None
    with _pool_lock:
        if _serving.get((wp.slug, wp.nid)) is wp:
            del _serving[(wp.slug, wp.nid)]
        other = _pool.get((wp.slug, wp.nid))
        if other is wp:
            other = None
        with wp._lk:
            wp.active = False       # close the delivery gate BEFORE parking:
            wp.claimed = False      # post-park stragglers must never queue
        _pool[(wp.slug, wp.nid)] = wp
        wp.parked_at = time.time()
        # cumulative counters only grow; max() so a turn that saw no cost
        # event cannot roll an earlier baseline back
        wp.cost_base = max(wp.cost_base, cost_base)
        wp.out_base = max(wp.out_base, out_base)
    if other is not None:
        _kill_proc(other)
        _journal_exit_once(other, "superseded")
        _mcp_reclaim_from_loser(wp, other)
    _set_proc_warm(wp.slug, wp.nid, True)
    _set_proc_lifecycle(wp.slug, wp.nid, live=True, owner=wp, adopt=True)
    _journal_proc("park", wp.slug, wp.nid, "turn-end", wp.hash)
    return True


def discard(wp: WarmProcess, reason: str) -> None:
    """A turn ends on a process that must not be parked (dirtied mid-turn,
    background children live, limit hit). Kill it — today's teardown."""
    with _pool_lock:
        if _pool.get((wp.slug, wp.nid)) is wp:
            del _pool[(wp.slug, wp.nid)]
        if _serving.get((wp.slug, wp.nid)) is wp:
            del _serving[(wp.slug, wp.nid)]
    _kill_proc(wp)
    _set_proc_warm(wp.slug, wp.nid, False)
    _set_proc_lifecycle(wp.slug, wp.nid, live=False, owner=wp)
    _journal_exit_once(wp, reason)


def poke() -> None:
    """Wake the keeper now — called from store.save_hooks (any org change may
    have dirtied a prompt) and from hire/retire/turn-end sites. Idempotent
    and cheap; the keeper does the hashing."""
    _poke.set()


# ── the keeper ─────────────────────────────────────────────────────────────
def _busy(slug: str, nid: str) -> bool:
    """A seat is skipped only while a turn actually RUNS on it (its park owns
    the pool slot then). `waiting` and a non-empty queue are deliberately NOT
    grounds to skip (process-cache-2 finding, coordinator-ruled): a seat
    blocked on a turn slot benefits most from a spawn racing its wait, and
    the double-spawn that race can produce is resolved at park time
    (`park_back` keeps the just-ran process and kills the other)."""
    from . import supervisor as sup                 # noqa: PLC0415
    with sup._state_lock:
        ent = sup._state.get((slug, nid)) or {}
        return bool(ent.get("busy") or ent.get("proc_control"))


def _keeper_pass() -> None:
    from . import supervisor as sup                 # noqa: PLC0415
    if not warm_enabled():
        # the OFF arm must be clean for the A/B: parked processes are torn
        # down, not merely unused, so "warm off" measures today's behaviour
        with _pool_lock:
            keys = list(_pool)
        for slug, nid in keys:
            kill_node(slug, nid, "disabled")
        return
    orgs = store.list_orgs()
    known = {o["slug"] for o in orgs}
    # a DELETED org never appears in the loop below — its parked processes
    # would otherwise be orphans no pass ever visits
    with _pool_lock:
        gone = [k for k in _pool if k[0] not in known]
    for slug, nid in gone:
        kill_node(slug, nid, "org-deleted")
    for o in orgs:
        slug = o["slug"]
        try:
            org = store.load_org(slug)
        except Exception:                           # noqa: BLE001
            continue
        live = {k for k, n in org.nodes.items() if n.get("state") == "live"}
        # reap processes whose seat is gone or no longer eligible — retire
        # and dissolve do not touch process state anywhere else (measured
        # gap: supervisor leaves st["proc"] and _state intact on archive)
        with _pool_lock:
            held = [k for k in _pool if k[0] == slug]
        for _s, nid in held:
            if nid not in live:
                kill_node(slug, nid, "retired")
                continue
            ok, why = eligible(org, nid)
            if not ok:
                kill_node(slug, nid, why)
        for nid in sorted(live):
            ok, _why = eligible(org, nid)
            busy = _busy(slug, nid)
            if busy:
                # A serving warm process keeps running to a safe boundary, but
                # a save-hook keeper pass can already know it is stale. Expose
                # that scheduled replacement immediately, including WHICH
                # identity input moved, rather than waiting for the boundary.
                with _pool_lock:
                    serving = _serving.get((slug, nid))
                if serving is not None and serving.alive():
                    if not ok:
                        _set_proc_lifecycle(
                            slug, nid, live=True, relaunch=True,
                            reason=_relaunch_text(_why or "not-eligible"),
                            owner=serving)
                    else:
                        try:
                            h, parts = identity_snapshot(org, nid)
                            if h != serving.hash:
                                fields = identity_change_fields(
                                    serving.hash, serving.ident_components,
                                    h, parts)
                                _set_proc_lifecycle(
                                    slug, nid, live=True, relaunch=True,
                                    reason=_relaunch_text(
                                        "identity-changed",
                                        fields.get("changed_inputs")),
                                    owner=serving)
                            else:
                                # A later pass is an observation too. If this
                                # exact serving generation is current again
                                # (for example a transient stub/probe result),
                                # clear its earlier scheduled-relaunch flag.
                                _set_proc_lifecycle(
                                    slug, nid, live=True, owner=serving)
                        except Exception:           # noqa: BLE001
                            pass
                continue
            if not ok:
                continue
            with _pool_lock:
                wp = _pool.get((slug, nid))
                if wp is not None and wp.claimed:
                    continue
            if wp is not None and not wp.alive():
                with _pool_lock:
                    if _pool.get((slug, nid)) is wp:
                        del _pool[(slug, nid)]
                _set_proc_warm(slug, nid, False)
                # Keep the same session/pid join contract as every other
                # exit owner, and share the once-only guard with the EOF pump.
                _journal_exit_once(wp, "crash")
                wp = None
            try:
                h, next_components = identity_snapshot(org, nid)
            except Exception:                       # noqa: BLE001
                continue
            if wp is not None and wp.hash == h:
                continue                             # warm and current
            if wp is not None:
                # THE SYSTEM PROMPT CHANGED — the only respawn reason there
                # is. Immediate and eager (user ruling): kill and re-warm
                # now, in the background, so the new process is ready before
                # any turn arrives.
                change = _record_identity_change(wp, h, next_components)
                _journal_proc("dirty", slug, nid, "identity-changed", h,
                              session_id=wp.sid,
                              pid=getattr(wp.proc, "pid", None),
                              identity_change=change)
                kill_node(slug, nid, "identity-changed")
            with _spawn_gate:
                if _busy(slug, nid):                 # a turn started meanwhile
                    continue
                nwp = _spawn_for(org, nid, "pre-warm" if wp is None
                                 else "identity-changed")
            if nwp is None:
                continue
            with _pool_lock:
                if _pool.get((slug, nid)) is None and not _busy(slug, nid):
                    _pool[(slug, nid)] = nwp
                    nwp.claimed = False
                else:
                    # raced a turn (its park wins) or a parallel spawn: kill
                    # OUR redundant spawn — the seat keeps warm coverage
                    # through the winner. Journaled like every other exit;
                    # an unjournaled kill is an exit with no tripwire on it.
                    _kill_proc(nwp)
                    _journal_exit_once(nwp, "superseded")
                    nwp = None
            if nwp is not None:
                _set_proc_lifecycle(slug, nid, live=True, owner=nwp,
                                    adopt=True)
                if isinstance(nwp, CodexWarmProc):
                    # full Codex prewarm: the seat is called warm only after
                    # the async finisher proves initialize()+MCP readiness
                    # (or explicit degradation). The process is already
                    # parked and claimable — a racing turn loses nothing.
                    threading.Thread(
                        target=_codex_prewarm_finish, args=(org, nid, nwp),
                        daemon=True, name=f"codexwarm-{slug}-{nid}").start()
                else:
                    _set_proc_warm(slug, nid, True)


def _pool_snapshot() -> None:
    """The line that decides whether warming actually holds. `eligible` is
    counted from the POPULATION THAT SHOULD BE WARM (live + eligible, straight
    off the org docs), never from the pool itself — `eligible=len(entries)`
    was refused in review as an instrument mathematically incapable of
    reporting a failed pre-warm. warm_count < eligible IS the underwarming
    signal. RSS sums each CLI's WHOLE process tree: the MCP servers and any
    wrapper are the part of the memory question nobody counts."""
    with _pool_lock:
        parked = [(wp.proc.pid, wp.slug, wp.nid) for wp in _pool.values()
                  if wp.alive()]
        serving = [(wp.proc.pid, wp.slug, wp.nid)
                   for wp in _serving.values() if wp.alive()]
    entries = parked + serving
    elig_total = 0
    for o in store.list_orgs():
        try:
            org = store.load_org(o["slug"])
        except Exception:                            # noqa: BLE001
            continue
        for nid, n in org.nodes.items():
            if n.get("state") == "live" and eligible(org, nid)[0]:
                elig_total += 1
    rss_total = 0
    free = 0
    try:
        import psutil                                # noqa: PLC0415
        for pid, _s, _n in entries:
            try:
                p = psutil.Process(pid)
                rss_total += p.memory_info().rss
                for c in p.children(recursive=True):
                    try:
                        rss_total += c.memory_info().rss
                    except Exception:                # noqa: BLE001
                        pass
            except Exception:                        # noqa: BLE001
                pass
        free = psutil.virtual_memory().available
    except ImportError:
        pass                                         # psutil absent: sizes 0
    # warm_count is EVERY warm-origin process (parked + serving): counting
    # parked alone structurally hid each serving process and reported half
    # the real memory in process-cache-2's two-stub probe — understating the
    # ceiling in the reassuring direction, on the number the user asked for
    _journal("pool", warm_count=len(entries), parked=len(parked),
             serving=len(serving), eligible=elig_total,
             rss_total_mb=round(rss_total / 1048576, 1),
             free_ram_mb=round(free / 1048576, 1), evictions_total=0)


def keeper_pass_now() -> None:
    """Synchronous single pass — the test seam process-cache-2 asked for:
    deterministic reconcile without waiting on the keeper's own clock."""
    _keeper_pass()


def _keeper() -> None:
    last_snap = 0.0
    while True:
        _poke.wait(WARM_POLL)
        _poke.clear()
        try:
            _keeper_pass()
        except Exception as e:                      # noqa: BLE001
            print(f"[orgtree] warmpool keeper pass failed: "
                  f"{type(e).__name__}: {e}")
        if time.time() - last_snap >= POOL_SNAP_EVERY:
            last_snap = time.time()
            try:
                _pool_snapshot()
            except Exception:                       # noqa: BLE001
                pass


def start_warm_pool() -> None:
    """Boot engine, same singleton shape as the other start_* loops. The
    first keeper pass IS the boot pre-warm: every live eligible agent gets a
    parked process before any turn arrives (user ruling: all of them, no
    subset, no cap — if the memory does not fit, that is measured by the
    pool snapshots and ruled on by a human, not quietly capped here)."""
    global _started
    if _started:
        return
    _started = True
    store.save_hooks.append(lambda _slug: _poke.set())
    # THE FIRST PASS RUNS SYNCHRONOUSLY, before this returns and therefore
    # before any driver (auto-resume, reconcile's re-drives, the first API
    # request) can start a turn. The user's ruling is "start all active
    # agents' processes immediately on orgtree launch, BEFORE a turn begins"
    # — an async first pass made the feature absent at exactly the moment it
    # was specified to be present, on every one of ~10 restarts a day
    # (process-cache-2's finding, coordinator-ruled).
    try:
        _keeper_pass()
    except Exception as e:                          # noqa: BLE001
        print(f"[orgtree] warmpool boot pass failed: {type(e).__name__}: {e}")
    threading.Thread(target=_keeper, daemon=True, name="warmpool").start()
