"""WHICH CLI DRIVES AN OPENROUTER AGENT — the harness axis, and only it.

Until now an OpenRouter tier meant exactly one thing: the Claude CLI with
`ANTHROPIC_BASE_URL` re-pointed at openrouter.ai (supervisor.spawn_env, the
lane's own comment). That is a harness choice nobody ever made explicitly,
because there was nothing to choose between. A machine with a usable Codex CLI
can drive the same gateway, so the choice becomes real and needs a name, a
stored value, an availability answer and a refusal — which is this module.

⚠ THE HARNESS IS NOT THE PROVIDER. `providers.provider_of` answers WHOSE
MODELS a tier reaches (an `or-` tier reaches OpenRouter's, whichever CLI is
holding the wire) and does not move. This module answers WHICH LOCAL PROGRAM
is holding that wire. Two agents on the same OpenRouter model, one per harness,
are the same provider, the same billing key and the same catalogue — they
differ only in the process orgtree spawns and the protocol it speaks to it.

MEASURED, not assumed (2026-09-19, codex-cli 0.154.0 on this host, against the
real gateway — probe/probe_appserver_openrouter.py in the author's scratch):

  · Codex reaches OpenRouter through a `model_providers.<name>` block passed
    as `-c` overrides, with `base_url` = the gateway's OpenAI-compatible v1
    root and `env_key` naming an environment variable holding the key. A real
    turn completed, streaming deltas and final item both carrying the model's
    own words, through `codexrun.AppServerClient` — the production transport,
    not `codex exec`.
  · `wire_api` MUST be `"responses"`. `"chat"` is the obvious guess, because
    OpenRouter is normally described as Chat-Completions-compatible, and this
    CLI REFUSES IT at config load: "`wire_api = "chat"` is no longer
    supported" (openai/codex discussion 7782). Version-coupled, so the
    capability is PROBED below rather than assumed from a version number.
  · `name` is MANDATORY. Omit it and config load dies with "provider name
    must not be empty" — a whole-process failure, not a silently ignored key.
  · The model id is the FAVORITE'S OWN `id`, never a de-slugged tier.
    `or-deepseek-deepseek-v4-1-flash` un-slugs to `deepseek/deepseek-v4-1-flash`
    and OpenRouter answers 400 "not a valid model ID"; the real id is
    `deepseek/deepseek-v4.1-flash`, dot intact. `openrouter.model_of` is the
    one correct source.
"""

from __future__ import annotations

import os
import subprocess
import threading
from typing import Any, Final

from . import openrouter, providers

# ── the vocabulary ─────────────────────────────────────────────────────────

CLAUDE_CODE: Final = "claude-code"
CODEX_CLI: Final = "codex-cli"
#: declaration order IS the UI's order, and the first entry is the default
HARNESSES: Final[tuple[str, ...]] = (CLAUDE_CODE, CODEX_CLI)
#: user ruling 2026-09-19: Claude Code is what an OpenRouter agent gets when
#: both are usable. It is also what every agent hired before this module
#: existed is running, so it is the value an absent stored harness means.
DEFAULT: Final = CLAUDE_CODE

#: the CLI's OWN product name, the same rule providers.PROVIDER_LABEL follows
LABEL: Final[dict[str, str]] = {
    CLAUDE_CODE: "Claude Code", CODEX_CLI: "Codex CLI"}

# ── the availability states ────────────────────────────────────────────────
# FOUR DISTINCT ANSWERS, because the ticket's own requirement is that they not
# be collapsed: a person who has not installed a CLI, a person whose install is
# broken, a person who has not supplied a credential and a person whose CLI is
# too old to do this at all need four different next actions, and one
# "unavailable" for all four sends three of them to the wrong one.

#: installed, credentialed, and its config accepted
AVAILABLE: Final = "available"
#: no executable resolved at all — nothing is installed
MISSING: Final = "missing"
#: an executable was named but is not there (a stale `ORGTREE_CODEX`, a
#: half-removed install): the user has a path problem, not an install problem
UNAVAILABLE: Final = "unavailable"
#: installed and fine, but the credential this lane runs on is absent.
#: ⚠ ON THIS LANE THE CREDENTIAL IS THE GATEWAY KEY, NOT A CLI LOGIN. Neither
#: harness signs in to its own vendor here: a Claude-Code OpenRouter agent
#: never touches an Anthropic login and a Codex one never touches a ChatGPT
#: login — both authenticate to openrouter.ai with the machine's OpenRouter
#: key. So a missing key makes BOTH harnesses unauthenticated at once, which
#: is the honest reading and the one that produces the right sentence on
#: screen ("set a key"), rather than two CLIs reported ready for work neither
#: can actually do.
UNAUTHENTICATED: Final = "unauthenticated"
#: installed and credentialed, but this build cannot be configured to reach
#: the gateway — MEASURED by `_codex_config_accepted`, never inferred from a
#: version number nobody bisected
UNSUPPORTED: Final = "unsupported"

