"""Build safe downloads for presented documents.

The API layer owns document lookup and authorization.  This module only gets
the already-authorized presenter record and its bounded scratch root; it never
looks up an org, walks a directory, or returns a filesystem path.

HTML asset manifests are deliberately explicit.  A manifest entry may be a
source path string, ``{"path": source, "name": archive_name}``, or a mapping
from archive name to source path.  A plain entry is placed relative to the
HTML source's directory, preserving the paths used by ordinary relative HTML
references (for example ``outbox/assets/app.js`` becomes ``assets/app.js`` in
an archive whose top-level page is ``index.html``).
"""

from __future__ import annotations

import io
import html.parser
import ntpath
import os
import re
from collections import deque
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence


class ArtifactDownloadError(Exception):
    """Base class for errors the route can translate to an HTTP response."""


class ArtifactNotFound(ArtifactDownloadError):
    """The requested document or one of its immutable source files is gone."""


class ArtifactForbidden(ArtifactDownloadError):
    """The document metadata names an unsafe or unauthorized artifact."""


# Descriptive aliases make route adapters pleasant to read without coupling
# them to a particular web framework's exception classes.
ArtifactNotFoundError = ArtifactNotFound
ArtifactForbiddenError = ArtifactForbidden


@dataclass(frozen=True)
class DownloadArtifact:
    """Response-neutral download data returned by :func:`build_download`."""

    kind: str
    content_type: str
    filename: str
    bytes: bytes

    @property
    def body(self) -> bytes:
        """Compatibility name for adapters that call response data ``body``."""
        return self.bytes

    @property
    def size(self) -> int:
        return len(self.bytes)


@dataclass(frozen=True)
class HtmlSnapshot:
    """Result of snapshotting an HTML page and its local dependencies."""

    file: str
    bytes: int
    assets: tuple[str, ...]


# Fixed archive timestamps make repeated downloads stable and avoid leaking
# source file mtimes through an otherwise content-only artifact.
_ZIP_DATE = (1980, 1, 1, 0, 0, 0)
_MARKDOWN_TYPE = "text/markdown; charset=utf-8"
_HTML_TYPE = "text/html; charset=utf-8"
_ZIP_TYPE = "application/zip"
_ASSET_KEYS = ("localassets", "local_assets", "assets")
_SOURCE_KEYS = ("file", "html_file", "path", "source")
_SENSITIVE_PARTS = {
    ".bridge", ".claude", ".credentials.json", ".claude.json", 
    "credentials.json", "secrets.json", "id_rsa", "id_ed25519",
}
_SENSITIVE_NAMES = {".env", ".env.local", ".env.production", ".npmrc"}


def build_document_download(
    document_id: str,
    presenter: Mapping[str, Any],
    artifact_root: str | os.PathLike[str],
) -> DownloadArtifact:
    """Build one authorized presented-document download.

    ``document_id`` is the route's authoritative id and must match a supplied
    ``id`` field when present. ``presenter`` is the immutable document metadata
    (including ``title``, ``format``, ``body`` and HTML ``file``/asset fields).
    ``artifact_root`` must be the presenter's bounded scratch directory; paths
    in the record are relative to it.  The function returns bytes only.

    Markdown preserves the stored body bytes.  An HTML document with a
    non-empty explicit local-asset manifest is a ZIP; a single-file HTML
    document is returned directly.
    """
    if not isinstance(document_id, str) or not document_id:
        raise ArtifactNotFound("presented document was not found")
    recorded_id = presenter.get("id")
    if recorded_id is not None and str(recorded_id) != document_id:
        raise ArtifactNotFound("presented document was not found")

    title = _safe_stem(presenter.get("title"))
    fmt = str(presenter.get("format") or "markdown").lower()
    if fmt != "html":
        body = _stored_bytes(presenter)
        if not body:
            raise ArtifactNotFound("presented document was not found")
        return DownloadArtifact("markdown", _MARKDOWN_TYPE, f"{title}.md", body)

    root = _authorized_root(artifact_root)
    source_name = _source_name(presenter)
    source_path = _safe_source_path(root, source_name)
    source_bytes = _read_file(source_path, source_is_required=True)
    assets = _asset_manifest(presenter)
    discovered = _discover_local_assets(source_path, root, source_name,
                                        source_bytes)
    if not assets and not discovered:
        return DownloadArtifact("html", _HTML_TYPE, f"{title}.html", source_bytes)

    source_archive_name = _source_archive_name(source_name)
    entries: list[tuple[str, bytes]] = [(source_archive_name, source_bytes)]
    seen = {source_archive_name}
    source_parent = _source_parent(source_name)
    for source_ref, archive_ref in _asset_entries(assets, source_parent):
        asset_path = _safe_source_path(root, source_ref)
        asset_bytes = _read_file(asset_path, source_is_required=False)
        archive_name = _safe_archive_name(archive_ref)
        if archive_name in seen:
            raise ArtifactForbidden("the document asset manifest contains a duplicate")
        seen.add(archive_name)
        entries.append((archive_name, asset_bytes))
    for archive_name, asset_bytes in discovered:
        if archive_name not in seen:
            seen.add(archive_name)
            entries.append((archive_name, asset_bytes))

    archive = _zip_bytes(entries)
    return DownloadArtifact("zip", _ZIP_TYPE, f"{title}.zip", archive)


