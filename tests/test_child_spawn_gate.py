"""Gate: a test file may not start ``sys.executable`` directly unless it is
allowlisted here with the reason it is safe.

A child Python started with ``sys.executable`` runs the MAIN checkout's
interpreter, whose ``python313._pth`` ignores PYTHONPATH and cwd and resolves
``orgtree``/``engine``/``tools`` from the main checkout -- so a worktree's test
silently tests main (child-python-tests-import-the-main-checkout-s-or). New
children go through ``tests/child_python.py``::

    subprocess.run(child_python.argv('-c', code, *args), ...)

which puts this checkout first and refuses (exit 97) otherwise.

The allowlist pins the exact number of ``sys.executable`` mentions per file, so
a NEW spawn added to an already-listed file fails too; a count that drops
fails as well, to keep the list true. If this test fails for your change:
use ``child_python.argv``; or, if the child genuinely imports no checkout code
or roots itself from its own ``__file__``, update the entry with the reason.
"""
import re
import unittest
from pathlib import Path

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

TESTS = Path(__file__).resolve().parent
MENTION = re.compile(r'\bsys\.executable\b')

HELPER = 'the helper itself, or its own test (whose control spawns a bare child on purpose)'
SELF = ('the child puts this checkout on sys.path itself -- from its own __file__, an explicit '
        'argv/env root or the parent\'s sys.path -- and most assert it')
TOOL = 'runs a tool or engine script by path that roots itself from its own __file__'
NOIMPORT = 'the child imports no checkout code (fake CLI, stdlib hook, -c pass/sleep/exit)'
NOSPAWN = 'names sys.executable without starting a child Python here (record, identity, mocked)'
MAILHUB = ('runs the mail hub submodule\'s own tests; not an orgtree import (submodule not '
           'checked out in worktrees)')

# path relative to tests/ -> (exact mentions, why it is safe)
ALLOWED = {
    'acceptance/automation.py': (2, SELF),
    'acceptance/claude_engine.py': (1, NOSPAWN),
    'acceptance/management_engine.py': (1, NOSPAWN),
    'acceptance/run_claude.py': (2, TOOL),
    'acceptance/run_provider.py': (2, TOOL),
    'acceptance/verify_mcp.py': (1, NOSPAWN),
    'acceptance/visual_engine.py': (1, NOIMPORT),
    'child_python.py': (3, HELPER),
    'p02_contacts_probe.py': (1, TOOL),
    'pg_bootstrap_drill.py': (1, SELF),
    'pg_process_drill.py': (1, SELF),
    'restart_kill_probe.py': (3, SELF),
    'restart_mail_kill_probe.py': (4, SELF),
    'restart_reconcile_kill_probe.py': (4, SELF),
    'restart_reconcile_mutation_probe.py': (7, TOOL),
    'restart_rescue_mail_probe.py': (5, SELF),
    'test_antigravity_hook_command.py': (2, NOIMPORT),
    'test_antigravity_parity.py': (5, NOIMPORT),
    'test_antigravity_turn_result.py': (2, NOIMPORT),
    'test_assert_repo_import.py': (2, SELF),
    'test_background_tasks_stop.py': (2, NOIMPORT),
    'test_census_contact_overhead.py': (1, TOOL),
    'test_child_python.py': (2, HELPER),
    'test_claude_pipe_lifecycle.py': (3, NOIMPORT),
    'test_engine_http.py': (2, SELF),
    'test_engine_work_deploy_ready.py': (1, SELF),
    'test_fence_default.py': (1, SELF),
    'test_freeze_classification.py': (1, NOIMPORT),
    'test_halt_lifecycle_settlement.py': (3, NOIMPORT),
    'test_hub_isolation.py': (2, SELF),
    'test_invariant_sweep_snapshot_gate.py': (1, NOIMPORT),
    'test_isolation_guards.py': (2, TOOL),
    'test_live_effort.py': (1, NOIMPORT),
    'test_mail_ownership.py': (1, SELF),
    'test_mailhub_repo.py': (1, MAILHUB),
    'test_operation_census_report.py': (4, TOOL),
    'test_p02_probe_provenance.py': (1, TOOL),
    'test_p02_replay_gate.py': (2, SELF),
    'test_pg5_load_tripwire.py': (2, TOOL),
    'test_pg_process.py': (1, NOIMPORT),
    # 1 SELF child (-c, puts this checkout on sys.path); 2 run tools/pypg/pgimport.py by
    # path (TOOL, it roots itself); 1 names sys.executable as a dummy --custodian
    # argument that is never started (NOSPAWN; added with the first-launch conversion).
    'test_pgimport.py': (4, f'{SELF}; {TOOL}; {NOSPAWN}'),
    'test_process_lifetime.py': (6, SELF),
    'test_provider_attempt_and_liveness.py': (2, NOIMPORT),
    'test_python_runner_skip_classification.py': (1, TOOL),
    'test_python_verification_runner.py': (3, NOSPAWN),
    'test_restart_replay_turnlog.py': (1, NOIMPORT),
    'test_s6_fable_wall_turn.py': (1, NOIMPORT),
    'test_scale_baseline.py': (1, NOIMPORT),
    'test_scale_controller_smoke.py': (1, TOOL),
    'test_scale_controls.py': (2, NOIMPORT),
    'test_scale_history_fixture.py': (1, TOOL),
    'test_scale_history_pg.py': (2, TOOL),
    'test_scale_switch_defaults.py': (1, SELF),
    'test_service_host.py': (7, TOOL),
    'test_startup_readiness.py': (2, TOOL),
    'test_state_audit_fixes.py': (2, NOIMPORT),
    'test_state_desktop_import_boundary.py': (1, NOIMPORT),
    'test_state_git_workspace_boundary.py': (1, NOIMPORT),
    'test_state_operation_contracts.py': (1, TOOL),
    'test_state_org_admin_boundary.py': (1, NOIMPORT),
    'test_state_org_read_boundary.py': (1, NOIMPORT),
    'test_steer_credential_pg.py': (1, SELF),
    'test_turn_end_stamp.py': (1, NOIMPORT),
    'test_turn_locals_org_copies.py': (1, NOIMPORT),
    'test_turn_org_state_shared.py': (1, NOIMPORT),
    'test_v3_qualification.py': (1, NOSPAWN),
    'test_v3_qualification_adapters.py': (5, NOSPAWN),
    'test_v3_qualification_ui.py': (8, TOOL),
    'test_work_evidence_receipts.py': (8, SELF),
}


