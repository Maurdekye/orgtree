# pyright: strict
"""The antigravity turn runner: one `agy` print-mode process per turn.

The shape deliberately mirrors codexrun.py: ONE PROCESS PER TURN, resumed by
a durable id — here the CLI's `conversation_id`, harvested from the `init`
event and handed back through `--conversation <id>` on the next turn (both
measured cross-process, probe logs 2026-09-02, Antigravity CLI 1.1.24).

The wire is print mode's `--output-format stream-json` — NDJSON on stdout:

    {"event":"init", "conversation_id":…, "init":{"cwd":…, "model":…,
                     "permission_mode":…, "tools":[…]}}
    {"event":"step_update", "step_update":{"step_index":n,
                     "state":"ACTIVE|DONE|ERROR",
                     "step_type":"user_input|agent_response|tool",
                     "text_delta":…, "tool_name":…, "tool_info":{…},
                     "usage":{input_tokens, output_tokens, thinking_tokens,
                              cache_read_tokens, total_tokens}}}
    {"event":"result", "result":{"conversation_id":…, "status":"SUCCESS|
                     ERROR|CANCELED", "response":…, "error":…, "usage":{…}}}

and the PROMPT rides STDIN as `--input-format stream-json` — one line,
`{"event":"user","message":{"role":"user","content":<text>}}` — then EOF,
which is what ends the run after that one turn ("stream input closed after
1 turn(s)"). Stdin, not argv: Windows caps a command line at 32K characters
and a mail batch can be longer; the stdin lane carried 120K characters of
prose intact (measured). ⚠ A single 40,000-character TOKEN (no whitespace)
made the CLI return an empty SUCCESS with zero usage — real text does not do
that, and nothing orgtree sends is a 40K-character word.

There is NO mid-turn steer verb on this wire — `steer()` always refuses, and
the supervisor's queue fallback (the same one the codex turn-over guard
falls to) delivers the mail at the next turn boundary instead. Interrupting
is a KILL of the process tree: the conversation store is written as the
turn runs, so the next `--conversation` resume finds everything up to the
kill and the model knows where it stopped (measured: "the last number I
wrote was 10"). An interrupted turn is a COMPLETED turn, booked from the
per-request usage the steps had reported before the kill.

Org powers attach as a WORKSPACE PLUGIN the CLI discovers walking up from
the cwd: `<cwd>/.agents/plugins/orgtree/mcp_config.json` (measured) carries
the same `python -m orgtree.mcptool` stdio server the claude lane spawns via
--mcp-config, so the ledger enforces authority identically on every lane and
nothing is written to the user's own CLI config. ⚠ An MCP server
INHERITS every environment variable its spec does not name (measured — the
parent's ANTHROPIC_API_KEY reached the orgtree server), so `write_workspace`
names the full ORGTREE_* identity set and the spawn env is scrubbed of the
other providers' material (`providers.antigravity_env`).

⚠ THE MODEL PIN IS ASSERTED, NOT ASSUMED. An id the CLI's registry does not
know fails the run LOUDLY (rc=1, `result.status == "ERROR"`, the registry
listed — measured, unlike the previous Google lane which substituted its
default silently), and the `init` event echoes the base id actually
serving the session; the turn fails on any mismatch as a belt.

⚠ PERMISSIONS: headless print mode CANNOT prompt, so in its default
review mode every command, write and MCP call is auto-denied and the run
ends with "no output produced" (measured — an agent with no org powers).
Every orgtree turn therefore runs `--dangerously-skip-permissions`, and a
node whose ⚙ scope narrows `bash`/`edit` is held to it by a PreToolUse HOOK
(`<cwd>/.agents/hooks.json`, measured: {"decision":"deny"} blocks the call
and the run CONTINUES with the reason shown to the model; a hook that fails
to run blocks the call too — fail closed). The hook command is a wrapper
script taking NO arguments, and on Windows its path is emitted with NO
QUOTES AND NO SPACES — see `_hook_command`, which carries the measurement.
A quote of ours is fatal: the CLI is a Go binary, so `syscall.EscapeArg`
backslash-escapes it on the way to `cmd`, and every tool call on that seat
then dies before it runs (live, 2026-09-11).

⚠ THE CWD IS NOT THE WORKSPACE unless `--add-dir <cwd>` says so: without it
the agent's tools ran in the CLI's own app-data scratch (measured),
so the flag is unconditional.

⚠ CREDENTIALS: this module never reads, copies or moves auth material. The
CLI self-authenticates from the OS keyring; a missing login fails the turn
with the CLI's own error.

Hermetic by construction: everything is parameterized (argv head, cwd,
hooks), so tests drive it against backend/tests/fakeantigravity.py instead
of the real CLI — see backend/tests/test_antigravityrun.py.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from typing import Any, Final, NoReturn, cast

from . import providers, antigravity_provenance

#: how long `start()` waits for the `init` event before declaring the CLI
#: unresponsive. Turns themselves are bounded by the caller's turn timeout
#: (handed to the CLI as `--print-timeout` too); this bounds only startup.
INIT_TIMEOUT: Final = 120.0

#: normalized turn statuses — the same vocabulary codexrun exports, so the
#: supervisor's policy layer never learns a provider's raw strings.
STATUS_COMPLETED: Final = "completed"
STATUS_INTERRUPTED: Final = "interrupted"
STATUS_FAILED: Final = "failed"

#: the CLI's tool names per capability class for the ⚙-rights seam — the same
#: four switches the claude lane enforces with --disallowed-tools. SHELL and
#: EDIT names come from the measured `init.tools` list (1.1.24).
TOOLS_BASH: Final = ("run_command", "send_command_input", "notebook_execution")
TOOLS_EDIT: Final = ("write_to_file", "replace_file_content",
                     "multi_replace_file_content", "sed_file", "notebook_edit")

#: WEB-class. The claude lane's `web` switch drops WebSearch and WebFetch;
#: this CLI's equivalent surface is larger because it drives a browser, and
#: leaving it out meant a `web: off` node kept every one of these while its
#: identity prompt told it web access was disabled (that prompt line is
#: lane-independent). PROVENANCE, because it decides what is enforced:
#: `search_web` and `read_url_content` are MEASURED — they appear in real
#: Antigravity turns in this machine's own journals (27 and 20 calls across
#: 21 sessions, read 2026-09-05). The rest are tool-name literals in the
#: installed binary (1.1.26) and were NOT observed in those journals; they
#: are included because opening or driving a page is the same capability,
#: and a name that turns out not to exist costs nothing — a missing one
#: costs the whole switch.
TOOLS_WEB: Final = (
    "search_web", "read_url_content", "open_browser_url",
    "read_browser_page", "list_browser_pages", "click_browser_pixel",
    "capture_browser_screenshot", "capture_browser_console_logs",
    "execute_browser_javascript", "browser_input", "browser_press_key",
    "browser_get_dom", "browser_click_element", "browser_select_option",
    "browser_refresh_page", "browser_resize_window", "browser_scroll",
    "browser_scroll_down", "browser_scroll_up", "browser_mouse_wheel",
    "browser_mouse_down", "browser_mouse_up", "browser_move_mouse",
    "browser_drag_pixel_to_pixel", "browser_list_network_requests",
    "browser_get_network_request", "browser_subagent")

#: SUBAGENT-class (the claude lane drops Task and Agent). Literals in the
#: installed binary (1.1.26), NOT observed in this machine's journals —
#: no agent on this lane has spawned one yet, which is not evidence that it
#: cannot. `browser_subagent` is in both classes; whichever switch is off
#: first supplies the reason.
TOOLS_SUBAGENT: Final = ("invoke_subagent", "manage_subagents",
                         "browser_subagent")

#: the prefix a rights hook puts on its reason; the CLI reports a hook
#: denial as "tool call denied by pre-tool hook: <reason>" (measured), so
#: this is how the leg tells ITS denials from any other tool error.
HOOK_DENY_MARK: Final = "orgtree:"
_HOOK_DENIED_PREFIX: Final = "tool call denied by pre-tool hook: "

#: workspace files this lane owns inside the agent's scratch
AGENTS_FILE: Final = "AGENTS.md"
_AGENTS_DIR: Final = ".agents"
_PLUGIN_DIR: Final = os.path.join(_AGENTS_DIR, "plugins", "orgtree")
_HOOKS_FILE: Final = os.path.join(_AGENTS_DIR, "hooks.json")
_RIGHTS_PY: Final = os.path.join(_AGENTS_DIR, "orgtree-rights.py")
_RIGHTS_WRAPPER: Final = os.path.join(
    _AGENTS_DIR, "orgtree-rights.cmd" if os.name == "nt" else "orgtree-rights.sh")


class AntigravityError(RuntimeError):
    """The CLI refused the turn before it ran, or never came up."""


def _dict(obj: Any) -> dict[str, Any]:
    """A wire document's sub-object, or an empty one — the shapes on this
    wire are JSON objects by contract, and a missing or malformed one must
    read as empty rather than crash the reader thread."""
    return cast("dict[str, Any]", obj) if isinstance(obj, dict) else {}


# ── the mcp door ─────────────────────────────────────────────────────────

def deliverable_mcp(servers: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Split a registry subset into (what this lane can attach, what it
    cannot). The CLI's `mcp_config.json` expresses stdio servers (command +
    args + env) and http servers (`serverUrl` + headers — the shape `agy mcp
    add --type http` itself writes, measured). Anything else is named so
    the identity prompt can say so out loud instead of promising it (the
    D-180 discipline)."""
    ok: dict[str, Any] = {}
    dropped: list[str] = []
    for name in sorted(servers):
        srv = cast("dict[str, Any] | None", servers[name]
                   if isinstance(servers[name], dict) else None)
        if srv is not None and (srv.get("command") or srv.get("url")):
            ok[name] = srv
        else:
            dropped.append(name)
    return ok, dropped


