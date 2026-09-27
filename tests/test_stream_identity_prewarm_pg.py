"""Run read-only prewarming against an owned PostgreSQL database."""
import unittest
import test_stream_identity_pg as database
import test_stream_identity_prewarm as fixture


@unittest.skipUnless(database.ADMIN, 'ORGTREE_TEST_PG_ADMIN_URL not set: NOT RUN')
class PostgresPrewarm(fixture.StreamIdentityPrewarm):
    @classmethod
    def setUpClass(cls):
        database.PostgresStreamIdentity.setUpClass()


tearDownModule = database.tearDownModule

if __name__ == '__main__':
    unittest.main()
