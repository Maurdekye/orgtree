import unittest

from engine.winservice.session_token import (
    MEDIUM_INTEGRITY, TokenFacts, valid_operator_logon,
)


class TokenFactsTests(unittest.TestCase):
    def test_only_matching_real_medium_logon_is_accepted(self):
        expected = "S-1-5-21-10-20-30-1001"
        good = TokenFacts(expected, 4, 2, 3, MEDIUM_INTEGRITY)
        self.assertTrue(valid_operator_logon(good, expected, 4))
        for facts in (
            TokenFacts("S-1-5-18", 4, 2, 3, MEDIUM_INTEGRITY),
            TokenFacts(expected, 5, 2, 3, MEDIUM_INTEGRITY),
            TokenFacts(expected, 4, 4, 3, MEDIUM_INTEGRITY),
            TokenFacts(expected, 4, 2, 2, MEDIUM_INTEGRITY),
            TokenFacts(expected, 4, 2, 3, 0x3000),
        ):
            with self.subTest(facts=facts):
                self.assertFalse(valid_operator_logon(facts, expected, 4))


if __name__ == "__main__":
    unittest.main()
