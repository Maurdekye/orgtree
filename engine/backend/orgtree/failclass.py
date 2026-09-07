# pyright: strict
"""The turn-failure classifiers, as a SIDE-EFFECT-FREE module.

These are VERBATIM copies of the supervisor's pure predicates (the suite
`test_failure_fixtures.py` §6 asserts the source of every function here is
byte-identical to the one in supervisor.py, so the two cannot drift apart
silently). They exist here so that `failfix.replay` and
`tools/replay_failure.py` can classify a recorded failure fixture with NO
import of the supervisor — which would bind the storage root, load the
provider registry and start nothing it should not. This module imports only
`typing`.

Behaviour-preserving by construction; the supervisor keeps its own copies
until the rewiring is reviewed (docs/failure-fixtures.md).
"""
from __future__ import annotations

from typing import Any, Mapping, cast

_STATUS_KEYS = ("api_error_status", "apiErrorStatus")


def _strict_http_status(value: Any) -> int | None:
    """An HTTP ERROR status the CLI reported, or None — `int` ONLY.

    `True` is an int in Python and `"401"` is a digit string; both are
    refused here on purpose. This value picks a turn's failure CLASS
    exclusively (OpenRouter lane, 2026-09-05), so it must be a number the
    CLI typed, never a coercion of something that merely looks like one."""
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 400 <= value <= 599 else None


def _typed_status_field(obj: Any) -> int | None:
    """The HTTP error status on ONE record, under either spelling, or None."""
    if not isinstance(obj, dict):
        return None
    rec = cast("dict[str, Any]", obj)
    for key in _STATUS_KEYS:
        status = _strict_http_status(rec.get(key))
        if status is not None:
            return status
    return None


def _typed_api_status(res: dict[str, Any],
                      stream_err: Mapping[str, Any]) -> int | None:
    """The HTTP error status this turn ENDED on, as a strict int, or None.

    Precedence: the top-level RESULT event first, then the latest unresolved
    engine-authored status the stream showed (`_note_synthetic_status`). A
    clean result with no such status left standing answers None, and None
    means "no typed evidence": the caller falls back to the prose predicates
    exactly as before this existed. A typed answer is never widened by prose
    and prose never invents a number (coordinator ruling 2026-09-05).

    ⚠ THE FIRST SOURCE IS THE ONLY ONE THE PINNED CLI FEEDS. Read out of the
    2.1.258 binary: the engine assigns `is_error` and `api_error_status` onto
    the result from the LAST assistant message together, so the flag and the
    number travel as a pair — a turn ending on the synthetic refusal carries
    both, and a turn that produced real output after an error carries neither.
    Requiring `is_error` here is therefore not a restriction the CLI can
    surprise us on. The second source is hypothetical compatibility; see
    `_note_synthetic_status`, and the retained review artifact
    cli-stdout-shape-2.1.258.md (codex-delivery's scratch, not this repo)."""
    if res.get("is_error") is True:
        status = _typed_status_field(res)
        if status is not None:
            return status
    return _strict_http_status(stream_err.get("status"))


def _looks_like_usage_limit(blob: str) -> bool:
    # №8 adjacent fix: the CLI's session-limit phrasing is "You've hit your
    # session limit — resets 1:40pm", which matched NONE of the original
    # second set — the freeze machinery never fired for exactly that case
    # 2026-09-04: Anthropic's live 429 says "would exceed your account's rate
    # limit"; the too-long "exceeded" stem silently returned False here.
    # 2026-09-04 (same day, follow-up): the bare "exceed" stem added for that
    # 429 ALSO matched "input length and max_tokens exceed context limit:
    # 205000 > 200000" — a context overflow, not a wall. That froze the agent
    # to wait out a reset that never comes, and swallowed the real error; a
    # wrong freeze is worse than the missed 429, which at least failed loudly.
    # So "exceed" now needs an account-scope word beside it. Both "account"
    # and "rate limit" appear in the observed 429 and in no overflow message.
    # "exceeded" still stands alone, exactly as it did before either change.
    b = blob.lower()
    if "limit" not in b:
        return False
    if any(w in b for w in ("usage", "weekly", "reached", "exceeded",
                            "quota", "hit your", "resets", "session")):
        return True
    return "exceed" in b and any(w in b for w in ("account", "rate limit"))