def mcp_config(servers: dict[str, Any]) -> dict[str, Any]:
    """Registry entries → the `mcp_config.json` document. Keys sorted for a
    stable file (and stable tests); env values stringified, the CLI takes a
    plain object for both env and headers (measured)."""
    out: dict[str, Any] = {}
    for name, raw in sorted(servers.items()):
        if not isinstance(raw, dict):
            continue
        srv = cast("dict[str, Any]", raw)
        if srv.get("command"):
            env_raw = srv.get("env")
            env_map = cast("dict[str, Any]", env_raw)                 if isinstance(env_raw, dict) else {}
            args_raw = srv.get("args")
            args = cast("list[Any]", args_raw)                 if isinstance(args_raw, list) else []
            out[name] = {
                "command": str(srv["command"]),
                "args": [str(a) for a in args],
                "env": {str(k): str(v) for k, v in sorted(env_map.items())},
            }
        elif srv.get("url"):
            entry: dict[str, Any] = {"serverUrl": str(srv["url"])}
            headers_raw = srv.get("headers")
            if isinstance(headers_raw, dict):
                headers = cast("dict[str, Any]", headers_raw)
                entry["headers"] = {str(k): str(v)
                                    for k, v in sorted(headers.items())}
            out[name] = entry
    return {"mcpServers": out}


