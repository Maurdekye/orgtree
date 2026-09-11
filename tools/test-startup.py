"""Run each startup suite in its own process, with storage pinned before imports."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

repo = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="orgtree-startup-suites-") as temp:
    root = Path(temp).resolve()
    data, profile = root / "data", root / "home"
    data.mkdir()
    profile.mkdir()
    env = {**os.environ, "ORGTREE_DATA": str(data), "HOME": str(profile), "USERPROFILE": str(profile)}
    for module in ("test_startup_budget", "test_startup_recovery", "test_startup_readiness", "test_startup_progress",
                   "test_transcript_lookup", "test_restart_resume"):
        result = subprocess.run([sys.executable, "-B", "-m", "unittest", f"tests.{module}", "-v"],
                                cwd=repo, env=env, timeout=180)
        if result.returncode:
            raise SystemExit(result.returncode)
