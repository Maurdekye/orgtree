"""subproxy's OAuth refresh: the request it actually sends, and what it is
entitled to conclude when that request comes back refused.

Background, measured 2026-09-11 with credential-free probes (no token, no
account data, a deliberately invalid refresh token):

    POST https://console.anthropic.com/v1/oauth/token
        no User-Agent          -> 403  body "error code: 1010"
        UA axios/claude-cli    -> 404  {"type":"not_found_error"}
    POST https://platform.claude.com/v1/oauth/token
        no User-Agent          -> 403  body "error code: 1010"
        UA axios/1.7.9         -> 400  {"error":"invalid_grant"}
        UA orgtree-subproxy/…  -> 400  {"error":"invalid_grant"}
        UA zzqqxx/0.0.1        -> 400  {"error":"invalid_grant"}
    positive control, GET api.anthropic.com/api/oauth/usage -> 429 for EVERY
    User-Agent, so the probe method itself was never the thing being blocked.

Two defects, both required to explain the reported failure: the host had
moved, AND urllib's default User-Agent is banned at the edge. The second is
what produced the bare `403 Forbidden` the user saw — an answer from a WAF,
before anything looked at the credential, reported as though the account
needed signing in again.

Pure unit tests: no CLI, no network, no real credentials touched.
"""
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.error

_root = tempfile.TemporaryDirectory(prefix='v2-subproxy-refresh-')
os.environ['ORGTREE_DATA'] = _root.name
assert not Path(_root.name).resolve().is_relative_to((Path.home() / 'orgtree').resolve())
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine' / 'backend'))
from orgtree import accounts, subproxy   # noqa: E402

REFRESH = 'rt-fixture-value-do-not-echo'


def _http_error(code, body=b'', headers=None):
    return urllib.error.HTTPError(
        subproxy.TOKEN_URL, code, 'reason', headers or {}, io.BytesIO(body))


class _Response(io.BytesIO):
    """Minimal stand-in for what urlopen yields — a context manager whose
    body json.load can read."""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _creds(tmp, *, scopes=('user:profile', 'user:inference'), expired=True):
    """A profile directory holding a credentials file, shaped like the CLI's."""
    d = Path(tmp) / 'profile'
    d.mkdir(parents=True, exist_ok=True)
    doc = {'claudeAiOauth': {
        'accessToken': 'at-old',
        'refreshToken': REFRESH,
        # 0 = long expired, so every test drives the REFRESH path rather than
        # the early return. A fixture that is still valid would make every
        # assertion below free (no request is ever sent) — the vacuous pass
        # this file exists to avoid.
        'expiresAt': 0 if expired else int((_time() + 86400) * 1000),
    }}
    if scopes is not None:
        doc['claudeAiOauth']['scopes'] = list(scopes)
    (d / '.credentials.json').write_text(json.dumps(doc), encoding='utf-8')
    return str(d)


def _time():
    import time
    return time.time()


