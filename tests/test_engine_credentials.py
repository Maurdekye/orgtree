import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

_root = tempfile.TemporaryDirectory(prefix='v2-credentials-')
os.environ['ORGTREE_DATA'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine' / 'backend'))
from orgtree import net

class HubCredentialTests(unittest.TestCase):
    def test_owner_requires_exact_runtime_loopback_endpoint(self):
        with patch.dict(os.environ, {'ORGTREE_V2_HUB_ADDRESS':'http://127.0.0.1:45678'}):
            hub = {'id':net.LOCAL_HUB_ID,'address':'http://127.0.0.1:45678','token':'owner'}
            self.assertEqual(net._hub_headers(hub, [])['X-Hub-Token'], 'owner')
            for address in ('http://remote.example:45678','http://127.0.0.1:45679', 'http://user@127.0.0.1:45678'):
                changed = {**hub,'address':address,'peer_token':'scoped'}
                headers = net._hub_headers(changed, [])
                self.assertNotIn('X-Hub-Token', headers)
                self.assertEqual(headers['X-Hub-Peer-Token'], 'scoped')
                grouped = net._group_headers({'org':{'hubs':[changed]}}, {'org':net.LOCAL_HUB_ID}, [])
                self.assertNotIn('X-Hub-Token', grouped)

if __name__ == '__main__': unittest.main()
