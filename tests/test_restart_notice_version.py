"""The restart notice names the installed release, end to end.

The notice is the one message every live agent gets when the backend comes back,
and until now it identified the running build only by commit. A commit is what an
agent checks ancestry against; the version is what a PERSON knows their own
installation by, and reading `ab3453b` told them nothing about whether the build
they installed by hand is the one that restarted.

These tests drive the real `restart_wake.on_backend_startup()` sweep against a
throwaway data root, so what they assert is the notice that is actually written
into a mailbox — not a rendering helper called in isolation. The version is the
field most likely to be missing or wrong, and it is the least important field in
the message, so the cases below are weighted accordingly: one proves it arrives,
and the rest prove that its absence costs nothing else.
"""
from __future__ import annotations

import os
from pathlib import Path
import tempfile
import unittest

_root = tempfile.TemporaryDirectory(prefix='restart-notice-version-')
_data = Path(_root.name) / 'data'; _data.mkdir()
_home = Path(_root.name) / 'home'; _home.mkdir()
os.environ.update(ORGTREE_DATA=str(_data), HOME=str(_home),
                  USERPROFILE=str(_home), ORGTREE_V2_TOKEN='operator')
for _key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(_key, None)
from engine.launch import load_app
load_app()
from orgtree import store, ledger, restart_wake

assert Path(store.DATA_ROOT).resolve() == _data.resolve(), store.DATA_ROOT

SHA = '0123456789abcdef0123456789abcdef01234567'
SLUGS: list[str] = []


def tearDownModule():
    for slug in SLUGS:
        store._POOL.close_all(slug)
    _root.cleanup()


class RestartNoticeVersionDeliveryTests(unittest.TestCase):

    def setUp(self):
        restart_wake._reset_boot_build_info_for_tests()
        restart_wake._reset_startup_done_for_tests()

    def tearDown(self):
        restart_wake._reset_boot_build_info_for_tests()
        restart_wake._reset_startup_done_for_tests()

    def notice_for(self, slug, boot):
        """Run the real startup sweep and return the notice a live agent got."""
        SLUGS.append(slug)
        org = store.create_org(slug)
        org.hire(ledger.USER, None, 'haiku', 0, 'watcher')
        store.save_org(org)
        restart_wake._reset_boot_build_info_for_tests({
            'commit': SHA, 'commit_short': SHA[:7], 'branch': None, 'dirty': False,
            'backend_pid': 1344, 'started_at': '2026-09-15T15:50:33Z', **boot})
        restart_wake._reset_startup_done_for_tests()
        restart_wake.on_backend_startup()
        box = store.load_org(slug).d.get('mail', {}).get('watcher', [])
        notices = [m for m in box if m.get('restart_notice')]
        self.assertEqual(len(notices), 1, box)
        return notices[0]['body']

    # ------------------------------------------------------ the version is there
    def test_a_packaged_release_names_itself_in_the_delivered_notice(self):
        body = self.notice_for('notice-packaged',
                               {'provenance': 'packaged', 'version': '2.1.5-beta.4'})
        self.assertIn('- Installed version: 2.1.5-beta.4', body)

    def test_a_packaged_development_build_is_not_dressed_up_as_a_release(self):
        body = self.notice_for('notice-devchannel',
                               {'provenance': 'packaged',
                                'version': '2.0.9-dev.gab12cd34ef'})
        self.assertIn('- Installed version: 2.0.9-dev.gab12cd34ef', body)

    # ------------------------------------- and its absence is stated, not faked
    def test_a_source_checkout_says_so_instead_of_reporting_a_failure(self):
        body = self.notice_for('notice-source', {'provenance': 'source', 'version': None})
        self.assertIn('- Installed version: not applicable (running from a source checkout)',
                      body)

    def test_unreadable_metadata_says_unavailable_and_names_no_number(self):
        body = self.notice_for('notice-unreadable',
                               {'provenance': 'packaged', 'version': None})
        line = next(l for l in body.splitlines() if l.startswith('- Installed version:'))
        self.assertEqual(line, '- Installed version: unavailable (no packaged build metadata)')
        self.assertNotRegex(line, r'\d+\.\d+\.\d+')

    # ------------------------------------- and cannot cost the notice or startup
    def test_a_boot_record_with_no_version_key_at_all_still_delivers(self):
        """An older build's frozen boot record has no `version`. Startup must
        not raise KeyError partway through the org sweep and leave some
        mailboxes noticed and the rest silent."""
        body = self.notice_for('notice-legacy-boot', {'provenance': 'packaged'})
        self.assertIn('[ORGTREE RESTART NOTICE]', body)
        self.assertIn('- Installed version: unavailable', body)

    def test_the_fields_the_notice_already_carried_all_survive(self):
        """A new line at the top of the block is exactly the change that
        quietly drops one below it."""
        body = self.notice_for('notice-preserves',
                               {'provenance': 'packaged', 'version': '2.1.5-beta.4',
                                'branch': 'feature/w22'})
        for expected in (
            '[ORGTREE RESTART NOTICE] The backend was restarted.',
            f'- Commit: {SHA} (short: {SHA[:7]})',
            '- Identity provenance: packaged',
            '- Backend PID: 1344',
            '- Started at: 2026-09-15T15:50:33Z, branch: feature/w22',
            f'git merge-base --is-ancestor <your-commit> {SHA}',
            'orgtree_restart_wake',
        ):
            self.assertIn(expected, body)

    def test_a_dirty_build_keeps_both_its_warning_and_its_version(self):
        body = self.notice_for('notice-dirty',
                               {'provenance': 'packaged', 'version': '2.1.5-beta.4',
                                'dirty': True})
        self.assertIn('- Installed version: 2.1.5-beta.4', body)
        self.assertIn('[DIRTY - uncommitted changes present at boot]', body)

    def test_the_wake_path_reports_the_same_version_as_the_notice(self):
        """An agent with an armed toggle gets a different message for the same
        restart. Two wordings of one fact is how they drift apart."""
        slug = 'notice-wake'
        SLUGS.append(slug)
        org = store.create_org(slug)
        org.hire(ledger.USER, None, 'haiku', 0, 'armed')
        store.save_org(org)
        restart_wake._reset_boot_build_info_for_tests({
            'commit': SHA, 'commit_short': SHA[:7], 'branch': None, 'dirty': False,
            'provenance': 'packaged', 'version': '2.1.5-beta.4',
            'backend_pid': 1344, 'started_at': '2026-09-15T15:50:33Z'})
        restart_wake.arm_restart_wake(slug, 'armed', 'user', reason='checking the build')
        restart_wake._reset_startup_done_for_tests()
        sent: list[str] = []
        original = restart_wake.supervisor.send_message
        restart_wake.supervisor.send_message = (
            lambda s, n, text, **kw: sent.append(text))
        try:
            restart_wake.on_backend_startup()
        finally:
            restart_wake.supervisor.send_message = original
        self.assertEqual(len(sent), 1, sent)
        self.assertIn('[ORGTREE RESTART WAKE]', sent[0])
        self.assertIn('- Installed version: 2.1.5-beta.4', sent[0])
        self.assertIn(f'- Commit: {SHA}', sent[0])


if __name__ == '__main__':
    unittest.main()
