"""W08: scoped immutable artifacts, findings with dispositions, and the
docket-side provenance fields — driven through the REAL agent endpoint.

Through `/api/agent` with real per-node tokens rather than by calling the ledger
directly, because the thing being tested is authorization, and authorization
that is only correct when called from inside the process is not authorization.
The three agents are an author, a peer it may grant to, and a stranger, so every
allow is proved before its matching refusal is believed:

  · the author reads its own named artifact            (positive control)
  · the stranger cannot                                (the refusal)
  · a grant makes exactly that one file readable        (the grant works)
  · a second artifact stays unreadable to the grantee   (one file, not a key)
  · revoking ends it and the grant row survives         (auditable)
  · a path outside the agent's folders is refused        (no smuggling)
  · a tampered stored path is refused                    (no traversal)
"""
from __future__ import annotations

import os
from pathlib import Path
import tempfile
import unittest

from fastapi.testclient import TestClient

root = tempfile.TemporaryDirectory(prefix='v2-w08-artifacts-')
data = Path(root.name) / 'data'; data.mkdir()
home = Path(root.name) / 'home'; home.mkdir()
os.environ.update(ORGTREE_DATA=str(data), HOME=str(home), USERPROFILE=str(home),
                  ORGTREE_V2_TOKEN='operator')
for key in ('ORGTREE_V1_ROOT', 'ORGTREE_V1_DATA_ROOT', 'ORGTREE_V2_PORT'):
    os.environ.pop(key, None)
from engine.launch import load_app                        # noqa: E402
app, *_ = load_app()
from orgtree import agentauth, ledger, store, supervisor  # noqa: E402
from orgtree import api as api_mod                        # noqa: E402

HEADERS = {'X-Orgtree-Desktop-Token': 'operator'}
_orgs_created: list[str] = []


def tearDownModule():
    for slug in _orgs_created:
        store._POOL.close_all(slug)
    root.cleanup()


class W08Base(unittest.TestCase):
    """One org, three agents, one item, and a file in each agent's scratch."""

    _seq = 0

    def setUp(self) -> None:
        # a short deterministic slug, and the slug the STORE actually minted is
        # the one everything else uses — inventing the name and hoping it
        # survived normalisation is how the first run of this file failed
        W08Base._seq += 1
        org = store.create_org(f'w08-fixture-{W08Base._seq}')
        self.slug = str(org.d['slug'])
        _orgs_created.append(self.slug)
        org.hire(ledger.USER, None, 'haiku', 0, 'author')
        org.hire(ledger.USER, None, 'haiku', 0, 'peer')
        org.hire(ledger.USER, None, 'haiku', 0, 'stranger')
        created = org.work_create('author', 'Prove it', 'the objective',
                                  owner='author')
        self.wid = str(created['slug'])
        store.save_org(org)
        self.client = TestClient(app)
        self.tokens = {n: agentauth.child_env(self.slug, n)['ORGTREE_AGENT_TOKEN']
                       for n in ('author', 'peer', 'stranger')}

    # ---- helpers ---------------------------------------------------------
    def call(self, node: str, **args: object) -> tuple[int, dict]:
        r = self.client.post('/api/agent', json={
            'org': self.slug, 'node': node, 'tool': 'orgtree_work',
            'args': {'slug': self.wid, **args}},
            headers={'X-Orgtree-Agent-Token': self.tokens[node]})
        try:
            return r.status_code, r.json()
        except ValueError:                                  # pragma: no cover
            return r.status_code, {'text': r.text}

    def scratch_file(self, node: str, name: str, text: str) -> str:
        d = Path(supervisor.scratch_dir(self.slug, node))
        d.mkdir(parents=True, exist_ok=True)
        p = d / name
        p.write_text(text, encoding='utf-8')
        return str(p)

    def record(self, node: str, name: str, text: str, **args: object
               ) -> tuple[int, dict]:
        path = self.scratch_file(node, name, text)
        return self.call(node, action='artifact', path=path, **args)


