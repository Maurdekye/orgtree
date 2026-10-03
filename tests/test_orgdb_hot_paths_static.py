"""Captured SQL guards complement plans that can hide partial-index predicates."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import re
import unittest


TOKENS = re.compile(r"--[^\n]*|/\*.*?\*/|'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|"
                    r"ORDER\s+BY|GROUP\s+BY|->>?|#>>?|::\s*json(?:b)?\b|"
                    r"[()]|[A-Za-z_][A-Za-z_0-9]*", re.I | re.S)
JSON_TOKEN = re.compile(r"->|#>|::\s*json|json(?:b)?_extract_path", re.I)


def hot_sql_violations(statement):
    """Find JSON in predicates/order, allowing selected body projections.

    Track clauses per parenthesis depth: a subquery SELECT starts a new
    projection, whereas parentheses inside a WHERE retain its predicate.
    Quoted values, identifiers and comments cannot introduce clause keywords.
    This inspects authored SQL too, so a partial index cannot hide its WHERE.
    """
    hot, found = [False], []
    for match in TOKENS.finditer(statement):
        token = match.group()
        upper = re.sub(r'\s+', ' ', token.upper())
        if token.startswith(("'", '"', '--', '/*')):
            continue
        if token == '(':
            hot.append(hot[-1])
        elif token == ')':
            if len(hot) > 1:
                hot.pop()
        elif upper in ('WHERE', 'ON', 'HAVING', 'ORDER BY'):
            hot[-1] = True
        elif upper in ('SELECT', 'FROM', 'GROUP BY', 'LIMIT', 'OFFSET',
                       'UNION', 'INTERSECT', 'EXCEPT', 'RETURNING'):
            hot[-1] = False
        elif hot[-1] and JSON_TOKEN.search(token):
            found.append('JSON lookup in captured SQL predicate/order: ' + token)
    return found


class CapturedSql(unittest.TestCase):
    def test_distinct_from_operator_keeps_predicate_context(self):
        for comparison in ('IS DISTINCT FROM', 'IS NOT DISTINCT FROM'):
            with self.subTest(comparison=comparison):
                self.assertTrue(hot_sql_violations("SELECT id FROM history WHERE kind "
                    + comparison + " 'folded' AND (changes->'status') IS NOT NULL"))

    def test_partial_index_cannot_hide_authored_json_predicate(self):
        self.assertTrue(hot_sql_violations("SELECT id FROM history WHERE item_id=%s "
                                          "AND (op='update' AND changes->'status' IS NOT NULL)"))

    def test_body_and_nested_projection_are_allowed(self):
        self.assertFalse(hot_sql_violations("SELECT DISTINCT extra->>'owner' FROM watchdogs"))
        self.assertFalse(hot_sql_violations("SELECT id FROM agents WHERE EXISTS "
            "(SELECT body::json->'field' FROM bodies WHERE bodies.id=agents.id)"))

    def test_nested_predicate_order_cast_and_function_are_caught(self):
        for sql in ("SELECT id FROM agents WHERE EXISTS (SELECT id FROM bodies WHERE extra->>'x'='yes')",
                    "SELECT id FROM agents ORDER BY (extra#>>'{name}')",
                    "SELECT id FROM agents WHERE body::jsonb IS NOT NULL",
                    "SELECT id FROM agents WHERE json_extract_path(body,'x') IS NOT NULL"):
            with self.subTest(sql=sql):
                self.assertTrue(hot_sql_violations(sql))

    def test_quotes_comments_and_projection_do_not_change_clause_state(self):
        self.assertFalse(hot_sql_violations("SELECT 'WHERE -> fake', extra->'x' AS \"ORDER BY\" "
            "FROM bodies /* WHERE extra->'x' */ WHERE id=%s -- ORDER BY body::json\n"))
        self.assertTrue(hot_sql_violations("SELECT body FROM bodies WHERE (extra->'x') IS NOT NULL"))


if __name__ == '__main__':
    unittest.main()
