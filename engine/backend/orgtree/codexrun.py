# pyright: strict
"""The Codex turn runner over a reusable `codex app-server` JSON-RPC client.

FR-15 Phase 1 (design-multi-provider.md §3.2 + Appendix B/C, all measured on
codex-cli 0.150.1 against a live account). The shape deliberately mirrors the
Claude lane: one turn object at a time, resumed by a durable session id — here
the app-server `threadId`, harvested from `thread/start` and passed back
through `thread/resume` on the next turn. The process itself may come from the
warm pool and survive that boundary. Steering and interrupting act on the
LIVE client object the supervisor holds while the turn runs:

    turn/steer      — append input to the in-flight turn (expectedTurnId
                      guard; measured landing inside the same turn, C.2)
    turn/interrupt  — graceful stop; the turn completes with
                      status "interrupted" (C.3)

Org powers attach as **dynamicTools** (measured round-trip, M6 probe): the
thread is started with the orgtree tool cards as client-defined function
tools; the model's calls arrive as `item/tool/call` server-requests and the
supervisor answers them in-process — no bridge process, no writes to the
user's codex config, and per-agent identity is simply which dispatcher
answers. Approval callbacks (`item/commandExecution/requestApproval`,
`item/fileChange/requestApproval`, …) arrive the same way and are decided by
the caller-supplied policy hook — that is the ⚙-rights seam.

⚠ CREDENTIALS: this module never reads, copies or moves auth material. The
CLI process inherits CODEX_HOME (default: the machine's own ~/.codex, the
signed-in primary) and maintains its own auth.json in place. Copying that
file anywhere would split-brain the refresh cycle (design §3.4); nothing
here, and nothing built on top of this, may do it.

Hermetic by construction: everything is parameterized (exe, home, cwd,
hooks), so tests drive it against an impostor script instead of the real
CLI — see backend/tests/test_codexrun.py.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
from collections import deque
from collections.abc import Callable
from typing import Any, Final, cast

#: how long request() waits before declaring the server unresponsive. Turns
#: themselves are unbounded (the caller owns the turn timeout); this bounds
#: single request/response exchanges like initialize or thread/start.
REQUEST_TIMEOUT: Final = 120.0

#: normalized turn statuses (M2 vocabulary): the supervisor's policy layer
#: consumes these, never codex's raw strings. "interrupted" is a completed
#: turn (C.3) — codex reports it inside turn/completed, not as a failure.
STATUS_COMPLETED: Final = "completed"
STATUS_INTERRUPTED: Final = "interrupted"
STATUS_FAILED: Final = "failed"

#: codex's own `TurnStatus` → ours (D-209). ⚠ THERE IS NO `turn/failed`
#: NOTIFICATION IN codex-cli 0.150.1 — the literal string does not occur
#: anywhere in the binary, and the notification set interned there is
#: turn/started, turn/completed, turn/diff/updated, turn/plan/updated. A FAILED
#: turn arrives as `turn/completed` carrying `turn.status = "failed"` and a
#: `turn.error`, and codex's TurnStatus enum is exactly
#: completed | interrupted | failed | inProgress.
#:
#: ⚠ THIS TABLE IS THE DEFECT'S WHOLE STORY. What stood here was
#: `INTERRUPTED if raw == "interrupted" else COMPLETED`, so "failed" WAS
#: "completed": a Codex agent that hit its usage limit had the failure booked
#: as a successful turn — normal tokens, normal cost, no error row, no freeze
#: — and simply went quiet. Measured on cache-structural, 2026-08-30T22:41:41Z,
#: silent for 9h47m until a person noticed.
_TURN_STATUS: Final = {
    "completed": STATUS_COMPLETED,
    "interrupted": STATUS_INTERRUPTED,
    "failed": STATUS_FAILED,
}


def _status_of(raw: str) -> str:
    """Normalize one of codex's turn statuses.

    ⚠ AN UNKNOWN STATUS IS A FAILURE, NOT A SUCCESS, and the asymmetry is
    deliberate: `compact_fork` in this same module already refuses anything
    outside (completed, interrupted), and the cost of the two mistakes is not
    symmetric. Calling a healthy new status a failure costs one visible error
    row the operator can read and complain about; calling a failure a success
    is what made an agent disappear for ten hours with nobody able to tell it
    from an idle one."""
    return _TURN_STATUS.get(raw.strip(), STATUS_FAILED) if raw else (
        STATUS_COMPLETED)


def error_text(error: Any) -> str:
    """A `TurnError` flattened into the one string the classifiers read.

    The wire shape is `{message, codexErrorInfo, additionalDetails}` (measured:
    `struct TurnError with 3 elements` in the 0.150.1 binary), and
    `codexErrorInfo` is a short machine tag — `"usage_limit_exceeded"` in the
    specimen. Both halves are kept: the MESSAGE is what
    `supervisor._looks_like_usage_limit` matches on and what a person reads,
    the TAG is what survives a wording change upstream.

    Never raises and never returns None — a caller building a failure blob has
    nothing else to fall back on but the stderr tail, which for a limit is
    empty (the app-server says all of this on the wire, not on stderr)."""
    if not isinstance(error, dict):
        return ""
    err: dict[str, Any] = error
    msg = str(err.get("message") or "").strip()
    extra = str(err.get("additionalDetails") or "").strip()
    info: Any = err.get("codexErrorInfo")
    if isinstance(info, dict):
        # the tagged-object form, should the protocol ever send one
        code = str(info.get("type") or info.get("kind") or "").strip()
    else:
        code = str(info or "").strip()
    out = " — ".join(p for p in (msg, extra) if p)
    if code and code.lower() not in out.lower():
        out = f"{out} [{code}]" if out else code
    return out[:600]


def _window_reset(window: Any) -> float | None:
    """`resetsAt` of a window that is actually EXHAUSTED, or None.

    Only a window at 100% describes the wall the turn just hit. A window with
    room left has a reset time too, and taking it would park the agent on a
    deadline belonging to a limit it never reached."""
    if not isinstance(window, dict):
        return None
    win: dict[str, Any] = window
    try:
        if float(win.get("usedPercent") or 0) < 100.0:
            return None
        return float(win.get("resetsAt") or 0) or None
    except (TypeError, ValueError):
        return None


def limit_reset_epoch(snapshots: Any) -> float | None:
    """The soonest reset among the EXHAUSTED windows of every rate-limit
    snapshot the turn saw → epoch seconds, or None (D-209).

    This is the number the prose usually cannot give us. The specimen's message
    said "try again at Sep 6th, 2026 10:33 AM", which no reset parser in this
    codebase can read; the notification 298 ms earlier carried
    `resets_at: 1788680032`, which is that instant exactly.

    ⚠ TAKES THE WHOLE BOARD, keyed by limitId — see `CodexTurn.rate_limit_
    snapshots`. The notifications are sparse and arrive per bucket: in the
    specimen the exhausted `codex` bucket came first and a `premium` bucket
    with `primary: null` came 286 ms later, so a single last-wins field held
    the useless one at exactly the moment the useful one was needed.

    Unbanded on purpose — the caller bands it against the same horizon it bands
    a prose timestamp with, so one rule governs both."""
    if not isinstance(snapshots, dict):
        return None
    best: float | None = None
    for snap in list(cast("dict[str, Any]", snapshots).values()):
        if not isinstance(snap, dict):
            continue
        for slot in ("primary", "secondary"):
            ts = _window_reset(cast("dict[str, Any]", snap).get(slot))
            if ts is not None and (best is None or ts < best):
                best = ts
    return best


class CodexServerError(RuntimeError):
    """The app-server refused or never answered a protocol request."""


class CodexRequestError(CodexServerError):
    """The server ANSWERED, with a JSON-RPC error. `code` and `message` are
    the server's own; whether they mean "not applied" is `steer`'s question,
    not this class's (audit D3)."""

    def __init__(self, method: str, code: int | None, message: str) -> None:
        super().__init__(f"{method}: {json.dumps({'code': code, 'message': message})[:400]}")
        self.method = method
        self.code = code
        self.message = message


