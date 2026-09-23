"""Provider process factory for turns requiring a genuine sign-in token.

This is called at the existing provider launch seam. The service rechecks
sign-in under its admission lock immediately before resuming each suspended
child, so a status read by the engine never authorizes a later spawn.
"""

from __future__ import annotations

import os
import uuid
from typing import Any


def bridged_binary(argv: list[str], cwd: str | None,
                   env: dict[str, str]) -> Any:
    from engine import bridge_client
    return bridge_client.spawn(uuid.uuid4().hex, argv, cwd or os.getcwd(), env)


def bridged_text(argv: list[str], cwd: str | None,
                 env: dict[str, str]) -> Any:
    from engine import bridge_client
    return bridge_client.spawn(uuid.uuid4().hex, argv, cwd or os.getcwd(), env,
                               text=True, encoding="utf-8", errors="replace")