class ArtifactScopeTests(W08Base):

    def test_item_scope_is_readable_by_anyone_who_reads_the_item(self):
        code, body = self.record('author', 'probe.py', 'print("hi")')
        self.assertEqual(code, 200, body)
        aid = body['artifact']['id']
        self.assertEqual(body['artifact']['scope'], 'item')
        # the author reads it (positive control) …
        code, got = self.call('author', action='artifact_read', artifact=aid)
        self.assertEqual(code, 200, got)
        self.assertEqual(got['content'], 'print("hi")')
        self.assertTrue(got['sha256_matches'],
                        'the bytes served match the bytes recorded')
        # … and so does the owner-adjacent user-side route
        served = self.client.get(
            f'/api/orgs/{self.slug}/work-items/{self.wid}/artifacts/{aid}',
            headers=HEADERS)
        self.assertEqual(served.status_code, 200, served.text)
        self.assertEqual(served.content, b'print("hi")')

    def test_a_named_artifact_is_refused_to_a_stranger_and_opened_by_a_grant(self):
        code, body = self.record('author', 'private-probe.py', 'secret probe',
                                 scope='named')
        self.assertEqual(code, 200, body)
        aid = body['artifact']['id']
        # POSITIVE CONTROL FIRST: the author can read its own
        code, got = self.call('author', action='artifact_read', artifact=aid)
        self.assertEqual(code, 200, got)
        self.assertEqual(got['content'], 'secret probe')
        # the stranger cannot, and the refusal does not confirm what it is
        code, ref = self.call('stranger', action='artifact_read', artifact=aid)
        self.assertEqual(code, 422, ref)
        self.assertNotIn('private-probe', str(ref),
                         'the refusal must not disclose the filename')
        # a grant opens exactly this file
        code, g = self.call('author', action='grant', artifact=aid, to='peer')
        self.assertEqual(code, 200, g)
        code, got = self.call('peer', action='artifact_read', artifact=aid)
        self.assertEqual(code, 200, got)
        self.assertEqual(got['content'], 'secret probe')

    def test_a_grant_is_one_file_not_a_key_to_the_others(self):
        _c, first = self.record('author', 'shared.py', 'shared bytes',
                                scope='named')
        _c, second = self.record('author', 'unshared.py', 'other bytes',
                                 scope='named')
        self.call('author', action='grant', artifact=first['artifact']['id'],
                  to='peer')
        code, ok = self.call('peer', action='artifact_read',
                             artifact=first['artifact']['id'])
        self.assertEqual(code, 200, ok)
        code, ref = self.call('peer', action='artifact_read',
                              artifact=second['artifact']['id'])
        self.assertEqual(code, 422,
                         f'one grant must not carry the next artifact with '
                         f'it: {ref}')

    def test_revoking_ends_access_and_keeps_the_record(self):
        _c, body = self.record('author', 'temp.py', 'temporary', scope='named')
        aid = body['artifact']['id']
        self.call('author', action='grant', artifact=aid, to='peer')
        code, _ok = self.call('peer', action='artifact_read', artifact=aid)
        self.assertEqual(code, 200, 'control: access was really granted')
        code, rv = self.call('author', action='revoke', artifact=aid, to='peer')
        self.assertEqual(code, 200, rv)
        code, ref = self.call('peer', action='artifact_read', artifact=aid)
        self.assertEqual(code, 422, ref)
        # the grant row SURVIVES, stamped — a past disclosure stays provable
        org = store.load_org(self.slug)
        it, _ = org._work_find(self.wid)
        rec = next(a for a in it['artifacts'] if a['id'] == aid)
        self.assertEqual(len(rec['grants']), 1,
                         'the row is stamped, never deleted')
        self.assertTrue(rec['grants'][0]['revoked_at'])
        self.assertEqual(rec['grants'][0]['to'], 'peer')
        # and revoking twice is refused rather than silently re-stamping
        code, again = self.call('author', action='revoke', artifact=aid, to='peer')
        self.assertEqual(code, 422, again)

    def test_only_the_author_may_grant_even_for_the_item_owner(self):
        # the peer is made a participant, so it can READ the item and still
        # must not be able to hand out somebody else's file
        org = store.load_org(self.slug)
        org.work_participants('author', self.wid, add=['peer'])
        store.save_org(org)
        _c, body = self.record('author', 'authored.py', 'mine', scope='named')
        aid = body['artifact']['id']
        code, ref = self.call('peer', action='grant', artifact=aid,
                              to='stranger')
        self.assertEqual(code, 422, ref)
        self.assertIn('only the agent that recorded', str(ref))
        # control: the author can
        code, ok = self.call('author', action='grant', artifact=aid,
                             to='stranger')
        self.assertEqual(code, 200, ok)

    def test_a_named_artifact_is_hidden_in_the_item_view_but_not_erased(self):
        _c, body = self.record('author', 'hidden.py', 'x', scope='named')
        code, seen = self.call('author', action='get')
        self.assertEqual(code, 200, seen)
        mine = seen['item']['artifacts']
        self.assertEqual(len(mine), 1)
        self.assertTrue(mine[0]['visible'])
        self.assertEqual(mine[0]['name'], 'hidden.py')
        org = store.load_org(self.slug)
        org.work_participants('author', self.wid, add=['peer'])
        store.save_org(org)
        code, theirs = self.call('peer', action='get')
        self.assertEqual(code, 200, theirs)
        rows = theirs['item']['artifacts']
        self.assertEqual(len(rows), 1,
                         'the row must not vanish - that would read as no '
                         'evidence existing')
        self.assertFalse(rows[0]['visible'])
        self.assertNotIn('name', rows[0],
                         'the filename is content and is withheld')

    def test_granting_to_an_unknown_agent_is_refused(self):
        _c, body = self.record('author', 'p.py', 'x', scope='named')
        code, ref = self.call('author', action='grant',
                              artifact=body['artifact']['id'], to='ghost')
        self.assertEqual(code, 422, ref)
        self.assertIn('no agent', str(ref))