# ── the workspace the CLI discovers ──────────────────────────────────────

_RIGHTS_TEMPLATE: Final = '''"""orgtree's ⚙-rights hook for the Antigravity CLI — written per spawn,
never edited by hand. A PreToolUse hook: the CLI hands the pending tool
call on stdin and reads {"decision": ...} from stdout."""
import json
import sys

DENY = %(deny)s
try:
    payload = json.load(sys.stdin)
except Exception:                                            # noqa: BLE001
    payload = {}
doc = payload if isinstance(payload, dict) else {}
call = doc.get("toolCall")
call = call if isinstance(call, dict) else {}
# `toolCall.name` is the measured envelope; the alternates are read only so
# that a renamed field DENIES as before instead of failing open silently
name = str(call.get("name") or doc.get("tool_name")
           or doc.get("toolName") or "")
if name in DENY:
    print(json.dumps({"decision": "deny",
                      "reason": "orgtree: " + DENY[name]}))
else:
    print(json.dumps({"decision": "allow"}))
'''


#: characters no amount of escaping available here carries through cmd as
#: part of ONE unquoted token. A path holding one is REFUSED, never emitted.
#:   space, tab : the token re-splits — and a quote of ours is fatal, see
#:                `_hook_command`, so quoting is not a way out
#:   "          : cannot occur in a Windows filename anyway
#:   , ; =      : cmd's other token delimiters; `^` does NOT rescue these
#:                (measured — only the 8.3 alias, which drops them, does)
#:   % !        : the expansion sigils. `%VAR%` is substituted before `^` is
#:                ever considered (measured: nothing rescues `%PATH%data`),
#:                and `!VAR!` is too wherever DelayedExpansion is switched on
#:                machine-wide — a setting this process cannot see, so `!` is
#:                refused even though it measures fine with the default one.
_CMD_INEXPRESSIBLE: Final = ' \t",;=%!'

#: cmd metacharacters a leading `^` DOES carry through an unquoted token
#: (measured, both envelopes, before and after 8.3). `< > |` are absent
#: because Windows refuses to create a name containing one at all.
_CMD_ESCAPABLE: Final = '&^()'


