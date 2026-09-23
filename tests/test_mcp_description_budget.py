"""The MCP tool cards stay short, and every catalogue carries them whole.

The cards were cut roughly in half (105,030 -> ~55,000 description
characters, `orgtree_work` 37,755 -> ~16,000) because every agent pays for
them on every turn and long cards are harder to scan. The budgets below are
ceilings with a little headroom, so a later edit that grows a card back is a
deliberate change to this file rather than an accident.

The desktop-managed catalogue drops the `verify` action. It used to strip the
prose with a `partition`, which cut the whole `orgtree_work` card off after
the word `verify` (13,269 -> 3,876 characters). It now removes exactly one
sentence, and this suite pins that.
"""
import os
import unittest
from unittest.mock import patch

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from orgtree import mcptool

TOTAL_BUDGET = 60_000
WORK_BUDGET = 17_000
WORK_TOP_BUDGET = 6_000
CARD_TOP_BUDGET = 2_300


def description_chars(node):
    if isinstance(node, dict):
        return sum(len(v) if k == 'description' and isinstance(v, str)
                   else description_chars(v) for k, v in node.items())
    if isinstance(node, list):
        return sum(description_chars(v) for v in node)
    return 0


def card(tools, name):
    return next(t for t in tools if t['name'] == name)


class DescriptionBudget(unittest.TestCase):
    def test_total_description_text_stays_under_budget(self):
        self.assertLessEqual(description_chars(mcptool.TOOLS), TOTAL_BUDGET)

    def test_the_docket_card_stays_under_budget(self):
        work = card(mcptool.TOOLS, 'orgtree_work')
        self.assertLessEqual(description_chars(work), WORK_BUDGET)
        self.assertLessEqual(len(work['description']), WORK_TOP_BUDGET)

    def test_no_other_card_description_is_long(self):
        cards = list(mcptool.TOOLS) + list(mcptool._DESKTOP_RELAUNCH_CARDS)
        for spec in cards:
            if spec['name'] == 'orgtree_work':
                continue
            with self.subTest(tool=spec['name']):
                self.assertLessEqual(len(spec['description']), CARD_TOP_BUDGET)

    def test_every_card_and_property_is_described_in_plain_text(self):
        for spec in mcptool.TOOLS:
            with self.subTest(tool=spec['name']):
                self.assertTrue(spec['description'].strip())
                self.assertNotIn('  ', spec['description'])


class DesktopCatalogueKeepsTheWholeCard(unittest.TestCase):
    def test_desktop_work_card_loses_only_the_verify_sentence(self):
        standard = card(mcptool.TOOLS, 'orgtree_work')['description']
        self.assertEqual(standard.count(mcptool._WORK_VERIFY_SENTENCE), 1)
        with patch.dict(os.environ, {'ORGTREE_DESKTOP_MANAGED': '1'}):
            managed = card(mcptool.available_tools(), 'orgtree_work')
        self.assertEqual(managed['description'],
                         standard.replace(mcptool._WORK_VERIFY_SENTENCE, ''))
        self.assertNotIn('`verify`', managed['description'])
        self.assertNotIn('verify', managed['inputSchema']['properties']['action']['enum'])
        # the tail of the card survives: the old strip cut everything after
        # `verify`, including the description rule and the attention rules
        for tail in ('SUBSEQUENT PARAGRAPH', 'deploy_ready',
                     'WITHDRAW A STALE ATTENTION FLAG'):
            self.assertIn(tail, managed['description'])

    def test_standard_catalogue_keeps_verify(self):
        with patch.dict(os.environ, {'ORGTREE_DESKTOP_MANAGED': '0'}):
            standard = card(mcptool.available_tools(), 'orgtree_work')
        self.assertIn(mcptool._WORK_VERIFY_SENTENCE, standard['description'])
        self.assertIn('verify', standard['inputSchema']['properties']['action']['enum'])


if __name__ == '__main__':
    unittest.main()
