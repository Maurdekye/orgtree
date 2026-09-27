import unittest
from tools.scale.ui_mix import polls, WINDOWS


class UIMix(unittest.TestCase):
    def test_each_visible_surface_only_polls_its_own_reads(self):
        expected = [{"org_tree", "work_items"}, {"org_tree", "work_items", "chat"},
                    {"org_tree", "work_items", "inbox"}, {"org_tree", "org_list"}]
        for index, names in enumerate(expected):
            with self.subTest(window=WINDOWS[index]):
                rows = polls("org", "agent", index)
                self.assertEqual({row[0] for row in rows}, names)
                self.assertFalse(any("archived=1" in row[1] or "backlogged=1" in row[1] for row in rows))
                self.assertEqual(rows, polls("org", "agent", index + 4))
                tree = next(row for row in rows if row[0] == "org_tree")
                self.assertEqual(tree[1], "/api/orgs/org?view=delta")

    def test_chat_window_and_idle_busy_cadences_match_convo(self):
        for streaming, period in ((True, 2.5), (False, 7.0)):
            chat = next(row for row in polls("org", "agent", 1, streaming) if row[0] == "chat")
            self.assertTrue(chat[1].endswith("chat?last=8"))
            self.assertEqual(chat[2], period)
        for window, period in ((0, 5), (1, 15), (2, 5)):
            docket = next(row for row in polls("org", "agent", window) if row[0] == "work_items")
            self.assertEqual(docket[2:], (period, True))


if __name__ == "__main__":
    unittest.main()
