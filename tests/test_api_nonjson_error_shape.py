"""A failing API call must answer JSON, not the words `Internal Server Error`.

Docket: fix-agents-stuck-halting-and-non-json-stop-error.

⚠ THE SCREENSHOT THIS FILE EXISTS FOR. The user pressed stop on an agent that
was stuck `halting`, and the desktop showed:

    error: Unexpected token 'I', "Internal S"... is not valid JSON

Two defects produced that one sentence, and this file pins the backend half.
An exception escaping a FastAPI handler is answered by Starlette's default
500: the body is the literal bytes `Internal Server Error`, `text/plain`, no
JSON anywhere. The desktop parses every error body as JSON, so what the user
was shown was our parser complaining about our own error page — with nothing
in it about the agent, the stop, or the `[Errno 22] Invalid argument` that
actually happened.

The renderer half is pinned separately, in
`apps/desktop/renderer/tests/stopnonjson.test.tsx`: the client no longer
assumes JSON either. Both halves are fixed because either one alone leaves a
real failure mode — a plain-text body from some other layer, or a future
handler that raises before this one is reached.

`raise_server_exceptions=False` below is REQUIRED, not incidental: the test
client's default is to re-raise a server exception into the test instead of
returning the response, which would measure nothing about the wire. The
negative control uses a bare FastAPI app with no handler registered, so the
`Internal Server Error` shape being fixed is measured here rather than
assumed.
"""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

_root = tempfile.TemporaryDirectory(prefix="orgtree-nonjson-",
                                    ignore_cleanup_errors=True)
os.environ.update(ORGTREE_DATA=_root.name,
                  ORGTREE_V2_TOKEN="nonjson-error-shape-tests")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine/backend"))

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from orgtree import api  # noqa: E402


#: the exact exception the live failure carried: a write to a killed
#: app-server's stdin pipe on Windows. `str()` of it is
#: `[Errno 22] Invalid argument` — the bare errno retire and dissolve returned.
BOOM = OSError(22, "Invalid argument")
PATH = "/api/_verification/unhandled-oserror"


def _boom() -> dict[str, str]:
    raise BOOM


class UnhandledErrorsAnswerJson(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        api.app.add_api_route(PATH, _boom, methods=["POST"])
        cls.client = TestClient(api.app, raise_server_exceptions=False)

    @classmethod
    def tearDownClass(cls):
        api.app.router.routes = [r for r in api.app.router.routes
                                 if getattr(r, "path", None) != PATH]

    def test_an_unhandled_oserror_is_a_json_body(self):
        r = self.client.post(PATH)
        self.assertEqual(r.status_code, 500)
        # the whole point: this parses
        body = json.loads(r.text)
        self.assertIn("Invalid argument", body["detail"])
        self.assertEqual(body["error"]["type"], "OSError")
        self.assertIn("Invalid argument", body["error"]["message"])
        self.assertEqual(body["error"]["path"], PATH)
        self.assertEqual(body["error"]["method"], "POST")
        self.assertTrue(body["error"]["unhandled"])
        self.assertIn("application/json", r.headers.get("content-type", ""))
        # and the body never starts with the word the parser choked on
        self.assertFalse(r.text.lstrip().startswith("Internal Server Error"))

    def test_the_detail_key_is_the_one_every_client_already_reads(self):
        """`HTTPException` answers on `detail`, so the catch-all uses the same
        key — an existing client needs no new code to read this."""
        r = self.client.post(PATH)
        self.assertIsInstance(json.loads(r.text).get("detail"), str)

    def test_negative_control_a_bare_app_answers_the_broken_plain_text(self):
        """THE PRE-FIX SHAPE, measured rather than assumed: with no catch-all
        registered, the same exception produces the exact bytes the desktop
        could not parse."""
        bare = FastAPI()
        bare.add_api_route(PATH, _boom, methods=["POST"])
        r = TestClient(bare, raise_server_exceptions=False).post(PATH)
        self.assertEqual(r.status_code, 500)
        self.assertEqual(r.text, "Internal Server Error")
        self.assertIn("text/plain", r.headers.get("content-type", ""))
        with self.assertRaises(json.JSONDecodeError) as caught:
            json.loads(r.text)
        # the same complaint, from the same first character, that the user saw
        self.assertEqual(caught.exception.pos, 0)
        self.assertTrue(r.text.startswith("Internal S"))


if __name__ == "__main__":
    unittest.main()
