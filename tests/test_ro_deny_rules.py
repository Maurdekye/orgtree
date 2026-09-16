"""Read-only grant carving: the agent's own scratch is never denied.

Ticket `the-sandbox-refuses-to-create-files-and-folders` (2026-09-16). A
read-only grant on an ANCESTOR of an agent's scratch folder used to render an
`Edit(<level>/*)` rule at every chain level. That wildcard matches the chain
DIRECTORY too, so the carve denied the agent's own desk and the file tools
refused `breadcrumbs.md` with "File is in a directory that is denied by your
permission settings" while the shell wrote the same path unimpeded.

These tests pin both halves: own scratch is never named by any rule, and
everything else under the grant keeps exactly the coverage it had.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault(
    "ORGTREE_DATA", tempfile.mkdtemp(prefix="orgtree-rodeny-test-"))
from engine.backend.orgtree.supervisor import ro_deny_rules


def _rule_paths(rules: list[str]) -> list[str]:
    """`Edit(<path>)` / `Edit(<path>/**)` -> the bare path body."""
    out = []
    for r in rules:
        assert r.startswith("Edit(") and r.endswith(")"), r
        out.append(r[len("Edit("):-1])
    return out


class RoDenyRulesTests(unittest.TestCase):
    def _tree(self, folder: str) -> tuple[str, str]:
        """data/<scratch/<org>/<agent>> plus siblings and files at each level."""
        root = Path(folder) / "data"
        own = root / "scratch" / "org" / "agent"
        own.mkdir(parents=True)
        (own / "breadcrumbs.md").write_text("notes", encoding="utf-8")
        # a sibling directory and a loose file at EVERY chain level
        (root / "orgs").mkdir()
        (root / "orgs" / "org.json").write_text("{}", encoding="utf-8")
        (root / "accounts.json").write_text("{}", encoding="utf-8")
        (root / "scratch" / "other-org").mkdir()
        (root / "scratch" / "index.json").write_text("{}", encoding="utf-8")
        (root / "scratch" / "org" / "sibling-agent").mkdir()
        (root / "scratch" / "org" / "roster.json").write_text(
            "{}", encoding="utf-8")
        return str(root), str(own)

    # ── the defect ────────────────────────────────────────────────────────
    def test_own_scratch_is_never_named_by_any_rule(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root, own = self._tree(folder)
            paths = _rule_paths(ro_deny_rules([root], own))
            own_slash = own.replace("\\", "/")
            for p in paths:
                self.assertNotEqual(p, own_slash)
                self.assertNotEqual(p, own_slash + "/**")
                self.assertFalse(
                    p.startswith(own_slash + "/"),
                    f"rule {p!r} reaches into the agent's own scratch")

    def test_no_chain_level_wildcard_rule_survives(self) -> None:
        """`Edit(<level>/*)` is what denied the chain directory itself."""
        with tempfile.TemporaryDirectory() as folder:
            root, own = self._tree(folder)
            paths = _rule_paths(ro_deny_rules([root], own))
            for p in paths:
                self.assertFalse(p.endswith("/*"),
                                 f"single-star rule {p!r} matches a directory")

    def test_breadcrumbs_in_own_scratch_is_not_covered(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root, own = self._tree(folder)
            paths = set(_rule_paths(ro_deny_rules([root], own)))
            target = os.path.join(own, "breadcrumbs.md").replace("\\", "/")
            self.assertNotIn(target, paths)
            # nor by any ancestor-subtree rule on the chain
            for p in paths:
                self.assertFalse(
                    p.endswith("/**") and target.startswith(p[:-3] + "/"),
                    f"{p!r} still covers {target!r}")

    # ── nothing else was widened ──────────────────────────────────────────
    def test_every_sibling_directory_keeps_its_subtree_clamp(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root, own = self._tree(folder)
            paths = set(_rule_paths(ro_deny_rules([root], own)))
            for rel in ("orgs", "scratch/other-org",
                        "scratch/org/sibling-agent"):
                want = f"{root}/{rel}".replace("\\", "/") + "/**"
                self.assertIn(want, paths)

    def test_every_loose_file_on_the_chain_is_denied_exactly(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root, own = self._tree(folder)
            paths = set(_rule_paths(ro_deny_rules([root], own)))
            for rel in ("accounts.json", "scratch/index.json",
                        "scratch/org/roster.json"):
                want = f"{root}/{rel}".replace("\\", "/")
                self.assertIn(want, paths)
                self.assertNotIn(want + "/**", paths)

    def test_grant_that_does_not_contain_own_scratch_is_clamped_whole(
            self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root, own = self._tree(folder)
            elsewhere = os.path.join(folder, "elsewhere")
            os.mkdir(elsewhere)
            rules = ro_deny_rules([elsewhere], own)
            self.assertEqual(
                rules, [f"Edit({elsewhere.replace(chr(92), '/')}/**)"])

    def test_grant_equal_to_own_scratch_denies_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            _root, own = self._tree(folder)
            self.assertEqual(ro_deny_rules([own], own), [])

    def test_unreadable_ancestor_keeps_the_blanket_clamp(self) -> None:
        """A carve that cannot enumerate must not silently widen the grant."""
        with tempfile.TemporaryDirectory() as folder:
            root, own = self._tree(folder)
            missing = os.path.join(folder, "gone")
            deeper = os.path.join(missing, "scratch", "org", "agent")
            rules = ro_deny_rules([missing], deeper)
            self.assertEqual(
                rules, [f"Edit({missing.replace(chr(92), '/')}/**)"])
            self.assertTrue(os.path.isdir(root))  # tree built, unused here

    # ── determinism: this JSON rides argv into the D-201 identity hash ────
    def test_rules_are_deterministic_and_sorted_per_level(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root, own = self._tree(folder)
            first = ro_deny_rules([root], own)
            self.assertEqual(first, ro_deny_rules([root], own))
            self.assertEqual(len(first), len(set(first)))


if __name__ == "__main__":
    unittest.main()