#: the `model_providers.<KEY>` block orgtree writes. Namespaced so it cannot
#: collide with a provider the user configured by hand in their own
#: config.toml — orgtree passes this per launch with `-c` and writes nothing
#: to that file (the rule codexrun.mcp_config_overrides already states).
PROVIDER_KEY: Final = "orgtree_openrouter"
#: the environment variable the `-c` block tells codex to read the key from.
#: Deliberately NOT `OPENAI_API_KEY`: codexrun.child_env strips that name on
#: purpose so a stray host value cannot flip the billing lane, and reusing it
#: would fight that guard for no gain.
KEY_ENV: Final = "ORGTREE_OPENROUTER_KEY"


class HarnessUnavailable(RuntimeError):
    """The requested harness cannot run this turn, with the written reason.

    Raised INSTEAD of returning a different harness. The whole point of the
    ticket is that a Codex-selected agent never quietly starts on Claude Code:
    an unavailable harness is a refusal carrying the actual condition, so the
    person reads what is wrong rather than wondering why their choice was
    ignored (and, worse, paying for a lane they did not pick).
    """


def canonical(value: object) -> str:
    """`value` as one of HARNESSES, or DEFAULT for anything unrecognised.

    Tolerant on READ because stored values outlive code: a node hired before
    this module existed has no harness at all, and one hired by a future build
    may carry a name this one does not know. Both mean "the lane's default",
    which is also what those agents are actually running. The WRITE side
    (`api`/`ledger`) refuses an unknown name instead — tolerance belongs where
    old data is read, not where new data is accepted.
    """
    text = str(value or "").strip().lower()
    return text if text in HARNESSES else DEFAULT


def config_overrides(model_id: str) -> list[str]:
    """The `-c` argv pointing one codex launch at openrouter.ai.

    Global options, so `codexrun.AppServerClient` places them before the
    subcommand — the same list shape `mcp_config_overrides` returns, and it
    concatenates with that one.

    Every field here is load-bearing and three of the four were measured into
    place rather than copied from a doc; see the module docstring for what
    each one costs when it is wrong.
    """
    p = f"model_providers.{PROVIDER_KEY}"
    return [
        "-c", f'model_provider="{PROVIDER_KEY}"',
        # mandatory — an absent name fails config load outright
        "-c", f'{p}.name="{openrouter.PROVIDER_LABEL}"',
        "-c", f'{p}.base_url="{openrouter.API_BASE}"',
        "-c", f'{p}.env_key="{KEY_ENV}"',
        # "chat" is rejected by this CLI family; see the docstring
        "-c", f'{p}.wire_api="responses"',
        # the model id is passed on the wire by the turn itself, but a launch
        # that never names it would fall back to the CLI's own default model
        # — an OpenAI id the gateway would refuse — so it is pinned here too
        "-c", f'model="{model_id}"',
    ]


# ── the codex config-capability probe ──────────────────────────────────────
# ⚠ A MEASUREMENT, NOT A VERSION FLOOR. The tempting shape is a `_CODEX_MIN`
# tuple, and it would be a guess: the author measured 0.154.0 working and
# bisected nothing below it, so any floor would fail closed on builds that
# work and claim knowledge nobody has. What CAN be measured directly is the
# only thing that matters — does THIS build accept THIS configuration — and
# codex answers it for free, because `app-server` validates config at startup
# and exits with the reason written on stderr (measured both ways: a rejected
# `wire_api` and a malformed provider block each died before any network).
#
# Cached on (executable, mtime, size): a rebuilt or swapped binary re-probes,
# an unchanged one is asked once. The probe is a bounded subprocess of the
# same class `providers._codex_version` already runs for the accounts panel.

_PROBE_TIMEOUT: Final = 20.0
_probe_lock = threading.Lock()
_probe_cache: dict[str, tuple[bool, str]] = {}


def _probe_key(exe: str) -> str:
    try:
        stat = os.stat(exe)
        return f"{exe}|{int(stat.st_mtime)}|{stat.st_size}"
    except OSError:
        return f"{exe}|?"


