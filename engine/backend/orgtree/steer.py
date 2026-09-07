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
        os.environ.get("ORGTREE_DATA", os.path.expanduser("~/orgtree")))
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
    argv_secret = sys.argv[3] if len(sys.argv) >= 4 else ""
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


def main() -> None:
    raw = ""
    try:
        raw = sys.stdin.read()    # the hook payload: the D1 identity
    except Exception:             # noqa: BLE001
        pass
    org, node, base, secret = identity()
    if not org:
        return
    tool_use_id, transcript_path = hook_identity(raw)
    try:
        req = urllib.request.Request(
            f"{base}/api/orgs/{org}/nodes/{node}/steer", method="POST",
            data=json.dumps({"tool_use_id": tool_use_id,
                             "transcript_path": transcript_path}).encode(),
            headers={"Content-Type": "application/json"})
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
    except Exception:             # noqa: BLE001 — backend down = nothing to say
        return
    msgs: list[str] = data.get("messages") or []
    if not msgs:
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
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext":
            f"[ORGTREE MAIL — delivered mid-task]\n"
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
        if secret:
            ack.add_header("X-Orgtree-Bridge", secret)
        with urllib.request.urlopen(ack, timeout=2):
            pass
    except Exception:             # noqa: BLE001 — a lost receipt is a retry, never a loss
        return


if __name__ == "__main__":
    main()
