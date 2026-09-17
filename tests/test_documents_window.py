"""The presented-documents list endpoint as a WINDOW, not a page.

`canvas/gallery.tsx` no longer offers "Newer"/"Older": it reads the newest-first
list from offset 0 and grows `limit` as the reader scrolls, so every response is
a complete PREFIX of the gallery and the rows already on screen come back
identical.  That only works if the endpoint will serve a window larger than one
page, which is what the old `min(limit, 100)` clamp forbade.

What each case would catch, since each fails for a different reason:
  * the DEFAULT is unchanged — any caller that sends no `limit` still gets 100,
    and `locate` still snaps to the 100-row page it always did (the renderer is
    not the only reader of this route, and `test_desktop_notifications` pins
    that exact offset).
  * a window LARGER than a page is actually served, and `next_offset` closes
    once it covers the list — the growth's stop condition.
  * a window larger than the ceiling is clamped TO THE CEILING rather than back
    down to 100, and says so through `next_offset`, so the client's
    "short answer means stop" guard is reachable instead of spinning.
  * `locate` is answered relative to the REQUESTED window, so a jump lands
    inside a prefix read from zero rather than on a detached middle slice.

Run:  python -B -m unittest tests.test_documents_window -v
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

_temp = tempfile.TemporaryDirectory(prefix='v2-documents-window-')
data = Path(_temp.name) / 'data'; data.mkdir()
home = Path(_temp.name) / 'home'; home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app  # noqa: E402

app, *_ = load_app()

from orgtree import store  # noqa: E402
from orgtree.api import DOCUMENTS_MAX_WINDOW  # noqa: E402
from orgtree.ledger import USER  # noqa: E402

_orgs: list[str] = []
HEADERS = {'X-Orgtree-Desktop-Token': 'operator'}


def stamp(i: int) -> str:
    """`d{i}` is presented at second `i`, so a higher index is NEWER."""
    hour, rest = divmod(i, 3600)
    minute, second = divmod(rest, 60)
    return f'2026-09-12T{hour:02}:{minute:02}:{second:02}Z'


def fixture_org(slug: str, documents: int):
    org = store.create_org(slug)
    _orgs.append(slug)
    org.hire(USER, None, 'haiku', 0, 'agent', charter='fixture')
    org.d['documents'] = [
        {'id': f'd{i}', 'node': 'agent', 'title': f'Plan {i}',
         'at': stamp(i), 'body': 'Plan body'}
        for i in range(documents)
    ]
    store.save_org(org)
    return org


def at_position(total: int, position: int) -> str:
    """The id the gallery puts at `position`. The list is NEWEST FIRST and the
    fixture is written oldest first, so the two run opposite ways — spelling
    that out here keeps every expectation below readable."""
    return f'd{total - 1 - position}'


def tearDownModule():
    for slug in _orgs:
        store._POOL.close_all(slug)
    _temp.cleanup()


class DocumentsWindowTests(unittest.TestCase):
    def get(self, slug: str, query: str = ''):
        response = TestClient(app).get(
            f'/api/orgs/{slug}/documents{query}', headers=HEADERS)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_default_limit_is_unchanged(self):
        """No `limit` still means one hundred rows — this route has readers
        other than the gallery, and the default is not what changed."""
        fixture_org('window-default', 250)
        page = self.get('window-default')
        self.assertEqual(len(page['documents']), 100)
        self.assertEqual(page['total'], 250)
        self.assertEqual(page['offset'], 0)
        self.assertEqual(page['next_offset'], 100)
        self.assertEqual(page['documents'][0]['id'], at_position(250, 0), 'newest first')

    def test_a_window_larger_than_a_page_is_served_whole(self):
        """The growth step: one request covering everything already read plus
        the next page, answered as one prefix."""
        fixture_org('window-grow', 250)
        page = self.get('window-grow', '?offset=0&limit=160')
        self.assertEqual(len(page['documents']), 160)
        self.assertEqual([r['id'] for r in page['documents'][:3]],
                         [at_position(250, i) for i in range(3)])
        self.assertEqual(page['next_offset'], 160, 'older rows remain')
        # …and the window that covers the whole list closes the boundary, which
        # is the client's one signal to stop asking
        done = self.get('window-grow', '?offset=0&limit=250')
        self.assertEqual(len(done['documents']), 250)
        self.assertIsNone(done['next_offset'])

    def test_a_window_over_the_ceiling_clamps_to_the_ceiling_not_to_a_page(self):
        """A clamp back down to 100 would have made every growth past the
        ceiling re-serve the same hundred rows while still reporting more —
        the exact shape of an endless request loop."""
        fixture_org('window-ceiling', DOCUMENTS_MAX_WINDOW + 40)
        page = self.get('window-ceiling', f'?offset=0&limit={DOCUMENTS_MAX_WINDOW + 500}')
        self.assertEqual(len(page['documents']), DOCUMENTS_MAX_WINDOW)
        self.assertEqual(page['next_offset'], DOCUMENTS_MAX_WINDOW)
        self.assertGreater(DOCUMENTS_MAX_WINDOW, 100,
                           'the ceiling has to be above the old page size to mean anything')

    def test_locate_answers_relative_to_the_requested_window(self):
        """A jump has to land INSIDE a prefix read from zero. With the window
        the client is holding, `offset` comes back 0 and the located row is in
        the answer; with the default page it is the row's own page, which is
        the behaviour every other caller still gets."""
        fixture_org('window-locate', 250)
        # gallery position 129 — inside a 160-row window, on the second
        # hundred-row page, which is what makes the two answers differ
        target = at_position(250, 129)
        wide = self.get('window-locate', f'?offset=0&limit=160&locate={target}')
        self.assertEqual(wide['offset'], 0, 'the window already reaches it')
        self.assertEqual(wide['located'], target)
        self.assertEqual(wide['documents'][129]['id'], target)
        self.assertEqual(wide['documents'][0]['id'], at_position(250, 0),
                         'still a prefix from the newest end, not a slice')
        narrow = self.get('window-locate', f'?locate={target}')
        self.assertEqual(narrow['offset'], 100, 'the unchanged page-snapping default')
        self.assertEqual(narrow['documents'][29]['id'], target)

    def test_a_missing_document_is_still_a_404_at_any_window(self):
        fixture_org('window-missing', 30)
        response = TestClient(app).get(
            '/api/orgs/window-missing/documents?limit=500&locate=nope', headers=HEADERS)
        self.assertEqual(response.status_code, 404)


if __name__ == '__main__':
    unittest.main()
