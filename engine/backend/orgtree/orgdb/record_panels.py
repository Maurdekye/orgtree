"""Ordered assembly for org panel record readers and additive migrations.

B4c2 appends its declarations/readers here after B4c1. Runtime activation is
separate and only switches on with the complete panel migration and renderer.
"""
from __future__ import annotations

from . import record_shared_panels as shared
from .record_panel_sql import Extension
from .record_registry import Registry

SHARED = Extension('shared_inbox_events', shared.dependencies, shared.WINDOWS)
EXTENSIONS = (SHARED,)


def register(registry: Registry) -> Registry:
    return shared.register(registry)
