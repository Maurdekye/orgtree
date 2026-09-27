"""Replay preserved audit rows through the peer's exact launch classifier."""
import shutil
from pathlib import Path
from launch_guard import LaunchAudit


def audit_for(root):
    root = Path(root)
    return LaunchAudit(root, git=shutil.which('git'),
        providers=[str(root/'no-cli'/'claude.exe'), str(root/'no-cli'/'codex.exe')],
        agy=shutil.which('agy'))


def unexpected(audit, row):
    return audit.classify(row['event'], (row.get('executable'), row.get('argv'))) == 'unexpected'
