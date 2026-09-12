"""Installation-wide mailhub administration, owned by App Settings.

One Orgtree installation hosts at most one hub, so its hosting configuration
and the list of organizations allowed to connect to it are properties of the
installation. These exercise the real HubRuntime and the real desktop routes
that App Settings drives, with a real hub process and real credentials: an
operator grants, replaces and revokes access without any organization being
selected, and everything an earlier version stored keeps working.

Nothing here changes authentication: the token is still minted by the hub, the
admission check is still a stored fingerprint, and a grant is still bound to
exactly one organization address.
"""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

_temp = tempfile.TemporaryDirectory(prefix='v2-hub-appsettings-')
os.environ['ORGTREE_DATA'] = _temp.name
os.environ['HOME'] = _temp.name
os.environ['USERPROFILE'] = _temp.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine' / 'backend'))
from engine.hub import HubClient, HubClientError, PeerIdInUse, UnknownPeer
from engine.hub_runtime import HubRuntime


def tearDownModule():
    _temp.cleanup()


class _Runtime:
    """A started HubRuntime over its own private root."""

    def __init__(self, folder):
        self.folder = Path(folder)
        self.runtime = HubRuntime(self.folder)
        self.runtime.start()

    def client(self, slug, secret, token):
        return HubClient(self.folder, os.environ['ORGTREE_V2_HUB_ADDRESS'],
                         slug, secret, token, peer_token=True)