class RequestShapeTests(unittest.TestCase):
    """WHAT GOES ON THE WIRE. Every assertion here failed before the fix."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='subproxy-shape-')
        self.addCleanup(self.tmp.cleanup)
        self.captured = None

    def _run(self, profile, response=None):
        def fake_urlopen(req, timeout=None):
            self.captured = req
            return _Response(json.dumps(response or {
                'access_token': 'at-new', 'expires_in': 3600}).encode())

        orig = subproxy.urllib.request.urlopen
        subproxy.urllib.request.urlopen = fake_urlopen
        try:
            return subproxy.profile_access_token(profile)
        finally:
            subproxy.urllib.request.urlopen = orig

    def test_the_request_is_actually_captured(self):
        """POSITIVE CONTROL for every other test in this class: if the stub
        never ran, `captured` stays None and the assertions below would all
        be free."""
        token = self._run(_creds(self.tmp.name))
        self.assertIsNotNone(self.captured, 'the refresh never sent a request')
        self.assertEqual(token, 'at-new')

    def test_posts_to_the_endpoint_the_installed_cli_uses(self):
        self._run(_creds(self.tmp.name))
        self.assertEqual(self.captured.full_url,
                         'https://platform.claude.com/v1/oauth/token')

    def test_never_posts_to_the_retired_console_host(self):
        """That host still resolves and still answers — it just 404s this
        path now, which is why the move went unnoticed for so long."""
        self._run(_creds(self.tmp.name))
        self.assertNotIn('console.anthropic.com', self.captured.full_url)

    def test_sends_a_user_agent_that_is_not_urllibs_default(self):
        """⚠ THE 403. Without this header the edge answers `403 Forbidden`
        with body `error code: 1010` before the OAuth server sees anything."""
        self._run(_creds(self.tmp.name))
        ua = self.captured.get_header('User-agent')
        self.assertTrue(ua, 'no User-Agent header was set')
        self.assertNotIn('python-urllib', ua.lower())

    def test_one_user_agent_constant_shared_with_accounts(self):
        """The defect class, not just the defect: accounts.py had already
        learned this and subproxy.py had not."""
        self.assertEqual(accounts.USER_AGENT, subproxy.USER_AGENT)

    def test_body_carries_the_oauth_refresh_grant(self):
        self._run(_creds(self.tmp.name))
        body = json.loads(self.captured.data.decode())
        self.assertEqual(body['grant_type'], 'refresh_token')
        self.assertEqual(body['refresh_token'], REFRESH)
        self.assertEqual(body['client_id'], subproxy.CLIENT_ID)

    def test_scope_is_the_grant_this_file_records(self):
        """Taken from the file, never a list hard-coded here: a refresh may
        not ask for more than was granted."""
        self._run(_creds(self.tmp.name, scopes=('user:profile',)))
        self.assertEqual(json.loads(self.captured.data.decode())['scope'],
                         'user:profile')

    def test_scope_is_omitted_when_the_file_records_none(self):
        """RFC 6749 §6: absent means "the scope originally granted" — which
        is what we want. Sending an empty or invented scope is not."""
        self._run(_creds(self.tmp.name, scopes=None))
        self.assertNotIn('scope', json.loads(self.captured.data.decode()))

    def test_a_valid_token_sends_no_request_at_all(self):
        """The other side of the control: an unexpired credential must NOT
        reach the network. If this passed while the tests above also passed
        on the same fixture, the fixture would be proving nothing."""
        token = self._run(_creds(self.tmp.name, expired=False))
        self.assertIsNone(self.captured)
        self.assertEqual(token, 'at-old')


class ClassificationTests(unittest.TestCase):
    """Did anything actually JUDGE the credential? Only then may a sign-in
    prompt appear."""

    def test_invalid_grant_is_a_rejected_credential(self):
        self.assertTrue(subproxy._judged_credential(
            400, '{"error": "invalid_grant", "error_description": "…"}'))

    def test_authentication_error_is_a_rejected_credential(self):
        self.assertTrue(subproxy._judged_credential(
            401, '{"type":"error","error":{"type":"authentication_error"}}'))

    def test_client_level_refusals_are_not_the_accounts_fault(self):
        """⚠ root review of 81bc2d1. RFC 6749 aims `invalid_client` and
        `unauthorized_client` at the CLIENT — our client_id, the application
        — not at the account's refresh token. The user's credential can be
        perfectly good while WE are the thing being refused, so routing these
        to "sign in again" is the same cannot-help ritual one more time."""
        for code in ('invalid_client', 'unauthorized_client'):
            for status in (400, 401, 403):
                self.assertFalse(
                    subproxy._judged_credential(status, '{"error":"%s"}' % code),
                    f'{status} {code} must not read as a rejected credential')

    def test_the_grant_and_client_routes_are_actually_distinguished(self):
        """POSITIVE CONTROL for the test above, on one line each: the same
        status, the same shape, the same function — and opposite answers. A
        classifier that had simply stopped recognising anything would pass
        the client-refusal test and fail this one."""
        self.assertTrue(subproxy._judged_credential(
            400, '{"error":"invalid_grant"}'))
        self.assertFalse(subproxy._judged_credential(
            400, '{"error":"invalid_client"}'))

    def test_a_bare_403_is_not_proof_of_anything(self):
        """⚠ root review of 2024af5. A status code with nothing in it is an
        UNKNOWN refusal — and an edge in front of the server answers with
        exactly these codes. Calling it a rejected credential is the same
        mistake this module was written to stop making, just further in."""
        self.assertFalse(subproxy._judged_credential(403, ''))

    def test_a_bare_401_is_not_proof_of_anything_either(self):
        self.assertFalse(subproxy._judged_credential(401, ''))

    def test_a_challenge_with_an_empty_body_is_not_a_rejected_credential(self):
        """Cloudflare's challenge can carry NOTHING in the body and say so
        only in a header, so a body-only check reads its silence as a dead
        token."""
        self.assertFalse(subproxy._judged_credential(
            403, '', {'cf-mitigated': 'challenge'}))
        self.assertFalse(subproxy._judged_credential(
            403, '', {'Retry-After': '30'}))

    def test_headers_do_not_veto_an_explicit_rejection_wrongly(self):
        """POSITIVE CONTROL for the header check: absent those markers the
        same 403 with real evidence still reads as a rejection, so the veto
        is doing work rather than swallowing everything."""
        self.assertTrue(subproxy._judged_credential(
            403, '{"error":"invalid_grant"}', {'Content-Type': 'application/json'}))

    def test_waf_block_is_not_a_rejected_credential(self):
        """⚠ THE MISLEADING STATUS. This exact response — 403 with body
        `error code: 1010` — is what the user's account was reporting, and
        reading it as "sign in again" sent them at a ritual that could not
        have helped."""
        self.assertFalse(subproxy._judged_credential(403, 'error code: 1010'))

    def test_moved_endpoint_is_not_a_rejected_credential(self):
        self.assertFalse(subproxy._judged_credential(
            404, '{"type":"error","error":{"type":"not_found_error"}}'))

    def test_throttle_is_not_a_rejected_credential(self):
        for code, body in ((429, '{"type":"rate_limit_error"}'),
                           (403, '{"type":"rate_limit_error"}')):
            self.assertFalse(subproxy._judged_credential(code, body),
                             f'{code} {body} must not read as a bad login')

    def test_server_error_is_not_a_rejected_credential(self):
        for code in (500, 502, 503):
            self.assertFalse(subproxy._judged_credential(code, ''))


class FailureSurfaceTests(unittest.TestCase):
    """What a person reads, what a diagnosis gets, and what the sign-in
    button is allowed to key off."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='subproxy-fail-')
        self.addCleanup(self.tmp.cleanup)

    def _fail_with(self, err):
        def fake_urlopen(req, timeout=None):
            raise err

        orig = subproxy.urllib.request.urlopen
        subproxy.urllib.request.urlopen = fake_urlopen
        try:
            subproxy.profile_access_token(_creds(self.tmp.name))
        except RuntimeError as e:
            return e
        finally:
            subproxy.urllib.request.urlopen = orig
        self.fail('the refresh was expected to fail and did not')

    def test_waf_403_reads_as_recoverable_and_asks_for_no_sign_in(self):
        e = self._fail_with(_http_error(403, b'error code: 1010\n'))
        self.assertFalse(e.credential_rejected)
        self.assertIsNone(e.evidence)
        self.assertEqual(e.user_message, subproxy.RECOVERABLE_MESSAGE)

    def test_dead_refresh_token_does_ask_for_a_sign_in(self):
        """POSITIVE CONTROL for the test above: the same code path, the same
        assertions, opposite answer. A classifier hardwired to "never a
        rejection" would pass that test and fail this one."""
        e = self._fail_with(_http_error(
            400, b'{"error": "invalid_grant", "error_description": "bad"}'))
        self.assertTrue(e.credential_rejected)
        self.assertEqual(e.evidence, 'measured_refresh_rejected')
        self.assertEqual(e.user_message, subproxy.SIGNED_OUT_MESSAGE)

    def test_the_failure_keeps_its_status_and_body(self):
        """Root had to diagnose the original 403 blind because the body was
        read and thrown away. `error code: 1010` was in it the whole time."""
        e = self._fail_with(_http_error(403, b'error code: 1010\n'))
        self.assertEqual(e.status, 403)
        self.assertIn('error code: 1010', e.body)
        self.assertIn('error code: 1010', str(e))

    def test_the_refresh_token_is_never_echoed_into_the_error(self):
        """An endpoint that quotes the credential back at us must not put it
        into a log line or a panel."""
        e = self._fail_with(_http_error(
            400, f'{{"error":"invalid_grant","error_description":"bad {REFRESH}"}}'
            .encode()))
        self.assertNotIn(REFRESH, str(e))
        self.assertNotIn(REFRESH, e.body)
        self.assertIn('<redacted>', e.body)

    def test_a_token_late_in_a_long_body_is_still_removed(self):
        """The ordering, end to end. Under the old code — truncate to 600,
        THEN replace — a token sitting near that cutoff was no longer whole,
        `replace` matched nothing, and a partial credential was what got
        displayed. Redacting the full read first removes the case."""
        head = b'x' * 590
        e = self._fail_with(_http_error(400, head + REFRESH.encode()))
        for n in range(8, len(REFRESH) + 1):
            self.assertNotIn(REFRESH[:n], e.body,
                             f'a {n}-character fragment survived')


    def test_a_transport_failure_asks_for_no_sign_in(self):
        e = self._fail_with(urllib.error.URLError('connection refused'))
        self.assertFalse(e.credential_rejected)
        self.assertEqual(e.user_message, subproxy.RECOVERABLE_MESSAGE)

    def test_a_profile_that_never_signed_in_is_a_local_observation(self):
        """Distinct evidence on purpose: nothing was measured against a
        server here, so it must not claim to have been."""
        empty = Path(self.tmp.name) / 'never-signed-in'
        empty.mkdir()
        with self.assertRaises(RuntimeError) as cm:
            subproxy.profile_access_token(str(empty))
        self.assertEqual(cm.exception.evidence, 'not_connected')
        self.assertTrue(cm.exception.credential_rejected)

    def test_refresh_error_is_still_a_runtime_error(self):
        """Every existing caller catches RuntimeError. Narrowing that would
        turn a handled failure into a 500."""
        self.assertTrue(issubclass(subproxy.RefreshError, RuntimeError))