class ArtifactImmutabilityTests(W08Base):

    def test_the_same_name_is_refused_rather_than_replaced_or_duplicated(self):
        code, first = self.record('author', 'result.json', '{"a":1}')
        self.assertEqual(code, 200, first)
        code, again = self.record('author', 'result.json', '{"a":2}')
        self.assertEqual(code, 422, again)
        self.assertIn('IMMUTABLE', str(again))
        self.assertIn('different bytes', str(again),
                      'the refusal distinguishes a re-upload from a collision')
        # the first artifact and its bytes are untouched
        code, got = self.call('author', action='artifact_read',
                             artifact=first['artifact']['id'])
        self.assertEqual(got['content'], '{"a":1}')

    def test_an_identical_re_record_says_so(self):
        self.record('author', 'same.txt', 'identical')
        code, again = self.record('author', 'same.txt', 'identical')
        self.assertEqual(code, 422, again)
        self.assertIn('already here', str(again))

    def test_the_record_carries_the_hash_of_the_bytes(self):
        import hashlib
        text = 'measure me'
        _c, body = self.record('author', 'hashed.txt', text)
        want = 'sha256:' + hashlib.sha256(text.encode()).hexdigest()
        self.assertEqual(body['artifact']['sha256'], want)
        self.assertEqual(body['artifact']['bytes'], len(text))