class CodexRequestTimeout(CodexServerError):
    """No answer inside the caller's ceiling. The request may have been
    applied — the reply is merely LATE or lost, and `AppServerClient` keeps
    listening for it (`request(on_late=…)`)."""


class CodexServerGone(CodexServerError):
    """The app-server process exited while a request was outstanding."""


# ── audit D2: bounded tool workers ───────────────────────────────────────────
#: how many server requests (tool calls, approvals) may EXECUTE at once per
#: app-server. The reader thread never executes one; it only admits them.
CODEX_TOOL_WORKERS: Final = 4
#: how many admitted requests may WAIT for a worker. Beyond this the reader
#: answers at once with an explicit overload (tool: failure text; approval:
#: decline) rather than growing an unbounded queue — the server's own
#: parallelism is the normal bound, this is the belt.
CODEX_TOOL_QUEUE: Final = 16
#: how long `CodexTurn.wait` gives in-flight workers after the turn ends
#: before returning without them. NOT proof they stopped: whatever finishes
#: later still reaches the owning turn through its `on_late_tool_result`.
TOOL_DRAIN_S: Final = 2.0

# ── audit D3: three-way steer outcome ────────────────────────────────────────
#: the client-side ceiling on a `turn/steer` acknowledgement. Module-level
#: (not Final) so a test can shorten it; a timeout is UNKNOWN, never refusal.
STEER_TIMEOUT = 30.0
STEER_ACCEPTED: Final = "accepted"
STEER_REJECTED: Final = "rejected"
STEER_UNKNOWN: Final = "unknown"

#: JSON-RPC codes the SPEC defines as raised before the method body runs
#: (parse error, invalid request, method not found, invalid params): the only
#: structural evidence that a request was never applied. Anything else —
#: -32603 internal, the -32000… server range, an unknown code — is UNKNOWN
#: whatever its message says: an internal failure can follow the append
#: ("persistence failed after expectedTurnId validation" is still an append
#: that happened), so message text is never read as evidence here (review
#: 2026-09-05). ⚠ The real app-server's guard code is UNVERIFIED (no live
#: control has run); if it answers with a code outside this set, the outcome
#: reads unknown — a receipted redelivery, the safe direction — never a
#: false refusal.
_NEVER_APPLIED_CODES: Final = frozenset({-32700, -32600, -32601, -32602})


class SteerOutcome(str):
    """One of accepted / rejected / unknown, with the reason beside it.

    A `str`, so `outcome == "unknown"` reads naturally and it serialises into
    receipts as-is. Its TRUTHINESS is `accepted` only: a legacy boolean caller
    cannot mistake an unknown for an acceptance. ⚠ That does not make such a
    caller CORRECT — a caller that retries on falsy would still replay an
    unknown as if refused. Every retry site must read all three values
    (`supervisor._codex_leg`'s pump does; there is no other codex caller)."""

    reason: str

    def __new__(cls, value: str, reason: str = "") -> "SteerOutcome":
        if value not in (STEER_ACCEPTED, STEER_REJECTED, STEER_UNKNOWN):
            raise ValueError(f"not a steer outcome: {value!r}")
        out = str.__new__(cls, value)
        out.reason = reason
        return out

    def __bool__(self) -> bool:
        return str.__eq__(self, STEER_ACCEPTED)

    def __repr__(self) -> str:
        return f"SteerOutcome({str.__repr__(self)}, reason={self.reason!r})"


def classify_steer_error(code: int | None, message: str) -> SteerOutcome:
    """A JSON-RPC error on `turn/steer` → rejected or unknown (audit D3).

    Rejected ONLY on structural evidence that the input was never appended:
    a code the JSON-RPC spec reserves for failures raised before the method
    runs (`_NEVER_APPLIED_CODES`). The message is carried in the reason for
    a reader and is never itself evidence — an internal error can follow the
    append. Everything else stays unknown."""
    msg = str(message or "")
    if code in _NEVER_APPLIED_CODES:
        return SteerOutcome(STEER_REJECTED, f"server error {code}: {msg[:200]}")
    return SteerOutcome(STEER_UNKNOWN,
                        f"ambiguous server error {code}: {msg[:200]}")


def classify_steer_result(result: Any, expected_turn_id: str | None
                          ) -> SteerOutcome:
    """A `turn/steer` RESULT → accepted or unknown (audit D3, review).

    The schema (TurnSteerResponse) requires `turnId`; accepted means the
    server named the turn we steered. A result without one, or naming some
    other turn, is not an acknowledgement of THIS input — unknown, with the
    shape in the reason."""
    if isinstance(result, dict):
        r: dict[str, Any] = result
        tid = r.get("turnId")
        if isinstance(tid, str) and tid and expected_turn_id \
                and tid == expected_turn_id:
            return SteerOutcome(STEER_ACCEPTED, "acknowledged")
        return SteerOutcome(
            STEER_UNKNOWN,
            f"acknowledged with turnId={tid!r}, expected "
            f"{expected_turn_id!r}")
    return SteerOutcome(STEER_UNKNOWN,
                        f"acknowledged with no result object ({type(result).__name__})")


def _dyn_tool(name: str, description: str,
              input_schema: dict[str, Any]) -> dict[str, Any]:
    """One orgtree tool card as a DynamicToolSpec function entry."""
    return {"type": "function", "name": name, "description": description,
            "inputSchema": input_schema}


#: the registry fields we translate into codex `[mcp_servers.*]`. Claude's
#: `type` discriminator is deliberately NOT among them: codex infers transport
#: from command-vs-url, and `--strict-config` rejects keys it does not know.
_MCP_FIELDS: Final = ("command", "args", "env", "url")

#: a server name must be a TOML BARE KEY. `-c` splits its dotted path BEFORE
#: honouring quotes, so `mcp_servers."dot.name".command=…` does not merely fail
#: to attach — it aborts the whole app-server with "failed to load bootstrap
#: configuration / invalid transport" (measured, codex 0.150.1). A name we
#: cannot express is therefore undeliverable, and `deliverable_mcp` reports it
#: so the identity prompt can stop promising it.
_BARE_KEY: Final = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_-]*$")


def _toml(value: Any) -> str:
    """One TOML scalar for `-c`. JSON string escaping is a subset of TOML's
    basic-string escaping, so json.dumps is a correct encoder here — and it is
    the one that survives the BACKSLASHES in a registered server's Windows
    command path, which naive quoting corrupts silently."""
    return json.dumps(str(value))


