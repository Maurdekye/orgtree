# pyright: strict
"""PostToolUse steering hook — mid-task delivery without interrupting.

Runs after EVERY tool call of every agent (CLI >= ~2.1.2xx; older CLIs never
fire tool hooks headless). Asks the backend for steering messages pending for
THIS node and, if any, injects them as additionalContext — the model sees them
immediately after the current tool call finishes.

⚠ Hook processes get a SANITIZED env (custom vars do not survive), so identity
comes from the CWD (hooks run in the node's scratch dir:
<data-root>/scratch/<org>/<node>) and the port from <data-root>/.port, written
by the backend at startup. Must be fast and silent when there is nothing to
say.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from typing import cast


def option(name: str) -> str:
    try:
        return sys.argv[sys.argv.index(name) + 1]
    except (ValueError, IndexError):
        return ""


def identity() -> tuple[str | None, str | None, str | None, str | None]:
    """(org, node, base_url, secret) — org+node from argv when the backend
    passed them (it does since review C10), the cwd split as fallback. A third
    argv value carries the frozen org's rotatable bridge credential when
    present; same-org sandbox nodes are mutually trusted for this bearer.

    ⚠ The cwd is SHARED across a lineage: scratch_dir maps "name@gen" to the
    base "name" directory, so a live knowledge bearer's hook resolved as its
    SUCCESSOR and was handed (and confirmed away) the successor's steered
    mail. argv names the exact node the backend launched.

    Sandboxed kiosk containers mirror the host layout at ~/orgtree, so the
    cwd derivation is identical there; a `.bridge` file in the data root
    (written by the host into the mounted sandbox home) carries the
    off-container backend URL. Standard mode also keeps the legacy org-wide
    secret there; frozen mode deliberately does not."""
    cwd = os.path.realpath(os.getcwd())
    data_root = os.path.realpath(
        option("--data-root") or os.environ.get("ORGTREE_DATA", os.path.expanduser("~/orgtree")))
    scratch = os.path.join(data_root, "scratch")
    if len(sys.argv) >= 3 and sys.argv[1] and sys.argv[2]:
        org, node = sys.argv[1], sys.argv[2]
    else:
        if not cwd.startswith(scratch + os.sep):
            return None, None, None, None
        parts = cwd[len(scratch) + 1:].split(os.sep)
        if len(parts) < 2:
            return None, None, None, None
        org, node = parts[0], parts[1]
    argv_secret = sys.argv[3] if len(sys.argv) >= 4 and not sys.argv[3].startswith("--") else ""
    try:
        # ⚠ the file is written by ANOTHER process (sandbox.py, into a mounted
        # sandbox home) and can be truncated mid-write, a list, or carry a null
        # url. This runs after EVERY tool call, so anything that escapes here
        # is a traceback on every single one — hence a shape check rather than
        # a wider `except`: `[]` raised TypeError and `{"url": null}`
        # AttributeError, neither of which the old clause caught.
        with open(os.path.join(data_root, ".bridge"), encoding="utf-8") as f:
            raw: object = json.load(f)
        if isinstance(raw, dict):
            b = cast("dict[str, object]", raw)
            url, secret = b.get("url"), b.get("secret", "")
            if isinstance(url, str) and url.strip():
                return (org, node, url.strip().rstrip("/"),
                        argv_secret or (secret if isinstance(secret, str)
                                        else ""))
    except (OSError, ValueError):
        pass
    port = os.environ.get("ORGTREE_PORT")
    if not port:
        try:
            port = open(os.path.join(data_root, ".port"),
                        encoding="utf-8").read().strip()
        except OSError:
            port = "7360"
    return org, node, f"http://127.0.0.1:{port}", ""


def hook_identity(raw: str) -> tuple[str, str]:
    """(tool_use_id, transcript_path) from the PostToolUse payload — the two
    fields the D1 contract rides on. Field names are the pinned CLI's own
    hook-input schema (2.1.258: session_id, transcript_path, cwd, tool_name,
    tool_input, tool_response, tool_use_id). Missing or malformed → empty,
    and the backend then serves the legacy fetch."""
    try:
        data: object = json.loads(raw or "{}")
    except ValueError:
        return "", ""
    if not isinstance(data, dict):
        return "", ""
    d = cast("dict[str, object]", data)
    tu, tp = d.get("tool_use_id"), d.get("transcript_path")
    return (tu if isinstance(tu, str) else ""), (tp if isinstance(tp, str) else "")


_FILE_TOOLS = frozenset({"Write", "Edit", "MultiEdit", "NotebookEdit"})
# ⚠ THE SENSITIVE-PATH GATE ALSO CATCHES THE SHELL. `worktree-perms` was
# refused on a plain `rm -f <root>/.git/index.lock` (2026-09-16, transcript
# quoted on `a-third-git-gate-blocks-claude-lane-tools-above`) and received NO
# explanation at all, because this hook only ever looked at the file tools —
# 0 occurrences of the explainer in its 1.7 MB transcript. The shell tools are
# listed separately because only the SENSITIVE branch reaches them: a deny
# RULE is a file-tool concept and its advice would be wrong here.
_SHELL_TOOLS = frozenset({"Bash", "PowerShell"})
# the pinned CLI's own refusal wording, lowercased. Matched as substrings
# because the CLI phrases the same two gates slightly differently per tool.
_DENY_MARKS = ("denied by your permission settings",
               "denied by permission settings")
_SENSITIVE_MARKS = ("is a sensitive file", "sensitive file")

# ── what the gate actually matches ───────────────────────────────────────
# Read out of the shipped binary on 2026-09-17, from BOTH the npm global
# 2.1.241 and the private pin 2.1.258 that `supervisor.CLAUDE` resolves to —
# identical in each. The CLI's `checkPathSafetyForAutoEdit` matches path
# SEGMENTS against a hardcoded `DANGEROUS_DIRECTORIES` array and returns
# `{safe:false, message:"… which is a sensitive file.",
#   classifierApprovable:true}`. `classifierApprovable` is why the harness
# records `toolDenialKind:"user-rejected"`: it is a permission REQUEST, and a
# headless turn has nobody to answer it, so it surfaces as a refusal.
#
# ⚠ THIS IS NOT A `.git` MECHANISM AND IT IS NOT A `.claude` MECHANISM. It is
# ONE list of NINE directories, and until this commit we documented exactly
# one of them. `.claude` is the ONLY entry carrying carve-outs (skills,
# agents, commands, scheduled_tasks.json, worktrees) — which is why an agent
# can edit its own skills but cannot touch `.git/index.lock`. Every other
# entry matches unconditionally.
#
# Kept SORTED: this text reaches a cached prefix via the identity prompt, and
# an unstable order would re-pay it for nothing (D-181).
GATED_DIRS = (".cargo", ".claude", ".devcontainer", ".git", ".husky",
              ".idea", ".mvn", ".vscode", ".yarn")
# matched as a multi-segment tail rather than a single segment
GATED_DIR_PATHS = (".config/git",)


def gated_segment(path: str) -> str:
    """The gated directory this path actually trips on, or "".

    Named rather than guessed. The previous version of this hook asserted
    "that path contains a `.claude` segment" for EVERY sensitive refusal,
    which is false for the other eight and would have told an agent holding a
    `.git` refusal to go and look for a `.claude` component that is not there.

    ⚠ DELIBERATELY DOES NOT REPLICATE THE CLI'S `.claude` CARVE-OUTS. A first
    version skipped `.claude` when followed by skills/agents/commands, on the
    grounds that the CLI lets those through. That reasoning is backwards here:
    this function only ever runs on a refusal that ALREADY HAPPENED, so if the
    path holds a gated component, that component IS the reason — whatever the
    carve-out would have done. Modelling the carve-out only made the message
    vaguer on exactly the `.claude/skills` case the previous ticket was about.
    """
    segments = [s for s in path.replace("\\", "/").split("/") if s]
    lowered = [s.lower() for s in segments]
    for seg in lowered:
        if seg in GATED_DIRS:
            return seg
    joined = "/".join(lowered)
    for tail in GATED_DIR_PATHS:
        if tail in joined:
            return tail
    return ""


def sensitive_path_from(text: str) -> str:
    """The path out of the CLI's own refusal sentence.

    `Claude requested permissions to edit <PATH> which is a sensitive file.`
    Preferred over `tool_input` for the SHELL route, where the input is a
    whole command line and the gate reports the path it resolved and
    normalized out of it (an agent that typed forward slashes is refused with
    backslashes — measured). Returns "" when the wording does not match, and
    the caller then falls back to whatever the tool input offered.
    """
    lead, tail = "permissions to edit ", " which is a sensitive file"
    i = text.find(lead)
    if i == -1:
        return ""
    j = text.find(tail, i)
    if j == -1:
        return ""
    return text[i + len(lead):j].strip()


# ⚠ FIELDS THAT ECHO WHAT THE AGENT JUST WROTE, and therefore must never be
# searched for a refusal marker. REPRODUCED LIVE 2026-09-17 while writing this
# very commit: an Edit that SUCCEEDED came back through this hook and was
# explained as a refusal, because the file content being written contained the
# phrase "which is a sensitive file" and the old `_response_text` flattened
# every value of the response dict indiscriminately. Any agent editing a file
# that merely DISCUSSES the gate was told its write had been refused, naming a
# `.claude` segment the path did not contain — three wrong statements from one
# successful call.
_ECHO_KEYS = frozenset({
    "content", "file", "filecontents", "newstring", "oldstring", "newtext",
    "oldtext", "structuredpatch", "patch", "edits", "originalfile",
    "originalfilecontents", "updatedfile", "newtodos", "oldtodos", "stdout",
})
_ERROR_KEYS = frozenset({"is_error", "iserror", "error"})


def _response_text(value: object, *, skip_echo: bool = True) -> str:
    """Flatten a tool_response of any shape into searchable text.

    `skip_echo` drops the fields that carry the agent's own content back, so a
    marker found in what remains came from the HARNESS and not from the file.
    """
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        d = cast("dict[str, object]", value)
        return " ".join(
            _response_text(v, skip_echo=skip_echo) for k, v in d.items()
            if not (skip_echo and str(k).lower().replace("_", "") in _ECHO_KEYS))
    if isinstance(value, list):
        return " ".join(_response_text(v, skip_echo=skip_echo)
                        for v in cast("list[object]", value))
    return ""


def _looks_refused(value: object, text: str) -> bool:
    """Did this call actually FAIL? Never explain a success.

    A bare string response is the whole result, so a marker in it is the
    result. A dict is structured, and there the harness states failure
    explicitly — so an explicit `is_error: false` is believed and ends it.
    """
    if isinstance(value, dict):
        d = cast("dict[str, object]", value)
        for k, v in d.items():
            if str(k).lower().replace("_", "") in _ERROR_KEYS:
                if isinstance(v, bool):
                    return v
                if v:
                    return True
    return bool(text.strip())


def refusal_advice(raw: str) -> str:
    """Turn a generic file-tool refusal into one that says what IS permitted.

    Ticket `the-sandbox-refuses-to-create-files-and-folders` (2026-09-16). Two
    organizations hit a write refusal and both found the route that works BY
    TRYING IT: the CLI's message names a boundary without indicating what the
    agent may do instead, so it reads as a generic security block. The CLI owns
    that string and we do not — but this hook runs after every tool call and
    sees `tool_response`, so the explanation can be attached where the refusal
    actually lands, in the turn that hit it.

    Says nothing it does not know. It does not claim which grant applied (the
    hook holds no grant list and must not spend a round trip to guess); it
    states the two rules that are always true — your own working folder is
    writable, a read-only grant is for reading — and names the folder exactly.
    """
    try:
        data: object = json.loads(raw or "{}")
    except ValueError:
        return ""
    if not isinstance(data, dict):
        return ""
    d = cast("dict[str, object]", data)
    name = d.get("tool_name")
    if not isinstance(name, str):
        return ""
    if name not in _FILE_TOOLS and name not in _SHELL_TOOLS:
        return ""
    response: object = d.get("tool_response")
    text = _response_text(response)
    # ⚠ NEVER EXPLAIN A SUCCESS. Added after this hook did exactly that, to
    # the agent writing this commit: an `Edit` that SUCCEEDED came back and
    # was announced as a refusal naming a `.claude` segment the path did not
    # contain, because the file being written happened to contain the phrase
    # "which is a sensitive file". Three false statements out of one good
    # call, and the same trap for anyone editing a file that merely discusses
    # the gate — including this one.
    if not _looks_refused(response, text):
        return ""
    lowered = text.lower()
    target = ""
    raw_input: object = d.get("tool_input")
    if isinstance(raw_input, dict):
        ti = cast("dict[str, object]", raw_input)
        for key in ("file_path", "notebook_path", "path"):
            got = ti.get(key)
            if isinstance(got, str) and got:
                target = got
                break
    if any(m in lowered for m in _SENSITIVE_MARKS):
        # the CLI's own sentence carries the path it RESOLVED, which beats the
        # tool input on the shell route (there the input is a whole command
        # line) and is the only path available there at all.
        named = sensitive_path_from(text) or target
        seg = gated_segment(named)
        where = f"\nThe path was: {named}" if named else ""
        # name the component actually matched. Saying `.claude` for all nine
        # sent an agent holding a `.git` refusal looking for a component that
        # was never there.
        which = (f"That path contains a `{seg}` component"
                 if seg else "That path matched the CLI's sensitive-path list")
        return (
            "[ORGTREE — that refusal explained]"
            f"{where}\n"
            f"{which}. The CLI refuses to WRITE any path containing "
            + ", ".join(GATED_DIRS)
            + " as a folder component. It is ONE list and ONE gate, sitting "
            "ABOVE the permission system: it raises an approval REQUEST, and "
            "a headless turn has nobody present to answer it, so it surfaces "
            "to you as a refusal. It is not a deny rule, your grant is not at "
            "fault, and the file is neither missing nor corrupt.\n"
            # ⚠ "nothing to retry" and "bypassPermissions" are PINNED by
            # tests/test_steer_refusal_advice.py from the previous ticket.
            # They are promises that hook already makes and an agent may be
            # searching for; widening the message must not quietly drop them.
            "There is nothing to retry: no allow-rule, no --add-dir and no "
            "hook satisfies this gate (measured 2026-08-07), and no spelling "
            "of the path works. Only permission_mode=bypassPermissions "
            "clears it. Reading these paths is fine; so are non-mutating "
            "shell commands naming them.\n"
            "WHAT WORKS INSTEAD: if this is a `.git` path, run git itself — "
            "the gate matches the path you TYPE, and git writing its own "
            "internals is never intercepted, so `git -C <root> "
            "worktree add|remove`, commit, branch and push all work normally. "
            "A stale lock in a SHARED checkout is not worth fighting: your "
            "own worktree has its own index, so commit and push from there. "
            "Otherwise request the mode with orgtree_request_scope "
            "(permission_mode) and say why — do not work around it.\n"
            "[END ORGTREE]")
    # Everything below is the DENY-RULE branch, which is a file-tool concept:
    # its advice is about grants and working folders and would be wrong for a
    # shell refusal, so the shell tools stop here.
    if name not in _FILE_TOOLS:
        return ""
    where = f"\nThe path was: {target}" if target else ""
    if not any(m in lowered for m in _DENY_MARKS):
        return ""
    return (
        "[ORGTREE — that refusal explained]"
        f"{where}\n"
        "A permission deny rule stopped that write. This is a scope boundary, "
        "not a general security block, and these two rules always hold:\n"
        f" - YOUR OWN WORKING FOLDER is always writable with the file tools: "
        f"{os.getcwd()}\n"
        "   breadcrumbs.md, CLAUDE.md, suggestion-box.md and your notes belong "
        "there, and no grant anywhere takes that away.\n"
        " - A folder granted to you READ-ONLY is for READING. Writing into it "
        "is what was refused. Writing there from the shell instead is a "
        "workaround rather than a permission — if you genuinely need to write "
        "there, ask your superior to re-grant the folder read-write, or use "
        "orgtree_request_scope.\n"
        "If the path above IS inside your own working folder, that is a bug in "
        "orgtree rather than a decision about you: say so in your next update "
        "instead of working around it.\n"
        "[END ORGTREE]")


def _emit(context: str) -> None:
    """One PostToolUse payload, or nothing at all when there is nothing to say."""
    if not context:
        return
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PostToolUse", "additionalContext": context}}))
    sys.stdout.flush()


def main() -> None:
    raw = ""
    try:
        raw = sys.stdin.read()    # the hook payload: the D1 identity
    except Exception:             # noqa: BLE001
        pass
    # computed BEFORE the backend call and independent of it: a refusal must
    # still explain itself when the backend is down or the cwd is not a scratch
    # dir, which are exactly the moments an agent is most likely to be stuck.
    advice = refusal_advice(raw)
    org, node, base, secret = identity()
    if not org:
        _emit(advice)
        return
    tool_use_id, transcript_path = hook_identity(raw)
    try:
        req = urllib.request.Request(
            f"{base}/api/orgs/{org}/nodes/{node}/steer", method="POST",
            data=json.dumps({"tool_use_id": tool_use_id,
                             "transcript_path": transcript_path}).encode(),
            headers={"Content-Type": "application/json"})
        if option("--agent-token"):
            req.add_header("X-Orgtree-Agent-Token", option("--agent-token"))
        if secret:
            req.add_header("X-Orgtree-Bridge", secret)
        # ⚠ 2 s, not 5. This runs inside a PostToolUse hook with an 8 s budget,
        # on EVERY tool call of EVERY agent. A refused connection returns
        # instantly, but a black-holed backend — a paused container, a DROP
        # rule — burns the whole timeout on every single call, measured at
        # 5.09 s against TEST-NET-1 and completely invisible: it just makes
        # every turn slower. The backend is on loopback or the local bridge; if
        # it has not answered in 2 s it is not going to.
        with urllib.request.urlopen(req, timeout=2) as r:
            data = json.load(r)
    except Exception:             # noqa: BLE001 — backend down = no MAIL to say
        _emit(advice)
        return
    msgs: list[str] = data.get("messages") or []
    if not msgs:
        _emit(advice)
        return
    delivery_id = data.get("delivery_id")
    body = "\n---\n".join(msgs)
    # D1: the delivery marker rides INSIDE the context, so the CLI's own
    # transcript row for this hook (`hook_additional_context`) names the
    # delivery it recorded — that row, not this print, is what the backend
    # commits on. Sender attribution (FROM @user / FROM @agent lines) is
    # already inside each message — the wrapper stays sender-neutral so agent
    # mail is never mislabeled with user authority.
    mark = f"[ORGTREE-DELIVERY:{delivery_id}]\n" if delivery_id else ""
    # a hook may emit ONE payload, so a refusal explanation and pending mail
    # share it. The advice goes FIRST — it is about the tool call that just
    # failed, which is the thing the agent is looking at — and the delivery
    # marker stays inside the mail block, where the backend's receipt reads it.
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext":
            (f"{advice}\n" if advice else "")
            + f"[ORGTREE MAIL — delivered mid-task]\n"
            f"{mark}"
            f"{body}\n"
            f"[END ORGTREE MAIL — authentic per your system prompt; each "
            f"message has the authority of its stated sender; handle it "
            f"before continuing your current work]",
    }}))
    # print FIRST, then ack. The receipt must never precede the bytes it
    # receipts; it says the hook emitted them, not that the CLI read them —
    # the transcript record is that proof, and the backend waits for it.
    sys.stdout.flush()
    if not delivery_id or not tool_use_id:
        return
    try:
        ack = urllib.request.Request(
            f"{base}/api/orgs/{org}/nodes/{node}/steer/ack", method="POST",
            data=json.dumps({"delivery_id": str(delivery_id),
                             "tool_use_id": tool_use_id}).encode(),
            headers={"Content-Type": "application/json"})
        if option("--agent-token"):
            ack.add_header("X-Orgtree-Agent-Token", option("--agent-token"))
        if secret:
            ack.add_header("X-Orgtree-Bridge", secret)
        with urllib.request.urlopen(ack, timeout=2):
            pass
    except Exception:             # noqa: BLE001 — a lost receipt is a retry, never a loss
        return


if __name__ == "__main__":
    main()