def scan(root=TESTS):
    """{path relative to tests/: sys.executable mentions} for every .py file."""
    counts = {}
    for path in sorted(root.rglob('*.py')):
        if path.resolve() == Path(__file__).resolve():
            continue  # this gate only names it
        found = len(MENTION.findall(path.read_text(encoding='utf-8', errors='replace')))
        if found:
            counts[path.relative_to(root).as_posix()] = found
    return counts


def problems(counts, allowed=ALLOWED):
    out = []
    for rel, found in sorted(counts.items()):
        if rel not in allowed:
            out.append(f'{rel}: starts sys.executable directly ({found}x) and is not allowlisted -- '
                       f'use child_python.argv(...)')
        elif found != allowed[rel][0]:
            out.append(f'{rel}: {found} sys.executable mentions, allowlist says {allowed[rel][0]} -- '
                       f'a new spawn goes through child_python.argv(...); otherwise correct the count')
    for rel in sorted(set(allowed) - set(counts)):
        out.append(f'{rel}: allowlisted but no longer mentions sys.executable -- remove the entry')
    return out


class ChildSpawnGate(unittest.TestCase):
    def test_every_direct_spawn_is_allowlisted_with_a_reason(self):
        counts = scan()
        self.assertGreater(len(counts), 40, 'control: the scan found the spawning files')
        self.assertEqual(problems(counts), [])

    def test_the_gate_refuses_new_and_changed_spawns(self):
        counts = dict(scan())
        counts['test_new_child.py'] = 1
        counts['test_fence_default.py'] += 1
        del counts['test_mail_ownership.py']
        found = problems(counts)
        self.assertEqual(len(found), 3, found)
        self.assertTrue(any(p.startswith('test_new_child.py: starts') for p in found), found)
        self.assertTrue(any(p.startswith('test_fence_default.py: 2') for p in found), found)
        self.assertTrue(any('test_mail_ownership.py: allowlisted but no longer' in p for p in found), found)


if __name__ == '__main__':
    unittest.main()
