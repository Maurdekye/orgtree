"""Independently rerun real launcher/MCP authorization controls with bundled Python.

The existing HTTP fixture suppresses provider discovery; it does not mock HTTP,
the launcher, persistence, token authorization or the mcptool subprocess.
No real provider task runs here. Credentials stay in private process pipes.
"""
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(tempfile.mkdtemp(prefix="orgtree-v2-mcp-acceptance-"))
os.environ["ORGTREE_DATA"] = str(DATA)
for key in ("ORGTREE_PORT", "ORGTREE_BASE", "ORGTREE_V1_ROOT", "ORGTREE_V1_DATA_ROOT", "ORGTREE_V2_TOKEN"):
    os.environ.pop(key, None)

# Explicit root is established before importing a test or application module.
import sys
sys.path.insert(0, str(ROOT))
from tests import test_engine_http

# Embedded Python deliberately ignores cwd/PYTHONPATH. Explicitly name the copied
# engine for the fixture's script-form launcher import; production code is intact.
test_engine_http.CHILD = "import sys; sys.path.insert(0, " + repr(str(ROOT / "engine")) + ")\n" + test_engine_http.CHILD
suite = unittest.defaultTestLoader.loadTestsFromTestCase(test_engine_http.EngineHTTPTests)
result = unittest.TestResult()
suite.run(result)
report = {
    "status": "PASS" if result.wasSuccessful() and result.testsRun == 2 and not result.skipped else "FAIL",
    "evidence": "real-launcher-and-mcptool-with-seeded-identities-no-provider",
    "python": sys.executable,
    "testsRun": result.testsRun,
    "failures": [test.id() for test, _ in result.failures],
    "errors": [test.id() for test, _ in result.errors],
    "skipped": [test.id() for test, _ in result.skipped],
    "controls": ["exact fresh engine root and non-7360 port", "real mcptool subprocess success", "missing/forged credential rejection", "forged node/org and stale generation rejection", "agent credential denied desktop route", "owner secrets absent from clean child environment"],
    "retainedReport": str(DATA / "report.json"),
}
(DATA / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps(report, indent=2))
raise SystemExit(0 if report["status"] == "PASS" else 1)
