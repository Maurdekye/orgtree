import ctypes
import unittest

from engine.winservice.s4u import MSV1_0_S4U_LOGON, S4ULogon, s4u_packet


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


if __name__ == "__main__":
    unittest.main()
