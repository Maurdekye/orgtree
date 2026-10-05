"""Ordered assembly for org panel record readers and additive migrations.

B4c2 appends its declarations/readers here after B4c1. Runtime activation is
separate and only switches on with the complete panel migration and renderer.
"""
from __future__ import annotations

from . import record_shared_panels as shared, record_history as history
from . import record_mail as mail, record_mail_sql as mail_sql
from .record_panel_sql import Extension
from .record_registry import Registry

SHARED = Extension('shared_inbox_events', shared.dependencies, shared.WINDOWS, prepare=shared.PREPARE)
HISTORY = Extension('agent_history', history.dependencies, (history.WINDOW,), history.BEFORE, history.AFTER, history.PREPARE)
MAIL = Extension('agent_mail', mail_sql.dependencies, after=mail_sql.AFTER, prepare=mail_sql.PREPARE)
EXTENSIONS = (SHARED, HISTORY, MAIL)


def register(registry: Registry) -> Registry:
    return mail.register(history.register(shared.register(registry)))
