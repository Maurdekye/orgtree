"""Orgtree's NATIVE RULES say what a ticket description must contain.

USER REQUIREMENT 2026-09-12, in two halves:

  · STRUCTURE — the first paragraph contains a brief problem statement
    followed by a short solution; every subsequent paragraph contains all the
    remaining specifications, requirements, details and rulings about the
    problem or its solution.
  · AUTHORITY — the description is the ticket's authoritative STANDALONE
    scope. Acceptance conditions may test or restate it and messages may
    coordinate the work, but neither substitutes for content missing from the
    description. Only details the user has not specified may be absent, and a
    material gap is an explicit question rather than a silence.

WHERE THE RULE HAD TO GO, and why this suite asserts on `identity_prompt`
rather than on any one lane's file. `identity_prompt` is the single string
every provider leg renders:

  · claude       → <scratch>/.orgtree-identity.md   (--append-system-prompt-file)
  · codex        → <scratch>/AGENTS.md
  · antigravity  → developer_instructions

so a rule placed there reaches every lane by construction. A rule placed in a
repo doc would reach only the lanes that happen to read that doc. §2 pins that
the bytes really are the same on each.

The second home is the TOOL ITSELF (§4): an agent reading `orgtree_work`'s
schema — the only text some callers ever see — is told the same thing about
`objective`, so the rule does not depend on the agent having read the doctrine
block first.

⚠ THE STABILITY HALF IS NOT DECORATION (§5). `identity_prompt` is the cached
prefix; a doctrine block that interpolated anything live would rewrite that
prefix every turn. This rule is fixed prose, and §5 says so with a test.
"""
import os
import re
import tempfile
import unittest
import uuid
from pathlib import Path

# ⚠ ORGTREE_DATA BEFORE the first orgtree import: `store.DATA_ROOT` binds at
# import time. The assert below is the proof, not the intention.
fx = tempfile.TemporaryDirectory(prefix='desc-doctrine-')
os.environ['ORGTREE_DATA'] = str(Path(fx.name) / 'data')
os.environ['HOME'] = str(Path(fx.name) / 'home')
os.environ['USERPROFILE'] = os.environ['HOME']
Path(os.environ['ORGTREE_DATA']).mkdir()
Path(os.environ['HOME']).mkdir()
os.environ['ORGTREE_V2_TOKEN'] = 'desc-doctrine-only'
for k in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(k, None)
from engine.launch import load_app                                   # noqa: E402
load_app()
from orgtree import ledger, mcptool, store                          # noqa: E402
from orgtree import supervisor as sup                                # noqa: E402
assert Path(store.DATA_ROOT).resolve() == Path(os.environ['ORGTREE_DATA']).resolve(), \
    'this process would have written to the live root'

slugs: list[str] = []


def tearDownModule() -> None:
    for s in slugs:
        store._POOL.close_all(s)


def norm(text: object) -> str:
    """Case-folded, whitespace-flattened — a pin on the RULE, not on line
    wrapping. Re-flowing the paragraph must not turn this suite red; deleting
    the rule must."""
    return re.sub(r'\s+', ' ', str(text or '')).lower()


