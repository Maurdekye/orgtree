"""Raw tool-call framing markup in a docket description: where it comes from,
and what the docket does about it.

THE DIAGNOSIS THIS SUITE PINS (ticket
`raw-tool-call-xml-leaks-into-a-docket-item-s-des`, acceptance condition 1).
Descriptions arrived holding fragments of tool-call framing -- a closing tag, an
opening parameter tag, and then the entire payload of the argument that was
supposed to come next. Three layers could have done it: the model's own emission
of the tool call, the MCP argument decoding path, or the docket's storage of the
string. It is the FIRST, and the other two are measured innocent here rather
than argued innocent:

  section 1  THE TWO ENGINE-SIDE CANDIDATES ARE BYTE-FAITHFUL.
             1a the MCP decode path, driven end to end: a JSON-RPC `tools/call`
                line carrying the damaged text hands the tool exactly those
                characters.
             1b the docket's storage of the string, through `workfields.prose`
                and through a real save/load round trip of the document.
             Neither adds, removes or reorders a byte, so neither can be what
             invents an `</objective>` tag or splices one argument's payload
             into another's value. That leaves emission.

SO THE FIX CANNOT BE A CURE, AND THIS SUITE DOES NOT PRETEND OTHERWISE. The text
is already malformed when it arrives. What the docket can do is stop storing it
in silence, which is the call the length limits already make:

  section 2  REFUSAL. A description carrying framing markup is refused whole --
             at create, at update, and on `objective_append` -- with nothing
             written: no item, no revision bump, no scope row. The message names
             the token and its position and says what probably went wrong.

  section 3  THE FALSE-REFUSAL GUARD, which is the hard half. The ticket that
             reports this defect QUOTES the fragment in its own description, so
             a naive substring test refuses the bug report about the bug. Code
             fences and inline code spans are ignored completely, ordinary XML
             in prose is not touched, and an item whose stored description is
             already damaged can still be appended to.

  section 4  THE REPAIR IS MECHANICAL. Re-typing a specification to fix an
             encoding bug is how a specification silently changes -- an earlier
             agent refused to hand-repair these for exactly that reason, and it
             was right. So the repair removes the markup spans and NOTHING else,
             and the proof is reconstruction: putting the removed spans back at
             their recorded offsets yields the original byte for byte. Applied
             through `work_update`, the before and after land in the item's
             `scope` record, so the repair is inspectable.

  section 5  NOTHING ELSE MOVED (acceptance condition 4): no length limit
             appears on the description, and `objective` is still lossless.

⚠ EVERY FRAMING TOKEN IN THIS FILE IS BUILT BY CONCATENATION, out of
`toolmarkup.FRAMING_TOKENS`, and never written as a single literal. Writing the
namespaced closing token as a literal ends the enclosing tool-call parameter, so
the file is written truncated at that byte and the call still reports success --
which is how the first draft of the probe for this ticket became a 608-byte file
with no error anywhere. Do not "tidy" these into literals.
"""
import io
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from typing import Any

