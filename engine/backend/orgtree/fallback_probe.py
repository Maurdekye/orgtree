"""Isolated liveness probes for registered Claude fallback keys.

The CLI silently falls back to its normal login after an OAuth-key rejection
when that login is present.  A probe must therefore always give it a fresh
``CLAUDE_CONFIG_DIR`` and remove every competing credential from its child
environment.  This module never returns, logs, or persists either the token
or the CLI's raw output.
"""
from __future__ import annotations

import os
import re
import subprocess
import tempfile
from typing import Sequence

from . import limits

ALIVE = "alive"
LIMITED = "limited"
DEAD = "dead"
UNKNOWN = "unknown"

# The shared limits module carries the battle-tested rate and tier matchers.
# It must run before rejection markers: a limit response proves authentication,
# even when upstream adds a word such as "invalid" to its refusal.
_DEAD_RE = re.compile(
    r"\b401\b|\binvalid\b|\bauth(?:enticate|entication|orization)?\b",
    re.IGNORECASE,
)


def classify(exit_code: int, response: str) -> str:
    """Classify one isolated CLI result without retaining its raw response.

    Precedence is deliberate.  A rate/session refusal is authenticated proof
    of life; a dead verdict is considered only when no such marker exists.
    Unknown is intentionally a non-verdict.
    """
    text = str(response or "")
    if limits.is_limit_message(text):
        return LIMITED
    if _DEAD_RE.search(text):
        return DEAD
    if int(exit_code) == 0:
        return ALIVE
    return UNKNOWN


def probe(token: str, argv: Sequence[str]) -> str:
    """Make one Haiku request with ``token`` as the sole possible credential.

    The result is only one of the four public state labels above.  In
    particular, exception detail and CLI output stay in local variables until
    they are discarded: either may contain material inappropriate for logs.
    """
    if not token or not argv:
        return UNKNOWN
    env = dict(os.environ)
    for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
                 "CLAUDE_CODE_OAUTH_TOKEN"):
        env.pop(name, None)
    env["CLAUDE_CODE_OAUTH_TOKEN"] = token
    try:
        with tempfile.TemporaryDirectory(prefix="orgtree-fallback-probe-") as cfg:
            env["CLAUDE_CONFIG_DIR"] = cfg
            # Every other Windows spawn site in this codebase sets
            # CREATE_NO_WINDOW (see supervisor.py's `_detached_spawn` and
            # `_wd_popen`) so a console child can never paint a window when it
            # inherits a hidden/console-less parent. This one shipped without
            # it (D-205) -- harmless under today's launch chain (measured: the
            # backend's own hidden console is what every child actually
            # inherits), but it is the one spawn in this file that runs on a
            # bare hourly clock rather than in response to a turn, so it is
            # the one most likely to eventually run under a parent with no
            # console to inherit at all.
            run = subprocess.run(
                [*argv, "-p", "say ok", "--model", "haiku"], env=env,
                capture_output=True, text=True, timeout=120,
                creationflags=(subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
                               if os.name == "nt" else 0),
            )
            response = (run.stdout or "") + (run.stderr or "")
            return classify(run.returncode, response)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return UNKNOWN