class RedactionTests(unittest.TestCase):
    """`_redact` on its own, because the guard that matters most here is the
    one for a token cut in half by our own read limit — and at `_http_failure`
    level that fragment lands past the display cutoff anyway, so an end-to-end
    test of it would pass whether the guard existed or not. Tested directly,
    it can fail."""

    def test_an_echoed_token_is_replaced(self):
        out = subproxy._redact(f'left {REFRESH} right', REFRESH)
        self.assertNotIn(REFRESH, out)
        self.assertIn('<redacted>', out)
        self.assertIn('left', out)          # and the rest is left alone

    def test_a_token_cut_by_the_read_limit_leaves_no_fragment(self):
        """⚠ THE STRADDLE. Our own `_MAX_BODY` can slice a token in half, and
        what remains is not matchable by `replace` — it is just a partial
        credential sitting at the end of the string."""
        for n in range(8, len(REFRESH)):
            out = subproxy._redact('body ' + REFRESH[:n], REFRESH)
            self.assertNotIn(REFRESH[:n], out,
                             f'a {n}-character fragment survived')
            self.assertIn('<redacted>', out)

    def test_a_short_coincidence_is_not_eaten(self):
        """POSITIVE CONTROL: the straddle guard must not chew up ordinary text
        that happens to share a character or two with the credential, or it
        would be quietly destroying every error body it touches."""
        out = subproxy._redact('all quiet ' + REFRESH[:3], REFRESH)
        self.assertTrue(out.endswith(REFRESH[:3]), out)

    def test_a_body_with_no_token_is_untouched(self):
        text = '{"error":"invalid_grant"}'
        self.assertEqual(subproxy._redact(text, REFRESH), text)

    def test_an_empty_secret_changes_nothing(self):
        self.assertEqual(subproxy._redact('anything', ''), 'anything')


