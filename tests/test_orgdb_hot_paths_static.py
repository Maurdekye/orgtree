"""Captured SQL guards complement plans that can hide partial-index predicates."""
import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

import re
import unittest


TOKENS = re.compile(r"--[^\n]*|/\*.*?\*/|'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|"
                    r"ORDER\s+BY|GROUP\s+BY|->>?|#>>?|::\s*json(?:b)?\b|"
                    r"[()]|[A-Za-z_][A-Za-z_0-9]*", re.I | re.S)
JSON_TOKEN = re.compile(r"->|#>|::\s*json|json(?:b)?_extract_path", re.I)
MIN_SCAN_PAGES = 16
BIG_TABLE_ROWS = 256


def is_read_statement(statement):
    return bool(re.match(r'\s*(SELECT|WITH)\b', statement, re.I))


def large_relations(rows, pages):
    """Require indexes once retained tables exceed the small-relation floor."""
    return {table for table, count in rows.items()
            if count >= BIG_TABLE_ROWS and pages[table] >= MIN_SCAN_PAGES}


def hot_sql_violations(statement):
    """Find JSON in predicates/order, allowing selected body projections.

    Track clauses per parenthesis depth: a subquery SELECT starts a new
    projection, whereas parentheses inside a WHERE retain its predicate.
    Quoted values, identifiers and comments cannot introduce clause keywords.
    This inspects authored SQL too, so a partial index cannot hide its WHERE.
    """
    hot, casts, found, previous = [False], [False], [], ''
    for match in TOKENS.finditer(statement):
        token = match.group()
        upper = re.sub(r'\s+', ' ', token.upper())
        if token.startswith(("'", '"', '--', '/*')):
            continue
        if token == '(':
            hot.append(hot[-1])
            casts.append(previous == 'CAST')
        elif token == ')':
            if len(hot) > 1:
                hot.pop()
                casts.pop()
        elif upper in ('WHERE', 'ON', 'HAVING', 'ORDER BY'):
            hot[-1] = True
        elif upper == 'FROM' and previous == 'DISTINCT':
            # IS [NOT] DISTINCT FROM is a comparison within this predicate.
            pass
        elif upper in ('SELECT', 'FROM', 'GROUP BY', 'LIMIT', 'OFFSET',
                       'UNION', 'INTERSECT', 'EXCEPT', 'RETURNING'):
            hot[-1] = False
        elif hot[-1] and (JSON_TOKEN.search(token) or
                         (casts[-1] and previous == 'AS' and upper in ('JSON', 'JSONB'))):
            found.append('JSON lookup in captured SQL predicate/order: ' + token)
        previous = upper
    return found


class CapturedSql(unittest.TestCase):
    def test_leading_comments_do_not_hide_read_commands(self):
        prefixes = ('', '-- SELECT in annotation\n', '/* WITH in annotation */ ',
                    ' /* outer /* nested */ still outer */ -- next\r\n\t')
        for prefix in prefixes:
            for command in ('SELECT id FROM agents', 'with a as (SELECT 1) SELECT * FROM a'):
                with self.subTest(prefix=prefix, command=command):
                    self.assertTrue(is_read_statement(prefix + command))
            for command in ('UPDATE agents SET title=%s', 'SELECTED', ''):
                with self.subTest(prefix=prefix, command=command):
                    self.assertFalse(is_read_statement(prefix + command))
        self.assertFalse(is_read_statement('/* unterminated SELECT'))

    def test_small_page_count_allows_seq_scan_without_relaxing_json_guard(self):
        rows = dict(small=500, big=500, few=4)
        pages = dict(small=15, big=16, few=200)
        self.assertEqual(large_relations(rows, pages), {'big'})
        with self.assertRaises(KeyError):
            large_relations(rows, {})
        self.assertTrue(hot_sql_violations("SELECT id FROM small WHERE extra->>'owner'='dev'"))

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

    def test_ansi_json_casts_are_caught_only_in_hot_clauses(self):
        for sql in ("SELECT id FROM agents WHERE CAST(body AS json) IS NOT NULL",
                    "SELECT id FROM agents ORDER BY CAST(body AS jsonb)",
                    "SELECT id FROM agents WHERE EXISTS (SELECT id FROM bodies "
                    "WHERE CAST(bodies.body AS jsonb) IS NOT NULL)"):
            with self.subTest(sql=sql):
                self.assertTrue(hot_sql_violations(sql))
        for sql in ("SELECT CAST(body AS json) FROM bodies WHERE id=%s",
                    "SELECT id FROM agents WHERE EXISTS (SELECT CAST(body AS jsonb) "
                    "FROM bodies WHERE bodies.id=agents.id)",
                    "SELECT id FROM agents WHERE CAST(id AS text) IS NOT NULL"):
            with self.subTest(sql=sql):
                self.assertFalse(hot_sql_violations(sql))

    def test_quotes_comments_and_projection_do_not_change_clause_state(self):
        self.assertFalse(hot_sql_violations("SELECT 'WHERE -> fake', extra->'x' AS \"ORDER BY\" "
            "FROM bodies /* WHERE extra->'x' */ WHERE id=%s -- ORDER BY body::json\n"))
        self.assertTrue(hot_sql_violations("SELECT body FROM bodies WHERE (extra->'x') IS NOT NULL"))


if __name__ == '__main__':
    unittest.main()