class ArtifactContainmentTests(W08Base):

    def test_a_file_outside_the_agents_folders_is_refused(self):
        outside = Path(root.name) / 'not-mine.txt'
        outside.write_text('secrets', encoding='utf-8')
        code, ref = self.call('author', action='artifact', path=str(outside))
        self.assertEqual(code, 422, ref)
        self.assertIn('only files in your working folder', str(ref))

    def test_a_peers_scratch_file_is_not_recordable(self):
        theirs = self.scratch_file('peer', 'peer-notes.md', 'peer only')
        code, ref = self.call('author', action='artifact', path=theirs)
        self.assertEqual(code, 422, f'recording a peer scratch file would '
                                    f'make a named grant a way to publish '
                                    f'it: {ref}')

    def test_a_traversal_in_a_stored_path_is_refused_on_read(self):
        _c, body = self.record('author', 'ok.txt', 'fine')
        aid = body['artifact']['id']
        # control: it reads now
        code, _ok = self.call('author', action='artifact_read', artifact=aid)
        self.assertEqual(code, 200)
        # tamper with the stored path the way a bad import or hand-edit would
        secret = Path(root.name) / 'outside-secret.txt'
        secret.write_text('do not serve me', encoding='utf-8')
        org = store.load_org(self.slug)
        it, _ = org._work_find(self.wid)
        rec = next(a for a in it['artifacts'] if a['id'] == aid)
        depth = len(Path(api_mod._work_artifact_dir(self.slug, self.wid)).parts)
        rec['path'] = ('..' + os.sep) * depth + 'outside-secret.txt'
        store.save_org(org)
        code, ref = self.call('author', action='artifact_read', artifact=aid)
        self.assertEqual(code, 422, ref)
        self.assertIn('escapes its storage', str(ref))
        served = self.client.get(
            f'/api/orgs/{self.slug}/work-items/{self.wid}/artifacts/{aid}',
            headers=HEADERS)
        self.assertEqual(served.status_code, 404, served.text)
        self.assertNotIn('do not serve me', served.text)

    def test_an_empty_file_is_refused(self):
        code, ref = self.record('author', 'empty.txt', '')
        self.assertEqual(code, 422, ref)
        self.assertIn('proves nothing', str(ref))