def _short_path(path: str) -> str:
    """The volume's 8.3 alias for `path`, or "" when there is no usable one.

    8dot3 name creation is switchable PER VOLUME (and off by default on
    non-system volumes), and a directory made while it was off never gets an
    alias afterwards — so this returns "" far more often than it looks, and
    every caller must have a fallback. The alias is only handed back once it
    has been confirmed to open the SAME file, so a stale or refused lookup
    can never redirect the permission hook at something else."""
    if os.name != "nt":
        return ""
    try:
        import ctypes
        buf = ctypes.create_unicode_buffer(4096)
        n = int(ctypes.windll.kernel32.GetShortPathNameW(  # type: ignore[attr-defined]
            str(path), buf, 4096))
        short = buf.value if 0 < n < 4096 else ""
    except (OSError, ValueError, AttributeError):            # noqa: BLE001
        return ""
    if not short or short == path:
        return ""
    try:
        if not os.path.samefile(short, path):
            return ""
    except OSError:
        return ""
    return short


def _cmd_token(path: str) -> str | None:
    """`path` as ONE unquoted cmd token, or None when cmd cannot express it.

    The caret is the only escape available: the command reaches cmd through
    Go's EscapeArg, which would backslash-escape a quote of ours into
    uselessness, and cmd honours `^` only OUTSIDE quotes — which is why a
    path holding both a space and an `&` has to go through the 8.3 alias
    first (measured: `org&tree v2` fails caret-escaped, and passes once the
    alias has taken the space out)."""
    if not path or any(c in path for c in _CMD_INEXPRESSIBLE):
        return None
    return "".join(("^" + c) if c in _CMD_ESCAPABLE else c for c in path)


def _hook_command(path: str) -> str:
    """The hooks.json `command` for the wrapper at `path` — which must already
    EXIST, because the Windows branch asks the filesystem for its 8.3 alias.

    ⚠ ON WINDOWS THIS STRING MAY NOT CONTAIN A DOUBLE QUOTE. The CLI is a Go
    binary and hands the command to `cmd` as ONE argv element, so Go's
    syscall.EscapeArg BACKSLASH-escapes any quote we put in it on the way
    out: `"C:\\p\\x.cmd"` leaves as `cmd.exe /c "\\"C:\\p\\x.cmd\\""`. cmd
    does not understand `\\"`; it strips the outer pair and tries to run a
    file literally named `\\"C:\\p\\x.cmd\\"`. That is the measured live
    failure — every Flash tool call died before it ran:

        '\\"…\\orgtree-rights.cmd\\"' is not recognized as an internal or
        external command
        (antigravity/logs/orgtree/provider-polish.log, 2026-09-11,
         command_hook_executor.go:75)

    A BARE path needs no quote of ours: EscapeArg supplies its own pair when
    the path holds a space. That lands under `cmd /c` — but NOT under
    `cmd /s /c`, which always strips the outer pair and then splits the path
    at the space. The log cannot tell the two envelopes apart (both produce
    the error above), so rather than bet on one, the command is kept free of
    SPACES as well, via the 8.3 alias — the one shape measured to work under
    both.

    ⚠ NOTHING BEST-EFFORT COMES OUT OF HERE. A token cmd re-splits or expands
    does not merely fail to find the hook: `…\\Orgtree v2\\…` runs
    `…\\Orgtree` and hands it `v2\\…`, so a stray `Orgtree.exe` beside the
    data root would be EXECUTED, and `%VAR%` pastes the environment into the
    command line. Where no expressible shape exists this RAISES and the turn
    never spawns — which is the safe direction, because a narrowed seat whose
    hook is missing or broken runs under `--dangerously-skip-permissions`
    with no enforcement at all.

    Measured in tests/test_antigravity_hook_command.py against the real
    cmd.exe and the real EscapeArg rules, both envelopes, allow and deny.

    Raises:
        AntigravityError: cmd cannot express this path, so no hook can be
            installed and the caller must not spawn."""
    if os.name != "nt":
        # `sh -c` takes the whole command as one word-split string, so here
        # the quoting IS ours to do — and single quotes, not double, so a
        # `$` in the path is not expanded on the way through.
        return shlex.quote(path)
    # long path first (it is the readable one), then its 8.3 alias, which is
    # what drops a space or a `,;=` delimiter the long form cannot carry
    for candidate in (path, _short_path(path)):
        token = _cmd_token(candidate) if candidate else None
        if token is not None:
            return token
    raise AntigravityError(
        "cannot install the orgtree rights hook for this agent: no cmd "
        "command line resolves to %s. Its path holds a character cmd "
        "re-splits or expands (a space, one of , ; = or a %% or ! sigil) "
        "and the volume offers no 8.3 alias without it. Refusing to spawn "
        "the turn — a narrowed seat whose hook does not run would get "
        "FULL tool access, not a blocked one. Put orgtree's data root on a "
        "path free of those characters, or re-enable 8dot3 name creation "
        "on that volume." % path)


