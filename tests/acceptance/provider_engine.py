"""Real engine with observation and a guard limiting this test to read-only chart.

No provider response, process specification or successful tool response is mocked.
The guard refuses every agent tool except the single authorized chart operation.
"""
import json
import os
from pathlib import Path
import sys
import urllib.request
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(os.environ["ORGTREE_DATA"]).resolve()
assert DATA.name == "data" and DATA.parent.name.startswith("orgtree-v2-provider-")
assert DATA.is_dir()
sys.path.insert(0, str(ROOT))
from engine import launch

original = launch.load_app


def load_observed():
    result = original()
    from orgtree import agentauth, store, supervisor
    port = result[3]
    assert port != 7360 and Path(store.DATA_ROOT).resolve() == DATA
    assert os.environ["ORGTREE_PORT"] == str(port)
    original_spec = supervisor._codex_process_spec

    def observed_spec(org, nid, **kwargs):
        spec = original_spec(org, nid, **kwargs)
        assert org.d["slug"] == "v2-codex-acceptance" and nid == "probe"
        assert spec["port"] == str(port)
        assert spec["env_extra"]["ORGTREE_PORT"] == str(port)
        assert agentauth.verify(spec["env_extra"]["ORGTREE_AGENT_TOKEN"]) == (org.d["slug"], nid, 0)
        (DATA.parent / "mcp-target.json").write_text(json.dumps({
            "port": port, "dataRoot": str(DATA), "org": org.d["slug"], "node": nid,
            "generation": 0, "scopedCredentialVerified": True,
            "cwdInsideTestRoot": DATA in Path(spec["cwd"]).resolve().parents,
        }), encoding="utf-8")
        assert DATA in Path(spec["cwd"]).resolve().parents
        return spec

    supervisor._codex_process_spec = observed_spec
    original_open = urllib.request.urlopen

    def guarded_open(request, *args, **kwargs):
        url = urlsplit(request.full_url if hasattr(request, "full_url") else request)
        if url.path == "/api/agent":
            assert url.hostname == "127.0.0.1" and url.port == port
            body = json.loads(request.data)
            assert body["org"] == "v2-codex-acceptance" and body["node"] == "probe"
            if body["tool"] != "orgtree_chart":
                raise RuntimeError("Acceptance permits only read-only orgtree_chart")
            response = original_open(request, *args, **kwargs)
            with (DATA.parent / "tool-observations.jsonl").open("a", encoding="utf-8") as stream:
                stream.write(json.dumps({"tool": body["tool"], "org": body["org"], "node": body["node"], "port": port, "httpStatus": response.status}) + "\n")
            return response
        return original_open(request, *args, **kwargs)

    urllib.request.urlopen = guarded_open
    return result


launch.load_app = load_observed
launch.main()
