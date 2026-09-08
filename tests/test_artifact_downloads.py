"""Focused, filesystem-backed tests for presented-document downloads."""

from __future__ import annotations

import io
import tempfile
import unittest
import zipfile
from pathlib import Path

from engine.backend.orgtree.artifact_downloads import (
    ArtifactForbidden,
    ArtifactNotFound,
    build_document_download,
    build_document_preview,
    snapshot_html_bundle,
)


class ArtifactDownloadTests(unittest.TestCase):
    def test_markdown_preserves_original_bytes_and_uses_safe_filename(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            original = b"# title\r\n\xff\x00\n"
            artifact = build_document_download(
                "d-md", {"id": "d-md", "title": "Plan / final?", "body": "ignored",
                         "original_bytes": original}, Path(temp))
            self.assertEqual(artifact.kind, "markdown")
            self.assertEqual(artifact.content_type, "text/markdown; charset=utf-8")
            self.assertEqual(artifact.filename, "Plan-final.md")
            self.assertEqual(artifact.bytes, original)
            self.assertEqual(artifact.body, original)

    def test_single_file_html_is_direct_and_does_not_sweep_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            outbox = root / "outbox"
            outbox.mkdir()
            html = b"<!doctype html><p>standalone</p>"
            (outbox / "index.html").write_bytes(html)
            (root / ".env").write_text("TOKEN=must-not-leak", encoding="utf-8")
            (root / "unrelated.txt").write_text("not part of the document", encoding="utf-8")

            artifact = build_document_download(
                "d-html", {"id": "d-html", "format": "html", "title": "Demo",
                           "file": "outbox/index.html"}, root)
            self.assertEqual(artifact.kind, "html")
            self.assertEqual(artifact.filename, "Demo.html")
            self.assertEqual(artifact.bytes, html)

    def test_zip_contains_real_nested_assets_with_working_relative_names(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "outbox" / "assets" / "css").mkdir(parents=True)
            (root / "outbox" / "assets" / "images").mkdir()
            html = (b'<link rel="stylesheet" href="assets/css/site.css">'
                    b'<img src="assets/images/logo.svg">')
            (root / "outbox" / "index.html").write_bytes(html)
            (root / "outbox" / "assets" / "css" / "site.css").write_bytes(b"body{color:red}")
            (root / "outbox" / "assets" / "images" / "logo.svg").write_bytes(b"<svg/>")
            (root / "outbox" / "credentials.json").write_bytes(b"private")
            (root / "unrelated.txt").write_bytes(b"private")

            artifact = build_document_download(
                "d-zip", {
                    "id": "d-zip", "format": "html", "title": "Nested demo",
                    "file": "outbox/index.html",
                    "localassets": [
                        "assets/css/site.css",
                        {"path": "outbox/assets/images/logo.svg", "name": "assets/images/logo.svg"},
                    ],
                }, root)
            self.assertEqual(artifact.kind, "zip")
            self.assertEqual(artifact.content_type, "application/zip")
            self.assertEqual(artifact.filename, "Nested-demo.zip")
            with zipfile.ZipFile(io.BytesIO(artifact.bytes)) as archive:
                self.assertEqual(archive.namelist(), ["index.html", "assets/css/site.css", "assets/images/logo.svg"])
                self.assertEqual(archive.read("index.html"), html)
                self.assertEqual(archive.read("assets/css/site.css"), b"body{color:red}")
                self.assertEqual(archive.read("assets/images/logo.svg"), b"<svg/>")

    def test_missing_asset_is_truthful_and_does_not_expose_a_filesystem_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "outbox").mkdir()
            (root / "outbox" / "index.html").write_bytes(b"<p>missing</p>")
            with self.assertRaises(ArtifactNotFound) as raised:
                build_document_download(
                    "d-missing", {"id": "d-missing", "format": "html", "title": "Missing",
                                  "file": "outbox/index.html",
                                  "localassets": ["outbox/assets/nope.js"]}, root)
            self.assertIn("local asset", str(raised.exception))
            self.assertNotIn(str(root), str(raised.exception))

    def test_traversal_and_sensitive_explicit_assets_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "outbox").mkdir()
            (root / "outbox" / "index.html").write_bytes(b"<p>x</p>")
            hostile = ["outbox/../outside.txt", "../outside.txt"]
            for path in hostile:
                with self.subTest(path=path), self.assertRaises(ArtifactForbidden):
                    build_document_download(
                        "d-traversal", {"id": "d-traversal", "format": "html",
                                         "title": "Hostile", "file": "outbox/index.html",
                                         "localassets": [path]}, root)
            (root / "credentials.json").write_bytes(b"do not package")
            with self.assertRaises(ArtifactForbidden):
                build_document_download(
                    "d-secret", {"id": "d-secret", "format": "html", "title": "Secret",
                                 "file": "outbox/index.html",
                                 "localassets": ["credentials.json"]}, root)

    def test_symlink_to_outside_root_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            outside = root.parent / (root.name + "-outside")
            outside.mkdir()
            try:
                (outside / "secret.js").write_bytes(b"outside")
                (root / "outbox").mkdir()
                (root / "outbox" / "index.html").write_bytes(b"<p>x</p>")
                try:
                    (root / "outbox" / "assets").symlink_to(outside, target_is_directory=True)
                except OSError:
                    self.skipTest("symlink creation is unavailable on this Windows runner")
                with self.assertRaises(ArtifactForbidden):
                    build_document_download(
                        "d-link", {"id": "d-link", "format": "html", "title": "Link",
                                   "file": "outbox/index.html",
                                   "localassets": ["outbox/assets/secret.js"]}, root)
            finally:
                # The outside directory is a test fixture, not a worktree or
                # application data.  Path.unlink/rmdir avoids recursive cleanup.
                (outside / "secret.js").unlink(missing_ok=True)
                outside.rmdir()

    def test_production_record_discovers_local_html_dependencies_without_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "outbox" / "assets").mkdir(parents=True)
            (root / "outbox" / "index.html").write_bytes(
                b'<link rel="stylesheet" href="assets/site.css">'
                b'<script src="assets/app.js"></script>')
            (root / "outbox" / "assets" / "site.css").write_bytes(
                b'body{background:url("images/bg.png")}')
            (root / "outbox" / "assets" / "app.js").write_bytes(b"console.log(1)")
            (root / "outbox" / "assets" / "images").mkdir()
            (root / "outbox" / "assets" / "images" / "bg.png").write_bytes(b"PNG")

            artifact = build_document_download(
                "d-production", {"id": "d-production", "format": "html",
                                  "title": "Production", "file": "outbox/index.html"}, root)
            self.assertEqual(artifact.kind, "zip")
            with zipfile.ZipFile(io.BytesIO(artifact.bytes)) as archive:
                self.assertEqual(archive.namelist(), [
                    "index.html", "assets/site.css", "assets/app.js", "assets/images/bg.png"
                ])
                self.assertIsNone(archive.testzip())

    def test_snapshot_helper_copies_immutable_dependency_tree(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source_dir = root / "project"
            source_dir.mkdir()
            (source_dir / "assets").mkdir()
            (source_dir / "index.html").write_bytes(b'<script src="assets/app.js"></script>')
            (source_dir / "assets" / "app.js").write_bytes(b"old")
            outbox = root / "outbox"
            outbox.mkdir()

            snapshot = snapshot_html_bundle(source_dir / "index.html",
                                            outbox / "presentation-1", source_dir,
                                            destination_root=root)
            self.assertEqual(snapshot.file, "outbox/presentation-1/index.html")
            self.assertEqual(snapshot.assets, ("outbox/presentation-1/assets/app.js",))
            self.assertEqual((outbox / "presentation-1" / "assets" / "app.js").read_bytes(), b"old")
            (source_dir / "assets" / "app.js").write_bytes(b"new")
            self.assertEqual((outbox / "presentation-1" / "assets" / "app.js").read_bytes(), b"old")
            artifact = build_document_download(
                "d-snapshot", {"id": "d-snapshot", "format": "html", "title": "Snap",
                               "file": snapshot.file}, root)
            with zipfile.ZipFile(io.BytesIO(artifact.bytes)) as archive:
                self.assertEqual(archive.read("assets/app.js"), b"old")

    def test_bundle_size_cap_covers_source_and_dependencies_before_snapshot_write(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source_dir = root / "project"
            source_dir.mkdir()
            (source_dir / "assets").mkdir()
            (source_dir / "index.html").write_bytes(b'<img src="assets/app.js">')
            (source_dir / "assets" / "app.js").write_bytes(b"5678")
            outbox = root / "outbox"
            outbox.mkdir()
            with self.assertRaises(ArtifactForbidden):
                snapshot_html_bundle(source_dir / "index.html", outbox / "bundle",
                                     source_dir, destination_root=root, max_bytes=28)
            self.assertFalse((outbox / "bundle").exists())
            with self.assertRaises(ArtifactForbidden):
                build_document_download(
                    "d-cap", {"id": "d-cap", "format": "html", "title": "Cap",
                              "file": "project/index.html"}, root, max_bytes=28)

    def test_preview_inlines_actual_nested_local_assets_and_keeps_external_urls(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            assets = root / "outbox" / "assets"
            (assets / "css").mkdir(parents=True)
            (assets / "images").mkdir()
            (assets / "fonts").mkdir()
            (root / "outbox" / "index.html").write_text(
                '<link rel="stylesheet" href="assets/css/site.css">'
                '<script src="assets/app.js"></script>'
                '<img src="assets/images/logo.svg">'
                '<img src="https://cdn.example.test/remote.png">', encoding="utf-8")
            (assets / "css" / "site.css").write_text(
                '@import "more.css"; body{background:url("../images/bg.svg")} '
                '@font-face{src:url("../fonts/font.woff2")}', encoding="utf-8")
            (assets / "css" / "more.css").write_text("h1{color:red}", encoding="utf-8")
            (assets / "images" / "logo.svg").write_bytes(b"<svg id=logo/>")
            (assets / "images" / "bg.svg").write_bytes(b"<svg id=bg/>")
            (assets / "fonts" / "font.woff2").write_bytes(b"FONT")
            (assets / "app.js").write_text("console.log('local')", encoding="utf-8")

            preview = build_document_preview(
                "d-preview", {"id": "d-preview", "format": "html",
                               "file": "outbox/index.html"}, root)
            self.assertIn("data:image/svg+xml;base64,", preview)
            self.assertIn("data:font/woff2;base64,Rk9OVA==", preview)
            self.assertIn("console.log('local')", preview)
            self.assertIn("h1{color:red}", preview)
            self.assertIn("https://cdn.example.test/remote.png", preview)
            self.assertNotIn('href="assets/css/site.css"', preview)
            self.assertNotIn('src="assets/app.js"', preview)

    def test_preview_missing_local_asset_is_truthful(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "outbox").mkdir()
            (root / "outbox" / "index.html").write_text(
                '<img src="assets/missing.svg">', encoding="utf-8")
            with self.assertRaises(ArtifactNotFound) as raised:
                build_document_preview(
                    "d-preview-missing", {"id": "d-preview-missing", "format": "html",
                                           "file": "outbox/index.html"}, root)
            self.assertIn("local asset", str(raised.exception))
            self.assertNotIn(str(root), str(raised.exception))

    def test_preview_rejects_source_id_mismatch_and_aggregate_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "outbox").mkdir()
            (root / "outbox" / "index.html").write_bytes(b'<img src="asset.bin">')
            (root / "outbox" / "asset.bin").write_bytes(b"123456")
            document = {"id": "real-id", "format": "html", "file": "outbox/index.html"}
            with self.assertRaises(ArtifactNotFound):
                build_document_preview("wrong-id", document, root)
            with self.assertRaises(ArtifactForbidden):
                build_document_preview("real-id", document, root, max_bytes=20)


if __name__ == "__main__":
    unittest.main()