def write_workspace(cwd: str, *, identity: str, mcp_servers: dict[str, Any],
                    rights: dict[str, Any] | None = None,
                    python: str | None = None) -> dict[str, Any]:
    """Regenerate everything the CLI discovers in the agent's scratch:

      · AGENTS.md — the identity door (a directory rule, injected verbatim;
        measured — the same file the codex leg writes for the same reason)
      · .agents/plugins/orgtree/{plugin.json, mcp_config.json} — org powers
      · .agents/hooks.json + the rights wrapper — only for a NARROWED node;
        a full-rights node gets the files REMOVED, so a scope change in
        either direction takes effect at the next spawn

    Returns {"hooks": bool, "denied": [tool names]} for the caller's
    bookkeeping (the cache fingerprint wants to know).

    Raises:
        AntigravityError: a NARROWED node whose scratch path cmd cannot
            express (see `_hook_command`). The caller must let this through
            rather than spawn: the turn failing is recorded as `last_error`
            by `_run_one_turn`, whereas spawning without a working hook hands
            that seat every tool it was narrowed away from."""
    os.makedirs(cwd, exist_ok=True)
    with open(os.path.join(cwd, AGENTS_FILE), "w", encoding="utf-8") as f:
        f.write(identity)
    plug = os.path.join(cwd, _PLUGIN_DIR)
    os.makedirs(plug, exist_ok=True)
    with open(os.path.join(plug, "plugin.json"), "w", encoding="utf-8") as f:
        json.dump({"name": "orgtree"}, f)
    with open(os.path.join(plug, "mcp_config.json"), "w",
              encoding="utf-8") as f:
        json.dump(mcp_config(mcp_servers), f, indent=1)
    sc = rights or {}
    deny: dict[str, str] = {}
    for switch, names, reason in (
            ("bash", TOOLS_BASH,
             "this agent has no shell rights (bash is off in its orgtree "
             "scope) — do not retry the command"),
            ("edit", TOOLS_EDIT,
             "this agent has no file-editing rights (edit is off in its "
             "orgtree scope, or it is on a plan-mode seat) — do not retry "
             "the write"),
            ("web", TOOLS_WEB,
             "this agent has no web rights (web access is off in its "
             "orgtree scope) — do not retry the fetch"),
            ("subagents", TOOLS_SUBAGENT,
             "this agent may not run subagents (subagents are off in its "
             "orgtree scope) — do the work in this turn instead"),
            # THE SHELL GOES WITH THE WRITE DOOR, keyed on the SAME `edit`
            # right: `echo x > f` is a write, so leaving `run_command` open
            # beside a denied `write_to_file` is a wall with a door in it.
            # COST: that seat loses reads THROUGH the terminal too; the CLI's
            # own read tools are not shell and stay open (view_file,
            # grep_search, list_dir, find_by_name).
            # The only enforcement here is this hook. `--sandbox` ("run in a
            # sandbox with terminal restrictions enabled", 1.1.26) is
            # UNVERIFIED — no turn has been run with it — so nothing relies
            # on it, and the codex lane's sandbox-backed terminal has no
            # equivalent on this one.
            ("edit", TOOLS_BASH,
             "this agent may not change files (edit is off in its orgtree "
             "scope, or it is on a plan-mode seat), and this CLI has no "
             "verified read-only shell — so the terminal is closed too. Read "
             "with view_file, grep_search, list_dir and find_by_name")):
        if not sc.get(switch, True):
            for t in names:
                # setdefault, not assignment: a name in two classes keeps the
                # reason of the first switch that is off, and no class can
                # silently overwrite another's denial
                deny.setdefault(t, reason)
    hooks_path = os.path.join(cwd, _HOOKS_FILE)
    rights_py = os.path.join(cwd, _RIGHTS_PY)
    wrapper = os.path.join(cwd, _RIGHTS_WRAPPER)
    if not deny:
        for p in (hooks_path, rights_py, wrapper):
            try:
                os.remove(p)
            except OSError:
                pass
        return {"hooks": False, "denied": []}
    py = python or sys.executable
    with open(rights_py, "w", encoding="utf-8") as f:
        f.write(_RIGHTS_TEMPLATE % {"deny": json.dumps(deny, indent=4)})
    if os.name == "nt":
        body = f'@echo off\r\n"{py}" "%~dp0orgtree-rights.py"\r\n'
        with open(wrapper, "w", encoding="utf-8", newline="") as f:
            f.write(body)
    else:
        body = f'#!/bin/sh\nexec "{py}" "$(dirname "$0")/orgtree-rights.py"\n'
        with open(wrapper, "w", encoding="utf-8", newline="\n") as f:
            f.write(body)
        os.chmod(wrapper, 0o755)
    # ⚠ RESOLVED BEFORE hooks.json IS OPENED. `_hook_command` REFUSES a path
    # cmd cannot express, and `open(…, "w")` truncates on the way in — so
    # computing it inside the `with` would leave a ZERO-BYTE hooks.json
    # behind on that raise, which is the one shape that loses enforcement
    # without looking like it: the CLI finds no hook and the seat is already
    # running under --dangerously-skip-permissions.
    command = _hook_command(os.path.abspath(wrapper))
    with open(hooks_path, "w", encoding="utf-8") as f:
        json.dump({"orgtree-rights": {"PreToolUse": [{
            "matcher": "*",
            "hooks": [{"type": "command",
                       "command": command,
                       "timeout": 20}]}]}}, f, indent=1)
    return {"hooks": True, "denied": sorted(deny)}


