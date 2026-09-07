# pyright: strict
"""Redacted failure fixtures — contract in docs/failure-fixtures.md.

  · ALLOWLIST: a field not built here does not exist; no prose — text inputs
    become per-predicate FEATURES from finite vocabularies, plus a length.
  · EVERY STRING LEAF is a closed vocabulary member or "other"/None.
  · TYPED EVIDENCE IS PRESERVED, never coerced: statuses go through the
    supervisor's own strict predicate (failclass._strict_http_status).
  · observed (facts) / recorded (the site's decision) / phase (inference,
    "unknown" allowed) are separate fields.
  · Bounded (CAP_BYTES, RING), never in the org document, fail-open, pure.
"""
from __future__ import annotations

import itertools
import json
import os
import re
import time
from typing import Any, Callable, Mapping, cast

from . import failclass

SCHEMA = 4
CAP_BYTES = 8192            # three maximal feature sets fit (suite §1 bound)
RING = 40
TEXT_FIELDS = ("err_blob", "stderr_tail", "result_detail")
_SEQ = itertools.count(1)       # per-process; `next` is atomic under the GIL

# --------------------------------------------------------------- vocabularies
# The three predicate vocabularies are the classifiers' OWN phrases
# (failclass.py); the suite asserts that by AST and asserts
# predicate(blob) == predicate(blob_of(features_of(blob))).
LIMIT_WORDS = ("limit", "usage", "weekly", "reached", "exceeded", "quota",
               "hit your", "resets", "session", "exceed", "account",
               "rate limit")
NET_WORDS = ("econnrefused", "econnreset", "etimedout", "econnaborted",
             "enetunreach", "ehostunreach", "enotfound", "eai_again",
             "socket hang up", "fetch failed", "network error", "networkerror",
             "connection refused", "connection reset", "connection error",
             "getaddrinfo", "dns lookup failed")
FILTER_WORDS = ("content filter", "filtering policy", "content policy",
                "blocked by content", "output blocked", "flagged by")
# the CLI's typed API-error vocabulary (read out of the 2.1.258 binary,
# supervisor `_AUTH_ERROR_CODES` and siblings) and provider machine tags
CODE_WORDS = ("authentication_failed", "oauth_org_not_allowed",
              "account_on_hold", "billing_error", "rate_limit",
              "model_not_found", "invalid_request", "server_error",
              "max_output_tokens", "dlp_request_denied",
              "usagelimitexceeded", "usage_limit_reached", "invalid api key",
              "authentication failure")
# fixed diagnoses orgtree itself writes into the blob
DIAG_WORDS = ("the cli exited", "without writing anything to stderr",
              "unknown option", "no conversation found", "turn killed",
              "per-message ceiling", "enospc", "enomem", "eacces", "eperm",
              "api status")
# the options orgtree passes to the claude CLI (supervisor argv literals):
# an `unknown option` diagnosis names one of these, or "other"
CLI_OPTIONS = frozenset({
    "--add-dir", "--settings", "--resume", "--model", "--fork-session",
    "--strict-mcp-config", "--output-format", "--mcp-config",
    "--disallowed-tools", "--allowedTools", "--verbose", "--session-id",
    "--permission-mode", "--version", "--max-turns", "--input-format",
    "--include-partial-messages", "--effort", "--debug-to-stderr",
    "--append-system-prompt-file", "--print", "--continue"})
FEATURE_VOCAB: dict[str, tuple[str, ...]] = {
    "limit": LIMIT_WORDS, "net": NET_WORDS, "filter": FILTER_WORDS,
    "code": CODE_WORDS, "diag": DIAG_WORDS}
VOCAB = LIMIT_WORDS + NET_WORDS + FILTER_WORDS + CODE_WORDS + DIAG_WORDS
NUM_MAX = 8                                    # per numeric feature list
_STATUS_RE = re.compile(r"(?<![\d.])([45]\d\d)(?![\d.])")
_EXIT_RE = re.compile(r"the cli exited (\d{1,3})")
_RPC_RE = re.compile(r"(-32\d{3})")
_OPTION_RE = re.compile(r"unknown option '?(--[A-Za-z][A-Za-z0-9-]{0,40})")

STREAM_CODES = frozenset(CODE_WORDS[:10])
TERMINAL_REASONS = frozenset({"api_error", "max_turns", "error", "success",
                              "interrupted", "cancelled", "aborted"})
