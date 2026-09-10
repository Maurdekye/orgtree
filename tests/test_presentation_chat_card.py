import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

_root = tempfile.TemporaryDirectory(prefix='presentation-chat-')
os.environ.update(ORGTREE_DATA=_root.name, HOME=_root.name, USERPROFILE=_root.name)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine/backend'))
from orgtree import store, ledger, supervisor
assert Path(store.DATA_ROOT).resolve() == Path(_root.name).resolve()


class PresentationChatTests(unittest.TestCase):
    def test_real_transcript_projection_accepts_success_only_on_both_tool_names(self):
        org = store.create_org('presentation-chat')
        org.hire(ledger.USER, None, 'haiku', 0, 'worker')
        records = []
        for i, (name, failed) in enumerate([
            ('orgtree_present', False), ('mcp__orgtree__orgtree_present', False),
            ('orgtree_present', True), ('another_tool', False),
        ]):
            records.extend([
                {'type':'assistant','message':{'role':'assistant','content':[
                    {'type':'tool_use','id':str(i),'name':name,'input':{'title':'Proposal'}}]}},
                {'type':'user','message':{'role':'user','content':[
                    {'type':'tool_result','tool_use_id':str(i),'is_error':failed,
                     'content':json.dumps({'presented':f'd{i}','title':'Proposal'})}]}},
            ])
        result = supervisor._read_chat_source(org, 'worker', hold_back=False,
            _path=Path(_root.name)/'fixture.jsonl', _lines=[json.dumps(r)+'\n' for r in records], _prompt_views={})
        chips = [t for m in result['messages'] for t in m.get('tools', [])]
        self.assertEqual(len(chips), 4)
        self.assertEqual([t['presentation']['id'] for t in chips if 'presentation' in t], ['d0','d1'])
        store._POOL.close_all('presentation-chat')


if __name__ == '__main__':
    unittest.main()