class DescriptionDoctrine(unittest.TestCase):
    def setUp(self) -> None:
        slug = 'descdoc-' + uuid.uuid4().hex[:8]
        slugs.append(slug)
        self.org = store.create_org(slug)
        self.slug = slug

    def agent(self, tier: str = 'opus', name: str | None = None) -> str:
        name = name or ('a' + uuid.uuid4().hex[:6])
        self.org.hire(ledger.USER, None, tier, 0, name, add_dirs=[],
                      tools={'bash': True, 'web': False, 'edit': True,
                             'subagents': False, 'mcp': []},
                      org_visibility='self', charter='fixture agent')
        store.save_org(self.org)
        return name

    def prompt(self, tier: str = 'opus') -> str:
        return sup.identity_prompt(self.org, self.agent(tier))

    # ── §1 the rule reaches an ordinary agent at all ──────────────────────
    def test_s1_the_managed_prompt_states_the_description_structure(self) -> None:
        text = norm(self.prompt())
        # positive control: if `identity_prompt` returned something degenerate
        # every assertion below would pass vacuously
        self.assertIn('the docket', text)

        self.assertIn('first paragraph', text)
        self.assertIn('problem', text)
        self.assertIn('solution', text)
        # the SECOND half of the structure rule — everything else goes on
        self.assertIn('subsequent paragraph', text)
        for word in ('specification', 'requirement', 'edge case', 'ruling'):
            self.assertIn(word, text,
                          f'the doctrine does not say descriptions carry every {word}')

    def test_s1b_the_managed_prompt_states_the_standalone_authority(self) -> None:
        text = norm(self.prompt())
        self.assertIn('authoritative standalone scope', text)
        # acceptance and mail are named as NOT substitutes — the exact failure
        # the user described, where a requirement survived only in a message
        self.assertIn('acceptance conditions may', text)
        self.assertRegex(text, r'neither .{0,40}stands in for')
        self.assertIn('the ones the user has not specified', text)
        self.assertIn('explicit question', text)

    def test_s1c_the_managed_prompt_says_there_is_no_length_limit(self) -> None:
        text = norm(self.prompt())
        self.assertIn('no length limit', text)
        self.assertIn('nothing is truncated', text)
        # and that the way to write one is markdown, because the pane renders it
        self.assertIn('markdown', text)
        self.assertIn('expand control', text)

    # ── §2 every lane is told the same thing ──────────────────────────────
    def test_s2_claude_codex_and_antigravity_get_identical_bytes(self) -> None:
        texts = [sup.identity_prompt(self.org, self.agent(tier))
                 for tier in ('opus', 'luna', 'flash')]
        for text in texts:
            self.assertIn(sup.DOCKET_DOCTRINE, text,
                          'a lane is missing the docket doctrine entirely')
        # the doctrine bytes are the SAME on each; only the surrounding
        # per-agent envelope differs
        self.assertEqual(len({sup.DOCKET_DOCTRINE}), 1)

    # ── §3 the rule is in the doctrine constant, not only in a rendering ──
    def test_s3_the_doctrine_constant_carries_both_halves(self) -> None:
        text = norm(sup.DOCKET_DOCTRINE)
        self.assertIn('first paragraph', text)
        self.assertIn('subsequent paragraph', text)
        self.assertIn('authoritative standalone scope', text)

    def test_s3b_the_doctrine_keeps_clear_of_the_reserved_tool_verbs(self) -> None:
        # the recital pin in test_mcptool matches tool verbs as SUBSTRINGS, so
        # these words may not appear in this text at all (the note above
        # DOCKET_DOCTRINE says so; this is that note as a test)
        text = sup.DOCKET_DOCTRINE.lower()
        for verb in ('move', 'rename', 'swap'):
            self.assertNotIn(verb, text,
                             f'{verb!r} in DOCKET_DOCTRINE trips the recital pin')

    # ── §4 the tool says it too ───────────────────────────────────────────
    def test_s4_the_work_tool_schema_states_the_same_rule(self) -> None:
        spec = next(t for t in mcptool.TOOLS if t['name'] == 'orgtree_work')
        blurb = norm(spec['description'])
        self.assertIn('first paragraph', blurb)
        self.assertIn('subsequent paragraph', blurb)
        self.assertIn('authoritative standalone', blurb)
        self.assertIn('no length limit', blurb)

        field = norm(spec['inputSchema']['properties']['objective']['description'])
        self.assertIn('authoritative standalone scope', field)
        self.assertIn('never truncated', field)

    # ── §5 doctrine, not telemetry ────────────────────────────────────────
    def test_s5_the_rule_is_fixed_prose_with_nothing_live_in_it(self) -> None:
        text = sup.DOCKET_DOCTRINE
        # no formatting field could smuggle a live value in
        self.assertNotIn('{', text)
        self.assertNotIn('%', text)
        # and the whole prompt is stable across two reads of the same agent
        nid = self.agent()
        self.assertEqual(sup.identity_prompt(self.org, nid),
                         sup.identity_prompt(self.org, nid))


if __name__ == '__main__':
    unittest.main()
