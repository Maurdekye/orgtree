import ctypes
import unittest

from ctypes import wintypes as w

from engine.winservice.s4u import MSV1_0_S4U_LOGON, S4ULogon, S4UIdentity, s4u_packet


class S4UPacketTests(unittest.TestCase):
    def test_contiguous_names_and_no_password_field(self):
        packet = s4u_packet("operator", "MACHINE")
        request = ctypes.cast(packet, ctypes.POINTER(S4ULogon)).contents
        start = ctypes.addressof(packet)
        end = start + len(packet)
        self.assertEqual(request.MessageType, MSV1_0_S4U_LOGON)
        self.assertTrue(start <= request.UserPrincipalName.Buffer < end)
        self.assertTrue(start <= request.DomainName.Buffer < end)
        self.assertEqual(request.UserPrincipalName.Length, len("operator".encode("utf-16-le")))
        self.assertEqual(request.DomainName.Length, len("MACHINE".encode("utf-16-le")))

    def test_rejects_empty_or_embedded_nul_name(self):
        for name in ("", "a\x00b"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                s4u_packet(name)

    def test_admin_membership_uses_temporary_impersonation_token(self):
        calls = []

        class Advapi:
            def GetLengthSid(self, _sid):
                return 16

            def SetTokenInformation(self, *_args):
                calls.append("medium")
                return True

            def DuplicateToken(self, token, level, output):
                calls.append(("duplicate", int(token.value), level))
                ctypes.cast(output, ctypes.POINTER(w.HANDLE))[0] = 77
                return True

            def CheckTokenMembership(self, token, _sid, output):
                calls.append(("membership", int(token.value)))
                ctypes.cast(output, ctypes.POINTER(w.BOOL))[0] = False
                return True

        class Kernel:
            def CloseHandle(self, token):
                calls.append(("close", int(token.value)))

            def LocalFree(self, _sid):
                pass

        identity = S4UIdentity.__new__(S4UIdentity)
        identity.advapi = Advapi()
        identity.kernel = Kernel()
        identity._sid = lambda _text: ctypes.c_void_p(1)
        identity._restrict_to_medium(42)
        self.assertEqual(calls, ["medium", ("duplicate", 42, 2),
                                 ("membership", 77), ("close", 77)])


if __name__ == "__main__":
    unittest.main()