CODEX_STATUS = frozenset({"completed", "failed", "interrupted", "in_progress"})
CODEX_POOLS = frozenset({"plan", "reserve", "<sent>"})   # codex_route pools
# codex_decide vocabularies (pool_capacity states; FailureClass.pool_state)
CAP_STATES = frozenset({"absent", "stale", "usable", "exhausted"})
POOL_STATES = frozenset({"exhausted", "no-grant", "unexplained",
                         "unattributed", "n/a"})
AGY_STATUS = frozenset({"completed", "failed", "interrupted"})
SCHEDULE_KINDS = frozenset({"observed-deadline", "probe"})
# codex_route._CODE_KIND keys (normalised machine tags) and KIND_* values
CODEX_ERROR_CODES = frozenset({
    "usagelimitexceeded", "ratelimitexceeded", "unauthorized",
    "contextwindowexceeded", "sessionbudgetexceeded", "serveroverloaded",
    "httpconnectionfailed", "responsestreamconnectionfailed",
    "responsestreamdisconnected", "responsetoomanyfailedattempts"})
CODEX_KINDS = frozenset({"usage-limit", "rate-limit", "auth", "context",
                         "budget", "overloaded", "connection",
                         "usage-limit-prose", "other", "unknown"})
LANES = frozenset({"claude", "openrouter", "codex", "antigravity"})
SITES = frozenset({"terminal", "exhausted", "codex", "antigravity"})
PHASES = ("admission", "stream", "result-error", "teardown", "unknown")
_VERSION_RE = re.compile(r"^\d{1,3}\.\d{1,3}\.\d{1,4}$")
_AT_RE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")


def features_of(text: Any) -> dict[str, list[Any]]:
    """Per-predicate features of a text: for each vocabulary, the phrases
    present (bounded by the vocabulary itself, so nothing later in the list
    can be dropped), and up to NUM_MAX typed numbers each for status, exit,
    rpc and option (an option outside CLI_OPTIONS is "other")."""
    b = str(text or "").lower()
    out: dict[str, list[Any]] = {k: [] for k in FEATURE_VOCAB}
    out.update({"status": [], "exit": [], "rpc": [], "option": []})
    if not b:
        return out
    for k, words in FEATURE_VOCAB.items():
        out[k] = [w for w in words if w in b]
    out["status"] = [int(m) for m in dict.fromkeys(_STATUS_RE.findall(b))][:NUM_MAX]
    out["exit"] = [int(m) for m in dict.fromkeys(_EXIT_RE.findall(b))][:NUM_MAX]
    out["rpc"] = [int(m) for m in dict.fromkeys(_RPC_RE.findall(b))][:NUM_MAX]
    out["option"] = [(m if m in CLI_OPTIONS else "other")
                     for m in dict.fromkeys(_OPTION_RE.findall(str(text or "")))][:NUM_MAX]
    return out


def blob_of(f: Mapping[str, Any]) -> str:
    """The classifier input a feature set stands for."""
    words: list[str] = []
    for k in FEATURE_VOCAB:
        words += [str(w) for w in (f.get(k) or [])]
    words += [f"api status {s}" for s in (f.get("status") or [])]
    words += [f"the cli exited {e}" for e in (f.get("exit") or [])]
    words += [str(r) for r in (f.get("rpc") or [])]
    words += [f"unknown option '{o}'" for o in (f.get("option") or [])]
    return " ".join(words)


def _vocab(value: Any, allowed: frozenset[str]) -> str | None:
    if value is None or value == "":
        return None
    v = str(value).strip().lower()[:48]
    return v if v in allowed else "other"


def _version(value: Any) -> str | None:
    v = str(value or "").strip()
    return v if _VERSION_RE.match(v) else None


def _int_or_none(value: Any) -> int | None:
    """Counts and codes: an int (not a bool) or None — no string coercion."""
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _status(value: Any) -> int | None:
    """Typed HTTP evidence through the supervisor's own strict predicate."""
    return failclass._strict_http_status(value)


