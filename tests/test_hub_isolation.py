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


class ProvingARoot(unittest.TestCase):
    """read_rig_hub / hub_status_problems: the proof a rig checks before
    (a stand-in engine) or after (an unmodified boot chain) the engine runs."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='hub-isolation-proof-')
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def test_an_isolated_root_reads_back_as_its_own_hub(self):
        hub = hub_isolation.isolate_data_root(self.root)
        self.assertEqual(hub_isolation.read_rig_hub(self.root), hub)

    def test_a_root_that_is_not_provably_isolated_is_refused(self):
        def rewrite(filename, **change):
            path = self.root / filename
            path.write_text(json.dumps({**json.loads(path.read_text(encoding='utf-8')), **change}),
                            encoding='utf-8')
        cases = {
            'no hub of its own': lambda: (self.root / 'mailhub-hosting.json').unlink(),
            'no explicit default': lambda: (self.root / 'defaults.json').unlink(),
            'the live port': lambda: rewrite('mailhub-hosting.json', port=7370),
            'the public listener port': lambda: rewrite('mailhub-hosting.json', port=7371),
            'a name that is not a rig name': lambda: rewrite('mailhub-hosting.json', name=''),
            'a public listener': lambda: rewrite('mailhub-hosting.json', public_listener=True),
            'a network bind': lambda: rewrite('mailhub-hosting.json', bind='0.0.0.0'),
            'a live default': lambda: rewrite('defaults.json', net_hub_address='127.0.0.1'),
            'an empty default': lambda: rewrite('defaults.json', net_hub_address=''),
        }
        for label, damage in cases.items():
            with self.subTest(label):
                for name in ('defaults.json', 'mailhub-hosting.json'):
                    (self.root / name).unlink(missing_ok=True)
                hub_isolation.isolate_data_root(self.root)
                damage()
                with self.assertRaises(RuntimeError):
                    hub_isolation.read_rig_hub(self.root)

    def test_the_status_must_name_the_rigs_hub(self):
        hub = {'address': 'http://127.0.0.1:51234', 'name': 'test-rig-abc'}
        good = {'address': hub['address'], 'hub_name': hub['name'], 'healthy': True}
        self.assertEqual(hub_isolation.hub_status_problems(good, hub), [])
        for label, change in {'another address': {'address': LIVE},
                              'another hub answering': {'hub_name': 'operator-hub'},
                              'no hub answering': {'healthy': False, 'hub_name': None}}.items():
            with self.subTest(label):
                self.assertNotEqual(hub_isolation.hub_status_problems({**good, **change}, hub), [])


class EnforcedInsideTheEngineProcess(unittest.TestCase):
    """enforce_isolated_root, run the way a stand-in engine runs it: loaded by
    path in a fresh interpreter before anything else."""

    CODE = ('import importlib.util, json, sys, urllib.request; '
            'spec = importlib.util.spec_from_file_location("hub_isolation", sys.argv[1]); '
            'h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h); '
            'hub = h.enforce_isolated_root(sys.argv[2]); '
            'print(json.dumps({"hub": hub, "guarded": getattr(urllib.request.OpenerDirector.open, '
            '"_hub_isolation_guard", False)}))')

    def run_child(self, root, **extra):
        env = {k: v for k, v in os.environ.items() if k not in ('PYTHONPATH', 'PYTHONHOME')}
        env.update(extra)
        return subprocess.run([sys.executable, '-I', '-c', self.CODE,
                               str(ROOT / 'tests' / 'hub_isolation.py'), str(root)],
                              env=env, capture_output=True, text=True, timeout=60)

    def test_an_isolated_root_boots_with_the_guard_installed(self):
        with tempfile.TemporaryDirectory(prefix='hub-isolation-enforce-') as tmp:
            hub = hub_isolation.isolate_data_root(Path(tmp))
            run = self.run_child(tmp)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(json.loads(run.stdout), {'hub': hub, 'guarded': True})

    def test_an_inherited_address_or_an_unprepared_root_refuses_to_boot(self):
        with tempfile.TemporaryDirectory(prefix='hub-isolation-enforce-') as tmp:
            run = self.run_child(tmp)
            self.assertNotEqual(run.returncode, 0)
            self.assertIn('not an isolated rig root', run.stderr)
            hub_isolation.isolate_data_root(Path(tmp))
            run = self.run_child(tmp, ORGTREE_LOCAL_HUB_ADDRESS=LIVE)
            self.assertNotEqual(run.returncode, 0)
            self.assertIn('inherited ORGTREE_LOCAL_HUB_ADDRESS', run.stderr)
            self.assertEqual(run.stdout, '')


class NodeTwinMatches(unittest.TestCase):
    """tests/hub_isolation.mjs carries the same constants (read from source:
    this suite must not depend on a Node binary)."""

    def test_the_constants_are_the_same(self):
        import re
        source = (ROOT / 'tests' / 'hub_isolation.mjs').read_text(encoding='utf-8')

        def const(name):
            match = re.search(rf"export const {name} = (?:Object\.freeze\()?(.+?)\)?\n", source)
            self.assertIsNotNone(match, name)
            return json.loads(match.group(1).replace("'", '"'))
        self.assertEqual(sorted(const('LIVE_HUB_PORTS')), sorted(hub_isolation.LIVE_HUB_PORTS))
        self.assertEqual(const('UNROUTABLE_HUB_ADDRESS'), hub_isolation.UNROUTABLE_HUB_ADDRESS)
        self.assertEqual(tuple(const('INHERITED_HUB_ENV')), hub_isolation.INHERITED_HUB_ENV)
        self.assertEqual(const('RIG_HUB_PREFIX'), hub_isolation.RIG_HUB_PREFIX)


class EveryRealEngineRigIsIsolated(unittest.TestCase):
    """THE AUDIT. A real hub starts only in ``launch.main()``, which is reached
    by calling it, by spawning the real ``engine/launch.py`` or
    ``engine/service_host.py``, or by an Electron entry that spawns the app's
    launcher. Every file under tests/ that does one of those must use the
    isolation helpers, delegate to a file that does, or be listed below with
    the reason it boots no hub. A new rig that does none of these fails here
    instead of quietly registering fixtures on the operator's hub."""

    BOOT = (r"\blaunch\.main\(\)|engine['\"]?\s*/\s*['\"](?:launch|service_host)\.py"
            r"|engine[/\\]+(?:launch|service_host)\.py|service_host\.reviewed\.py"
            r"|endsWith\(['\"]launch\.py['\"]\)|\bh\.main\(\)|service_host\.main\(\)"
            r"|MailhubRuntime\(")
    ISOLATED = r"hub_isolation|isolatedRoot\("
    # stand-ins that exec another stand-in's source (which enforces) first
    DELEGATES = {
        'tests/acceptance/maintenance_engine.py': 'visual_engine.py',
        'tests/acceptance/management_engine.py': 'visual_engine.py',
        'tests/acceptance/lifecycle_engine.py': 'maintenance_engine.py',
        'tests/acceptance/unstick_engine.py': 'maintenance_engine.py',
        'tests/acceptance/artifacts_engine.py': 'maintenance_engine.py',
    }
    ELECTRON_ENTRY = ('boots through the app its acceptance runner (tests/acceptance/run*.mjs) '
                      'starts on an isolatedRoot() checked by assertIsolatedEnvironment()')
    EXEMPT = {
        'tests/acceptance/application.cjs': ELECTRON_ENTRY,
        'tests/acceptance/artifacts.cjs': ELECTRON_ENTRY,
        'tests/acceptance/connections.cjs': ELECTRON_ENTRY,
        'tests/acceptance/history.cjs': ELECTRON_ENTRY,
        'tests/acceptance/lifecycle.cjs': ELECTRON_ENTRY,
        'tests/acceptance/maintenance.cjs': ELECTRON_ENTRY,
        'tests/acceptance/management.cjs': ELECTRON_ENTRY,
        'tests/acceptance/relaunch.cjs': ELECTRON_ENTRY,
        'tests/acceptance/unstick.cjs': ELECTRON_ENTRY,
        'tests/attach.test.mjs': 'reads service_host.py source; its engines are stub launchers',
        'tests/dev-install.test.mjs': 'names engine/launch.py in a package manifest only',
        'tests/release-windows.test.mjs': 'names engine/launch.py in release manifests only',
        'tests/traylist-wiring.test.mjs': 'reads engine/launch.py source only',
        'tests/paired-boot-preparation.test.ps1': 'reads the host source and runs the shim with '
                                                  'run_path stubbed; it asserts the shim isolates',
        'tests/prepare-boot-paired-snapshot.cjs': 'copies files into a snapshot; boots nothing',
        'tests/test_mailhub_runtime.py': 'starts MailhubRuntime only on its own TEST_PORT',
        'tests/test_python_verification_runner.py': 'writes a one-line fixture launch.py',
        'tests/test_startup_progress.py': 'runs service_host.main against a stub launch.py',
    }

    def files(self):
        for path in sorted((ROOT / 'tests').rglob('*')):
            if (path.suffix in ('.py', '.mjs', '.cjs', '.js', '.ps1')
                    and 'node_modules' not in path.parts and '__pycache__' not in path.parts):
                yield path.relative_to(ROOT).as_posix(), path.read_text(encoding='utf-8', errors='replace')

    def test_no_real_engine_rig_skips_the_isolation(self):
        import re
        boots, missing = set(), []
        for name, text in self.files():
            if not re.search(self.BOOT, text):
                continue
            boots.add(name)
            if name in self.EXEMPT or name in self.DELEGATES:
                continue
            if not re.search(self.ISOLATED, text):
                missing.append(name)
        self.assertEqual(missing, [], 'these files boot a real engine without hub isolation')
        stale = sorted(set(self.EXEMPT) - boots)
        self.assertEqual(stale, [], 'exemptions for files that no longer boot anything')

    def test_stand_in_engines_enforce_before_the_engine_is_imported(self):
        import re
        for name, text in self.files():
            if ('launch.main()' not in text or name in self.DELEGATES
                    or name in ('tests/hub_isolation.py', 'tests/test_hub_isolation.py')):
                continue
            with self.subTest(name):
                enforce = text.find('enforce_isolated_root(')
                imported = re.search(r"^\s*(?:from engine import launch|import launch)\b", text, re.M)
                self.assertGreater(enforce, -1, 'a stand-in engine must call enforce_isolated_root')
                self.assertIsNotNone(imported)
                self.assertLess(enforce, imported.start())
        for name, target in self.DELEGATES.items():
            with self.subTest(name):
                # follow the chain (lifecycle -> maintenance -> visual) to the
                # stand-in that enforces
                seen = [name]
                while True:
                    text = (ROOT / seen[-1]).read_text(encoding='utf-8')
                    self.assertIn(target, text)
                    self.assertIn('exec(', text)
                    seen.append(str(Path(seen[-1]).with_name(target).as_posix()))
                    if seen[-1] not in self.DELEGATES:
                        break
                    target = self.DELEGATES[seen[-1]]
                self.assertIn('enforce_isolated_root(', (ROOT / seen[-1]).read_text(encoding='utf-8'))

    def test_acceptance_runners_build_their_roots_through_the_isolation(self):
        isolation = (ROOT / 'tests' / 'acceptance' / 'isolation.mjs').read_text(encoding='utf-8')
        self.assertIn("isolateDataRoot(path.join(root, 'data'))", isolation)
        self.assertIn('scrubInheritedHub(env)', isolation)
        self.assertIn('readRigHub(env.ORGTREE_V2_DATA)', isolation)
        runners = sorted((ROOT / 'tests' / 'acceptance').glob('run*.mjs'))
        self.assertTrue(runners)
        for runner in runners:
            with self.subTest(runner.name):
                text = runner.read_text(encoding='utf-8')
                self.assertIn('isolatedRoot(', text)
                self.assertIn('assertIsolatedEnvironment(', text)


if __name__ == '__main__':
    unittest.main()