def build_download(
    document_id: str,
    presenter: Mapping[str, Any],
    artifact_root: str | os.PathLike[str],
) -> DownloadArtifact:
    """Short alias for :func:`build_document_download`."""
    return build_document_download(document_id, presenter, artifact_root)


def snapshot_html_bundle(
    source_path: str | os.PathLike[str],
    destination_folder: str | os.PathLike[str],
    artifact_root: str | os.PathLike[str],
    *,
    destination_root: str | os.PathLike[str] | None = None,
) -> HtmlSnapshot:
    """Copy an HTML source and its local dependencies into an immutable folder.

    The caller must already have checked that ``source_path`` is permitted by
    the agent's grants.  This function independently proves that it remains
    below ``artifact_root`` (including symlink resolution), discovers all
    local HTML/CSS references before writing, and only then creates the
    destination folder.  The destination is expected to be a newly selected
    folder in the presenter's outbox; it is never traversed or swept.

    The returned ``file`` is relative to ``destination_root`` (or
    ``artifact_root`` when omitted) and can be stored as the document's HTML
    file.  ``destination_root`` is useful when the source is in a granted
    workspace but the immutable snapshot belongs in the presenter's scratch.
    The copied folder keeps the same page-relative layout, so no HTML rewriting
    is needed. Missing local references raise :class:`ArtifactNotFound` before
    any destination is created.
    """
    root = _authorized_root(artifact_root)
    output_root = _authorized_root(destination_root or artifact_root)
    source = _absolute_source_path(source_path, root)
    source_bytes = _read_file(source, source_is_required=True)
    source_name = _relative_root_name(source, root)
    discovered = _discover_local_assets(source, root, source_name, source_bytes)

    try:
        destination = Path(destination_folder).resolve(strict=False)
    except (OSError, RuntimeError, TypeError):
        raise ArtifactForbidden("the HTML snapshot destination is unsafe") from None
    if not _contained(output_root, destination):
        raise ArtifactForbidden("the HTML snapshot destination is unauthorized")
    try:
        if destination.exists() or destination.is_symlink():
            raise ArtifactForbidden("the HTML snapshot destination already exists")
        parent = destination.parent.resolve(strict=True)
        if not parent.is_dir():
            raise OSError
        destination.mkdir()
        copied = destination / _source_archive_name(source_name)
        copied.write_bytes(source_bytes)
        for archive_name, data in discovered:
            target = destination / Path(*archive_name.split("/"))
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    except ArtifactDownloadError:
        raise
    except OSError:
        # Do not expose destination paths through a route-facing exception.
        raise ArtifactForbidden("the HTML snapshot could not be created") from None

    destination_rel = os.path.relpath(destination, output_root).replace("\\", "/")
    source_archive_name = _source_archive_name(source_name)
    return HtmlSnapshot(
        file=f"{destination_rel}/{source_archive_name}",
        bytes=len(source_bytes),
        assets=tuple(f"{destination_rel}/{name}" for name, _ in discovered),
    )


