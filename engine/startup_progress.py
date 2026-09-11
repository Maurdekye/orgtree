"""Startup checkpoints, never a timer that makes a hung engine look busy."""
import json
import os
from pathlib import Path
import threading


class StartupProgress:
    def __init__(self, root: Path):
        self.root = str(root.resolve())
        self.sequence = 0
        self.lock = threading.Lock()

    def report(self, phase: str) -> None:
        with self.lock:
            self.sequence += 1
            print(json.dumps({"type": "startup-progress", "protocol": 1,
                              "pid": os.getpid(), "dataRootId": self.root,
                              "sequence": self.sequence, "phase": phase},
                             separators=(",", ":")), flush=True)


def parse_progress(line: str, child_pid: int, root: Path, previous: int) -> int:
    """Only advancing checkpoints from this child/root extend its deadline."""
    try:
        value = json.loads(line)
    except (ValueError, UnicodeError):
        return previous
    if not isinstance(value, dict) or value.get("type") != "startup-progress":
        return previous
    sequence = value.get("sequence")
    reported = value.get("dataRootId")
    if (type(value.get("protocol")) is not int or value.get("protocol") != 1 or value.get("pid") != child_pid
            or type(sequence) is not int or not previous < sequence <= 2**53 - 1
            or not isinstance(value.get("phase"), str) or not 0 < len(value["phase"]) <= 100
            or not isinstance(reported, str) or not Path(reported).is_absolute()):
        return previous
    if os.path.normcase(os.path.normpath(reported)) != os.path.normcase(str(root.resolve())):
        return previous
    return sequence
