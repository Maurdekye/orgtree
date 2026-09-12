"""A ticket description is complete: no length cap, no silent truncation.

USER REQUIREMENT 2026-09-12. A ticket must stand on its own — the first
paragraph states the problem and the short solution, and everything after it
carries the rest of the specification. That is only true if the product keeps
what was written, so the description had to stop being a capped field.

WHAT WAS WRONG. `Org.work_create` and `Org.work_update` both ended their
description handling with `[:2000]`. It cut silently: the caller got a
success, the stored item read as a complete (if oddly short) description, and
the missing requirement only surfaced when somebody tried to build from it.
The user hit this on `configure-desktop-notifications`, whose description lost
its tail exactly that way.

WHAT THIS SUITE PINS, end to end along the path a description actually
travels:

  §1  CREATE keeps every character, well past the old 2000-character cap.
  §2  UPDATE — the editing path — keeps every character too, and the
      still-mandatory rules (blank refused, ends trimmed) are unchanged.
  §3  STORAGE and its round trip: what `save_org` writes and `load_org` reads
      back is the same text, and the persisted document holds it whole. A
      file-level export/import of an org is a copy of exactly that document,
      so this is the same guarantee.
  §4  API PROJECTION: the wire item served by `work_get` and by `work_list`
      carries the description entire, not an excerpt.
  §5  MAIL NOTIFICATIONS still carry a short excerpt — a mail is a nudge to go
      and read the item — but they SAY they are an excerpt. A silent cut in a
      notification is the same failure in a smaller place.
  §6  MARKDOWN survives verbatim: fences, tables, headings, entities and the
      characters an escaping bug would eat.

The renderer half of the requirement (full Markdown, the ten-line fold) is
`apps/desktop/renderer/tests/docketdesc.test.tsx`; the native-rules half is
`tests/test_description_doctrine.py`.
"""
import os
import shutil
import tempfile
import unittest
import uuid
from pathlib import Path