def deliverable_mcp(servers: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Split a registry subset into (what this lane can attach, what it cannot).

    The codex lane cannot carry every shape the claude lane can, and BOTH the
    spawn and the identity prompt are built from this one split — promising a
    capability the config drops is the bug class this function exists to close.
    """
    ok: dict[str, Any] = {}
    dropped: list[str] = []
    for name in sorted(servers):
        srv = servers[name]
        if (isinstance(srv, dict) and _BARE_KEY.match(name)
                and (srv.get("command") or srv.get("url"))):
            ok[name] = srv
        else:
            dropped.append(name)
    return ok, dropped


def mcp_config_overrides(servers: dict[str, Any]) -> list[str]:
    """`-c key=value` argv attaching `servers` as codex `[mcp_servers.*]`.

    LAUNCH-scoped by design. Measured 2026-08-29 (probe_resume.py): codex
    starts configured MCP servers when the APP-SERVER starts, not when a thread
    is created — the marker appeared in a run where no thread existed at all.
    So the set is process-scoped and no thread operation (start, resume, fork)
    can drop it, which is the failure `thread/resume` already caused once for
    dynamicTools. It also writes NOTHING to the user's config.toml and never
    repoints CODEX_HOME (that would split-brain the auth refresh cycle, §3.4).
    """
    out: list[str] = []
    for name, srv in sorted(servers.items()):
        for field in _MCP_FIELDS:
            if field not in srv:
                continue
            val = srv[field]
            if field == "args":
                if not isinstance(val, list):
                    continue
                rendered = "[" + ", ".join(_toml(v) for v in val) + "]"
            elif field == "env":
                if not isinstance(val, dict):
                    continue
                rendered = "{" + ", ".join(
                    f"{k} = {_toml(v)}" for k, v in sorted(val.items())
                    if _BARE_KEY.match(str(k))) + "}"
            else:
                rendered = _toml(val)
            out += ["-c", f"mcp_servers.{name}.{field}={rendered}"]
        # `servers` is already the node's granted + deliverable subset (the
        # caller gets it from codex_mcp_grant).  Codex otherwise defaults MCP
        # tools to prompting, but Orgtree runs headless and answers an MCP
        # prompt as a rejection.  Approve only this attached server's tools;
        # never change the thread's broader approval or sandbox policy.
        out += ["-c", (f"mcp_servers.{name}."
                       'default_tools_approval_mode="approve"')]
    return out


class AppServerClient:
    """One `codex app-server` child process spoken to over stdio NDJSON.

    Threading model (audit D2, 2026-09-05): a reader thread pumps stdout and
    NEVER runs caller code that can block. Server->client REQUESTS (tool
    calls, approvals) are ADMITTED by the reader into a bounded job queue and
    answered by up to `CODEX_TOOL_WORKERS` worker threads through the caller's
    hooks; the reader keeps consuming responses and notifications meanwhile,
    so a `turn/steer` acknowledgement sitting behind a 60 s tool call is read
    when it arrives, not when the tool returns. It used to answer them inline
    on the reader — a slow tool blocked every acknowledgement and the steer
    timed out with its reply already on the pipe (protocol_probes.py,
    `blocked_protocol_reader`). Notifications append to an internal list AND
    stream to `on_event` as they arrive, synchronously, in wire order —
    `on_event` must stay short.

    OWNERSHIP of a dispatched request: every job carries the client's binding
    `epoch` (bumped by bind/unbind/close) and the server's request id. A tool
    runs AT MOST ONCE per request id (a replayed id is answered from the
    record). A job that starts after its epoch ended is not executed. A result
    finishing after its epoch ended is never written to the wire under the
    new binding: it is retained and handed to the ORIGINAL binding's
    `on_tool_result`, exactly once, for that turn to journal.
    """

    def __init__(self, argv_head: list[str], *, codex_home: str | None = None,
                 cwd: str | None = None,
                 on_event: Callable[[dict[str, Any]], None] | None = None,
                 tool_dispatch: Callable[[str, dict[str, Any]], str] | None = None,
                 approval_decide: Callable[[str, dict[str, Any]], str] | None = None,
                 env_extra: dict[str, str] | None = None,
                 config_overrides: list[str] | None = None) -> None:
        # an ARGV HEAD, not a bare exe — the same shape as supervisor's
        # _claude_argv(): production passes [codex.exe], tests pass
        # [python, fakecodex.py], and nobody ever routes through a .CMD shim
        # (the argv-truncation hazard the claude resolver documents).
        env = dict(os.environ)
        # the claude lane's hygiene, mirrored: a codex child must never see
        # Anthropic credentials (one-credential-per-spawn, supervisor
        # spawn_env) — and equally never a stray OPENAI_API_KEY that would
        # silently flip the billing lane away from the subscription login.
        for k in list(env):
            if k.startswith(("ANTHROPIC_", "CLAUDE_CODE_")) or k in (
                    "CLAUDECODE", "OPENAI_API_KEY"):
                env.pop(k, None)
        if codex_home:
            env["CODEX_HOME"] = codex_home
        if env_extra:
            env.update(env_extra)
        # cwd is the agent's own scratch, same as the claude lane's Popen —
        # the process-level cwd, not just thread/start's `cwd` param, because
        # AGENTS.md discovery and any relative path the model touches resolve
        # against the PROCESS
        # `-c` overrides are GLOBAL options and must precede the subcommand —
        # codex parses them off the top-level command line, not off app-server.
        self.proc = subprocess.Popen(
            argv_head + list(config_overrides or []) + ["app-server"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, cwd=cwd,
            creationflags=(subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
                           if os.name == "nt" else 0))
        self.on_event = on_event
        self.on_exit: Callable[[], None] | None = None
        self.tool_dispatch = tool_dispatch
        self.approval_decide = approval_decide
        # A pre-warmed app-server is initialized by its first claimant and
        # then reused.  JSON-RPC initialize is process-scoped, not turn-
        # scoped, so issuing it again on every claim is both unnecessary and
        # rejected by stricter server versions.
        self._initialized = False
        self._initialize_result: dict[str, Any] = {}
        self._initialize_lock = threading.Lock()
        self._lock = threading.Lock()
        self._next_id = 1
        self._responses: dict[int, dict[str, Any]] = {}
        #: request ids whose waiter gave up (timeout): a LATE reply is routed
        #: to the registered resolver instead of rotting in `_responses`.
        self._late: dict[int, Callable[[dict[str, Any]], None] | None] = {}
        self.notifications: list[dict[str, Any]] = []
        self.stderr_tail: list[str] = []
        # ── audit D2: admission + bounded workers ──
        self.on_tool_result: Callable[[dict[str, Any]], None] | None = None
        self._epoch = 0
        self._closed = False
        self._jobs_cv = threading.Condition()
        self._jobs: deque[dict[str, Any]] = deque()
        self._workers: list[threading.Thread] = []
        self._idle_workers = 0
        self._inflight = 0
        #: request id → record, for every admitted server request this
        #: process ever saw: the at-most-once table and the late-result home.
        self._dispatched: dict[Any, dict[str, Any]] = {}
        #: explicit overload answers the reader gave (a count, for receipts)
        self.overloaded = 0
        self._reader = threading.Thread(target=self._pump, daemon=True)
        self._reader.start()
        threading.Thread(target=self._pump_err, daemon=True).start()

    # ── wire plumbing ────────────────────────────────────────────────────

    def _pump_err(self) -> None:
        err = self.proc.stderr
        assert err is not None
        for raw in err:
            line = raw.decode(errors="replace").rstrip()
            self.stderr_tail.append(line)
            del self.stderr_tail[:-50]

    def _pump(self) -> None:
        out = self.proc.stdout
        assert out is not None
        try:
            for raw in out:
                try:
                    msg: dict[str, Any] = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if "id" in msg and ("result" in msg or "error" in msg):
                    resolver: Callable[[dict[str, Any]], None] | None = None
                    late = False
                    with self._lock:
                        rid = int(msg["id"])
                        if rid in self._late:
                            # the waiter gave up: route, never store (D3)
                            resolver = self._late.pop(rid)
                            late = True
                        else:
                            self._responses[rid] = msg
                    if late and resolver is not None:
                        try:
                            resolver(msg)
                        except Exception:
                            pass   # a resolver must never kill the reader
                elif "id" in msg and "method" in msg:
                    self._admit(msg)      # never executed HERE (audit D2)
                else:
                    self.notifications.append(msg)
                    if self.on_event:
                        try:
                            self.on_event(msg)
                        except Exception:
                            pass   # observer must never kill the wire reader
        finally:
            if self.on_exit:
                try:
                    self.on_exit()
                except Exception:
                    pass

    # ── server requests: admit on the reader, execute on a worker (D2) ──

    @staticmethod
    def _tool_reply(rid: Any, ok: bool, text: str) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": rid, "result": {
            "success": ok,
            "contentItems": [{"type": "inputText", "text": text}]}}

    def _admit(self, msg: dict[str, Any]) -> None:
        """Reader-thread half of a server request: bound admission, never
        execution. Answers at once — from the record for a replayed id, with
        an explicit overload when the queue is full, with a refusal for a
        method nobody handles — and otherwise queues a job stamped with the
        CURRENT binding (epoch + hooks + result sink)."""
        method = str(msg.get("method", ""))
        params: dict[str, Any] = msg.get("params") or {}
        rid = msg["id"]
        is_tool = method == "item/tool/call" and self.tool_dispatch is not None
        is_approval = "requestApproval" in method
        if not (is_tool or is_approval):
            # anything unexpected: refuse loudly rather than hang the server.
            self._send_quiet({"jsonrpc": "2.0", "id": rid, "error": {
                "code": -32601, "message": f"orgtree declines: {method}"}})
            return
        with self._jobs_cv:
            rec = self._dispatched.get(rid)
            if rec is not None:
                # AT MOST ONCE per request id: a replayed request is answered
                # from the record when done, and otherwise by the job already
                # running it — never by a second execution.
                rec["replays"] = int(rec.get("replays") or 0) + 1
                answer = rec.get("answer") if rec.get("done") else None
                if answer is not None and rec["epoch"] == self._epoch:
                    self._send_quiet(answer)
                return
            tool = str(params.get("tool", "")) if is_tool else ""
            rec = {"rid": rid, "method": method, "tool": tool,
                   "call_id": str(params.get("callId") or ""),
                   "epoch": self._epoch, "admitted_at": time.time(),
                   "started_at": None, "finished_at": None, "done": False,
                   "ok": None, "text": None, "answer": None,
                   "wire": None, "skipped": False, "replays": 0}
            if len(self._jobs) >= CODEX_TOOL_QUEUE:
                # EXPLICIT OVERLOAD: the reader must not block and the queue
                # must not grow without bound. A tool gets a failure answer it
                # can retry; an approval fails CLOSED.
                self.overloaded += 1
                rec.update(done=True, skipped=True, ok=False,
                           finished_at=time.time(),
                           text=(f"orgtree: tool worker overload "
                                 f"({self._inflight} running, "
                                 f"{len(self._jobs)} queued); retry"))
                rec["answer"] = (
                    self._tool_reply(rid, False, str(rec["text"])) if is_tool
                    else {"jsonrpc": "2.0", "id": rid,
                          "result": {"decision": "decline"}})
                rec["wire"] = self._send_quiet(rec["answer"])
                self._dispatched[rid] = rec
                return
            self._dispatched[rid] = rec
            job = {"rec": rec, "params": params, "epoch": self._epoch,
                   "tool_dispatch": self.tool_dispatch,
                   "approval_decide": self.approval_decide,
                   "on_result": self.on_tool_result}
            self._jobs.append(job)
            if self._idle_workers == 0 and \
                    len(self._workers) < CODEX_TOOL_WORKERS:
                t = threading.Thread(target=self._worker, daemon=True,
                                     name=f"codextool-{self.proc.pid}")
                self._workers.append(t)
                t.start()
            self._jobs_cv.notify()

    def _worker(self) -> None:
        while True:
            with self._jobs_cv:
                while not self._jobs:
                    if self._closed:
                        return
                    self._idle_workers += 1
                    self._jobs_cv.wait()
                    self._idle_workers -= 1
                job = self._jobs.popleft()
                self._inflight += 1
                rec = job["rec"]
                rec["started_at"] = time.time()
                stale = job["epoch"] != self._epoch
            try:
                self._run_job(job, stale)
            finally:
                with self._jobs_cv:
                    self._inflight -= 1
                    self._jobs_cv.notify_all()

    def _run_job(self, job: dict[str, Any], stale: bool) -> None:
        rec: dict[str, Any] = job["rec"]
        params: dict[str, Any] = job["params"]
        rid = rec["rid"]
        method = str(rec["method"])
        answer: dict[str, Any]
        if stale:
            # its turn ended before it ran: NOT executed. Stated, not silent.
            rec.update(skipped=True, ok=False,
                       text="orgtree: the turn ended before this tool ran")
            answer = (self._tool_reply(rid, False, str(rec["text"]))
                      if method == "item/tool/call" else
                      {"jsonrpc": "2.0", "id": rid,
                       "result": {"decision": "decline"}})
        elif method == "item/tool/call":
            tool = str(rec["tool"])
            args = params.get("arguments")
            dispatch = job["tool_dispatch"]
            if dispatch is None:
                text, ok = f"orgtree: no tool dispatcher bound for {tool}", False
            else:
                try:
                    text = dispatch(tool, args if isinstance(args, dict) else {})
                    ok = True
                except Exception as e:   # a tool error is an ANSWER, not a hang
                    text, ok = f"tool {tool} failed: {e}", False
            rec.update(ok=ok, text=text)
            answer = self._tool_reply(rid, ok, text)
        else:
            decision = "decline"
            decide = job["approval_decide"]
            if decide is not None:
                try:
                    decision = decide(method, params)
                except Exception:
                    decision = "decline"   # fail CLOSED, loudly in the turn
            rec.update(ok=True, text=decision)
            answer = {"jsonrpc": "2.0", "id": rid,
                      "result": {"decision": decision}}
        rec["answer"] = answer
        rec["finished_at"] = time.time()
        # ⚠ THE WIRE IS THE ORIGINAL BINDING'S. A result finishing under a
        # later epoch is retained for its owner and never written under the
        # new turn's binding — pipe-open is not ownership.
        with self._jobs_cv:
            same_epoch = job["epoch"] == self._epoch
        rec["wire"] = self._send_quiet(answer) if same_epoch else False
        rec["done"] = True
        sink = job["on_result"]
        if sink is not None:
            try:
                sink(dict(rec))          # exactly once, to the ORIGINAL owner
            except Exception:
                pass

    def _send_quiet(self, obj: dict[str, Any]) -> bool:
        """`_send` that reports a dead pipe instead of raising: a worker or
        the reader answering a server request has nobody to raise to."""
        try:
            self._send(obj)
            return True
        except (OSError, ValueError, AttributeError):
            return False

    def inflight_tools(self) -> int:
        """Admitted server requests not yet finished (running + queued)."""
        with self._jobs_cv:
            return self._inflight + len(self._jobs)

    def drain_tools(self, timeout: float) -> int:
        """Wait up to `timeout` for admitted requests to finish; return how
        many are still unfinished. Zero is proof of quiet; a positive count
        is a fact the caller reports, not a failure it hides."""
        deadline = time.time() + timeout
        with self._jobs_cv:
            while self._inflight or self._jobs:
                left = deadline - time.time()
                if left <= 0:
                    break
                self._jobs_cv.wait(left)
            return self._inflight + len(self._jobs)

    def tool_records(self, epoch: int | None = None) -> list[dict[str, Any]]:
        """Copies of the dispatch records (this binding's by default)."""
        with self._jobs_cv:
            want = self._epoch if epoch is None else epoch
            return [dict(r) for r in self._dispatched.values()
                    if r["epoch"] == want]

    @property
    def epoch(self) -> int:
        return self._epoch

    def _send(self, obj: dict[str, Any]) -> None:
        stdin = self.proc.stdin
        assert stdin is not None
        with self._lock:
            stdin.write((json.dumps(obj) + "\n").encode())
            stdin.flush()

    # ── protocol surface ─────────────────────────────────────────────────

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    @staticmethod
    def _raise_for(method: str, resp: dict[str, Any]) -> dict[str, Any]:
        err = resp.get("error")
        if err:
            code: int | None = None
            message = ""
            if isinstance(err, dict):
                e: dict[str, Any] = err
                try:
                    code = int(e.get("code")) if e.get("code") is not None else None
                except (TypeError, ValueError):
                    code = None
                message = str(e.get("message") or "")
            else:
                message = str(err)
            raise CodexRequestError(method, code, message)
        result: dict[str, Any] = resp.get("result") or {}
        return result

    def request(self, method: str, params: dict[str, Any],
                timeout: float = REQUEST_TIMEOUT, *,
                on_late: Callable[[dict[str, Any]], None] | None = None
                ) -> dict[str, Any]:
        """One JSON-RPC exchange. Raises `CodexRequestError` on a server
        error, `CodexServerGone` on process exit, `CodexRequestTimeout` after
        `timeout` — and in that last case REGISTERS `on_late` (or a discard)
        under the request id, so the reply, if it ever comes, is routed to it
        on the reader thread instead of leaking into `_responses` (D3).
        `on_late` gets the raw response message; keep it short."""
        with self._lock:
            rid = self._next_id
            self._next_id += 1
        self._send({"jsonrpc": "2.0", "id": rid,
                    "method": method, "params": params})
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                if rid in self._responses:
                    resp = self._responses.pop(rid)
                    return self._raise_for(method, resp)
            if self.proc.poll() is not None:
                raise CodexServerGone(
                    f"{method}: app-server exited rc={self.proc.returncode}; "
                    f"stderr tail: {' | '.join(self.stderr_tail[-3:])[:400]}")
            time.sleep(0.02)
        with self._lock:
            if rid in self._responses:          # landed on the last tick
                return self._raise_for(method, self._responses.pop(rid))
            self._late[rid] = on_late
        raise CodexRequestTimeout(f"{method}: no answer in {timeout:.0f}s")

    def initialize(self, timeout: float = 60.0) -> dict[str, Any]:
        with self._initialize_lock:
            if self._initialized:
                return dict(self._initialize_result)
            r = self.request("initialize", {
                "clientInfo": {"name": "orgtree",
                               "title": "orgtree supervisor",
                               "version": "1"},
                "capabilities": {"experimentalApi": True}}, timeout)
            self.notify("initialized", {})
            self._initialize_result = dict(r)
            self._initialized = True
            return dict(r)

    def mcp_tool_names(self) -> list[str]:
        """Exact MCP function names currently callable in this app-server.

        ``mcpServerStatus/list`` is runtime evidence: unlike launch config it
        reports each connected server's resolved ``tools`` map.  Pagination is
        followed deterministically and built-in/dynamic tools never enter the
        result.
        """
        names: set[str] = set()
        cursor: str | None = None
        seen: set[str] = set()
        while True:
            params = {"cursor": cursor} if cursor else {}
            result = self.request("mcpServerStatus/list", params)
            rows = result.get("data") or []
            if isinstance(rows, list):
                for row in rows:
                    if not isinstance(row, dict):
                        continue
                    server = str(row.get("name") or "")
                    tools = row.get("tools")
                    if not server or not isinstance(tools, dict):
                        continue
                    for tool in tools:
                        if isinstance(tool, str) and tool:
                            names.add(f"mcp__{server}__{tool}")
            nxt = result.get("nextCursor")
            cursor = str(nxt) if nxt else None
            if not cursor or cursor in seen:
                break
            seen.add(cursor)
        return sorted(names)

    def bind(self, *,
             on_event: Callable[[dict[str, Any]], None] | None = None,
             tool_dispatch: Callable[[str, dict[str, Any]], str] | None = None,
             approval_decide: Callable[[str, dict[str, Any]], str] | None = None,
             on_tool_result: Callable[[dict[str, Any]], None] | None = None,
             ) -> None:
        """Attach one turn's callbacks to a parked app-server client.

        Opens a NEW BINDING EPOCH: requests admitted from here on belong to
        this turn; anything still running from the previous binding finishes
        as the previous binding's (retained, handed to ITS sink) and cannot
        be written to the wire under this one."""
        with self._jobs_cv:
            self._epoch += 1
            self.on_event = on_event
            self.tool_dispatch = tool_dispatch
            self.approval_decide = approval_decide
            self.on_tool_result = on_tool_result

    def unbind(self) -> None:
        """Drop references to the completed turn while the process parks —
        and end its binding epoch (see `bind`)."""
        with self._jobs_cv:
            self._epoch += 1
            self.on_event = None
            self.tool_dispatch = None
            self.approval_decide = None
            self.on_tool_result = None

    def close(self) -> None:
        """Tear the app-server down — the WHOLE process tree, and wait for it.

        ⚠ `codex app-server` (the `node …/codex.js` entry orgtree spawns) forks
        a native `codex-*-win32-x64` engine child and a `codex-code-mode-host`
        child. A bare `self.proc.kill()` kills only the node parent; on Windows
        the children are orphaned and KEEP THE THREAD'S `~/.codex` write lock,
        so the NEXT turn's `thread/resume` fails with "thread … already has an
        active writer" (measured 2026-08-30: a run of orphaned pairs from four
        failed turns). Kill by pid through the OS so the tree goes, then
        `wait()` so the next turn does not spawn into a lock the dying tree
        still holds (the same rapid-kill→spawn contention the module docstring
        warns about).

        Ends the binding epoch first (D2): a worker still running finishes as
        the closed binding's — retained, handed to its sink, never sent."""
        with self._jobs_cv:
            self._epoch += 1
            self._closed = True
            self._jobs_cv.notify_all()
        if os.name == "nt":
            try:
                subprocess.run(
                    ["taskkill", "/T", "/F", "/PID", str(self.proc.pid)],
                    check=False, capture_output=True, timeout=10,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            except (OSError, subprocess.SubprocessError):
                pass
        try:
            self.proc.kill()          # POSIX, and a belt over taskkill
        except OSError:
            pass
        try:
            self.proc.wait(timeout=5)
        except (subprocess.TimeoutExpired, OSError, ValueError):
            pass


def _thread_id_of(result: dict[str, Any]) -> str | None:
    thread = result.get("thread")
    if isinstance(thread, dict) and thread.get("id"):
        return str(thread["id"])
    for k in ("threadId", "id"):
        if result.get(k):
            return str(result[k])
    return None


def compact_fork(argv_head: list[str], *, cwd: str, model: str | None,
                 thread_id: str, timeout: float,
                 codex_home: str | None = None,
                 sandbox: str = "workspace-write",
                 approval_policy: str = "on-request",
                 developer_instructions: str | None = None,
                 env_extra: dict[str, str] | None = None) -> dict[str, Any]:
    """Fork ``thread_id`` and compact the fork with the app-server's native
    lifecycle.  The source thread is never modified, so it remains a usable
    knowledge bearer while the returned thread becomes the live successor.

    ``thread/compact/start`` only acknowledges that compaction started.  The
    durable success proof is the compact turn's ``turn/completed`` event; an
    empty request response must never be mistaken for a completed compact.
    """
    client = AppServerClient(
        argv_head, codex_home=codex_home, cwd=cwd, env_extra=env_extra)
    try:
        client.initialize()
        forked = client.request("thread/fork", {
            "threadId": thread_id,
            "model": model,
            "cwd": cwd,
            "sandbox": sandbox,
            "approvalPolicy": approval_policy,
            "developerInstructions": developer_instructions,
            # A compaction split needs the new handle, not a second copy of a
            # potentially enormous turn list in the JSON-RPC response.
            "excludeTurns": True,
            # Preserve an active goal but let the next explicit Orgtree turn
            # own its continuation; compaction itself is not agent work.
            "deferGoalContinuation": True,
        })
        new_thread_id = _thread_id_of(forked)
        if not new_thread_id or new_thread_id == thread_id:
            raise CodexServerError(
                "thread/fork returned no distinct successor thread id")

        first_event = len(client.notifications)
        client.request("thread/compact/start", {"threadId": new_thread_id})
        deadline = time.time() + timeout
        seen = first_event
        token_usage: dict[str, Any] | None = None
        while time.time() < deadline:
            while seen < len(client.notifications):
                msg = client.notifications[seen]
                seen += 1
                method = str(msg.get("method") or "")
                params = (msg.get("params")
                          if isinstance(msg.get("params"), dict) else {})
                event_thread = str(params.get("threadId") or "")
                if event_thread and event_thread != new_thread_id:
                    continue
                if method == "thread/tokenUsage/updated":
                    value = params.get("tokenUsage")
                    if isinstance(value, dict):
                        token_usage = value
                    continue
                if method == "turn/failed":
                    raise CodexServerError(
                        "thread/compact/start: compact turn failed")
                if method != "turn/completed":
                    continue
                turn = params.get("turn")
                status = (str(turn.get("status") or "completed")
                          if isinstance(turn, dict) else "completed")
                if status not in (STATUS_COMPLETED, STATUS_INTERRUPTED):
                    detail = (turn.get("error")
                              if isinstance(turn, dict) else None)
                    raise CodexServerError(
                        f"thread/compact/start: compact turn {status}: "
                        f"{str(detail)[:300]}")
                return {"thread_id": new_thread_id,
                        "token_usage": token_usage}
            if client.proc.poll() is not None:
                raise CodexServerError(
                    "thread/compact/start: app-server exited "
                    f"rc={client.proc.returncode}; stderr tail: "
                    f"{' | '.join(client.stderr_tail[-3:])[:400]}")
            time.sleep(0.02)
        raise CodexServerError(
            f"thread/compact/start: no completion in {timeout:.0f}s")
    finally:
        client.close()


_USAGE_COUNTER_FIELDS = (
    "totalTokens", "inputTokens", "cachedInputTokens",
    "outputTokens", "reasoningOutputTokens", "cacheWriteInputTokens")


def _usage_before_last(token_usage: dict[str, Any]) -> dict[str, Any] | None:
    """Infer the thread counter immediately before this turn's first request."""
    total = token_usage.get("total")
    last = token_usage.get("last")
    if not isinstance(total, dict) or not isinstance(last, dict):
        return None
    base: dict[str, Any] = {}
    for key in _USAGE_COUNTER_FIELDS:
        if key in total or key in last:
            value = int(total.get(key) or 0) - int(last.get(key) or 0)
            if value < 0:
                return None
            base[key] = value
    return base or None


def _turn_usage(token_usage: dict[str, Any] | None,
                baseline: dict[str, Any] | None
                ) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Convert Codex's thread-cumulative counter into this turn's delta.

    A missing baseline retains the old full-snapshot fallback.  If a known
    counter moves backwards (thread reset, app-server replacement, or provider
    discontinuity), the current snapshot becomes the new baseline and is
    booked whole: never a negative cost and never a silent zero.  The second
    return value is durable audit evidence for the supervisor to record.
    """
    if not isinstance(token_usage, dict):
        return token_usage, None
    total = token_usage.get("total")
    if not isinstance(total, dict) or not isinstance(baseline, dict):
        return token_usage, None
    backwards = [key for key in _USAGE_COUNTER_FIELDS
                 if key in baseline and key in total
                 and int(total.get(key) or 0) < int(baseline.get(key) or 0)]
    normalized = dict(token_usage)
    normalized["sessionTotal"] = dict(total)
    if backwards:
        reset = {"fields": backwards, "baseline": dict(baseline),
                 "current": dict(total), "policy": "book_current_snapshot"}
        return normalized, reset
    delta = dict(total)
    for key in _USAGE_COUNTER_FIELDS:
        if key in total or key in baseline:
            delta[key] = max(0, int(total.get(key) or 0)
                             - int(baseline.get(key) or 0))
    normalized["total"] = delta
    return normalized, None


class CodexTurn:
    """One turn's lifecycle, from spawn to normalized result.

    The supervisor holds this object while the turn runs — steer() and
    interrupt() act on the live session, which is exactly the shape the
    Claude lane's mid-turn machinery (steer hook / control_request) expects
    to find behind the provider seam.
    """

    def __init__(self, argv_head: list[str], *, cwd: str, model: str | None,
                 effort: str | None, thread_id: str | None,
                 codex_home: str | None = None,
                 sandbox: str = "workspace-write",
                 approval_policy: str = "on-request",
                 dynamic_tools: list[dict[str, Any]] | None = None,
                 developer_instructions: str | None = None,
                 on_event: Callable[[dict[str, Any]], None] | None = None,
                 tool_dispatch: Callable[[str, dict[str, Any]], str] | None = None,
                 approval_decide: Callable[[str, dict[str, Any]], str] | None = None,
                 env_extra: dict[str, str] | None = None,
                 config_overrides: list[str] | None = None,
                 usage_baseline: dict[str, Any] | None = None,
                 client: AppServerClient | None = None,
                 on_late_tool_result: Callable[[dict[str, Any]], None] | None = None,
                 ) -> None:
        self._caller_on_event = on_event
        self.cwd = cwd
        self.model = model
        self.effort = effort
        self.sandbox = sandbox
        self.approval_policy = approval_policy
        self.dynamic_tools = dynamic_tools or []
        self.developer_instructions = developer_instructions
        self.thread_id = thread_id
        self.turn_id: str | None = None
        self.agent_text: list[str] = []
        self.token_usage: dict[str, Any] | None = None
        # `tokenUsage.total` is THREAD-cumulative, despite its turn-local
        # notification name.  A pre-turn notification gives the baseline
        # directly; otherwise the first post-start snapshot minus its `last`
        # request reconstructs it.  Keeping this inside the adapter prevents
        # every consumer (billing, compaction, future telemetry) from having
        # to rediscover the provider's counter semantics.
        self._token_usage_base: dict[str, Any] | None = (
            dict(usage_baseline) if isinstance(usage_baseline, dict) else None)
        self._turn_started = False
        self.rate_limits: dict[str, Any] | None = None
        #: EVERY rate-limit snapshot this turn saw, keyed by limitId — the
        #: board, not the last card off it. `rate_limits` above stays last-wins
        #: for its existing readers; this is what `limit_reset_epoch` prices a
        #: freeze from, and it exists because in the measured specimen the last
        #: card was the empty one (D-209).
        self.rate_limit_snapshots: dict[str, dict[str, Any]] = {}
        #: the `turn.error` of a failed turn — the CLI's own words for why.
        #: Discarded entirely until D-209, which is how a usage limit reached
        #: no detector: it is not on stderr, it is here.
        self.error: dict[str, Any] | None = None
        self.status: str | None = None
        #: WHAT THE PROVIDER SAID IT WAS RUNNING, kept apart from `model`
        #: (what we ASKED for). `reported_model` is the `model` field of the
        #: thread/start or thread/resume RESPONSE (0.153.3 schema:
        #: ThreadStartResponse.model / ThreadResumeResponse.model) — the
        #: server's echo of the thread's model, which is a receipt that the
        #: field was accepted, not proof of which weights served the turn.
        #: `rerouted` is the `model/rerouted` notification, the one place the
        #: protocol positively reports serving a DIFFERENT model than asked.
        #: Both None when the server said nothing; never inferred.
        self.reported_model: str | None = None
        self.rerouted: dict[str, Any] | None = None
        self._done = threading.Event()
        # whether THIS turn constructed the app-server, and may therefore end
        # it — see `close`. A borrowed one belongs to the warm pool.
        self._owns_client = client is None
        self.client = client or AppServerClient(
            argv_head, codex_home=codex_home, cwd=cwd,
            env_extra=env_extra, config_overrides=config_overrides)
        # ── audit D2/D3 bookkeeping, owned by this turn ──
        #: dispatch records that finished AFTER this turn ended (or never
        #: reached the wire): the server emits no `item/completed` for them,
        #: so the caller journals them from here — once each, keyed by rid.
        self.late_tool_results: list[dict[str, Any]] = []
        self._late_rids: set[Any] = set()
        self._late_lock = threading.Lock()
        self._caller_on_late_tool_result = on_late_tool_result
        #: every steer this turn sent, in order, with its outcome — including
        #: an UNKNOWN later resolved by a late reply (`resolved` appended).
        self.steer_log: list[dict[str, Any]] = []
        self.client.bind(on_event=self._observe,
                         tool_dispatch=tool_dispatch,
                         approval_decide=approval_decide,
                         on_tool_result=self._tool_result)

    def _tool_result(self, rec: dict[str, Any]) -> None:
        """The client's per-request sink (captured at admission, so a record
        reaches the turn that OWNED the request even after rebind). A result
        the server will not report — finished after the turn ended, or never
        written to the wire — is kept and forwarded; a normal one is not,
        because `item/completed` carries it."""
        late = self._done.is_set() or not rec.get("wire")
        if not late:
            return
        with self._late_lock:
            if rec["rid"] in self._late_rids:
                return
            self._late_rids.add(rec["rid"])
            self.late_tool_results.append(rec)
        if self._caller_on_late_tool_result is not None:
            try:
                self._caller_on_late_tool_result(rec)
            except Exception:                              # noqa: BLE001
                pass         # a journaling fault never reaches the worker

    # ── event fold (M2: raw notifications → normalized fields) ───────────

    def _note_reported_model(self, res: Any) -> None:
        """Keep the `model` a thread/start or thread/resume RESPONSE names.
        Absent on older servers; never substituted with what we asked for."""
        if isinstance(res, dict):
            m = cast("dict[str, Any]", res).get("model")
            if isinstance(m, str) and m:
                self.reported_model = m

    def _note_error(self, err: Any) -> None:
        """Keep a `turn.error` if there is one. A turn that completes cleanly
        sends `"error": null`, so the guard is what stops a clean completion
        from erasing an error an earlier event already recorded."""
        if isinstance(err, dict) and error_text(err):
            self.error = dict(cast("dict[str, Any]", err))

    def _observe(self, msg: dict[str, Any]) -> None:
        method = str(msg.get("method", ""))
        params: dict[str, Any] = msg.get("params") or {}
        if method == "item/agentMessage/delta":
            d = params.get("delta")
            if isinstance(d, str):
                self.agent_text.append(d)
        elif method == "thread/tokenUsage/updated":
            tu = params.get("tokenUsage")
            if isinstance(tu, dict):
                if not self._turn_started and self._token_usage_base is None:
                    total = tu.get("total")
                    if isinstance(total, dict):
                        self._token_usage_base = dict(total)
                else:
                    # Infer only from the FIRST in-turn snapshot. If an older
                    # server omits `last` there, retain the safe full-total
                    # fallback; inferring from a later request would discard
                    # earlier work in this same turn.
                    if self._token_usage_base is None \
                            and self.token_usage is None:
                        self._token_usage_base = _usage_before_last(tu)
                    self.token_usage = tu
        elif method == "account/rateLimits/updated":
            rl = params.get("rateLimits")
            if isinstance(rl, dict):
                self.rate_limits = rl
                self.rate_limit_snapshots[
                    str(rl.get("limitId") or "codex")] = rl
        elif method == "model/rerouted":
            # the provider's own word that it served `toModel` instead of
            # `fromModel` (schema 0.153.3). Kept whole; read by the route
            # receipt, never by the classifiers.
            self.rerouted = {k: params.get(k)
                             for k in ("fromModel", "toModel", "reason",
                                       "turnId")}
        elif method == "turn/completed":
            turn = params.get("turn")
            if isinstance(turn, dict):
                # ⚠ THE STATUS IS READ, NOT ASSUMED (D-209). See `_status_of`.
                self.status = _status_of(str(turn.get("status") or ""))
                self._note_error(turn.get("error"))
            else:
                self.status = STATUS_COMPLETED
            self._done.set()
        elif method == "turn/failed":
            # Kept although codex-cli 0.150.1 never sends it (see _TURN_STATUS)
            # — a future server that does must not land back in silence. The
            # error is read from either shape it could plausibly wear.
            self.status = STATUS_FAILED
            _t = params.get("turn")
            self._note_error(_t.get("error") if isinstance(_t, dict)
                             else params.get("error"))
            self._done.set()
        if self._caller_on_event:
            self._caller_on_event(msg)

    # ── lifecycle ────────────────────────────────────────────────────────

    def start(self, input_text: str,
              image_inputs: list[dict[str, Any]] | None = None,
              on_thread: Callable[[str], None] | None = None) -> str:
        """Initialize, open/resume the thread, start the turn. Returns the
        durable thread id (the provider session id the node records).

        `on_thread(thread_id)` fires the instant the thread id is FINAL and
        before `turn/start` goes on the wire — the last moment at which no
        notification for this turn can exist yet, because the turn does not.

        That hook is not a convenience; it is where the caller's ordering
        invariant is enforceable (supervisor `_codex_leg`). Returning the
        thread id from here is too late: `_pump` dispatches notifications on
        the READER thread while this one is still inside `request()`'s poll
        loop, so `item/started`, `item/agentMessage/delta` and
        `item/completed` are all observed BEFORE this method returns — on
        every run of a ten-run measurement, fresh threads and resumed ones
        alike. A caller that opens its journal on the return value therefore
        streams assistant output against a transcript that does not yet carry
        the user's message. test_codex_stream_order.py holds that failure
        down: remove this hook and it reports it.

        The hook is fail-open: journaling must never be the reason a turn
        does not run (same contract as `_codex_journal`), so an exception in
        it is swallowed and the turn proceeds."""
        self.client.initialize()
        if self.thread_id:
            # dynamicTools + developerInstructions ride the RESUME too —
            # measured (probe_resume_dyntools.py, 2026-08-29): the server
            # accepts both and calls the tool in the resumed turn. Without
            # them every turn after an agent's first had no org powers and a
            # stale identity, which fakecodex (mirroring the wire) caught.
            #
            # ⚠ AND SO DOES `sandbox` (2026-09-04). It used to ride only
            # `thread/start`, which pinned a thread's OS sandbox mode to
            # whatever it was BORN with: once `supervisor._codex_sandbox`
            # started answering `danger-full-access` for a bypassPermissions
            # node, lowering that node back down changed the setting in the UI
            # and revoked nothing on the thread it already had — a security
            # control that appears to apply and does not.
            #
            # MEASURED, not inferred, because this server IGNORES unknown
            # request fields (an invented `nonsenseField` is accepted
            # silently), so "the server took it" would prove nothing. The
            # proof is that `thread/resume` REJECTS a deliberately misspelt
            # sandbox value — `{"code": -32600, "message": "Invalid request:
            # unknown variant `danger-full-acess`, expected one of
            # `read-only`, `workspace-write`, `danger-full-access`"}` — so the
            # field is genuinely parsed by resume's schema, and behaviourally
            # a resumed turn that could write outside its cwd stops being able
            # to when resumed at `workspace-write`. codex-cli 0.153.3.
            res = self.client.request("thread/resume", {
                "threadId": self.thread_id,
                # the ROUTE's model rides the resume too (item 12).
                # `ThreadResumeParams.model` is in the 0.153.3 schema
                # ("Configuration overrides for the resumed thread"); the
                # per-turn override on `turn/start` below is what the
                # schema documents as applying "for this turn and
                # subsequent turns". Naming it here as well means the
                # response's `model` echo (ThreadResumeResponse.model)
                # describes the thread AS RESUMED rather than as it was
                # born. ⚠ Whether a real server keeps the conversation
                # across a model change is UNVERIFIED (no live control has
                # run); older servers ignore unknown fields (measured).
                "model": self.model,
                "sandbox": self.sandbox,
                "developerInstructions": self.developer_instructions,
                "dynamicTools": self.dynamic_tools or None})
            resumed = _thread_id_of(res)
            if resumed:
                self.thread_id = resumed
            self._note_reported_model(res)
        else:
            res = self.client.request("thread/start", {
                "model": self.model, "cwd": self.cwd,
                "sandbox": self.sandbox,
                "approvalPolicy": self.approval_policy,
                "developerInstructions": self.developer_instructions,
                "dynamicTools": self.dynamic_tools or None})
            tid = _thread_id_of(res)
            if not tid:
                raise CodexServerError(
                    f"thread/start returned no thread id: "
                    f"{json.dumps(res)[:300]}")
            self.thread_id = tid
            self._note_reported_model(res)
        user_input: list[dict[str, Any]] = [
            {"type": "text", "text": input_text}]
        user_input.extend(image_inputs or [])
        if on_thread is not None and self.thread_id:
            try:
                on_thread(self.thread_id)
            except Exception:                              # noqa: BLE001
                pass      # journaling never blocks a turn — see the docstring
        self._turn_started = True
        turn = self.client.request("turn/start", {
            "threadId": self.thread_id,
            "input": user_input,
            "model": self.model, "effort": self.effort,
            "cwd": self.cwd, "summary": "none"})
        t = turn.get("turn")
        self.turn_id = (str(t["id"]) if isinstance(t, dict) and t.get("id")
                        else str(turn.get("turnId") or "") or None)
        assert self.thread_id is not None
        return self.thread_id

    def close(self) -> None:
        """End the app-server THIS turn created.

        It did not exist until 2026-09-04, and its absence was a quiet
        footgun: `try: turn.close() except Exception: pass` reads as teardown,
        raised `AttributeError`, got swallowed, and left the whole app-server
        tree alive holding the thread's `~/.codex` write lock — so the NEXT
        `thread/resume` died with "already has an active writer", a failure
        that points nowhere near the missing teardown. Measured while probing
        the resume path.

        ⚠ ONLY a client this turn constructed. When the supervisor hands a
        pre-warmed process in (`client=`), its lifetime belongs to `warmpool`
        and the correct end is `park_back`/`discard`, not this — closing it
        here would silently turn a park into a kill. That case RAISES rather
        than no-opping: a no-op is the inert kind of safety that reads as
        working teardown and is not.
        """
        if not self._owns_client:
            raise RuntimeError(
                "CodexTurn.close() on a BORROWED app-server client: this "
                "turn did not create it and must not end it. A pooled "
                "process is returned with warmpool.park_back() or ended with "
                "warmpool.discard(); see supervisor._codex_leg's finally.")
        self.client.close()

    def steer(self, text: str, timeout: float | None = None,
              on_late: Callable[[SteerOutcome], None] | None = None
              ) -> SteerOutcome:
        """Mid-turn input (C.2) → accepted / rejected / UNKNOWN (audit D3).

        rejected: the server answered that the input was NOT appended (the
            expectedTurnId guard; see `classify_steer_error`). The caller may
            re-deliver: nothing reached the model.
        accepted: the server answered `turnId`. The text is in the turn.
        unknown:  no answer inside `timeout` (default `STEER_TIMEOUT`), the
            process died, the pipe broke, or an ambiguous server error. The
            text MAY be in the turn. This used to be returned as False and
            re-delivered as if refused — the audit's duplicate. Now the id
            stays registered: if the reply comes later, `on_late(outcome)` is
            called ON ITS OWN THREAD with the resolved accepted/rejected, and
            the entry in `steer_log` gains `resolved`.
        """
        if not (self.thread_id and self.turn_id):
            return SteerOutcome(STEER_REJECTED, "no active turn to steer")
        entry: dict[str, Any] = {"at": time.time(), "chars": len(text),
                                 "outcome": None, "reason": ""}
        self.steer_log.append(entry)

        expected = self.turn_id

        def _late(resp: dict[str, Any]) -> None:
            # the SAME three-way classification as the prompt path: a late
            # reply can be an acknowledgement, a structural refusal, or an
            # ambiguous error / wrong-turn ack — and that last one stays
            # UNKNOWN (review 2026-09-05: it must never read as refused)
            try:
                result = AppServerClient._raise_for("turn/steer", resp)
                resolved = classify_steer_result(result, expected)
            except CodexRequestError as e:
                resolved = classify_steer_error(e.code, e.message)
            resolved = SteerOutcome(str(resolved), "late " + resolved.reason)
            entry["resolved"] = str(resolved)
            entry["resolved_reason"] = resolved.reason
            if on_late is not None:
                # off the reader thread: the caller commits a doc write here
                threading.Thread(target=on_late, args=(resolved,),
                                 daemon=True, name="codexsteer-late").start()

        try:
            result = self.client.request("turn/steer", {
                "threadId": self.thread_id,
                "expectedTurnId": self.turn_id,
                "input": [{"type": "text", "text": text}]},
                STEER_TIMEOUT if timeout is None else timeout, on_late=_late)
            out = classify_steer_result(result, expected)
        except CodexRequestError as e:
            out = classify_steer_error(e.code, e.message)
        except CodexRequestTimeout as e:
            out = SteerOutcome(STEER_UNKNOWN, str(e))
        except CodexServerError as e:          # process gone, and the rest
            out = SteerOutcome(STEER_UNKNOWN, str(e))
        except (OSError, ValueError) as e:     # the pipe itself
            out = SteerOutcome(STEER_UNKNOWN, f"wire: {type(e).__name__}: {e}")
        entry["outcome"] = str(out)
        entry["reason"] = out.reason
        return out

    def interrupt(self) -> bool:
        if not (self.thread_id and self.turn_id):
            return False
        try:
            self.client.request("turn/interrupt", {
                "threadId": self.thread_id, "turnId": self.turn_id}, 30)
            return True
        except CodexServerError:
            return False

    def wait(self, timeout: float | None = None, *,
             close_client: bool = True) -> dict[str, Any]:
        """Block until the turn ends and return the normalized result.

        Cold callers retain the historical default and close the app-server.
        A warm-pool claimant passes ``close_client=False`` and parks the same
        process after this boundary.
        """
        finished = self._done.wait(timeout) if timeout else self._done.wait()
        if not finished and self.status is None:
            self.status = STATUS_FAILED
        # ── D2: give in-flight tool workers a bounded moment ──
        # Whatever finishes inside it is answered on the wire under this
        # binding and reported below; whatever does not is COUNTED here and
        # still reaches `_tool_result` (retained, sink) when it ends — the
        # deadline is a courtesy, not the proof that work stopped.
        inflight = self.client.drain_tools(TOOL_DRAIN_S)
        if close_client:
            self.client.close()
        usage, usage_reset = _turn_usage(
            self.token_usage, self._token_usage_base)
        return {
            "thread_id": self.thread_id,
            "turn_id": self.turn_id,
            "status": self.status or STATUS_FAILED,
            "agent_text": "".join(self.agent_text),
            "token_usage": usage,
            # A counter moving backwards is not silently clamped: the current
            # snapshot is booked as a new baseline and the supervisor records
            # this evidence on the node for audit/reconciliation.
            "usage_reset": usage_reset,
            "rate_limits": self.rate_limits,
            # D-209: the CLI's own reason, and the whole rate-limit board that
            # dates it. Both are None/{} on every healthy turn.
            "error": self.error,
            "rate_limit_snapshots": dict(self.rate_limit_snapshots),
            # the provider-reported side of the route receipt (see __init__)
            "reported_model": self.reported_model,
            "rerouted": dict(self.rerouted) if self.rerouted else None,
            # D2: tool results the server will not report (finished after the
            # turn ended, or never reached the wire), and how many were still
            # running when this returned. `late_tool_results` may still GROW
            # after this dict is built — the sink appends as workers end.
            "late_tool_results": list(self.late_tool_results),
            "inflight_tools": inflight,
            # D3: every steer this turn sent and how it went, for receipts.
            "steer_log": [dict(e) for e in self.steer_log],
        }
