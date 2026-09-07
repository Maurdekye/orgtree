"""Fail-closed PreToolUse hook for disposable prompt-cache keepalives.

The keepalive must present Claude with the same tools as a real turn so its
prompt-cache key stays representative.  Execution is a separate boundary:
this local hook denies every attempted tool after the model responds.
"""
from __future__ import annotations

import json


def decision() -> dict:
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": (
            "Automated prompt-cache keepalive: tool execution is disabled."),
    }}


def main() -> None:
    print(json.dumps(decision(), separators=(",", ":")))


if __name__ == "__main__":
    main()