# ⚠ ORGTREE_DATA BEFORE the first orgtree import: `store.DATA_ROOT` binds at
# import time. The assert below is the proof, not the intention.
fx = tempfile.TemporaryDirectory(prefix='desc-complete-')
os.environ['ORGTREE_DATA'] = str(Path(fx.name) / 'data')
os.environ['HOME'] = str(Path(fx.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'desc-complete-only'
for k in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(k, None)
from engine.launch import load_app                                   # noqa: E402
load_app()
from orgtree import events, ledger, store                            # noqa: E402
from orgtree import events_render                                    # noqa: E402,F401
assert Path(store.DATA_ROOT).resolve() == Path(os.environ['ORGTREE_DATA']).resolve(), \
    'this process would have written to the live root'

slugs: list[str] = []


def tearDownModule() -> None:
    for s in slugs:
        store._POOL.close_all(s)


#: A description of the shape the requirement describes: a first paragraph
#: with the problem and the short solution, then every remaining rule. Well
#: past the old 2000-character cap, and deliberately full of the Markdown a
#: naive escape or a plain-text pipeline would damage.
def long_description(marker: str = 'alpha') -> str:
    head = ('Ticket descriptions were capped at 2000 characters, so a spec '
            f'longer than that lost its tail in silence ({marker}). Store the '
            'whole description and fold it in the pane instead of cutting it.\n')
    body = ['\n## Requirements\n']
    for i in range(1, 61):
        body.append(
            f'- **Rule {i}** — the {i}th requirement, stated in full so that a '
            f'reader with only this description can build the right thing. It '
            f'mentions `code`, a [link](https://example.invalid/{i}) and an '
            f'edge case: "when x < y & z > 0, keep going".\n')
    body.append('\n```python\n'
                'def keep(text: str) -> str:\n'
                '    return text  # no [:2000] anywhere on this path\n'
                '```\n')
    body.append('\n| field | rule |\n| --- | --- |\n'
                '| objective | uncapped |\n| acceptance | may restate it |\n')
    body.append('\nFinal ruling: the last character of this description is '
                'the one that proves nothing was cut. END-OF-SPEC-' + marker)
    return head + ''.join(body)


class DescriptionCompleteness(unittest.TestCase):
    def setUp(self) -> None:
        slug = 'desccomp-' + uuid.uuid4().hex[:8]
        slugs.append(slug)
        self.org = store.create_org(slug)
        self.slug = slug
        self.agent = self.hire('worker')

    def hire(self, name: str, parent: str | None = None) -> str:
        name = f'{name}-{uuid.uuid4().hex[:4]}'
        self.org.hire(ledger.USER if parent is None else parent, parent,
                      'haiku', 0, name, add_dirs=[],
                      tools={'bash': False, 'web': False, 'edit': False,
                             'subagents': False, 'mcp': []},
                      org_visibility='self', charter='fixture agent')
        store.save_org(self.org)
        return name

    # ── §1 creation keeps everything ──────────────────────────────────────
    def test_s1_create_stores_a_long_description_byte_for_byte(self) -> None:
        text = long_description()
        self.assertGreater(len(text), 2000,
                           'the fixture must exceed the cap it is testing')

        item = self.org.work_create(self.agent, 'Uncapped', text)

        stored = self.org.work_get(self.agent, item['slug'])['objective']
        self.assertEqual(stored, text)
        self.assertTrue(stored.endswith('END-OF-SPEC-alpha'),
                        'the tail of the description was cut')
        # the specific regression: exactly the old boundary, unremarkable now
        self.assertNotEqual(len(stored), 2000)

    def test_s1b_a_very_long_description_is_still_whole(self) -> None:
        # an order of magnitude past the old cap — there is no NEW limit
        # hiding further out, which a single 2500-character case would miss
        text = long_description() * 8
        item = self.org.work_create(self.agent, 'Very long', text)
        self.assertEqual(self.org.work_get(self.agent, item['slug'])['objective'],
                         text)
        self.assertGreater(len(text), 20000)

    # ── §2 the editing path ───────────────────────────────────────────────
    def test_s2_update_rewrites_to_another_long_description_uncut(self) -> None:
        item = self.org.work_create(self.agent, 'Editable', 'short for now')
        text = long_description('beta')

        self.org.work_update(self.agent, item['slug'], ['spec written'], [],
                             objective=text)

        self.assertEqual(self.org.work_get(self.agent, item['slug'])['objective'],
                         text)

    def test_s2b_short_descriptions_and_the_blank_rule_are_unchanged(self) -> None:
        item = self.org.work_create(self.agent, 'Short', '  problem, solution  ')
        # ends are still trimmed — that was never the cut anybody complained of
        self.assertEqual(self.org.work_get(self.agent, item['slug'])['objective'],
                         'problem, solution')
        with self.assertRaises(ledger.LedgerError):
            self.org.work_update(self.agent, item['slug'], ['x'], [],
                                 objective='   ')
        with self.assertRaises(ledger.LedgerError):
            self.org.work_create(self.agent, 'No description', '')

    # ── §3 storage, and the round trip an export/import is ────────────────
    def test_s3_a_long_description_survives_save_and_load(self) -> None:
        text = long_description('gamma')
        item = self.org.work_create(self.agent, 'Persisted', text)
        store.save_org(self.org)
        store._POOL.close_all(self.slug)

        reloaded = store.load_org(self.slug)

        self.assertEqual(reloaded.work_get(self.agent, item['slug'])['objective'],
                         text)

    def test_s3b_a_file_level_copy_of_the_org_still_has_it_all(self) -> None:
        """The export/import guarantee, exercised as the copy it actually is.

        Exporting an org copies its stored document; importing one reads that
        copy back. So: persist, close every handle, copy the files under a new
        name, and load THAT — if anything on the write path shortened the
        description, the copy is short too.
        """
        text = long_description('delta')
        item = self.org.work_create(self.agent, 'Exported', text)
        store.save_org(self.org)
        store._POOL.close_all(self.slug)

        copy_slug = self.slug + 'copy'
        slugs.append(copy_slug)
        orgs = Path(store.DATA_ROOT) / 'orgs'
        copied = 0
        for path in sorted(orgs.glob(self.slug + '.*')):
            shutil.copy2(path, orgs / (copy_slug + path.name[len(self.slug):]))
            copied += 1
        self.assertTrue(copied, 'nothing was persisted to copy')

        imported = store.load_org(copy_slug)
        self.assertEqual(
            imported.work_get(self.agent, item['slug'])['objective'], text)

    # ── §4 the wire ───────────────────────────────────────────────────────
    def test_s4_get_and_list_project_the_whole_description(self) -> None:
        text = long_description('epsilon')
        item = self.org.work_create(self.agent, 'Projected', text)

        self.assertEqual(self.org.work_get(self.agent, item['slug'])['objective'],
                         text)
        listed = [w for w in self.org.work_list(self.agent)['items']
                  if w['slug'] == item['slug']]
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]['objective'], text)

    # ── §5 notifications excerpt OUT LOUD ─────────────────────────────────
    def test_s5_a_notification_excerpt_says_it_is_an_excerpt(self) -> None:
        text = long_description('zeta')
        body = events.render_agent(self._assignment_event(text))

        self.assertIn('EXCERPT', body)
        self.assertIn(str(len(text)), body,
                      'the notice does not say how much there is to read')
        self.assertIn('orgtree_work get', body)
        # and it is still an excerpt — a mail is not the place for a 6 KB spec
        self.assertLess(len(body), len(text))

    def test_s5b_a_short_description_reaches_mail_whole_and_unmarked(self) -> None:
        body = events.render_agent(
            self._assignment_event('problem, then solution'))
        self.assertIn('Description: problem, then solution', body)
        self.assertNotIn('EXCERPT', body)

    def _assignment_event(self, objective: str) -> dict:
        return events.mint(
            'docket.assigned', {'kind': 'agent', 'id': 'coordinator'},
            {'kind': 'work_item', 'org': self.slug, 'slug': 'an-item',
             'title': 'An item'},
            owner='worker', previous_owner=None, assigner='coordinator',
            status='open', objective=objective,
            done_so_far=['nothing yet'], working_on_next=['start'])

    # ── §6 markdown is data, not formatting to be normalised ──────────────
    def test_s6_markdown_and_awkward_characters_survive_verbatim(self) -> None:
        text = ('Problem: markdown was flattened. Solution: keep it.\n\n'
                '# Heading\n\n'
                '```js\nif (a < b && c > d) { return "<b>x</b>" }\n```\n\n'
                '- [ ] unchecked\n- [x] checked\n\n'
                'Unicode: — ⚠ é 中文 🙂  |  entities: &amp; &lt; &#65;\n'
                'Trailing backslash line\\\n and a  double  space.')
        item = self.org.work_create(self.agent, 'Markdown', text)
        self.assertEqual(self.org.work_get(self.agent, item['slug'])['objective'],
                         text)


if __name__ == '__main__':
    unittest.main()