class ReceiptActionTests(W08Base):
    """The docket side of the receipt: captured by the backend, disclosed on
    read, and never refreshed."""

    def setUp(self) -> None:
        super().setUp()
        # a real repository inside the author's scratch, so `checkout` is a
        # directory the node actually holds
        from tests.test_work_evidence_receipts import TempRepo, git
        d = Path(supervisor.scratch_dir(self.slug, 'author'))
        d.mkdir(parents=True, exist_ok=True)
        self.repo_dir = d / 'wt'
        self.repo_dir.mkdir()
        git(self.repo_dir, 'init', '--initial-branch=main', '-q')
        (self.repo_dir / 'a.txt').write_text('one\n', encoding='utf-8')
        git(self.repo_dir, 'add', 'a.txt')
        git(self.repo_dir, 'commit', '-q', '-m', 'first')
        self.head = git(self.repo_dir, 'rev-parse', 'HEAD')
        self._git = git

    def test_a_receipt_binds_the_candidate_the_tree_and_the_result(self):
        code, body = self.call('author', action='receipt',
                               candidate=self.head[:12],
                               checkout=str(self.repo_dir),
                               command=['python', '-m', 'unittest', 'tests.x'],
                               execution='independent', result='passed',
                               note='the suite passed')
        self.assertEqual(code, 200, body)
        rc = body['receipt']
        self.assertEqual(rc['candidate'], self.head[:12])
        self.assertEqual(rc['tree']['commit'], self.head)
        self.assertEqual(rc['tree']['state'], 'clean')
        self.assertEqual(rc['result'], 'passed')
        self.assertTrue(rc['green'])
        self.assertTrue(rc['fingerprint'].startswith('sha256:'))
        self.assertEqual(body['execution'], 'independent')
        # and it is on the item, as evidence, with its provenance
        code, seen = self.call('author', action='get')
        ev = seen['item']['evidence'][-1]
        self.assertEqual(ev['execution'], 'independent')
        self.assertIn('ran the command itself', ev['execution_means'])
        self.assertEqual(ev['receipt']['fingerprint'], rc['fingerprint'])

    def test_a_dirty_tree_is_disclosed_in_the_result_and_the_record(self):
        (self.repo_dir / 'a.txt').write_text('one\nedited\n', encoding='utf-8')
        code, body = self.call('author', action='receipt', candidate=self.head,
                               checkout=str(self.repo_dir),
                               command=['pytest'], execution='independent',
                               result='passed')
        self.assertEqual(code, 200, body)
        self.assertEqual(body['disclosed']['tree_state'], 'dirty')
        self.assertEqual(body['disclosed']['dirty_count'], 1)
        self.assertIn('DIRTY', body['hint'])

    def test_receipts_are_read_back_with_a_staleness_disclosure(self):
        self.call('author', action='receipt', candidate=self.head,
                  checkout=str(self.repo_dir), command=['pytest'],
                  execution='independent', result='passed')
        code, first = self.call('author', action='receipts')
        self.assertEqual(code, 200, first)
        self.assertEqual(len(first['receipts']), 1)
        self.assertEqual(first['receipts'][0]['disclosure']['status'], 'current',
                         'control: nothing has changed yet')
        self.assertTrue(first['summary']['green'])
        # now move the code on
        (self.repo_dir / 'a.txt').write_text('one\ntwo\n', encoding='utf-8')
        self._git(self.repo_dir, 'add', 'a.txt')
        self._git(self.repo_dir, 'commit', '-q', '-m', 'second')
        code, later = self.call('author', action='receipts')
        d = later['receipts'][0]['disclosure']
        self.assertEqual(d['status'], 'commit_changed')
        self.assertFalse(d['current'])
        self.assertEqual(later['receipts'][0]['receipt']['fingerprint'],
                         first['receipts'][0]['receipt']['fingerprint'],
                         'the stored receipt is never rewritten')

    def test_a_checkout_is_required_and_must_be_one_the_agent_holds(self):
        code, ref = self.call('author', action='receipt', candidate=self.head,
                              command=['pytest'], execution='independent',
                              result='passed')
        self.assertEqual(code, 422, ref)
        self.assertIn('`checkout` is required', str(ref))
        code, ref = self.call('author', action='receipt', candidate=self.head,
                              checkout=str(Path(root.name)),
                              command=['pytest'], execution='independent',
                              result='passed')
        self.assertEqual(code, 422, ref)

    def test_logs_of_either_encoding_are_read_and_reported(self):
        d = Path(supervisor.scratch_dir(self.slug, 'author'))
        (d / 'utf8.log').write_bytes('PASS — all good\n'.encode('utf-8'))
        (d / 'utf16.log').write_bytes('PASS — all good\n'.encode('utf-16'))
        code, body = self.call('author', action='receipt', candidate=self.head,
                               checkout=str(self.repo_dir),
                               command=['pytest'], execution='independent',
                               result='passed',
                               logs=[str(d / 'utf8.log'), str(d / 'utf16.log'),
                                     str(d / 'missing.log')])
        self.assertEqual(code, 200, body)
        logs = body['receipt']['logs']
        self.assertEqual(len(logs), 3)
        self.assertEqual(logs[0]['encoding'], 'utf-8')
        self.assertEqual(logs[0]['text'], 'PASS — all good\n')
        self.assertEqual(logs[1]['encoding'], 'utf-16')
        self.assertEqual(logs[1]['text'], 'PASS — all good\n',
                         'the UTF-16 log reads identically to the UTF-8 one')
        self.assertTrue(logs[2]['unreadable'],
                        'a log that could not be read is disclosed, not dropped')

    def test_a_rangediff_records_all_four_endpoints(self):
        self._git(self.repo_dir, 'checkout', '-q', '-b', 'work')
        (self.repo_dir / 'b.txt').write_text('feature\n', encoding='utf-8')
        self._git(self.repo_dir, 'add', 'b.txt')
        self._git(self.repo_dir, 'commit', '-q', '-m', 'candidate')
        old_tip = self._git(self.repo_dir, 'rev-parse', 'HEAD')
        self._git(self.repo_dir, 'checkout', '-q', 'main')
        (self.repo_dir / 'c.txt').write_text('main\n', encoding='utf-8')
        self._git(self.repo_dir, 'add', 'c.txt')
        self._git(self.repo_dir, 'commit', '-q', '-m', 'main moved')
        new_base = self._git(self.repo_dir, 'rev-parse', 'HEAD')
        self._git(self.repo_dir, 'checkout', '-q', 'work')
        self._git(self.repo_dir, 'rebase', 'main')
        new_tip = self._git(self.repo_dir, 'rev-parse', 'HEAD')
        code, body = self.call('author', action='rangediff',
                               checkout=str(self.repo_dir),
                               old_base=self.head, old_tip=old_tip,
                               new_base=new_base, new_tip=new_tip)
        self.assertEqual(code, 200, body)
        rd = body['receipt']['range_diff']
        self.assertIs(rd['identical'], True, rd['detail'])
        self.assertEqual([rd['old_base'], rd['old_tip'], rd['new_base'],
                          rd['new_tip']],
                         [self.head, old_tip, new_base, new_tip])
        self.assertEqual(body['receipt']['result'], 'passed')

    def test_a_caller_cannot_supply_its_own_receipt_through_evidence(self):
        code, body = self.call('author', action='evidence', kind='log',
                               ref='suite.log', note='trust me',
                               execution='owner_report')
        self.assertEqual(code, 200, body)
        code, seen = self.call('author', action='get')
        ev = seen['item']['evidence'][-1]
        self.assertEqual(ev['execution'], 'owner_report')
        self.assertNotIn('receipt', ev,
                         'a fingerprint is captured by the backend or not at '
                         'all — a caller-supplied one is the unverifiable '
                         'claim this package replaces')

    #: A receipt shaped exactly like a real one — right schema, right result,
    #: a clean-looking fingerprint. It must be refused for WHO BUILT IT, not
    #: for how it looks, so the forgery here is deliberately well-formed.
    FORGED = {'schema': 'orgtree.verification-receipt/1', 'result': 'passed',
              'candidate': 'a' * 40, 'fingerprint': 'deadbeef',
              'execution': 'independent'}

    def test_a_hand_written_receipt_is_refused_on_the_single_row(self):
        code, ref = self.call('author', action='evidence', kind='log',
                              ref='suite.log', receipt=self.FORGED)
        self.assertEqual(code, 422, ref)
        self.assertIn('cannot be supplied by the caller', str(ref))
        code, seen = self.call('author', action='get')
        self.assertFalse([e for e in seen['item']['evidence']
                          if e.get('ref') == 'suite.log'],
                         'the refused row was not written')

    def test_a_hand_written_receipt_is_refused_inside_a_batch(self):
        """⚠ THE BATCH IS A SECOND DOOR TO THE SAME ROOM. The single form is
        refused by naming the argument; a batch element carries its own keys,
        so without its own check `items: [{receipt: ...}]` would walk a forged
        fingerprint straight past the rule the single form enforces."""
        code, ref = self.call('author', action='evidence', items=[
            {'kind': 'commit', 'ref': 'b' * 40, 'note': 'candidate'},
            {'kind': 'log', 'ref': 'suite.log', 'receipt': self.FORGED}])
        self.assertEqual(code, 422, ref)
        self.assertIn('cannot be supplied by the caller', str(ref))
        self.assertIn('items[1]', str(ref),
                      'the refusal names which element was wrong')
        code, seen = self.call('author', action='get')
        self.assertFalse([e for e in seen['item']['evidence']
                          if e.get('ref') in ('b' * 40, 'suite.log')],
                         'ATOMIC: the good first element was not written '
                         'either')

    def test_a_batch_element_may_carry_its_own_execution(self):
        """The positive half: provenance rides on a batch element, so the
        refusal above is about receipts and not about batches."""
        code, body = self.call('author', action='evidence', items=[
            {'kind': 'commit', 'ref': 'c' * 40, 'execution': 'independent'},
            {'kind': 'log', 'ref': 'other.log', 'execution': 'owner_report'}])
        self.assertEqual(code, 200, body)
        self.assertEqual(body['executions'], ['independent', 'owner_report'])
        code, seen = self.call('author', action='get')
        rows = {e['ref']: e for e in seen['item']['evidence']}
        self.assertEqual(rows['c' * 40]['execution'], 'independent')
        self.assertEqual(rows['other.log']['execution'], 'owner_report')
        self.assertIn('reported by another agent',
                      rows['other.log']['execution_means'],
                      'the row spells out what the word means, so a reader '
                      'does not have to know the vocabulary')

    def test_an_unknown_execution_word_is_refused(self):
        code, ref = self.call('author', action='evidence', kind='note',
                              ref='x', execution='i-ran-it')
        self.assertEqual(code, 422, ref)
        self.assertIn('execution must be one of', str(ref))


