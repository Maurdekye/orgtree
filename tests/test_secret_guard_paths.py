"""The registry secret guard must accept filesystem paths and still refuse tokens."""
import unittest

from engine.backend.orgtree.accounts import SecretInRegistry, _reject_secrets

MAC_TMP = "/var/folders/gb/vjnzmng53glbvzpmncgly_1w0000gn/T/tmpwy8ihr4g"
OPAQUE = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3A"


def _wrap(value):
    return {"accounts": [{"credential": {"kind": "managed", "path": value}}]}


class SecretGuardPaths(unittest.TestCase):
    def test_paths_are_accepted(self):
        for value in (
            MAC_TMP,
            "~/Library/Application Support/orgtree/accounts/abcdef0123456789abcdef",
            "C:\\Users\\someone\\AppData\\Local\\Temp\\orgtree-registry-abcdefghijklmnop",
        ):
            with self.subTest(value=value):
                _reject_secrets(_wrap(value))

    def test_secrets_still_rejected(self):
        for value in (
            "sk-ant-api03-abc123",
            "eyJhbGciOiJIUzI1NiJ9.payload.sig",
            OPAQUE,
            OPAQUE[:20] + "/" + OPAQUE[20:],
            "/" + OPAQUE,
            "/var/tmp/" + OPAQUE,
            "sk-ant-oat01-abc/def",
        ):
            with self.subTest(value=value):
                with self.assertRaises(SecretInRegistry):
                    _reject_secrets(_wrap(value))


if __name__ == "__main__":
    unittest.main()
