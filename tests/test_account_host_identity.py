"""GET /api/accounts `host_identity`: WHO each provider's `default` login is.

The reported defect (user, 2026-09-12): the agent account-swap selector said
`default · email unavailable` while the Usage modal, one modal away, named
that same signed-in account by address. The cause is that the selector read
the address off the AMBIENT REGISTRY ROW and a machine login migration has
not registered has no row at all — on the reporting machine the registry held
two secondary accounts and nothing else.

So the payload that feeds the selector now carries the host logins BESIDE the
rows, read from the same functions the usage lanes read them from. These
tests pin the three things that make that safe: it is present even with an
EMPTY registry (the reported shape), it is the observed address rather than
an invented one, and an address nobody has observed stays `None` instead of
costing a subprocess to guess at.
"""
import asyncio
import os
import tempfile
import unittest


class HostIdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="orgtree-hostidentity-")
        os.environ["ORGTREE_DATA"] = cls.root
        from engine.backend.orgtree import (
            accounts, accountusage, api, providers, registry, store,
        )
        if not str(store.DATA_ROOT).lower().startswith(cls.root.lower()):
            raise AssertionError(f"store bound outside fixture: {store.DATA_ROOT}")
        cls.accounts = accounts
        cls.accountusage = accountusage
        cls.api = api
        cls.providers = providers
        cls.registry = registry

    def setUp(self):
        path = self.registry.registry_path()
        if os.path.exists(path):
            os.unlink(path)
        self._live = self.accounts.live_identity
        self._codex = self.providers._codex_account
        self._agy_cache = self.providers._antigravity_status_cache

    def tearDown(self):
        self.accounts.live_identity = self._live
        self.providers._codex_account = self._codex
        self.providers._antigravity_status_cache = self._agy_cache

    def _observe(self, *, claude="", codex=None, antigravity=None):
        self.accounts.live_identity = lambda: {"uuid": "u" if claude else "",
                                               "email": claude}
        self.providers._codex_account = lambda home=None: {
            "connected": codex is not None, "email": codex, "kind": "chatgpt"}
        self.providers._antigravity_status_cache = (
            None if antigravity is None else (0.0, {"email": antigravity}))

    def test_reports_each_provider_host_login_address(self):
        self._observe(claude="host@example.com", codex="codex@example.com",
                      antigravity="agy@example.com")
        self.assertEqual(self.accountusage.host_identities(), {
            "claude": {"email": "host@example.com"},
            "openai": {"email": "codex@example.com"},
            "google": {"email": "agy@example.com"},
        })

    def test_unobserved_address_stays_unknown(self):
        # nobody signed in anywhere: every answer is None, and none of them is
        # a label, a digest or a guess. `email unavailable` stays honest.
        self._observe()
        self.assertEqual(self.accountusage.host_identities(), {
            "claude": {"email": None},
            "openai": {"email": None},
            "google": {"email": None},
        })

    def test_antigravity_takes_only_what_is_already_cached(self):
        # its address costs a CLI subprocess to observe fresh, and
        # /api/accounts is polled — so an uncached lane answers None rather
        # than spawning one. Poisoning the FETCHING reader (rather than the
        # prober it guards) fails whether or not this machine has the CLI.
        def explode(force=False):
            raise AssertionError("host_identities must not run the CLI")
        self._observe(antigravity=None)
        real = self.providers.antigravity_status
        self.providers.antigravity_status = explode
        try:
            self.assertIsNone(
                self.accountusage.host_identities()["google"]["email"])
        finally:
            self.providers.antigravity_status = real
        # and when another surface HAS observed it, that observation is used
        self._observe(antigravity="agy@example.com")
        self.assertEqual(
            self.accountusage.host_identities()["google"]["email"],
            "agy@example.com")

    def test_empty_registry_still_names_the_default_login(self):
        # THE REPORTED SHAPE: no rows at all, so nothing carries the address
        # and the old ambient-row read had nothing to find.
        self._observe(claude="host@example.com")
        payload = asyncio.run(self.api.accounts_list())
        self.assertEqual(payload["accounts"], [])
        self.assertEqual(payload["host_identity"]["claude"]["email"],
                         "host@example.com")

    def test_registered_rows_do_not_displace_the_host_identity(self):
        # the reporting machine's exact registry: two SECONDARY accounts and
        # no ambient row. Their own addresses stay their own; `default` is
        # still answered beside them.
        self._observe(claude="host@example.com", codex="codex@example.com")
        self.registry.create_account(
            "claude", "claude-0",
            {"kind": "managed", "path": os.path.join(self.root, "second")})
        payload = asyncio.run(self.api.accounts_list())
        self.assertEqual(len(payload["accounts"]), 1)
        self.assertFalse(payload["accounts"][0]["ambient"])
        self.assertEqual(payload["host_identity"], {
            "claude": {"email": "host@example.com"},
            "openai": {"email": "codex@example.com"},
            "google": {"email": None},
        })


if __name__ == "__main__":
    unittest.main()