# ⚠ ORGTREE_DATA BEFORE the first orgtree import: `store.DATA_ROOT` binds at
# import time. The assert below is the proof, not the intention.
fx = tempfile.TemporaryDirectory(prefix='desc-markup-')
os.environ['ORGTREE_DATA'] = str(Path(fx.name) / 'data')
os.environ['HOME'] = str(Path(fx.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'desc-markup-only'
for k in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(k, None)

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from engine.launch import load_app                                   # noqa: E402
load_app()
from orgtree import ledger, store, toolmarkup, workfields            # noqa: E402
assert Path(store.DATA_ROOT).resolve() == Path(os.environ['ORGTREE_DATA']).resolve(), \
    'this process would have written to the live root'

slugs: list[str] = []


def tearDownModule() -> None:
    for s in slugs:
        store._POOL.close_all(s)


T = toolmarkup.FRAMING_TOKENS


def damaged_description(tail: str = 'acceptance') -> str:
    """A description of the shape actually recovered from the live store.

    Reconstructed from specimens `log_d` 24639 / 24663 / 24675: real prose, then
    an invented close tag named after the argument, then the NEXT argument's
    opening tag and its whole payload. The prose half is deliberately ordinary
    so a test can assert it survives a repair untouched.
    """
    return (
        'The attach button in the mail reply composer is disabled and no file '
        'can be added. Find which value is undefined at the call site rather '
        'than making the button merely look enabled.\n\n'
        '## Scope\n\nMerge into `main` and push. Do not package or tag.'
        + '</objective>\n'
        + T['parameter_open'] + '"' + tail + '">'
        + '["The actual cause is named.", "The attach button is enabled."]'
        # deliberately no trailing newline: `prose` trims the ends, and a
        # fixture that relied on it would blur the byte arithmetic section 4
        # uses to prove the repair touched nothing but the markup
        + T['parameter_close'])


#: The REAL description of the ticket that reports this defect, as it stands in
#: the live store today. It quotes the fragment in backticks, which is the
#: natural way to write about it -- and it is the single case a naive filter
#: gets wrong, so it is a fixture rather than an invented example.
TICKET_OWN_DESCRIPTION = (
    'Docket items are sometimes created with raw tool-call markup embedded in '
    'the `objective` field — fragments such as `'
    + T['parameter_close'] + T['parameter_open']
    + '"acceptance">` appear inline in the description text. The acceptance '
    'conditions themselves parse correctly, so the damage is confined to the '
    'one field a human actually reads. The proposed fix is to find where a '
    "tool call's argument text can survive into the stored field and stop it "
    'at the boundary, rather than asking agents to write around it.\n\n'
    '## Not in scope\n\nAny change to the length limit or Markdown rendering.')


class DescriptionMarkup(unittest.TestCase):
    def setUp(self) -> None:
        slug = 'descmk-' + uuid.uuid4().hex[:8]
        slugs.append(slug)
        self.org = store.create_org(slug)
        self.slug = slug
        self.agent = self.hire('worker')

    def hire(self, name: str, parent: str | None = None) -> str:
        name = f'{name}-{uuid.uuid4().hex[:4]}'
        self.org.hire(ledger.USER if parent is None else parent, parent,
                      'haiku', 0, name, add_dirs=[],
                      tools={'bash': False, 'web': False, 'edit': False,
                             'subagents': False, 'mcp': []},
                      org_visibility='self', charter='fixture agent')
        store.save_org(self.org)
        return name

    # ── section 1a: the MCP decode path is byte-faithful ──────────────────
    def test_s1a_mcp_decode_hands_the_tool_exactly_what_was_sent(self) -> None:
        """Candidate 2 (the MCP argument decoding path) is innocent.

        Driven through `mcptool.main` itself rather than asserted about it: a
        real JSON-RPC `tools/call` frame goes in on stdin and the arguments the
        tool would be called with come back out, so this covers the decode the
        product actually performs and not a re-implementation of it.
        """
        from orgtree import mcptool
        import sys

        text = damaged_description()
        line = json.dumps({
            'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
            'params': {'name': 'orgtree_work',
                       'arguments': {'action': 'create', 'title': 'T',
                                     'objective': text}},
        })

        seen: dict[str, Any] = {}

        def capture(tool: str, args: dict[str, Any]) -> str:
            seen['tool'] = tool
            seen['args'] = args
            return '{"ok": true}'

        real_call_api, real_stdin, real_stdout = (
            mcptool.call_api, sys.stdin, sys.stdout)
        try:
            mcptool.call_api = capture           # type: ignore[assignment]
            sys.stdin = io.StringIO(line + '\n')
            sys.stdout = io.StringIO()
            mcptool.main()
        finally:
            mcptool.call_api = real_call_api     # type: ignore[assignment]
            sys.stdin, sys.stdout = real_stdin, real_stdout

        self.assertEqual(seen.get('tool'), 'orgtree_work')
        got = seen['args']['objective']
        self.assertEqual(got, text)
        self.assertEqual(len(got), len(text))
        # said explicitly: the decode neither invents the tag nor drops it
        self.assertIn('</objective>', got)

    # ── section 1b: the docket's storage is byte-faithful ─────────────────
    def test_s1b_the_field_contract_alters_nothing_but_the_ends(self) -> None:
        """Candidate 3 (storage of the string) is innocent at the contract."""
        text = damaged_description()
        self.assertEqual(workfields.prose(text), text.strip())
        self.assertEqual(workfields.prose('  ' + text + '  '), text.strip())
        self.assertIn('objective', workfields.LOSSLESS)

    def test_s1b_storage_round_trips_a_damaged_description_unchanged(self) -> None:
        """...and innocent through a real save and load of the document.

        Written onto the stored item directly, because the write path now
        refuses this text -- which is the point of the fix and must not be
        allowed to hide the measurement the diagnosis rests on.
        """
        text = damaged_description()
        item = self.org.work_create(self.agent, 'Storage', 'clean for now')
        stored = next(i for i in self.org.d['work_items']
                      if i['slug'] == item['slug'])
        stored['objective'] = text
        store.save_org(self.org)
        store._POOL.close_all(self.slug)

        reloaded = store.load_org(self.slug)
        back = next(i for i in reloaded.d['work_items']
                    if i['slug'] == item['slug'])['objective']
        self.assertEqual(back, text)
        self.assertEqual(len(back), len(text))

    # ── section 2: refusal, with nothing written ──────────────────────────
    def test_s2_create_refuses_a_description_carrying_framing_markup(self) -> None:
        before = len(self.org.d.get('work_items') or [])
        with self.assertRaises(ledger.LedgerError) as caught:
            self.org.work_create(self.agent, 'Damaged', damaged_description())
        message = str(caught.exception)
        self.assertIn('NOTHING WAS WRITTEN', message)
        self.assertIn('`objective`', message)
        self.assertIn('raw tool-call framing markup', message)
        # no item was created -- the refusal is before the first mutation
        self.assertEqual(len(self.org.d.get('work_items') or []), before)

    def test_s2_update_refuses_and_leaves_the_item_exactly_as_it_was(self) -> None:
        item = self.org.work_create(self.agent, 'Editable', 'the real spec')
        name = item['slug']
        was = self.org.work_get(self.agent, name)
        with self.assertRaises(ledger.LedgerError):
            self.org.work_update(self.agent, name, ['x'], [],
                                 objective=damaged_description())
        now = self.org.work_get(self.agent, name)
        self.assertEqual(now['objective'], 'the real spec')
        self.assertEqual(now['rev'], was['rev'])
        # and no scope row was minted for a change that did not happen
        self.assertEqual(len(now.get('scope') or []), len(was.get('scope') or []))

    def test_s2_objective_append_is_refused_too(self) -> None:
        item = self.org.work_create(self.agent, 'Appendable', 'the real spec')
        name = item['slug']
        with self.assertRaises(ledger.LedgerError):
            self.org.work_update(self.agent, name, ['x'], [],
                                 objective_append=damaged_description())
        self.assertEqual(self.org.work_get(self.agent, name)['objective'],
                         'the real spec')

    def test_s2_the_message_names_the_token_and_where_it_is(self) -> None:
        text = damaged_description()
        leaks = toolmarkup.find_leaks(text)
        self.assertTrue(leaks)
        with self.assertRaises(ledger.LedgerError) as caught:
            self.org.work_create(self.agent, 'Damaged', text)
        message = str(caught.exception)
        self.assertIn(str(leaks[0].start), message)
        self.assertIn(leaks[0].text, message)
        # and it says how to write about the markup on purpose
        self.assertIn('code span', message)

    def test_s2_every_framing_spelling_is_caught(self) -> None:
        """Both the bare and the namespaced spelling of each construct.

        A detector that only knew the spelling in the specimens would pass this
        suite while missing the other half of the vocabulary.
        """
        for key, token in T.items():
            with self.subTest(token=key):
                body = 'A real specification sentence. ' + token
                if 'open' in key and 'function' not in key:
                    body += '"acceptance">payload'
                self.assertTrue(toolmarkup.find_leaks(body),
                                f'{key} was not detected')

    # ── section 3: legitimate content is NOT refused ──────────────────────
    def test_s3_the_ticket_that_reports_this_bug_is_accepted(self) -> None:
        """THE case a naive substring filter gets wrong.

        This is the live description of the item that reports the defect. If
        this is refused, the product cannot be used to report the product.
        """
        self.assertEqual(toolmarkup.find_leaks(TICKET_OWN_DESCRIPTION), [])
        item = self.org.work_create(self.agent, 'Bug report',
                                    TICKET_OWN_DESCRIPTION)
        self.assertEqual(self.org.work_get(self.agent, item['slug'])['objective'],
                         TICKET_OWN_DESCRIPTION)

    def test_s3_fenced_code_blocks_are_ignored_whole(self) -> None:
        for fence in ('```', '````', '~~~'):
            with self.subTest(fence=fence):
                text = ('Here is what the leak looks like on the wire.\n\n'
                        + fence + 'xml\n'
                        + T['parameter_open'] + '"acceptance">payload'
                        + T['parameter_close'] + '\n'
                        + fence + '\n\nAnd that is the whole of it.')
                self.assertEqual(toolmarkup.find_leaks(text), [])
                item = self.org.work_create(self.agent, 'Fenced', text)
                self.assertEqual(
                    self.org.work_get(self.agent, item['slug'])['objective'],
                    text)

    def test_s3_inline_code_spans_are_ignored_at_any_backtick_run(self) -> None:
        for ticks in ('`', '``', '```'):
            with self.subTest(ticks=ticks):
                text = ('The fragment ' + ticks + T['parameter_open']
                        + '"acceptance">' + ticks + ' appears inline.')
                self.assertEqual(toolmarkup.find_leaks(text), [])

    def test_s3_ordinary_xml_and_html_in_prose_are_untouched(self) -> None:
        text = ('The renderer emits <div class="docket"> around each item and '
                'closes it with </div>; the export is <?xml version="1.0"?> '
                'followed by <items><item name="x">1</item></items>. A '
                '<parameter> element with no name attribute is ordinary XML '
                'and says nothing about tool calls.')
        self.assertEqual(toolmarkup.find_leaks(text), [])
        item = self.org.work_create(self.agent, 'XML prose', text)
        self.assertEqual(self.org.work_get(self.agent, item['slug'])['objective'],
                         text)

    def test_s3_an_already_damaged_item_can_still_be_appended_to(self) -> None:
        """The refusal is about what the caller submits, never about what is
        already stored -- otherwise a damaged item becomes unusable as well as
        unreadable, and the repair could not be delivered through the normal
        update path."""
        item = self.org.work_create(self.agent, 'Legacy', 'clean for now')
        name = item['slug']
        stored = next(i for i in self.org.d['work_items'] if i['slug'] == name)
        stored['objective'] = damaged_description()

        self.org.work_update(self.agent, name, ['x'], [],
                             objective_append='A later scope addition.')
        after = self.org.work_get(self.agent, name)['objective']
        self.assertTrue(after.endswith('A later scope addition.'))
        self.assertIn('The attach button in the mail reply composer', after)

    # ── section 4: the repair is a mechanical strip ───────────────────────
    def test_s4_repair_removes_the_markup_and_not_one_other_byte(self) -> None:
        """THE constraint. Reconstruction is the proof, not inspection."""
        text = damaged_description()
        repaired, removed = toolmarkup.strip_leaks(text)
        self.assertTrue(removed)

        rebuilt: list[str] = []
        cursor = 0
        for span in removed:
            rebuilt.append(text[cursor:span.start])
            rebuilt.append(span.text)
            cursor = span.end
        rebuilt.append(text[cursor:])
        self.assertEqual(''.join(rebuilt), text,
                         'the recorded spans do not reconstruct the original, '
                         'so the repair cannot be shown to be mechanical')

        # and the repaired text is exactly the original minus those spans
        self.assertEqual(len(repaired),
                         len(text) - sum(len(s.text) for s in removed))

    def test_s4_the_prose_and_the_leaked_payload_both_survive(self) -> None:
        """The tags go; the words stay. Deleting the payload of the argument
        that leaked in would lose content its author wrote -- merely in the
        wrong field -- which is the thing the mechanical rule exists to
        prevent."""
        repaired, _ = toolmarkup.strip_leaks(damaged_description())
        self.assertIn('The attach button in the mail reply composer is '
                      'disabled', repaired)
        self.assertIn('Merge into `main` and push.', repaired)
        self.assertIn('The actual cause is named.', repaired)
        self.assertNotIn('</objective>', repaired)

    def test_s4_repair_is_idempotent_and_a_no_op_on_clean_text(self) -> None:
        repaired, _ = toolmarkup.strip_leaks(damaged_description())
        self.assertEqual(toolmarkup.find_leaks(repaired), [])
        again, removed = toolmarkup.strip_leaks(repaired)
        self.assertEqual(again, repaired)
        self.assertEqual(removed, [])
        for clean in (TICKET_OWN_DESCRIPTION, 'a plain description', ''):
            self.assertEqual(toolmarkup.strip_leaks(clean), (clean, []))

    def test_s4_a_repair_lands_before_and_after_in_the_scope_record(self) -> None:
        """Applied the ordinary way, so the repair is inspectable by design."""
        item = self.org.work_create(self.agent, 'To repair', 'clean for now')
        name = item['slug']
        stored = next(i for i in self.org.d['work_items'] if i['slug'] == name)
        damaged = damaged_description()
        stored['objective'] = damaged

        repaired, removed = toolmarkup.strip_leaks(damaged)
        self.org.work_update(self.agent, name, ['description repaired'], [],
                             objective=repaired)

        served = self.org.work_get(self.agent, name)
        self.assertEqual(served['objective'], repaired)
        rows = [r for r in (served.get('scope') or [])
                if r.get('kind') == 'objective']
        self.assertTrue(rows, 'the repair minted no scope row')
        row = rows[-1]
        self.assertEqual(row.get('before'), damaged)
        # the newest description row's `after` IS the current description, so
        # the read folds it away rather than serving the same long text twice
        # (`_work_scope_view`). Either spelling is the same fact.
        after = row.get('after')
        if after is None:
            self.assertEqual(row.get('after_same_as'), 'objective')
            after = served['objective']
        self.assertEqual(after, repaired)
        # the before/after in the record differ by exactly the markup bytes
        self.assertEqual(len(str(row['before'])) - len(str(after)),
                         sum(len(s.text) for s in removed))

    # ── section 6: the repair TOOL, driven end to end ─────────────────────
    def _repair_tool(self) -> Any:
        """`tools/repair-docket-markup.py`, loaded by path (it is a script, not
        a package module)."""
        import importlib.util
        path = (Path(__file__).resolve().parent.parent / 'tools'
                / 'repair-docket-markup.py')
        spec = importlib.util.spec_from_file_location('repair_docket_markup',
                                                      path)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_s6_the_repair_tool_reports_without_writing_then_repairs(self) -> None:
        item = self.org.work_create(self.agent, 'Tool target', 'clean for now')
        name = item['slug']
        stored = next(i for i in self.org.d['work_items'] if i['slug'] == name)
        damaged = damaged_description()
        stored['objective'] = damaged
        store.save_org(self.org)
        store._POOL.close_all(self.slug)

        import contextlib

        tool = self._repair_tool()
        data = os.environ['ORGTREE_DATA']

        # Report only: it must find the damage and change nothing.
        #
        # ⚠ INSTRUMENT THE CONTROL. Asserting only that the STORED text is
        # unchanged is not enough and this test proved it: deleting the
        # `--apply` guard entirely left this assertion passing, because the
        # write went to the in-memory org and the save was separately guarded.
        # A report-only run that quietly mutates a loaded org and relies on
        # nobody saving it is one `save_org` away from writing. So the run must
        # also SAY it wrote nothing, and the apply run must say it wrote
        # something — otherwise a count of zero could just mean it never ran.
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(tool.main(['--data', data, '--org', self.slug]), 0)
        report = out.getvalue()
        self.assertIn('1 damaged field(s)', report,
                      'the report found no damage, so a "0 repaired" below '
                      'would prove nothing')
        self.assertIn('0 repaired', report)
        untouched = store.load_org(self.slug)
        self.assertEqual(
            next(i for i in untouched.d['work_items']
                 if i['slug'] == name)['objective'], damaged)
        store._POOL.close_all(self.slug)

        # and with --apply it repairs, mechanically
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(
                tool.main(['--data', data, '--org', self.slug, '--apply']), 0)
        self.assertIn('1 repaired', out.getvalue())
        after = store.load_org(self.slug)
        got = next(i for i in after.d['work_items']
                   if i['slug'] == name)['objective']
        expected, removed = toolmarkup.strip_leaks(damaged)
        self.assertEqual(got, expected)
        self.assertEqual(toolmarkup.find_leaks(got), [])
        self.assertIn('The attach button in the mail reply composer', got)
        self.assertIn('The actual cause is named.', got)
        self.assertEqual(len(got), len(damaged)
                         - sum(len(s.text) for s in removed))

    def test_s6_the_tool_never_prints_the_word_the_runner_reads_as_a_skip(self) -> None:
        """A guard on the runner's classifier, not on English.

        `tools/run-python-verification.py` marks a WHOLE module as a skip when a
        case-insensitive `\\bSKIP(?:PED)?\\b` appears anywhere in its output, and
        a skipped module still exits 0. This suite drives the repair tool, so
        the tool printing "skipped" made 21 passing tests report as `"phase":
        "skip"`, `"skipped": 1`, `"passed": 0` — a green exit for a module
        nothing had verified. Caught once; pinned so it cannot come back.
        """
        import contextlib
        import re as _re

        item = self.org.work_create(self.agent, 'Silent', 'clean for now')
        stored = next(i for i in self.org.d['work_items']
                      if i['slug'] == item['slug'])
        stored['objective'] = damaged_description()
        store.save_org(self.org)
        store._POOL.close_all(self.slug)

        tool = self._repair_tool()
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            tool.main(['--data', os.environ['ORGTREE_DATA'],
                       '--org', self.slug, '--apply'])
        printed = out.getvalue() + err.getvalue()
        self.assertTrue(printed.strip(), 'the tool printed nothing at all, so '
                                         'this guard would pass vacuously')
        self.assertIsNone(_re.search(r'\bSKIP(?:PED)?\b', printed, _re.I),
                          'the repair tool printed a word the verification '
                          'runner reads as a module-level skip')

    def test_s6_the_tool_leaves_a_legitimate_quotation_alone(self) -> None:
        """The false-refusal guard applies to the repair too: a description
        that merely quotes the markup must come back byte-identical."""
        item = self.org.work_create(self.agent, 'Quoting',
                                    TICKET_OWN_DESCRIPTION)
        name = item['slug']
        store.save_org(self.org)
        store._POOL.close_all(self.slug)

        tool = self._repair_tool()
        self.assertEqual(tool.main(['--data', os.environ['ORGTREE_DATA'],
                                    '--org', self.slug, '--apply']), 0)
        after = store.load_org(self.slug)
        self.assertEqual(
            next(i for i in after.d['work_items']
                 if i['slug'] == name)['objective'], TICKET_OWN_DESCRIPTION)

    # ── section 5: nothing else moved ─────────────────────────────────────
    def test_s5_the_description_still_has_no_length_limit(self) -> None:
        text = ('A real problem statement, then the solution. '
                + 'Rule detail. ' * 4000)
        self.assertGreater(len(text), 20000)
        item = self.org.work_create(self.agent, 'Long', text)
        self.assertEqual(self.org.work_get(self.agent, item['slug'])['objective'],
                         text.strip())
        self.assertNotIn('objective', workfields.LIMITS)

    def test_s5_markdown_survives_verbatim(self) -> None:
        text = ('# Heading\n\n- bullet with `code`\n- **bold** and _em_\n\n'
                '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n'
                '```python\ndef f(x):\n    return x < 1 & x > 0\n```\n\n'
                'Entities &amp; &lt; &gt; and a [link](https://e.invalid).')
        item = self.org.work_create(self.agent, 'Markdown', text)
        self.assertEqual(self.org.work_get(self.agent, item['slug'])['objective'],
                         text)


if __name__ == '__main__':
    unittest.main()