def _looks_like_connection_failure(blob: str) -> bool:
    """USER REPORT 2026-08-06 ('network interruptions halt chats mid-turn;
    they should restart automatically once connectivity resumes'): the
    MISSING third class — filtered and usage-limit are positively
    classified, a dropped connection fell into the terminal turn-failed
    bucket where nothing ever re-drives the node while the backend stays
    up. Narrow and POSITIVE like _looks_like_filtered, never a catch-all:
    'retry any failure' turns a bad argv or a missing CLI into an infinite
    loop burning turn slots and real cost (№28's hazard). Phrasings are the
    node/undici and OS errno spellings the CLI emits when the wire drops."""
    b = blob.lower()
    return any(p in b for p in (
        "econnrefused", "econnreset", "etimedout", "econnaborted",
        "enetunreach", "ehostunreach", "enotfound", "eai_again",
        "socket hang up", "fetch failed", "network error", "networkerror",
        "connection refused", "connection reset", "connection error",
        "getaddrinfo", "dns lookup failed"))


def _died_in_flight(*, exit_only: bool, started: bool, boundary: bool) -> bool:
    """The same transient class as above, in the case the classifier above
    CANNOT SEE (user incident 2026-08-21).

    Read that docstring again: it names this exact hazard — "a dropped
    connection fell into the terminal turn-failed bucket where nothing ever
    re-drives the node" — and it fixed the half where the wire error is
    REPORTED. This is the half where the CLI dies too hard to report it. The
    connection closed mid-response, the CLI's stream-json catch path wrote
    nothing to stderr and left `errors: []` empty, so orgtree synthesized
    "the CLI exited 1 without writing anything to stderr" (see the `err_blob`
    fallback) — which matches no errno spelling on earth. It fell through to
    the terminal `raise`, no freeze record was written, and a live agent sat
    idle with uncommitted work until a human happened to notice, two hours
    later. Nothing in the system was ever going to re-drive it.

    With no text to classify, classify the SHAPE of the turn. All three must
    hold, and the conjunction IS the safety argument:

    `exit_only`  — the CLI exited nonzero and NOTHING anywhere said why:
        nothing on stderr, `errors: []` empty. A nonzero exit carrying a real
        error is evidence, and evidence is never overridden here — those keep
        today's terminal behaviour, untouched.
    `started`    — a top-level assistant event arrived, so the CLI launched,
        reached the API, and got an answer out of it. This is the clause that
        excludes the failures which must NEVER retry: a bad argv, a missing
        CLI, an unreadable config, a charter too big to send. They die before
        the model ever speaks, so they stay terminal exactly as they do now.
    `not boundary` — no top-level result event ever arrived, so it died IN
        FLIGHT and not after finishing. A turn that reached its boundary and
        then exited nonzero is a straggler, not a casualty.

    Deliberately NOT a catch-all, for №28's reason and the one the classifier
    above already states: "retry any failure" turns a crash loop into an
    infinite one. The residual case this DOES admit is a CLI that genuinely
    crashes mid-response every time — and that is bounded by the very same
    NET_RETRY_MAX, off the very same `net_fail_run` counter, deliberately
    shared so a node flapping between the two classes gets four attempts in
    total rather than four each. When it exhausts, it says so out loud
    (`_retry_exhausted`) instead of going quiet, which is the actual harm the
    incident did."""
    return exit_only and started and not boundary


def _looks_like_filtered(blob: str) -> bool:
    """A model-side content filter flagged the message (user spec — Fable
    carries extra safety filters). Phrases seen from the API/CLI on filter
    stops; deliberately narrow so ordinary errors never match."""
    b = blob.lower()
    return any(p in b for p in (
        "content filter", "filtering policy", "content policy",
        "blocked by content", "output blocked", "flagged by"))
