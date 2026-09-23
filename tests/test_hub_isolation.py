"""Test rigs cannot reach the operator's real mail hub (tests/hub_isolation.py).

Nothing here opens a socket to a hub: every request aimed at a live hub port
goes through a mock transport or a recording opener, so even a BROKEN guard
cannot touch the real hub; it can only fail these assertions.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import urllib.request

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import hub_isolation

ROOT = Path(__file__).resolve().parents[1]
LIVE = 'http://127.0.0.1:7370'
# Every hub route a client uses: registration, the long poll that reconnects,
# send, receipts, cleanup (unregister), the roster and the health check.
HUB_ROUTES = ('/api/register', '/api/poll', '/api/ack', '/api/send', '/api/receipts',
              '/api/unregister', '/api/roster', '/healthz')


class ConstantsMatchTheEngine(unittest.TestCase):
    def test_live_ports_and_dead_address_are_the_engines(self):
        from orgtree import net
        from engine import mailhub_runtime
        self.assertIn(net.DEFAULT_HUB_PORT, hub_isolation.LIVE_HUB_PORTS)
        self.assertIn(mailhub_runtime.PUBLIC_LISTENER_PORT, hub_isolation.LIVE_HUB_PORTS)
        self.assertEqual(hub_isolation.UNROUTABLE_HUB_ADDRESS, net.UNROUTABLE_HUB_ADDRESS)
        self.assertEqual(hub_isolation.INHERITED_HUB_ENV, import_provenance.INHERITED_HUB_ENV)

    def test_the_runner_scrubs_the_inherited_hub_address(self):
        source = (ROOT / 'tools' / 'run-python-verification.py').read_text(encoding='utf-8')
        for key in hub_isolation.INHERITED_HUB_ENV:
            self.assertIn(f'"{key}",', source)


class InheritedAddress(unittest.TestCase):
    def test_this_process_does_not_carry_it(self):
        for key in hub_isolation.INHERITED_HUB_ENV:
            self.assertNotIn(key, os.environ)

    def test_importing_the_provenance_guard_removes_it(self):
        env = {k: v for k, v in os.environ.items() if k not in ('PYTHONPATH', 'PYTHONHOME')}
        env['ORGTREE_LOCAL_HUB_ADDRESS'] = LIVE
        # The bundled runtime's ._pth lists the MAIN checkout; put this one first,
        # exactly as the runner does, or the provenance guard refuses the child.
        code = ('import os, sys; sys.path[:0] = sys.argv[1:]; import import_provenance; '
                'print(repr(os.environ.get("ORGTREE_LOCAL_HUB_ADDRESS")))')
        roots = [ROOT / 'tests', ROOT / 'engine' / 'backend', ROOT]
        run = subprocess.run([sys.executable, '-I', '-c', code, *map(str, roots)],
                             env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout.strip(), 'None')

    def test_scrub_reports_what_it_removed(self):
        env = {'ORGTREE_LOCAL_HUB_ADDRESS': LIVE, 'KEEP': '1'}
        self.assertEqual(hub_isolation.scrub_inherited_hub(env), ['ORGTREE_LOCAL_HUB_ADDRESS'])
        self.assertEqual(env, {'KEEP': '1'})
        self.assertEqual(hub_isolation.scrub_inherited_hub(env), [])


class Addresses(unittest.TestCase):
    def test_live_ports_are_recognised_however_they_are_spelled(self):
        for address in ('http://127.0.0.1:7370', 'http://localhost:7370/api/register',
                        '127.0.0.1', 'hub.lan', 'http://hub.lan', 'http://0.0.0.0:7371/healthz',
                        'http://[::1]:7370/api/poll'):
            self.assertTrue(hub_isolation.is_live_hub_address(address), address)
        for address in ('http://127.0.0.1:9', 'http://127.0.0.1:51234/api/register',
                        'https://quiet-hub.trycloudflare.com', '', 'http://[bad'):
            self.assertFalse(hub_isolation.is_live_hub_address(address), address)

    def test_bare_addresses_read_the_way_the_engine_reads_them(self):
        from orgtree import net
        for address in ('127.0.0.1', 'hub.lan', 'hub.lan:7411', 'http://hub.lan',
                        'https://quiet-hub.trycloudflare.com'):
            self.assertEqual(hub_isolation.hub_port(address),
                             hub_isolation.hub_port(net.normalize_hub_address(address)), address)

    def test_free_port_is_never_a_live_one(self):
        for _ in range(20):
            self.assertNotIn(hub_isolation.free_port(), hub_isolation.LIVE_HUB_PORTS)


class IsolatedDataRoot(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='hub-isolation-')
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def test_rig_root_gets_a_dead_default_and_its_own_hub(self):
        hub = hub_isolation.isolate_data_root(self.root)
        self.assertNotIn(hub['port'], hub_isolation.LIVE_HUB_PORTS)
        self.assertTrue(hub['name'].startswith(hub_isolation.RIG_HUB_PREFIX))
        self.assertEqual(json.loads((self.root / 'defaults.json').read_text(encoding='utf-8')),
                         {'net_hub_address': hub_isolation.UNROUTABLE_HUB_ADDRESS})
        # the engine's own config reader accepts the file unchanged
        from engine.mailhub_runtime import MailhubRuntime
        runtime = MailhubRuntime(self.root)
        self.assertEqual(runtime.config['port'], hub['port'])
        self.assertEqual(runtime.config['name'], hub['name'])
        self.assertEqual(runtime.config['bind'], '127.0.0.1')
        self.assertFalse(runtime.config['public_listener'])
        self.assertEqual(runtime._address(), hub['address'])

    def test_the_engine_resolves_the_rig_root_to_the_rig_hub_or_nowhere(self):
        from orgtree import net, store
        hub = hub_isolation.isolate_data_root(self.root)
        previous = store.DATA_ROOT
        store.DATA_ROOT = str(self.root)
        try:
            os.environ.pop('ORGTREE_LOCAL_HUB_ADDRESS', None)
            self.assertEqual(net._default_address(), hub_isolation.UNROUTABLE_HUB_ADDRESS)
            # the explicit dead default outranks even an inherited live address
            os.environ['ORGTREE_LOCAL_HUB_ADDRESS'] = LIVE
            self.assertEqual(net._default_address(), hub_isolation.UNROUTABLE_HUB_ADDRESS)
        finally:
            os.environ.pop('ORGTREE_LOCAL_HUB_ADDRESS', None)
            store.DATA_ROOT = previous
        self.assertFalse(hub_isolation.is_live_hub_address(hub['address']))

    def test_a_configured_root_is_refused_not_overwritten(self):
        for name in ('defaults.json', 'mailhub-hosting.json'):
            with self.subTest(name=name):
                root = self.root / name.split('.')[0]
                root.mkdir()
                (root / name).write_text('{"kept": true}', encoding='utf-8')
                with self.assertRaises(RuntimeError):
                    hub_isolation.isolate_data_root(root)
                self.assertEqual((root / name).read_text(encoding='utf-8'), '{"kept": true}')


class TransportGuard(unittest.TestCase):
    def setUp(self):
        import httpx
        self.httpx = httpx
        saved = (httpx.Client.send, urllib.request.OpenerDirector.open)

        def restore():
            httpx.Client.send, urllib.request.OpenerDirector.open = saved
        self.addCleanup(restore)
        self.reported = []
        hub_isolation.install_transport_guard(self.reported.append)
        hub_isolation.install_transport_guard(self.reported.append)   # idempotent

    def test_every_hub_route_on_a_live_port_is_refused_before_sending(self):
        sent = []

        def handler(request):
            sent.append(str(request.url))
            return self.httpx.Response(200, json={})
        client = self.httpx.Client(transport=self.httpx.MockTransport(handler))
        for base in ('http://127.0.0.1:7370', 'http://localhost:7371', 'http://hub.lan'):
            for route in HUB_ROUTES:
                with self.subTest(url=base + route):
                    with self.assertRaises(hub_isolation.LiveHubRefused):
                        client.post(base + route, json={})
        self.assertEqual(sent, [], 'a refused request must never reach the transport')
        self.assertEqual(len(self.reported), 3 * len(HUB_ROUTES))
        # the rig's own hub and the dead default still go through
        client.post('http://127.0.0.1:51234/api/register', json={})
        client.post(hub_isolation.UNROUTABLE_HUB_ADDRESS + '/api/register', json={})
        self.assertEqual(len(sent), 2)

    def test_a_refusal_reads_as_an_unreachable_hub(self):
        self.assertTrue(issubclass(hub_isolation.LiveHubRefused, ConnectionRefusedError))

    def test_urllib_health_checks_are_refused_too(self):
        opened = []

        class Recording(urllib.request.BaseHandler):
            def http_open(self, request):
                opened.append(request.full_url)
                raise AssertionError('reached the transport')
        opener = urllib.request.OpenerDirector()
        opener.add_handler(Recording())
        for url in (LIVE + '/healthz', urllib.request.Request('http://localhost:7371/healthz')):
            with self.assertRaises(hub_isolation.LiveHubRefused):
                opener.open(url)
        self.assertEqual(opened, [])
        self.assertEqual(self.reported, [LIVE + '/healthz', 'http://localhost:7371/healthz'])


if __name__ == '__main__':
    unittest.main()
