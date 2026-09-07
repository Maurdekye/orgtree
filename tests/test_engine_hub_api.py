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
