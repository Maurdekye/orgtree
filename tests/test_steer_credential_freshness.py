"""Credential revocation before feed delivery (review-astra's lag probe).

The cache delay here is deterministic, simulated on SQLite. The separate
test_steer_credential_pg module covers a real second-process PG commit.
"""
import json
import sqlite3
from contextlib import closing
import unittest
from unittest.mock import patch
import test_steer_poll_cost as fixture
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout


class FeedLagTests(unittest.TestCase):
    CHEAP = True
    setUp = fixture.SteerPollCostTests.setUp
    tearDown = fixture.SteerPollCostTests.tearDown
    token = fixture.SteerPollCostTests.token
    poll = fixture.SteerPollCostTests.poll
    carrier = fixture.SteerPollCostTests.carrier
    edit = fixture.SteerPollCostTests.edit

    def _revoked(self, cheap, change=None):
        token = self.token()
        self.assertEqual(self.poll(token).status_code, 200)
        self.carrier('mail for the new generation')
        old = fixture.store.cached_org(self.slug)
        generation = old.node(fixture.W)['generation']
        self.edit(change or (lambda org: org.node(fixture.W).__setitem__('generation', generation + 1)))
        if change is None:
            self.assertEqual(fixture.orgtx.org_read(self.slug).node(fixture.W)['generation'], generation + 1)
        self.assertEqual(old.node(fixture.W)['generation'], generation)
        # An external commit is visible to org_read before its asynchronous
        # pgfeed notification invalidates this process's cached_org snapshot.
        cached = fixture.store.cached_org
        with patch.object(fixture.sup, 'STEER_CHEAP', cheap), patch.object(
                fixture.store, 'cached_org', side_effect=lambda slug: old if slug == self.slug else cached(slug)):
            response = self.poll(token)
        self.assertEqual(response.status_code, 403, response.text)
        with patch.object(fixture.sup, 'STEER_CHEAP', cheap), \
                patch.object(fixture.store, 'cached_org', return_value=old), \
                patch.object(fixture.sup, 'ack_steer', return_value={}) as ack:
            response = self.client.post(
                f'/api/orgs/{self.slug}/nodes/{fixture.W}/steer/ack',
                headers={'x-orgtree-agent-token': token},
                json={'delivery_id': 'revoked-delivery', 'tool_use_id': 'revoked-tool'})
            self.assertEqual(response.status_code, 403, response.text)
            ack.assert_not_called()

    def test_off_rejects_revoked_token_before_feed_notification(self):
        self._revoked(False)

    def test_on_rejects_revoked_token_before_feed_notification(self):
        self._revoked(True)

    def test_on_rejects_replaced_seat_before_feed_notification(self):
        self._revoked(True, lambda org: org.node(fixture.W).__setitem__('seat_id', 'replacement'))

    def test_on_rejects_archived_seat_before_feed_notification(self):
        self._revoked(True, lambda org: org.node(fixture.W).__setitem__('state', 'archived'))

    def test_on_rejects_deleted_seat_before_feed_notification(self):
        self._revoked(True, lambda org: org.delete(fixture.ledger.USER, fixture.W))

    def test_row_projection_contains_only_credential_fields(self):
        self.edit(lambda org: org.node(fixture.W).__setitem__('charter', 'large charter' * 10000))
        expected = fixture.orgtx.org_read(self.slug).node(fixture.W)
        with patch.object(fixture.store, 'load_org', side_effect=AssertionError('full load')), \
                patch.object(fixture.orgtx, 'org_read', side_effect=AssertionError('full read')):
            self.assertEqual(fixture.store.read_node_credential(self.slug, fixture.W),
                             {k: expected[k] for k in ('state', 'generation', 'seat_id')})
            self.assertEqual(fixture.store.read_node_credential(self.slug, 'missing'), {})

    def test_legacy_seat_fallback_reads_committed_state(self):
        self.poll()
        old = fixture.store.cached_org(self.slug)
        # Simulate a stored pre-seat-id row; Org supplies its deterministic
        # legacy seat, which differs from the stale cached seat.
        with closing(sqlite3.connect(fixture.store._db_path(self.slug))) as conn, conn:
            row = json.loads(conn.execute('SELECT val FROM nodes WHERE id=?', (fixture.W,)).fetchone()[0])
            row.pop('seat_id')
            conn.execute('UPDATE nodes SET val=? WHERE id=?', (json.dumps(row), fixture.W))
        self.assertIsNone(fixture.store.read_node_credential(self.slug, fixture.W))
        current = fixture.orgtx.org_read(self.slug).node(fixture.W)
        self.assertNotEqual(current['seat_id'], old.node(fixture.W)['seat_id'])
        token = fixture.agentauth.node_env(self.slug, fixture.W, current)['ORGTREE_AGENT_TOKEN']
        with patch.object(fixture.store, 'cached_org', return_value=old):
            self.assertEqual(self.poll(token).status_code, 200)

    def test_unsupported_row_fallback_does_not_accept_stale_snapshot(self):
        with patch.object(fixture.store, 'row_store', return_value=False):
            self.assertIsNone(fixture.store.read_node_credential(self.slug, fixture.W))
        with patch.object(fixture.store, 'read_node_credential', return_value=None):
            self._revoked(True)


def tearDownModule():
    fixture.tearDownModule()


if __name__ == '__main__':
    unittest.main()
