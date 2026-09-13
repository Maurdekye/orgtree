"""CLI invocation hook. Only this process's private handoff directory is read."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys


def main() -> None:
    raw = json.load(sys.stdin)
    directory = os.environ.get("ORGTREE_AGY_STEER_DIR")
    if not directory or not isinstance(raw, dict):
        print("{}")
        return
    root = Path(directory)
    pending, claimed = root / "pending.json", root / "claimed.json"
    try:
        pending.rename(claimed)
    except FileNotFoundError:
        print("{}")
        return
    message = json.loads(claimed.read_text(encoding="utf-8"))
    result = {"injectSteps": [{"userMessage": message["text"]}]}
    if sys.argv[-1] == "post":
        result["terminationBehavior"] = "force_continue"
    print(json.dumps(result), flush=True)
    # This receipts emission only. The driver additionally requires a new
    # user_input step on the CLI wire before committing the durable carrier.
    ack = root / "emitted.json"
    tmp = root / "emitted.tmp"
    tmp.write_text(json.dumps({"id": message["id"]}), encoding="utf-8")
    tmp.replace(ack)
    claimed.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
