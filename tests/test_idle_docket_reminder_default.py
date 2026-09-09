import json
import os
import tempfile
import unittest


class IdleDocketReminderDefaultTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-settings-")
        os.environ["ORGTREE_DATA"] = cls.root
        from engine.backend.orgtree import appsettings, store
        cls.appsettings = appsettings
        cls.store = store
        if not str(store.DATA_ROOT).lower().startswith(cls.root.lower()):
            raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")

    def setUp(self):
        self.appsettings.store.DATA_ROOT = self.root
        path = self.appsettings.path()
        if os.path.exists(path):
            os.remove(path)

    def test_missing_defaults_on(self):
        self.assertTrue(self.appsettings.idle_docket_reminders_enabled())

    def test_explicit_saved_preference_wins(self):
        self.appsettings.set_idle_docket_reminders_enabled(False)
        self.assertFalse(self.appsettings.idle_docket_reminders_enabled())
        self.appsettings.set_idle_docket_reminders_enabled(True)
        self.assertTrue(self.appsettings.idle_docket_reminders_enabled())
        with open(self.appsettings.path(), encoding="utf-8") as f:
            self.assertIs(json.load(f)["runtime"]["idle_docket_reminders"], True)


if __name__ == "__main__":
    unittest.main()