import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from starlette.requests import Request
from fastapi import HTTPException

_temp = tempfile.TemporaryDirectory(prefix='v2-hub-api-')
os.environ['ORGTREE_DATA'] = _temp.name
os.environ['HOME'] = _temp.name
os.environ['USERPROFILE'] = _temp.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine' / 'backend'))
from engine.hub_runtime import HubRuntime
from orgtree import api, store, net

def tearDownModule():
    for slug in ('host-org','client-org'):
        store._POOL.close_all(slug)
    _temp.cleanup()

class HubAPITests(unittest.TestCase):
    def test_tls_runtime_owner_client_and_sanitized_config(self):
        from datetime import datetime, timedelta
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
        from engine.hub_runtime import validate_config
        with tempfile.TemporaryDirectory(prefix='v2-tls-') as folder:
            root = Path(folder)
            key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'advertised.example')])
            cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
                    .public_key(key.public_key()).serial_number(x509.random_serial_number())
                    .not_valid_before(datetime.utcnow()-timedelta(minutes=1))
                    .not_valid_after(datetime.utcnow()+timedelta(days=1))
                    .sign(key, hashes.SHA256()))
            cp, kp = root/'cert.pem', root/'key.pem'
            cp.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
            kp.write_bytes(key.private_bytes(serialization.Encoding.PEM,
                serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
            with self.assertRaises(ValueError):
                validate_config({'enabled':True,'bind_host':'0.0.0.0','advertise_host':'host.example'})
            runtime = HubRuntime(root)
            runtime.start()
            try:
                status = runtime.configure({'version':1,'enabled':True,'bind_host':'127.0.0.1',
                    'port':0,'advertise_host':'advertised.example','tls_certfile':str(cp),
                    'tls_keyfile':str(kp),'tls_ca_file':str(cp)})
                self.assertTrue(status['tls_configured'])
                self.assertNotIn(str(kp), json.dumps(status))
                address = os.environ['ORGTREE_V2_HUB_ADDRESS']
                self.assertTrue(address.startswith('https://127.0.0.1:'))
                from engine.hub import HubClient
                owner = HubClient(root, address, 'tls.fixture', 'test-secret', runtime.ready.token, ca_file=cp)
                owner.register()
                headers = {'X-Hub-Token':runtime.ready.token, 'X-Org-Auth':'tls.fixture:test-secret'}
                with net._client() as client:
                    response = client.get(address+'/api/roster', headers=headers)
                    self.assertEqual(response.status_code, 200)
                with patch.dict(os.environ, {'ORGTREE_V2_HUB_CA_FILE':''}):
                    with net._client() as client, self.assertRaises(Exception):
                        client.get(address+'/api/roster',headers=headers)
            finally:
                runtime.stop()

    def test_runtime_config_and_actual_scoped_pairing(self):
        runtime = HubRuntime(_temp.name)
        runtime.start()
        request = Request({'type':'http', 'headers':[], 'state':{}})
        try:
            cfg = runtime.configure({'version':1,'enabled':True,'bind_host':'127.0.0.1',
                                     'advertise_host':'127.0.0.1','port':0})
            self.assertTrue(cfg['status']['ready'])
            self.assertNotIn(runtime.ready.token, json.dumps(cfg))
            for slug in ('host-org','client-org'):
                org = store.create_org(slug)
                net.mint_identity(org)
                org.d['net_hubs'] = []
                store.save_org(org)
            ident = store.load_org('client-org').d['net_identity']
            invitation = api.create_net_invitation('host-org', api.NetInvitation(
                peer_id='connection',peer_slug=ident['slug']), request)
            self.assertNotEqual(invitation['peer_token'], runtime.ready.token)
            paired = api.pair_net_hub('client-org', api.NetPairing(
                address=invitation['address'],peer_id='connection',
                peer_slug=ident['slug'],peer_token=invitation['peer_token']), request)
            self.assertTrue(paired['paired'])
            with patch('engine.hub.HubClient') as transport:
                with self.assertRaises(HTTPException) as caught:
                    api.pair_net_hub('client-org', api.NetPairing(
                        address='http://remote.example:7370', peer_id='remote',
                        peer_slug=ident['slug'], peer_token=invitation['peer_token']), request)
                self.assertEqual(caught.exception.status_code, 422)
                self.assertIn('require HTTPS', caught.exception.detail)
                transport.assert_not_called()
            public = api.org_net('client-org', request)
            self.assertNotIn(invitation['peer_token'], json.dumps(public))
            self.assertNotIn(ident['secret'], json.dumps(public))
            with self.assertRaises(HTTPException) as caught:
                api.pair_net_hub('client-org', api.NetPairing(address=invitation['address'],
                    peer_id='wrong',peer_slug='forged',peer_token=invitation['peer_token']), request)
            self.assertEqual(caught.exception.status_code, 422)
            api.revoke_net_invitation('host-org', 'connection', request)
            with self.assertRaises(HTTPException) as caught:
                api.pair_net_hub('client-org', api.NetPairing(address=invitation['address'],
                    peer_id='connection',peer_slug=ident['slug'],peer_token=invitation['peer_token']), request)
            self.assertEqual(caught.exception.status_code, 502)
            saved_port = runtime.ready.port
            runtime.stop()
            runtime = HubRuntime(_temp.name)
            runtime.start()
            self.assertEqual(runtime.ready.port, saved_port)
        finally:
            runtime.stop()

if __name__ == '__main__': unittest.main()