class _HtmlReferences(html.parser.HTMLParser):
    """Collect resource URLs, excluding navigation links."""

    _RESOURCE_ATTRS = {
        "script": ("src",),
        "img": ("src", "srcset"),
        "source": ("src", "srcset"),
        "video": ("src", "poster"),
        "audio": ("src",),
        "track": ("src",),
        "object": ("data",),
        "iframe": ("src",),
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.urls: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        lowered = tag.lower()
        values = dict(attrs)
        if lowered == "link":
            rel = (values.get("rel") or "").lower().split()
            if "stylesheet" in rel:
                self._add(values.get("href"))
            return
        for attr in self._RESOURCE_ATTRS.get(lowered, ()):
            value = values.get(attr)
            if attr == "srcset" and value:
                self.urls.extend(_srcset_urls(value))
            else:
                self._add(value)

    def _add(self, value: str | None) -> None:
        if value:
            self.urls.append(value.strip())


def _srcset_urls(value: str) -> list[str]:
    urls: list[str] = []
    for candidate in value.split(","):
        pieces = candidate.strip().split()
        if pieces:
            urls.append(pieces[0])
    return urls


_CSS_URL = re.compile(r"url\(\s*(['\"]?)(.*?)\1\s*\)", re.I | re.S)
_CSS_IMPORT = re.compile(r"@import\s+(?:url\(\s*)?(['\"])(.*?)\1", re.I | re.S)


def _discover_local_assets(
    source_path: Path,
    root: Path,
    source_name: str,
    source_bytes: bytes,
) -> list[tuple[str, bytes]]:
    """Discover a dependency closure from HTML and nested CSS files."""
    source_parent = (root / Path(*_source_parent(source_name).split("/"))).resolve()
    pending: deque[tuple[Path, bytes]] = deque([(source_path, source_bytes)])
    visited: set[Path] = {source_path}
    found: list[tuple[str, bytes]] = []
    while pending:
        current, data = pending.popleft()
        refs = _resource_urls(current, data)
        for raw in refs:
            candidate = _resolve_local_reference(current, raw, root)
            if candidate is None:
                continue
            if not _contained(source_parent, candidate):
                raise ArtifactForbidden("the HTML asset escapes its source directory")
            if candidate in visited:
                continue
            asset = _read_file(candidate, source_is_required=False)
            visited.add(candidate)
            archive_name = os.path.relpath(candidate, source_parent).replace("\\", "/")
            archive_name = _safe_archive_name(archive_name)
            found.append((archive_name, asset))
            if candidate.suffix.lower() == ".css":
                pending.append((candidate, asset))
    return found


def _resource_urls(path: Path, data: bytes) -> list[str]:
    text = data.decode("utf-8", errors="replace")
    if path.suffix.lower() == ".css":
        urls = [match.group(2).strip() for match in _CSS_URL.finditer(text)]
        urls.extend(match.group(2).strip() for match in _CSS_IMPORT.finditer(text))
        return urls
    parser = _HtmlReferences()
    try:
        parser.feed(text)
        parser.close()
    except (ValueError, AssertionError):
        # A malformed document can still have useful resource tags; parser
        # errors should not turn a download into an internal server failure.
        pass
    return parser.urls


def _resolve_local_reference(base: Path, raw: str, root: Path) -> Path | None:
    """Resolve a local URL while ignoring network/data references."""
    value = raw.strip().strip("\"'")
    if not value or value.startswith(("#", "data:", "blob:", "javascript:", "mailto:")):
        return None
    # Protocol-relative URLs and all schemes remain external resources.  HTML
    # may load those online when viewed; they are not local ZIP dependencies.
    if value.startswith("//") or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", value):
        return None
    if "\x00" in value:
        raise ArtifactForbidden("the HTML asset names an unsafe path")
    from urllib.parse import unquote, urlsplit
    split = urlsplit(value)
    path_text = unquote(split.path)
    if not path_text or path_text.startswith(("/", "\\")) or ntpath.isabs(path_text):
        raise ArtifactForbidden("the HTML asset names an unsafe path")
    try:
        candidate = (base.parent / Path(*path_text.replace("\\", "/").split("/"))).resolve(strict=False)
    except (OSError, RuntimeError):
        raise ArtifactForbidden("the HTML asset names an unsafe path") from None
    if not _contained(root, candidate):
        raise ArtifactForbidden("the HTML asset escapes its authorized root")
    return candidate


def _absolute_source_path(raw: str | os.PathLike[str], root: Path) -> Path:
    try:
        path = Path(raw)
        if not path.is_absolute():
            raise ValueError
        resolved = path.resolve(strict=False)
    except (OSError, RuntimeError, TypeError, ValueError):
        raise ArtifactForbidden("the HTML source is outside its authorized root") from None
    if not _contained(root, resolved):
        raise ArtifactForbidden("the HTML source is outside its authorized root")
    return resolved


def _relative_root_name(path: Path, root: Path) -> str:
    try:
        return os.path.relpath(path, root).replace("\\", "/")
    except ValueError:
        raise ArtifactForbidden("the HTML source is outside its authorized root") from None


def _stored_bytes(document: Mapping[str, Any]) -> bytes:
    for key in ("original_bytes", "source_bytes", "body_bytes"):
        value = document.get(key)
        if isinstance(value, bytes):
            return value
        if isinstance(value, bytearray):
            return bytes(value)
        if isinstance(value, memoryview):
            return value.tobytes()
    value = document.get("body")
    if isinstance(value, bytes):
        return value
    if isinstance(value, bytearray):
        return bytes(value)
    if isinstance(value, memoryview):
        return value.tobytes()
    if isinstance(value, str):
        return value.encode("utf-8")
    return b""


def _safe_stem(raw: Any) -> str:
    value = str(raw or "document").strip()
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", value)
    value = value.strip("-._")
    return value or "document"


def _authorized_root(raw: str | os.PathLike[str]) -> Path:
    try:
        root = Path(raw).resolve(strict=True)
    except (OSError, RuntimeError, TypeError):
        raise ArtifactForbidden("the authorized artifact root is unavailable") from None
    if not root.is_dir():
        raise ArtifactForbidden("the authorized artifact root is not a directory")
    return root


def _source_name(document: Mapping[str, Any]) -> str:
    for key in _SOURCE_KEYS:
        value = document.get(key)
        if isinstance(value, str) and value:
            return value
    raise ArtifactNotFound("the presented HTML source is no longer available")


def _reject_path_syntax(raw: Any) -> str:
    if not isinstance(raw, str) or not raw or "\x00" in raw:
        raise ArtifactForbidden("the document names an unsafe artifact")
    # Records are persisted with POSIX separators, but reject Windows forms
    # too: this code is also exercised on POSIX hosts and must not interpret a
    # Windows drive or UNC path as an innocent relative name there.
    if ntpath.isabs(raw) or raw.startswith(("/", "\\")):
        raise ArtifactForbidden("the document names an unsafe artifact")
    parts = raw.replace("\\", "/").split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ArtifactForbidden("the document names an unsafe artifact")
    if any(_sensitive_part(part) for part in parts):
        raise ArtifactForbidden("the document names a protected artifact")
    return "/".join(parts)


def _safe_source_path(root: Path, raw: str) -> Path:
    normalized = _reject_path_syntax(raw)
    try:
        candidate = (root / Path(*normalized.split("/"))).resolve(strict=False)
    except (OSError, RuntimeError):
        # RuntimeError covers a symlink loop.  Do not let filesystem details or
        # the resolved path escape through a framework's 500 response.
        raise ArtifactForbidden("the document artifact is outside its authorized root") from None
    if not _contained(root, candidate):
        raise ArtifactForbidden("the document artifact is outside its authorized root")
    return candidate


def _contained(root: Path, candidate: Path) -> bool:
    try:
        return os.path.commonpath((os.path.normcase(str(root)),
                                   os.path.normcase(str(candidate)))) == os.path.normcase(str(root))
    except ValueError:
        return False


def _read_file(path: Path, *, source_is_required: bool) -> bytes:
    try:
        if not path.is_file():
            raise OSError
        return path.read_bytes()
    except OSError:
        if source_is_required:
            raise ArtifactNotFound("the presented HTML source is no longer available") from None
        raise ArtifactNotFound("a presented HTML local asset is no longer available") from None


def _asset_manifest(document: Mapping[str, Any]) -> Any:
    for key in _ASSET_KEYS:
        if key in document:
            value = document[key]
            if value is None:
                return []
            if isinstance(value, (str, Mapping, Sequence)) and not isinstance(value, (bytes, bytearray)):
                return value
            raise ArtifactForbidden("the document local-asset manifest is invalid")
    return []


def _source_parent(source_name: str) -> str:
    normalized = source_name.replace("\\", "/")
    parent = normalized.rsplit("/", 1)[0] if "/" in normalized else ""
    return parent


def _source_archive_name(source_name: str) -> str:
    normalized = _reject_path_syntax(source_name)
    return _safe_archive_name(normalized.rsplit("/", 1)[-1])


def _asset_entries(manifest: Any, source_parent: str) -> list[tuple[str, str]]:
    if isinstance(manifest, Mapping):
        raw_entries = [(str(name), source) for name, source in manifest.items()]
    elif isinstance(manifest, str):
        raw_entries = [(manifest, manifest)]
    else:
        try:
            raw_entries = []
            for item in manifest:
                if isinstance(item, str):
                    raw_entries.append((item, item))
                elif isinstance(item, Mapping):
                    source = item.get("path", item.get("file", item.get("source")))
                    name = item.get("name", item.get("archive_path", item.get("target")))
                    if not isinstance(source, str) or not source:
                        raise ArtifactForbidden("the document local-asset manifest is invalid")
                    raw_entries.append((str(name) if name else source, source))
                else:
                    raise ArtifactForbidden("the document local-asset manifest is invalid")
        except TypeError:
            raise ArtifactForbidden("the document local-asset manifest is invalid") from None

    result: list[tuple[str, str]] = []
    for archive_ref, source_ref in raw_entries:
        if not isinstance(source_ref, str) or not source_ref:
            raise ArtifactForbidden("the document local-asset manifest is invalid")
        source = _reject_path_syntax(source_ref)
        archive = _reject_path_syntax(archive_ref)
        # Asset references are naturally written relative to the HTML page.
        # A persisted path that already starts at the page directory is kept
        # root-relative; otherwise resolve it beside that page.  This keeps
        # both ``outbox/assets/app.js`` and ``assets/app.js`` useful inputs.
        if source_parent and not source.startswith(source_parent + "/"):
            source = f"{source_parent}/{source}"
        # Plain entries conventionally point beside the HTML source.  Explicit
        # archive names are already relative to the ZIP root and are retained.
        if archive == source_ref.replace("\\", "/") and source_parent:
            archive = source_ref.replace("\\", "/")
            if archive.startswith(source_parent + "/"):
                archive = archive[len(source_parent) + 1:]
        result.append((source, _safe_archive_name(archive)))
    return result


def _safe_archive_name(raw: str) -> str:
    normalized = _reject_path_syntax(raw)
    if normalized.lower().endswith((".credentials.json", "/.bridge", "/.claude.json")):
        raise ArtifactForbidden("the document asset manifest names a protected artifact")
    return normalized


def _sensitive_part(part: str) -> bool:
    lowered = part.lower()
    return lowered in _SENSITIVE_PARTS or lowered in _SENSITIVE_NAMES


def _zip_bytes(entries: Sequence[tuple[str, bytes]]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, strict_timestamps=False) as archive:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=_ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o600 << 16
            archive.writestr(info, data)
    return output.getvalue()


__all__ = [
    "ArtifactDownloadError", "ArtifactNotFound", "ArtifactNotFoundError",
    "ArtifactForbidden", "ArtifactForbiddenError", "DownloadArtifact",
    "HtmlSnapshot", "build_document_download", "build_download",
    "snapshot_html_bundle",
]