class InstallationGrantTests(unittest.TestCase):
    def test_grants_are_administered_without_an_organization_being_selected(self):
        with tempfile.TemporaryDirectory(prefix='v2-grants-') as folder:
            host = _Runtime(folder)
            runtime = host.runtime
            try:
                self.assertEqual(runtime.peers()['peers'], [])

                details = runtime.issue_peer('research-grant', 'research.user.a3f9c1')
                # The package is shape-identical to what the per-organization
                # invitation route has always produced, so details created
                # before this move still import into the same Connect form.
                self.assertEqual(details['version'], 1)
                self.assertEqual(details['peer_id'], 'research-grant')
                self.assertEqual(details['slug'], 'research.user.a3f9c1')
                self.assertEqual(details['peer_slug'], 'research.user.a3f9c1')
                self.assertTrue(details['address'].startswith('http'))
                first_token = details['peer_token']
                self.assertNotEqual(first_token, runtime.ready.token)

                listed = runtime.peers()['peers']
                self.assertEqual([p['peer_id'] for p in listed], ['research-grant'])
                self.assertEqual(listed[0]['slug'], 'research.user.a3f9c1')
                self.assertTrue(listed[0]['allowed'])
                self.assertIsNone(listed[0]['revoked_at'])
                # Listing an organization must never re-expose its secret.
                self.assertNotIn(first_token, json.dumps(runtime.peers()))

                # The grant admits exactly the organization it names.
                host.client('research.user.a3f9c1', 'research-secret',
                            first_token).register(org_name='Research')
                with self.assertRaises(HubClientError):
                    host.client('other.user.zzzzzz', 'other-secret',
                                first_token).register(org_name='Other')

                # Replacement keeps the identifier and the binding and puts a
                # new secret behind them; the old secret stops working at once.
                replaced = runtime.replace_peer('research-grant')
                self.assertEqual(replaced['peer_id'], 'research-grant')
                self.assertEqual(replaced['slug'], 'research.user.a3f9c1')
                self.assertNotEqual(replaced['peer_token'], first_token)
                host.client('research.user.a3f9c1', 'research-secret',
                            replaced['peer_token']).register(org_name='Research')
                with self.assertRaises(HubClientError):
                    host.client('research.user.a3f9c1', 'research-secret',
                                first_token).register(org_name='Research')

                # Revocation is the host withdrawing admission.
                self.assertEqual(runtime.revoke_peer('research-grant'),
                                 {'revoked': True, 'peer_id': 'research-grant'})
                self.assertFalse(runtime.revoke_peer('research-grant')['revoked'])
                with self.assertRaises(HubClientError):
                    host.client('research.user.a3f9c1', 'research-secret',
                                replaced['peer_token']).register(org_name='Research')
                revoked = runtime.peers()['peers'][0]
                self.assertFalse(revoked['allowed'])
                self.assertIsNotNone(revoked['revoked_at'])

                with self.assertRaises(PeerIdInUse):
                    runtime.issue_peer('research-grant', 'research.user.a3f9c1')
                with self.assertRaises(UnknownPeer):
                    runtime.replace_peer('never-granted')
            finally:
                runtime.stop()

    def test_existing_hosting_configuration_and_grants_survive_a_restart(self):
        with tempfile.TemporaryDirectory(prefix='v2-carryover-') as folder:
            root = Path(folder)
            # Exactly what a build BEFORE this move persisted: one
            # installation-level file, written while the same controls lived
            # in an organization's settings.
            (root / 'desktop-hub.json').write_text(json.dumps({
                'version': 1, 'enabled': True, 'bind_host': '127.0.0.1',
                'port': 0, 'advertise_host': 'carried.example'}), encoding='utf-8')
            host = _Runtime(root)
            try:
                status = host.runtime.status()
                self.assertTrue(status['enabled'])
                self.assertEqual(status['advertise_host'], 'carried.example')
                self.assertTrue(status['status']['ready'])
                details = host.runtime.issue_peer('carried-grant', 'carried.user.aaaaaa')
                # A save with no edits, which is what pins the chosen port.
                host.runtime.configure({})
                token, port = details['peer_token'], host.runtime.ready.port
                host.runtime.stop()
            except BaseException:
                host.runtime.stop()
                raise

            # Restart: no re-entry of hosting settings, no re-issue of grants.
            again = _Runtime(root)
            try:
                status = again.runtime.status()
                self.assertTrue(status['enabled'])
                self.assertEqual(status['advertise_host'], 'carried.example')
                self.assertEqual(again.runtime.ready.port, port)
                self.assertEqual([p['peer_id'] for p in again.runtime.peers()['peers']],
                                 ['carried-grant'])
                again.client('carried.user.aaaaaa', 'carried-secret',
                             token).register(org_name='Carried')
                # The stored file is still the same single installation-level
                # document, not a per-organization one.
                stored = json.loads((root / 'desktop-hub.json').read_text())
                self.assertEqual(stored['version'], 1)
                self.assertEqual(stored['advertise_host'], 'carried.example')
                self.assertNotIn('slug', stored)
                self.assertNotIn('org', stored)
            finally:
                again.runtime.stop()

    def test_desktop_routes_expose_grants_and_reject_malformed_administration(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from orgtree import api
        import engine.launch as launch

        with tempfile.TemporaryDirectory(prefix='v2-routes-') as folder:
            host = _Runtime(folder)
            app = FastAPI()
            previous = launch._HUB_RUNTIME
            launch._HUB_RUNTIME = host.runtime
            try:
                launch._install_desktop_routes(app, Path(folder), lambda: None,
                                               api.__file__)
                client = TestClient(app)

                self.assertEqual(client.get('/api/desktop/hub/peers').json(),
                                 {'version': 1, 'address': host.runtime.advertised_address(),
                                  'peers': []})

                created = client.post('/api/desktop/hub/peers',
                                      json={'peer_id': 'route-grant', 'slug': 'route.user.aaaaaa'})
                self.assertEqual(created.status_code, 200, created.text)
                token = created.json()['peer_token']
                host.client('route.user.aaaaaa', 'route-secret', token).register(org_name='Route')

                self.assertEqual([p['peer_id'] for p in
                                  client.get('/api/desktop/hub/peers').json()['peers']],
                                 ['route-grant'])
                self.assertEqual(client.post('/api/desktop/hub/peers',
                                             json={'peer_id': 'route-grant',
                                                   'slug': 'route.user.aaaaaa'}).status_code, 409)
                self.assertEqual(client.post('/api/desktop/hub/peers',
                                             json={'peer_id': 'bad id!', 'slug': 'route.user.aaaaaa'}
                                             ).status_code, 422)
                self.assertEqual(client.post('/api/desktop/hub/peers',
                                             json={'peer_id': 'ok', 'slug': 'Not A Slug'}
                                             ).status_code, 422)
                self.assertEqual(client.post('/api/desktop/hub/peers/never-granted/replace'
                                             ).status_code, 404)

                replaced = client.post('/api/desktop/hub/peers/route-grant/replace')
                self.assertEqual(replaced.status_code, 200, replaced.text)
                self.assertNotEqual(replaced.json()['peer_token'], token)

                self.assertEqual(client.delete('/api/desktop/hub/peers/route-grant').json(),
                                 {'revoked': True, 'peer_id': 'route-grant'})
                with self.assertRaises(HubClientError):
                    host.client('route.user.aaaaaa', 'route-secret',
                                replaced.json()['peer_token']).register(org_name='Route')

                # No hub runtime is a 503, not a traceback.
                launch._HUB_RUNTIME = None
                self.assertEqual(client.get('/api/desktop/hub/peers').status_code, 503)
                self.assertEqual(client.delete('/api/desktop/hub/peers/route-grant').status_code, 503)
                self.assertEqual(client.post('/api/desktop/hub/peers',
                                             json={'peer_id': 'x', 'slug': 'x.user.aaaaaa'}
                                             ).status_code, 503)
            finally:
                launch._HUB_RUNTIME = previous
                host.runtime.stop()


if __name__ == '__main__':
    unittest.main()
