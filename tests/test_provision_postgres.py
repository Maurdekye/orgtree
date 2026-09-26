"""Archive-selection controls; no downloads, native execution or data access."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

import import_provenance  # noqa: F401  runner proves checkout imports

spec = importlib.util.spec_from_file_location("provision_postgres", Path(__file__).resolve().parents[1] / "tools/provision-postgres.py")
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)


class ArchiveControls(unittest.TestCase):
    def test_selection_keeps_runtime_and_notices_only(self):
        for name in ["bin/postgres.exe", "lib/pgoutput.dll", "share/postgres.bki", *provision.NOTICES]:
            self.assertEqual(provision.selected_member("pgsql/" + name), name)
        for name in ["pgsql/pgAdmin 4/a.exe", "pgsql/StackBuilder/a.exe", "pgsql/include/a.h", "pgsql/doc/index.html"]:
            self.assertIsNone(provision.selected_member(name))

    def test_traversal_absolute_ads_and_backslash_refuse(self):
        for name in ["pgsql/bin/../../escape", "/pgsql/bin/a", "pgsql/bin/a:stream", "pgsql\\bin\\a", "C:/pgsql/bin/a"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                provision.selected_member(name)

    def archive(self, folder, extra=()):
        archive = folder / "fixture.zip"
        with zipfile.ZipFile(archive, "w") as out:
            for name in [*(f"bin/{tool}" for tool in provision.TOOLS), *provision.NOTICES,
                         "lib/pgoutput.dll", "share/postgres.bki", "pgAdmin 4/unused.exe", *extra]:
                out.writestr("pgsql/" + name, name.encode())
        return archive

    def test_extract_preserves_required_tree_without_admin_tools(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            target = folder / "out"
            provision.extract_runtime(self.archive(folder), target)
            self.assertTrue((target / "lib/pgoutput.dll").is_file())
            self.assertFalse((target / "pgAdmin 4").exists())
            self.assertEqual(len(provision.files(target)), 9)

    def test_duplicate_casefolded_path_refuses(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            with self.assertRaisesRegex(ValueError, "Duplicate"):
                provision.extract_runtime(self.archive(folder, ["bin/POSTGRES.exe"]), folder / "out")

    def test_missing_runtime_tool_refuses(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            archive = folder / "fixture.zip"
            with zipfile.ZipFile(archive, "w") as out:
                out.writestr("pgsql/bin/postgres.exe", b"placeholder")
            with self.assertRaisesRegex(ValueError, "regular file"):
                provision.extract_runtime(archive, folder / "out")


if __name__ == "__main__":
    unittest.main()