class FindingTests(W08Base):

    def test_a_finding_gets_a_citable_id_and_starts_open(self):
        code, body = self.call('peer', action='finding',
                               title='fold runs on every render',
                               detail='repro: type in the composer',
                               severity='blocking')
        self.assertEqual(code, 422,
                         f'a stranger to the item cannot raise findings on '
                         f'it: {body}')
        org = store.load_org(self.slug)
        org.work_participants('author', self.wid, add=['peer'])
        store.save_org(org)
        code, body = self.call('peer', action='finding',
                               title='fold runs on every render',
                               detail='repro: type in the composer',
                               severity='blocking')
        self.assertEqual(code, 200, body)
        self.assertEqual(body['id'], 'f1')
        self.assertEqual(body['disposition'], 'open')
        self.assertEqual(body['severity'], 'blocking')
        code, seen = self.call('author', action='get')
        self.assertEqual(seen['item']['findings_summary']['open'], ['f1'])
        self.assertEqual(seen['item']['findings_summary']['total'], 1)

    def test_a_disposition_needs_a_reason_and_keeps_the_earlier_ones(self):
        self.call('author', action='finding', title='the defect')
        code, ref = self.call('author', action='dispose', finding='f1',
                              disposition='rejected')
        self.assertEqual(code, 422, ref)
        self.assertIn('takes a `note`', str(ref))
        code, ok = self.call('author', action='dispose', finding='f1',
                             disposition='rejected',
                             note='measured; not reproducible on main')
        self.assertEqual(code, 200, ok)
        self.assertEqual(ok['disposition'], 'rejected')
        # round 9 revisits it — and round 5's decision is still there
        code, ok = self.call('author', action='dispose', finding='f1',
                             disposition='fixed', note='it was real after all')
        self.assertEqual(code, 200, ok)
        self.assertEqual(ok['decisions'], 2)
        code, seen = self.call('author', action='get')
        f = seen['item']['findings'][0]
        self.assertEqual(f['disposition'], 'fixed')
        self.assertEqual([d['disposition'] for d in f['decisions']],
                         ['rejected', 'fixed'],
                         'the whole sequence survives — that is the point')
        self.assertIn('not reproducible', f['decisions'][0]['note'])
        self.assertEqual(seen['item']['findings_summary']['open'], [])

    def test_reopening_needs_no_note_and_unknown_words_are_refused(self):
        self.call('author', action='finding', title='x')
        self.call('author', action='dispose', finding='f1',
                  disposition='fixed', note='done')
        code, ok = self.call('author', action='dispose', finding='f1',
                             disposition='open')
        self.assertEqual(code, 200, ok)
        code, ref = self.call('author', action='dispose', finding='f1',
                              disposition='wontfix', note='n')
        self.assertEqual(code, 422, ref)
        self.assertIn('disposition must be one of', str(ref))

    def test_an_over_long_title_is_refused_whole_with_the_numbers(self):
        code, ref = self.call('author', action='finding', title='x' * 250)
        self.assertEqual(code, 422, ref)
        self.assertIn('250', str(ref))
        self.assertIn('NOTHING WAS WRITTEN', str(ref))
        code, seen = self.call('author', action='get')
        self.assertEqual(seen['item']['findings'], [],
                         'a refused write leaves no row behind')


class ExpectedRevTests(W08Base):

    def test_a_stale_expected_rev_refuses_the_whole_call(self):
        code, seen = self.call('author', action='get')
        rev = seen['item']['rev']
        code, ok = self.call('author', action='finding', title='first',
                             expected_rev=rev)
        self.assertEqual(code, 200, ok)
        # the same rev is now stale
        code, ref = self.call('author', action='finding', title='second',
                              expected_rev=rev)
        self.assertEqual(code, 422, ref)
        # W03's wording, which W08 now shares: one compare-and-set, one message
        self.assertIn('somebody wrote to it since you read it', str(ref))
        self.assertIn('NOTHING WAS WRITTEN', str(ref))
        code, after = self.call('author', action='get')
        self.assertEqual([f['title'] for f in after['item']['findings']],
                         ['first'],
                         'the refused call wrote nothing at all')

    def test_a_non_integer_expected_rev_is_refused(self):
        code, ref = self.call('author', action='finding', title='x',
                              expected_rev='soon')
        self.assertEqual(code, 422, ref)
        self.assertIn('expected_rev must be', str(ref))


if __name__ == '__main__':
    unittest.main()