def _codex_config_accepted(exe: str) -> tuple[bool, str]:
    """Does this codex build accept the OpenRouter provider block?

    `(ok, why)`. ⚠ FAILS OPEN on a probe that could not be RUN — a timeout or
    an OSError is ignorance about the CLI, not evidence against it, and the
    same reasoning `supervisor.cli_capable` writes down for its own unknown
    version applies here: turning a working harness off on ignorance invents a
    silent failure. It fails CLOSED only on the CLI's own refusal, which is
    evidence.

    Nothing is spent and nothing is reached: the process is killed as soon as
    it has either died on the config or survived long enough to prove it did
    not. No key is supplied, no thread is started, no model is contacted.
    """
    key = _probe_key(exe)
    with _probe_lock:
        hit = _probe_cache.get(key)
    if hit is not None:
        return hit
    argv = (providers.codex_argv(exe)
            + config_overrides("probe/none") + ["app-server"])
    try:
        proc = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=(subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
                           if os.name == "nt" else 0))
    except OSError as e:
        # ⚠ NOT CACHED. A spawn that never happened says nothing durable about
        # the binary, and remembering it would pin a transient OS failure to
        # the install for the rest of the process's life.
        return True, f"probe could not start ({e}); assuming supported"
    # default is the fail-open one: every path below either confirms it or
    # replaces it with the CLI's own refusal
    verdict: tuple[bool, str] = (True, "config accepted")
    try:
        try:
            _out, err = proc.communicate(b"", timeout=_PROBE_TIMEOUT)
        except subprocess.TimeoutExpired:
            # still alive with the config loaded, which IS the answer: a build
            # that rejects the block dies immediately (measured both ways).
            verdict = (True, "config accepted (server stayed up)")
        else:
            text = (err or b"").decode(errors="replace").strip()
            if "config error" in text.lower() or "error loading" in text.lower():
                # the CLI's own sentence, kept verbatim — it names the
                # offending key and, in the case measured, the fix
                verdict = (False, text.splitlines()[0][:300] if text else
                           "this Codex build refused the OpenRouter "
                           "configuration")
    finally:
        try:
            proc.kill()
        except OSError:
            pass
    with _probe_lock:
        _probe_cache[key] = verdict
    return verdict


def forget_probe() -> None:
    """Drop the cached capability verdicts (an install or a swap happened)."""
    with _probe_lock:
        _probe_cache.clear()


# ── per-harness availability ───────────────────────────────────────────────

#: the sentence BOTH harnesses show when the gateway key is absent. One
#: string, because it is one condition: neither CLI can run an OpenRouter
#: agent without it, and two differently-worded copies of the same problem
#: would read as two problems.
_NO_KEY: Final = (
    "no OpenRouter API key is set — add one in the OpenRouter section of "
    "App settings")


def _state(state: str, why: str, **extra: Any) -> dict[str, Any]:
    return {"state": state, "available": state == AVAILABLE, "why": why,
            **extra}


def claude_state() -> dict[str, Any]:
    """Is Claude Code usable as this lane's harness?

    Imported late and read through `supervisor`, which owns claude CLI
    resolution (`CLAUDE`, `_claude_argv`, `cli_version`) — this module does not
    become a second copy of that axis.
    """
    from . import supervisor                          # noqa: PLC0415 — cycle
    exe = str(getattr(supervisor, "CLAUDE", "") or "")
    js = str(getattr(supervisor, "CLAUDE_CLI_JS", "") or "")
    version = supervisor.cli_version()
    found = bool(js and os.path.exists(js)) or bool(exe)
    if not found:
        return _state(MISSING, "the Claude Code CLI was not found on this "
                               "machine", version=None, path="")
    path = js if (js and os.path.exists(js)) else exe
    if path and not os.path.exists(path) and not _on_path(path):
        return _state(UNAVAILABLE,
                      f"the Claude Code CLI is configured at {path} but "
                      f"nothing is there", version=version, path=path)
    if not openrouter.key_set():
        return _state(UNAUTHENTICATED, _NO_KEY, version=version, path=path)
    return _state(AVAILABLE, "installed and ready", version=version, path=path)


def codex_state() -> dict[str, Any]:
    """Is Codex CLI usable as this lane's harness?

    ⚠ IT DOES NOT NEED `codex login`. The ordinary codex lane refuses to spawn
    without a ChatGPT session (`supervisor._codex_process_spec`), and copying
    that gate here would be wrong twice: this launch authenticates to
    openrouter.ai with the gateway key and never reads `auth.json` at all, and
    a person with Codex installed but not signed in would be told to run a
    login that changes nothing about whether this works. Measured: the
    app-server probe and the real turn both ran under a CODEX_HOME with no
    auth.json in it whatsoever.
    """
    st = providers.codex_status()
    exe = str(st.get("path") or "")
    if not exe:
        return _state(MISSING,
                      "the Codex CLI was not found on this machine — "
                      + providers.install_hint("openai"),
                      version=None, path="")
    if not st.get("installed"):
        return _state(UNAVAILABLE,
                      f"the Codex CLI is configured at {exe} but nothing is "
                      f"there", version=st.get("version"), path=exe)
    ok, why = _codex_config_accepted(exe)
    if not ok:
        return _state(UNSUPPORTED,
                      f"this Codex build cannot be pointed at OpenRouter: "
                      f"{why}", version=st.get("version"), path=exe)
    if not openrouter.key_set():
        return _state(UNAUTHENTICATED, _NO_KEY,
                      version=st.get("version"), path=exe)
    return _state(AVAILABLE, "installed and ready",
                  version=st.get("version"), path=exe)