class SuccessPathTests(unittest.TestCase):
    """The parts that already worked and must keep working."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='subproxy-ok-')
        self.addCleanup(self.tmp.cleanup)

    def _refresh(self, response):
        profile = _creds(self.tmp.name)

        def fake_urlopen(req, timeout=None):
            return _Response(json.dumps(response).encode())

        orig = subproxy.urllib.request.urlopen
        subproxy.urllib.request.urlopen = fake_urlopen
        try:
            token = subproxy.profile_access_token(profile)
        finally:
            subproxy.urllib.request.urlopen = orig
        doc = json.loads((Path(profile) / '.credentials.json')
                         .read_text(encoding='utf-8'))
        return token, doc['claudeAiOauth']

    def test_the_new_token_is_written_back(self):
        token, o = self._refresh({'access_token': 'at-new', 'expires_in': 3600})
        self.assertEqual(token, 'at-new')
        self.assertEqual(o['accessToken'], 'at-new')
        self.assertGreater(o['expiresAt'] / 1000, _time())

    def test_an_unrotated_refresh_token_is_kept(self):
        _, o = self._refresh({'access_token': 'at-new', 'expires_in': 3600})
        self.assertEqual(o['refreshToken'], REFRESH)

    def test_a_rotated_refresh_token_replaces_the_old_one(self):
        _, o = self._refresh({'access_token': 'at-new', 'expires_in': 3600,
                              'refresh_token': 'rt-rotated'})
        self.assertEqual(o['refreshToken'], 'rt-rotated')

    def test_no_temp_file_is_left_beside_the_credentials(self):
        profile = _creds(self.tmp.name)

        def fake_urlopen(req, timeout=None):
            return _Response(json.dumps(
                {'access_token': 'at-new', 'expires_in': 3600}).encode())

        orig = subproxy.urllib.request.urlopen
        subproxy.urllib.request.urlopen = fake_urlopen
        try:
            subproxy.profile_access_token(profile)
        finally:
            subproxy.urllib.request.urlopen = orig
        self.assertEqual([p.name for p in Path(profile).iterdir()],
                         ['.credentials.json'])

    def test_a_response_with_no_access_token_is_a_failure_not_a_write(self):
        profile = _creds(self.tmp.name)
        before = (Path(profile) / '.credentials.json').read_text(encoding='utf-8')

        def fake_urlopen(req, timeout=None):
            return _Response(b'{"error":"server_error"}')

        orig = subproxy.urllib.request.urlopen
        subproxy.urllib.request.urlopen = fake_urlopen
        try:
            with self.assertRaises(RuntimeError):
                subproxy.profile_access_token(profile)
        finally:
            subproxy.urllib.request.urlopen = orig
        self.assertEqual(
            (Path(profile) / '.credentials.json').read_text(encoding='utf-8'),
            before)


if __name__ == '__main__':
    unittest.main()