# ── process control ──────────────────────────────────────────────────────

def kill_tree(proc: subprocess.Popen[bytes] | None) -> None:
    """Kill the CLI AND its children by pid through the OS (the CLI forks a
    language-server child; a bare `kill()` of the parent would orphan it),
    then wait so the next spawn never contends with a dying tree."""
    if proc is None or proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                           capture_output=True, timeout=15,
                           creationflags=subprocess.CREATE_NO_WINDOW)  # type: ignore[attr-defined]
        proc.kill()
    except (OSError, subprocess.TimeoutExpired):
        pass
    try:
        proc.wait(timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        pass


# ── the turn ─────────────────────────────────────────────────────────────

class AntigravityTurn:
    """One turn's lifecycle, from spawn to normalized result — the same seam
    contract as codexrun.CodexTurn, so the supervisor's provider leg holds
    either object behind the same verbs."""

    def __init__(self, argv_head: list[str], *, cwd: str, model: str,
                 effort: str | None,
                 conversation_id: str | None = None,
                 yolo: bool = True,
                 on_event: Callable[[dict[str, Any]], None] | None = None,
                 env_extra: dict[str, str] | None = None,
                 log_file: str | None = None,
                 turn_timeout: float | None = None) -> None:
        argv = list(argv_head) + [
            "-p=", "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--add-dir", cwd, "--model", model]
        if effort:
            argv += ["--effort", effort]
        if conversation_id:
            argv += ["--conversation", conversation_id]
        if yolo:
            argv.append("--dangerously-skip-permissions")
        if log_file:
            argv += ["--log-file", log_file]
        if turn_timeout:
            # the CLI's own ceiling defaults to 5 minutes, far under an
            # agent turn; orgtree's TURN_TIMEOUT is the one that counts
            argv += ["--print-timeout", f"{int(turn_timeout)}s"]
        self.argv = argv
        self.cwd = cwd
        self.model = model
        self.effort = effort
        self.conversation_id = conversation_id
        self.log_file = log_file
        self._env_extra = dict(env_extra or {})
        self._caller_on_event = on_event
        self.proc: subprocess.Popen[bytes] | None = None
        self.stderr_tail: list[str] = []
        self.events: list[dict[str, Any]] = []
        self.agent_text: list[str] = []
        self.denials: list[dict[str, Any]] = []
        self.status: str | None = None
        self.stop_reason: str | None = None
        self.token_usage: dict[str, Any] | None = None
        self._init: dict[str, Any] | None = None
        self._result: dict[str, Any] | None = None
        self._provenance_boundary: antigravity_provenance.Boundary | None = None
        self._input_text = ""
        self._interrupted = False
        self._lock = threading.Lock()
        self._reader: threading.Thread | None = None
        # per-request usage fold (the interrupted-turn bill, and occupancy)
        self._u_in = 0
        self._u_cached = 0
        self._u_out = 0
        self._u_think = 0
        self._requests = 0
        self._last_prompt = 0

    # ── wire plumbing ────────────────────────────────────────────────────

    def _pump_err(self) -> None:
        assert self.proc is not None and self.proc.stderr is not None
        for raw in self.proc.stderr:
            line = raw.decode(errors="replace").rstrip()
            with self._lock:
                self.stderr_tail.append(line)
                del self.stderr_tail[:-50]

    def _pump(self) -> None:
        assert self.proc is not None and self.proc.stdout is not None
        for raw in self.proc.stdout:
            try:
                msg: dict[str, Any] = json.loads(raw.decode(errors="replace"))
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):  # pyright: ignore[reportUnnecessaryIsInstance]
                continue
            with self._lock:
                self.events.append(msg)
                self._fold(msg)
            if self._caller_on_event:
                try:
                    self._caller_on_event(msg)
                except Exception:      # noqa: BLE001
                    pass   # an observer must never kill the wire reader

    def _fold(self, msg: dict[str, Any]) -> None:
        ev = str(msg.get("event") or "")
        if ev == "init":
            self._init = msg
            return
        if ev == "result":
            self._result = _dict(msg.get("result"))
            return
        if ev != "step_update":
            return
        step = _dict(msg.get("step_update"))
        kind = str(step.get("step_type") or "")
        state = str(step.get("state") or "")
        if kind == "agent_response":
            delta = step.get("text_delta")
            if isinstance(delta, str) and delta:
                self.agent_text.append(delta)
            usage = _dict(step.get("usage"))
            if state == "DONE" and usage:
                inp = int(usage.get("input_tokens") or 0)
                cached = int(usage.get("cache_read_tokens") or 0)
                self._u_in += inp
                self._u_cached += cached
                self._u_out += int(usage.get("output_tokens") or 0)
                self._u_think += int(usage.get("thinking_tokens") or 0)
                self._requests += 1
                self._last_prompt = inp + cached
        elif kind == "tool" and state == "ERROR":
            info = _dict(step.get("tool_info"))
            err = _dict(info.get("error"))
            message = str(err.get("message") or "")
            if message.startswith(_HOOK_DENIED_PREFIX + HOOK_DENY_MARK):
                self.denials.append({
                    "tool_name": str(step.get("tool_name") or "tool"),
                    "tool_input": info.get("parameters") or {}})

    # ── lifecycle ────────────────────────────────────────────────────────

    def start(self, input_text: str) -> str:
        """Spawn, put the prompt on stdin, wait for `init`. Returns the
        durable conversation id (the provider's own — the one the node
        records and the next turn resumes)."""
        env = dict(os.environ)
        env.update(self._env_extra)
        from . import devguard
        env = devguard.child_env(env)
        # Normalize last: caller extras may add org identity, but may not
        # re-enable agy's updater or reintroduce another provider's secret.
        env = providers.antigravity_env(env)
        self._input_text = input_text
        self._provenance_boundary = antigravity_provenance.capture(self.conversation_id, env)
        self.proc = subprocess.Popen(
            self.argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=env, cwd=self.cwd,
            creationflags=(subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
                           if os.name == "nt" else 0))
        self._reader = threading.Thread(target=self._pump, daemon=True)
        self._reader.start()
        threading.Thread(target=self._pump_err, daemon=True).start()
        line = json.dumps({"event": "user", "message": {
            "role": "user", "content": input_text}}) + "\n"
        stdin = self.proc.stdin
        assert stdin is not None
        try:
            stdin.write(line.encode("utf-8"))
            stdin.flush()
            stdin.close()
        except OSError as e:
            self._fail_early(f"could not hand the prompt to the CLI: {e}")
        deadline = time.time() + INIT_TIMEOUT
        init: dict[str, Any] | None = None
        while time.time() < deadline:
            with self._lock:
                init = self._init
                result = self._result
            if init is not None:
                break
            if result is not None:
                # the run ended before it began — an unknown model, a
                # refused resume, a missing login: the CLI's own words
                self._fail_early(
                    "the CLI refused the turn: "
                    + str(result.get("error") or result.get("status")
                          or "no reason given")[:400])
            if self.proc.poll() is not None:
                self._fail_early(
                    f"the CLI exited rc={self.proc.returncode} before "
                    f"starting the turn; stderr tail: "
                    f"{' | '.join(self.stderr_tail[-3:])[:400]}")
            time.sleep(0.02)
        else:
            self._fail_early(
                f"no init event in {INIT_TIMEOUT:.0f}s — is the CLI signed "
                f"in? stderr tail: {' | '.join(self.stderr_tail[-3:])[:400]}")
        assert init is not None
        info = _dict(init.get("init"))
        # ⚠ the anti-silent-substitution belt: init echoes the base id
        # actually serving the session (measured)
        served = info.get("model")
        if isinstance(served, str) and served and served != self.model:
            self._fail_early(
                f"model pin refused: the session is serving {served!r}, not "
                f"the pinned {self.model!r}")
        cid = str(init.get("conversation_id") or "")
        if not cid:
            self._fail_early("init carried no conversation_id: "
                             + json.dumps(init)[:300])
        self.conversation_id = cid
        return cid

    def _fail_early(self, why: str) -> NoReturn:
        kill_tree(self.proc)
        raise AntigravityError(why)

    def steer(self, text: str) -> bool:
        """No mid-turn input verb exists on this wire — always False, and
        the caller's queue fallback delivers at the next turn boundary."""
        return False

    def interrupt(self) -> bool:
        """Kill the tree. The conversation store already holds everything
        up to here (measured), so the next resume continues from it; the
        result is booked as an interrupted-but-completed turn from the
        per-request usage seen so far."""
        if self.proc is None or self.proc.poll() is not None:
            return False
        self._interrupted = True
        kill_tree(self.proc)
        return True

    def wait(self, timeout: float | None = None) -> dict[str, Any]:
        """Block until the run resolves (result event AND process exit);
        return the normalized result the policy layer consumes."""
        assert self.proc is not None
        deadline = time.time() + timeout if timeout else None
        timed_out = False
        while True:
            if self.proc.poll() is not None:
                break
            if deadline and time.time() >= deadline:
                timed_out = True
                kill_tree(self.proc)
                break
            time.sleep(0.05)
        if self._reader is not None:
            self._reader.join(timeout=5)
        with self._lock:
            result = self._result
            events = list(self.events)
            usage_seen = self._requests > 0
            tu: dict[str, Any] | None = None
            if usage_seen or (result and isinstance(result.get("usage"), dict)):
                tu = {"model": self.model, "input": self._u_in,
                      "cached": self._u_cached, "output": self._u_out,
                      "thinking": self._u_think,
                      "last_prompt": self._last_prompt,
                      "requests": max(1, self._requests)}
                ru = _dict(result.get("usage")) if result else {}
                if (not usage_seen and ru
                        and int(ru.get("total_tokens") or 0)):
                    # A resumed conversation's result.usage is cumulative over
                    # the WHOLE SESSION (measured live: turn 2's result was
                    # exactly turn 1 + turn 2), so it must never overwrite the
                    # per-request fold above or every earlier turn is billed
                    # again.  It remains the fallback when this CLI generation
                    # emits no priced step at all: unknown/overstated is safer
                    # there than silently booking zero work.  last_prompt stays
                    # 0 because a session total cannot answer how large the
                    # final request was.
                    tu["input"] = int(ru.get("input_tokens") or 0)
                    tu["cached"] = int(ru.get("cache_read_tokens") or 0)
                    tu["output"] = int(ru.get("output_tokens") or 0)
                    tu["thinking"] = int(ru.get("thinking_tokens") or 0)
            text = "".join(self.agent_text)
        provenance = None
        if (not self._interrupted and not timed_out and result is not None
                and self._reader is not None and not self._reader.is_alive()):
            provenance = antigravity_provenance.reconcile(
                self._provenance_boundary, self._input_text,
                self.conversation_id, result, events)
        if self._interrupted:
            self.status = STATUS_INTERRUPTED
            self.stop_reason = "interrupted"
        elif result is None:
            self.status = STATUS_FAILED
            self.stop_reason = (
                f"the CLI exited rc={self.proc.returncode} without a result"
                if deadline is None or time.time() < deadline
                else "turn timeout")
        else:
            rstatus = str(result.get("status") or "")
            if rstatus == "SUCCESS" or provenance is not None:
                self.status = STATUS_COMPLETED
                self.stop_reason = "end_turn"
                if not text and isinstance(result.get("response"), str):
                    text = str(result["response"])
            else:
                self.status = STATUS_FAILED
                self.stop_reason = str(result.get("error") or "")[:300] or (
                    f"the CLI reported {rstatus or 'no status'}"
                    + (": " + " | ".join(self.stderr_tail[-2:])[:300]
                       if self.stderr_tail else ""))
        self.token_usage = tu
        normalized: dict[str, Any] = {
            "conversation_id": self.conversation_id,
            "status": self.status,
            "stop_reason": self.stop_reason,
            "agent_text": text,
            "token_usage": tu,
            "denials": list(self.denials),
            # parity with the codex result shape; the CLI's subscription
            # lane exposes no window telemetry in print mode
            "rate_limits": None,
        }
        if provenance is not None:
            normalized["result_provenance"] = provenance
        return normalized

    def poll(self) -> int | None:
        """The process generation's exit observation, in the Popen
        vocabulary the supervisor's MCP accounting polls its owners with;
        None while running (and before `start()`, when there is no process
        yet — the turn object is the owner token from the moment the leg
        adopts it)."""
        return self.proc.poll() if self.proc is not None else None

    @property
    def pid(self) -> int | None:
        return self.proc.pid if self.proc is not None else None

    def close(self) -> None:
        kill_tree(self.proc)


def which_python() -> str:
    """The interpreter the rights hook runs under — this one, unless it is
    somewhere `cmd` cannot spell (a wrapper handles the quoting anyway)."""
    return sys.executable or shutil.which("python") or "python"