def _on_path(exe: str) -> bool:
    import shutil                                     # noqa: PLC0415
    return bool(shutil.which(exe))


def availability() -> dict[str, dict[str, Any]]:
    """Every harness's state, keyed by harness id."""
    return {CLAUDE_CODE: claude_state(), CODEX_CLI: codex_state()}


def usable(states: dict[str, dict[str, Any]] | None = None) -> list[str]:
    """The harnesses that can actually run a turn right now, in UI order."""
    st = states if states is not None else availability()
    return [h for h in HARNESSES if st.get(h, {}).get("available")]


# ── what the selector does ─────────────────────────────────────────────────

def selector(stored: object = None) -> dict[str, Any]:
    """The whole selector, decided in ONE place so no surface re-derives it.

    User ruling 2026-09-19, and each clause is a distinct visible state:

      · BOTH usable → the control is ENABLED, offers both, and `selected` is
        the stored choice (Claude Code when nothing is stored).
      · EXACTLY ONE usable → that one is `selected` and the control is
        DISABLED. There is no choice to make, and a control that invites one
        and then refuses it is worse than a control that says so.
      · NEITHER usable → `unavailable`, with `explain` carrying the reason for
        each harness. No selection is offered, because every option in it
        would be a lie.

    ⚠ `selected` IS NOT `stored`. When the stored choice is the harness that
    is currently unusable, the selector shows the one that works — that is the
    honest state of the machine — but nothing is written back and nothing is
    launched on it. A turn for a node stored on the unusable harness still
    REFUSES (`resolve`), because a selector reflecting reality and a launch
    silently switching lanes are different things, and only the second is the
    fallback this ticket forbids.
    """
    states = availability()
    live = usable(states)
    want = canonical(stored)
    out: dict[str, Any] = {
        "harnesses": [{"id": h, "label": LABEL[h], **states[h]}
                      for h in HARNESSES],
        "stored": want,
        "default": DEFAULT,
    }
    if len(live) >= 2:
        out.update(enabled=True, unavailable=False, selected=want, explain="")
        return out
    if len(live) == 1:
        only = live[0]
        out.update(
            enabled=False, unavailable=False, selected=only,
            explain=(f"{LABEL[only]} is the only harness available on this "
                     f"machine — {_other_why(states, only)}"))
        return out
    out.update(
        enabled=False, unavailable=True, selected=None,
        explain="no OpenRouter harness is available on this machine. "
                + "; ".join(f"{LABEL[h]}: {states[h]['why']}"
                            for h in HARNESSES))
    return out


def _other_why(states: dict[str, dict[str, Any]], only: str) -> str:
    return "; ".join(f"{LABEL[h]} is not ({states[h]['why']})"
                     for h in HARNESSES if h != only)


def resolve(stored: object) -> str:
    """The harness to LAUNCH on, or `HarnessUnavailable` with the condition.

    THE NO-FALLBACK SEAM, and the whole reason it is one function: every
    launch path asks here, and this function has no branch that answers with a
    harness other than the one it was asked about. Availability is re-read at
    the moment of the call, so a CLI uninstalled between the choice and the
    launch refuses here rather than starting somewhere else — acceptance
    condition 5, and the reason `selector`'s display-time substitution is
    deliberately NOT shared with this path.
    """
    want = canonical(stored)
    # ONE reading, shared by the decision and by the sentence. Re-asking per
    # harness would let the refusal describe a machine that had changed
    # between the two questions — a message contradicting its own verdict is
    # worse than a stale one, because it makes the reader doubt the verdict.
    states = availability()
    state = states[want]
    if state["available"]:
        return want
    alt = "; ".join(f"{LABEL[h]} is available, but this agent is set to "
                    f"{LABEL[want]} and is not moved automatically"
                    for h in HARNESSES
                    if h != want and states[h]["available"])
    raise HarnessUnavailable(
        f"turn failed: this agent runs on OpenRouter through {LABEL[want]}, "
        f"which is not available — {state['why']}"
        + (f". {alt}" if alt else ""))
