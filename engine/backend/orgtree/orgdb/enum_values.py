"""Closed value sets of the current org writers; SQL types and base DDL stay unchanged.

Sources are recorded in docs/state-system/org-enum-inventory.md. Open labels,
provider payloads and recorded descriptions are deliberately not enum sets.
"""

PERMISSION = ('plan', 'default', 'acceptEdits', 'bypassPermissions')
VISIBILITY = ('self', 'team', 'subtree', 'full')
EFFORT = ('low', 'medium', 'high', 'xhigh', 'max', '')
DIR_MODE = ('rw', 'ro')
WORK_STATUS = ('backlogged', 'open', 'in_progress', 'blocked', 'review', 'approved',
               'deploy_ready', 'done', 'superseded', 'dropped')
EXECUTION = ('independent', 'owner_report', 'source_inspection')
CLASSIFICATION = ('met', 'not_exercised', 'environment_limited', 'known_negative')
RESULT = ('passed', 'expected_negative', 'failed', 'crashed', 'not_executed')
DISPOSITION = ('open', 'fixed', 'rejected', 'deferred', 'duplicate')
STAGE = ('implemented', 'committed', 'pushed', 'deployed', 'in_build')
MAIL_KIND = ('message', 'question', 'request', 'decision', 'status', 'notice', 'watchdog')
SEQ_ORIGIN = ('deposit', 'migration_unproven', 'unresolved_mailbox')
SCOPE_KIND = ('dir', 'tool', 'mcp', 'permission_mode')
SCOPE_DECISION = ('approve', 'deny', 'skip', 'approve (clamped — not in effect)',
                  'approve (partial)')
WORK_SCOPE_KIND = ('objective', 'acceptance', 'decision')
WORK_SCOPE_MODE = ('append', 'replace')
