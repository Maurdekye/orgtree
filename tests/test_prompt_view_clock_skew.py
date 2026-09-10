"""Does a prompt-view row stamped AFTER its provider event still project?

chat_window._views.match_row accepts a row only when 0 <= event - stamp <= 300
(one-sided), while supervisor's own matcher uses abs(event - row) <= 300
(symmetric). A provider that stamps its user event even slightly earlier than
our sidecar write is therefore rejected by the gate before the symmetric
matcher ever sees it -- the row renders RAW and loses its `segments`, which is
where the mail id the desk needs to retire a pending bubble lives.
"""
import json, os, tempfile, unittest, uuid
from pathlib import Path
from unittest.mock import patch

fx = tempfile.TemporaryDirectory(prefix='opus-skew-')
os.environ['ORGTREE_DATA'] = str(Path(fx.name)/'data')
os.environ['HOME'] = str(Path(fx.name)/'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir(); Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'opus-skew-only'
for k in ('ORGTREE_V1_ROOT','ORGTREE_V1_DATA_ROOT','ORGTREE_V2_PORT'): os.environ.pop(k, None)
from engine.launch import load_app
load_app()
from orgtree import store, ledger, supervisor as sup, chat_window, transcript_records as records
assert Path(store.DATA_ROOT).resolve() == Path(os.environ['ORGTREE_DATA']).resolve()

slugs = []
def tearDownModule():
    for s in slugs: store._POOL.close_all(s)

SEGMENTS = [{'kind': 'mail', 'rows': [{'id': 'mail-abc', 'body': 'audience theme request'}]}]

class Skew(unittest.TestCase):
    def setUp(self):
        slug = 'skew-' + uuid.uuid4().hex[:8]; slugs.append(slug)
        self.org = store.create_org(slug)
        self.org.hire(ledger.USER, None, 'haiku', 0, 'agent')
        store.save_org(self.org)
        self.sid = self.org.node('agent')['session_id']
        self.path = Path(fx.name) / (slug + '.jsonl')
        self.path.write_bytes(b'')
        p = patch.object(sup, 'transcript_path', return_value=str(self.path)); p.start()
        self.addCleanup(p.stop)

    def run_case(self, view_at, event_at):
        sup._record_prompt_view(self.org.d['slug'], self.sid, 'RAW REQUEST BODY',
                                'audience theme request', at=view_at,
                                segments=SEGMENTS,
                                incarnation=records.incarnation(self.org, 'agent'))
        with self.path.open('a', encoding='utf-8') as f:
            f.write(json.dumps({'type':'user','uuid':'u-1','timestamp':event_at,
                                'message':{'role':'user','content':'RAW REQUEST BODY'}}) + '\n')
            f.write(json.dumps({'type':'assistant','uuid':'a-1','timestamp':event_at,
                                'message':{'id':'m-1','role':'assistant','content':'ok'}}) + '\n')
        return chat_window.read_window(self.org, 'agent', 8)['messages']

    def test_control_sidecar_written_one_second_BEFORE_the_event(self):
        rows = self.run_case('2026-09-10T12:00:00.000000Z', '2026-09-10T12:00:01.000000Z')
        self.assertEqual(rows[0]['text'], 'audience theme request',
                         'control: the ordinary ordering projects')
        self.assertEqual(rows[0].get('segments'), SEGMENTS,
                         'control: and carries the mail segments')

    def test_sidecar_written_one_second_AFTER_the_event_loses_the_projection(self):
        rows = self.run_case('2026-09-10T12:00:01.000000Z', '2026-09-10T12:00:00.000000Z')
        self.assertEqual(rows[0]['text'], 'audience theme request',
                         'a one-second clock skew must not lose the projection')
        self.assertEqual(rows[0].get('segments'), SEGMENTS,
                         'and must not lose the mail id the desk retires on')

    def test_sidecar_written_one_millisecond_AFTER_the_event(self):
        rows = self.run_case('2026-09-10T12:00:00.001000Z', '2026-09-10T12:00:00.000000Z')
        self.assertEqual(rows[0].get('segments'), SEGMENTS,
                         'a one-millisecond skew must not lose the mail segments')


class Buried(unittest.TestCase):
    """Once matched, does a mail-bearing row buried past the 8-row viewport
    still reach the desk with its segments, via the `before` cursor?"""
    def setUp(self):
        slug = 'buried-' + uuid.uuid4().hex[:8]; slugs.append(slug)
        self.org = store.create_org(slug)
        self.org.hire(ledger.USER, None, 'haiku', 0, 'agent')
        store.save_org(self.org)
        self.sid = self.org.node('agent')['session_id']
        self.path = Path(fx.name) / (slug + '.jsonl')
        self.path.write_bytes(b'')
        p2 = patch.object(sup, 'transcript_path', return_value=str(self.path)); p2.start()
        self.addCleanup(p2.stop)

    def test_buried_mail_row_is_reachable_by_paging_with_its_segments(self):
        sup._record_prompt_view(self.org.d['slug'], self.sid, 'RAW REQUEST BODY',
                                'audience theme request',
                                at='2026-09-10T12:00:00.000000Z', segments=SEGMENTS,
                                incarnation=records.incarnation(self.org, 'agent'))
        with self.path.open('a', encoding='utf-8') as f:
            f.write(json.dumps({'type':'user','uuid':'u-1',
                                'timestamp':'2026-09-10T12:00:01.000000Z',
                                'message':{'role':'user','content':'RAW REQUEST BODY'}}) + chr(10))
            for i in range(30):    # 'many streamed events' after the send
                f.write(json.dumps({'type':'assistant','uuid':'a-%d' % i,
                                    'timestamp':'2026-09-10T12:%02d:00.000000Z' % (i+1),
                                    'message':{'id':'m-%d' % i,'role':'assistant',
                                               'content':'reply %d' % i}}) + chr(10))
        win = chat_window.read_window(self.org, 'agent', 8)
        found = [r for r in win['messages'] if r.get('segments')]
        self.assertFalse(found, 'control: the mail row really is buried past the viewport')
        self.assertTrue(win['has_older'] and win['before'],
                        'control: the payload offers a cursor to page back with')
        page, guard, seen = win, 0, []
        while page.get('has_older') and page.get('before') and guard < 12:
            guard += 1
            page = chat_window.read_page(self.org, 'agent', 8, page['before'])
            seen = page['messages'] + seen
            if any(r.get('segments') for r in page['messages']):
                break
        carriers = [r for r in seen if r.get('segments')]
        self.assertTrue(carriers,
                        'paging back must reach the mail row so the desk can retire its bubble')
        self.assertEqual(carriers[0]['segments'], SEGMENTS)
        self.assertIsInstance(carriers[0].get('seq'), (int, float),
                              'and it must carry a seq the client can order on')


if __name__ == '__main__':
    unittest.main(verbosity=2)