def _epoch(value: Any) -> int | None:
    """A reset instant / duration: a positive number (not a bool), as whole
    seconds; None otherwise — no string coercion."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value) if value > 0 else None


def ran_as_sentinel(ran_as: Any) -> str:
    r = str(ran_as or "")
    if not r:
        return ""
    return r if r in ("ambient", "api-key", "openrouter") else "account"


# ------------------------------------------------------------------ inference


def phase_of(obs: Mapping[str, Any], codex: Mapping[str, Any] | None) -> str:
    """Where the turn died, only where the observed facts establish it.

    admission     claude lanes: nothing was output, the result boundary was
                  reached and it carried a typed 401/402/429 refusal;
                  codex: the provider's own recorded rejection (which the
                  classifier grants only with nothing run)
    stream        output began and no result boundary was ever reached
    result-error  the boundary was reached carrying the error after output
    teardown      the boundary was reached clean; the process exited nonzero
    unknown       everything else — no output does not prove nothing ran;
                  an RPC error alone does not prove admission; a late
                  timeout is not teardown."""
    if codex is not None:
        if codex.get("rejected_recorded"):
            return "admission"
        if int(codex.get("items_seen") or 0) and codex.get("status") is None:
            return "stream"
        return "unknown"
    typed = obs.get("api_error_status") or obs.get("stream_status")
    if not obs.get("started"):
        if obs.get("boundary") and obs.get("is_error") and typed in (401, 402, 429):
            return "admission"
        return "unknown"
    if not obs.get("boundary"):
        return "stream"
    if obs.get("is_error") or typed is not None:
        return "result-error"
    if (obs.get("exit_code") or 0) != 0:
        return "teardown"
    return "unknown"


def verdict_of(cl: Mapping[str, Any]) -> str:
    """The predicate-level class in the supervisor's precedence — NOT the
    branch taken, which also reads the retry counter, lane policy, pause."""
    if cl.get("filtered"):
        return "filtered"
    if cl.get("limit"):
        return "limit"
    if cl.get("net"):
        return "net"
    return "none"


# ------------------------------------------------------------------ building


def build(*, lane: str, site: str, observed: Mapping[str, Any],
          text: Mapping[str, Any], recorded: Mapping[str, Any],
          codex: Mapping[str, Any] | None = None,
          agy: Mapping[str, Any] | None = None, ran_as: Any = "",
          cli: Mapping[str, Any] | None = None,
          at: str | None = None) -> dict[str, Any]:
    obs: dict[str, Any] = {
        "exit_code": _int_or_none(observed.get("exit_code")),
        "parked": bool(observed.get("parked")),
        "exit_only": bool(observed.get("exit_only")),
        "started": bool(observed.get("started")),
        "boundary": bool(observed.get("boundary")),
        "errors_n": _int_or_none(observed.get("errors_n")) or 0,
        "is_error": observed.get("is_error") is True,
        "api_error_status": _status(observed.get("api_error_status")),
        "stream_status": _status(observed.get("stream_status")),
        "stream_code": _vocab(observed.get("stream_code"), STREAM_CODES),
        "terminal_reason": _vocab(observed.get("terminal_reason"),
                                  TERMINAL_REASONS),
        "run": _int_or_none(observed.get("run")) or 0,
        "exhausted": bool(observed.get("exhausted")),
    }
    feats: dict[str, dict[str, list[Any]]] = {
        k: features_of(text.get(k)) for k in TEXT_FIELDS}
    lens: dict[str, int] = {k: len(str(text.get(k) or "")) for k in TEXT_FIELDS}
    rec: dict[str, Any] = {
        "limit": recorded.get("limit") is True,
        "net": recorded.get("net") is True,
        "filtered": recorded.get("filtered") is True,
        "typed": _status(recorded.get("typed")),
    }
    rec["verdict"] = verdict_of(rec)
    cx: dict[str, Any] | None = None
    if codex is not None:
        cx = {
            "status": _vocab(codex.get("status"), CODEX_STATUS),
            "rpc_code": _int_or_none(codex.get("rpc_code")),
            "error_code": _vocab(codex.get("error_code"), CODEX_ERROR_CODES),
            "items_seen": _int_or_none(codex.get("items_seen")) or 0,
            "had_usage": codex.get("had_usage") is True,
            "text_len": _int_or_none(codex.get("text_len")) or 0,
            "pool": _vocab(codex.get("pool"), CODEX_POOLS),
            "served": _vocab(codex.get("served"), CODEX_POOLS),
            "usage_prose": codex.get("usage_prose") is True,
            "now": _int_or_none(codex.get("now")),
            # the resolved evidence codex_decide.decide reads (typed)
            "snap_exhausted": codex.get("snap_exhausted") is True,
            "snap_reset": _epoch(codex.get("snap_reset")),
            "board_fresh": codex.get("board_fresh") is True,
            "board_complete": codex.get("board_complete") is True,
            "cap_state": _vocab(codex.get("cap_state"), CAP_STATES),
            "cap_reset": _epoch(codex.get("cap_reset")),
            # the site's decision, kept apart by name; never an input
            "kind_recorded": _vocab(codex.get("kind_recorded"), CODEX_KINDS),
            "rejected_recorded": codex.get("rejected_recorded") is True,
            "attributed_recorded": _vocab(codex.get("attributed_recorded"),
                                          CODEX_POOLS),
            "redrive_recorded": codex.get("redrive_recorded") is True,
            "pool_state_recorded": _vocab(codex.get("pool_state_recorded"),
                                          POOL_STATES),
            "reset_recorded": _epoch(codex.get("reset_recorded")),
        }
    ag: dict[str, Any] | None = None
    if agy is not None:
        ag = {
            "status": _vocab(agy.get("status"), AGY_STATUS),
            "items": _int_or_none(agy.get("items")) or 0,
            "had_usage": agy.get("had_usage") is True,
            "reset_in_s": _epoch(agy.get("reset_in_s")),
            "elapsed_s": _int_or_none(agy.get("elapsed_s")),
            "ceiling_s": _int_or_none(agy.get("ceiling_s")),
            # the site's decisions, kept apart by name
            "walled_recorded": agy.get("walled_recorded") is True,
            "reset_known_recorded": agy.get("reset_known_recorded") is True,
            "schedule_recorded": _vocab(agy.get("schedule_recorded"),
                                        SCHEDULE_KINDS),
            "ceiling_kill_recorded": agy.get("ceiling_kill_recorded") is True,
        }
    fx: dict[str, Any] = {
        "schema": SCHEMA,
        "lane": _vocab(lane, LANES) or "other",
        "site": _vocab(site, SITES) or "other",
        "at": (str(at) if at and _AT_RE.match(str(at))
               else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
        "observed": obs, "features": feats, "lens": lens, "recorded": rec,
        "codex": cx, "agy": ag, "ran_as": ran_as_sentinel(ran_as),
        "cli": {"exit": _int_or_none((cli or {}).get("exit")),
                "version": _version((cli or {}).get("version"))},
    }
    fx["phase"] = phase_of(obs, cx)
    return fx


# ------------------------------------------------------------------- writing


def fixture_dir(root: str, org: str, node: str) -> str:
    return os.path.join(root, "failfix", str(org), str(node))


def write(root: str, org: str, node: str, fx: Mapping[str, Any]) -> str | None:
    """One fixture into the node's ring (oldest beyond RING evicted). Returns
    the path, or None — never raises."""
    try:
        blob = json.dumps(fx, ensure_ascii=False, indent=1)
        if len(blob.encode("utf-8")) > CAP_BYTES:
            return None
        d = fixture_dir(root, org, node)
        os.makedirs(d, exist_ok=True)
        stamp = int(time.time() * 1000)
        seq = next(_SEQ) % 10000
        name = (f"{stamp:013d}-{seq:04d}-{fx.get('phase')}-"
                f"{fx.get('recorded', {}).get('verdict')}.json")
        path = os.path.join(d, name)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            f.write(blob)
        os.replace(tmp, path)
        names = sorted(n for n in os.listdir(d) if n.endswith(".json"))
        for old in (names[:-RING] if len(names) > RING else []):
            try:
                os.remove(os.path.join(d, old))
            except OSError:
                pass
        return path
    except Exception:                                        # noqa: BLE001
        return None


def record(root: str, org: str, node: str, **kw: Any) -> str | None:
    """build + write, fail-open — the one entry point production calls.
    `org`/`node` place the file and never enter it."""
    try:
        return write(root, org, node, build(**kw))
    except Exception:                                        # noqa: BLE001
        return None


def load(path: str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        fx = cast("dict[str, Any]", json.load(f))
    if int(fx.get("schema") or 0) != SCHEMA:
        raise ValueError(f"fixture schema {fx.get('schema')!r}, expected {SCHEMA}")
    return fx


def list_fixtures(root: str, org: str, node: str) -> list[str]:
    d = fixture_dir(root, org, node)
    try:
        return sorted(os.path.join(d, n) for n in os.listdir(d)
                      if n.endswith(".json"))
    except OSError:
        return []


# -------------------------------------------------------------------- replay

Predicates = Mapping[str, Callable[..., Any]]


def replay(fx: Mapping[str, Any], predicates: Predicates) -> dict[str, Any]:
    """Re-run the predicates on the fixture's features and observed facts.
    Returns recomputed / recorded / phase / drift (names whose recomputed
    value differs from the recorded). Codex outputs are not recomputed."""
    obs = cast("Mapping[str, Any]", fx.get("observed") or {})
    feats = cast("Mapping[str, Any]", fx.get("features") or {})
    rec = cast("Mapping[str, Any]", fx.get("recorded") or {})
    blob = blob_of(cast("Mapping[str, Any]", feats.get("err_blob") or {}))
    typed: int | None = None
    if fx.get("lane") == "openrouter":
        res = {"is_error": bool(obs.get("is_error")),
               "api_error_status": obs.get("api_error_status")}
        typed = predicates["typed"](res, {"status": obs.get("stream_status")})
    if typed is None:
        limit = bool(predicates["limit"](blob))
        net = bool(predicates["net"](blob)) or bool(
            predicates["died_in_flight"](exit_only=bool(obs.get("exit_only")),
                                         started=bool(obs.get("started")),
                                         boundary=bool(obs.get("boundary"))))
    else:
        limit = typed in (401, 402, 429)
        net = typed >= 500
    cl: dict[str, Any] = {"limit": limit, "net": net,
                          "filtered": bool(predicates["filtered"](blob)),
                          "typed": typed}
    cl["verdict"] = verdict_of(cl)
    phase = phase_of(obs, cast("Mapping[str, Any] | None", fx.get("codex")))
    drift = [k for k in ("limit", "net", "filtered", "typed", "verdict")
             if rec.get(k) != cl.get(k)]
    if phase != fx.get("phase"):
        drift.append("phase")
    cx = fx.get("codex")
    if isinstance(cx, Mapping) and "codex_decide" in predicates:
        # re-decide from the recorded EVIDENCE (never from *_recorded)
        cxm = cast("Mapping[str, Any]", cx)
        ev = {
            "status": cxm.get("status"), "code": cxm.get("error_code") or "",
            "usage_prose": bool(cxm.get("usage_prose")),
            "nothing_ran": bool(predicates["codex_nothing_ran"](
                items_seen=int(cxm.get("items_seen") or 0),
                had_usage=bool(cxm.get("had_usage")),
                text_len=int(cxm.get("text_len") or 0))),
            "pool": str(cxm.get("pool") or ""), "served": cxm.get("served"),
            "snap_exhausted": bool(cxm.get("snap_exhausted")),
            "snap_reset": cxm.get("snap_reset"),
            "board_fresh": bool(cxm.get("board_fresh")),
            "board_complete": bool(cxm.get("board_complete")),
            "cap_state": cxm.get("cap_state"), "cap_reset": cxm.get("cap_reset"),
        }
        d = cast("Mapping[str, Any]", predicates["codex_decide"](ev))
        cl["codex"] = {"kind": d["kind"], "rejected": bool(d["rejected"]),
                       "attributed": d["attributed"],
                       "redrive": bool(d["redrive"]),
                       "pool_state": d["pool_state"],
                       "reset_ts": _epoch(d["reset_ts"])}
        for k, rk in (("kind", "kind_recorded"), ("rejected", "rejected_recorded"),
                      ("attributed", "attributed_recorded"),
                      ("redrive", "redrive_recorded"),
                      ("pool_state", "pool_state_recorded"),
                      ("reset_ts", "reset_recorded")):
            if cxm.get(rk) != cl["codex"][k]:
                drift.append("codex." + k)
    ag = fx.get("agy")
    if isinstance(ag, Mapping):
        agm = cast("Mapping[str, Any]", ag)
        walled = bool(predicates["limit"](blob))
        reset_known = walled and agm.get("reset_in_s") is not None
        el, ce = agm.get("elapsed_s"), agm.get("ceiling_s")
        ceiling_kill = (not walled and isinstance(el, int)
                        and isinstance(ce, int) and el >= ce)
        cl["agy"] = {"walled": walled, "reset_known": reset_known,
                     "schedule": "observed-deadline" if reset_known else "probe",
                     "ceiling_kill": ceiling_kill}
        for k, rk in (("walled", "walled_recorded"),
                      ("reset_known", "reset_known_recorded"),
                      ("schedule", "schedule_recorded"),
                      ("ceiling_kill", "ceiling_kill_recorded")):
            if agm.get(rk) != cl["agy"][k]:
                drift.append("agy." + k)
    return {"recomputed": cl, "recorded": dict(rec), "phase": phase,
            "phase_recorded": fx.get("phase"), "drift": drift}
