"""Entry point for the synthetic v3 qualification harness."""
from pathlib import Path
import sys

# Explicitly permit only this checkout's tools even under Python -I.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from v3_qualification.runner import main

if __name__ == "__main__":
    raise SystemExit(main())
