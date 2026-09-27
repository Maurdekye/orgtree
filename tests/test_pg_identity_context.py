"""Actual PostgreSQL controls for foreground warm identity inputs."""
import copy
import threading
import unittest
from contextlib import ExitStack
from unittest.mock import patch
import test_pgstore as f
from orgtree import identity_context as ctx, foreground_store, ledger, store, warmpool
from orgtree import supervisor as sup


def tearDownModule(): f.tearDownModule()


@unittest.skipUnless(f.ADMIN, 'disposable PG required: NOT RUN')
class IdentityPG(unittest.TestCase):
    @classmethod
    def setUpClass(cls): store.claim_data_root()

    def setUp(self):
        org=store.create_org('identity-'+self._testMethodName)
        org.hire(ledger.USER,None,'haiku',30,'boss')
        org.hire(ledger.USER,'boss','haiku',5,'leaf')
        org.hire(ledger.USER,None,'haiku',0,'old')
        org.node('old')['state']='archived'
        org.node('leaf')['predecessor']='old'
        org.node('boss')['team_charter']='Inherited rules'
        org.d['audiences']=[{'grantee':'leaf','grantor':ledger.USER},
                            {'grantee':'leaf','grantor':ledger.EXTERN}]
        org=ledger.Org(copy.deepcopy(org.d)); self.slug=org.d['slug']
        store.save_org(org)
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(sup,'registered_mcp_servers',return_value={}))
        self.stack.enter_context(patch.object(sup,'_claude_argv',return_value=['fixture-claude']))

    def test_prompt_command_hash_and_selected_normalization_equal(self):
        full=store.load_org(self.slug); view=ctx.load(self.slug,'leaf')
        self.assertIsInstance(view,ctx.IdentityContext)
        self.assertEqual(set(view.nodes),{'boss','leaf','old'})
        for nid in view.nodes:self.assertEqual(view.node(nid),full.node(nid))
        self.assertEqual(sup.identity_prompt(view,'leaf'),sup.identity_prompt(full,'leaf'))
        cmd=sup._build_cmd(full,'leaf',write_ident=False,session_probe=False)
        self.assertEqual(sup._build_cmd(view,'leaf',write_ident=False,session_probe=False),cmd)
        self.assertEqual(warmpool.identity_snapshot(view,'leaf',cmd=cmd,env={},overrides={}),
                         warmpool.identity_snapshot(full,'leaf',cmd=cmd,env={},overrides={}))

    def test_context_cannot_be_persisted_or_wrapped(self):
        view=ctx.load(self.slug,'leaf')
        for value in (view,view.d,copy.deepcopy(view.d)):
            with self.subTest(value=type(value).__name__):
                with self.assertRaises(TypeError):ledger.Org(value)
                with self.assertRaises(TypeError):store.save_org(value)
        with self.assertRaises(AttributeError):view.hire

    def test_external_changes_are_fresh_and_prior_context_detached(self):
        before=ctx.load(self.slug,'leaf')
        org=store.load_org(self.slug);org.node('boss')['team_charter']='New charter'
        org.node('leaf')['halt']=True;org.d['killswitch']={'reason':'stop'}
        store.save_org(org)
        after=ctx.load(self.slug,'leaf')
        self.assertEqual(before.node('boss')['team_charter'],'Inherited rules')
        self.assertEqual(after.node('boss')['team_charter'],'New charter')
        self.assertFalse(warmpool.eligible(after,'leaf')[0])
        after.node('boss')['team_charter']='local'
        self.assertEqual(ctx.load(self.slug,'leaf').node('boss')['team_charter'],'New charter')

    def test_snapshot_does_not_mix_crossing_commit(self):
        errors=[]
        def project(raw):
            def write():
                try:
                    org=store.load_org(self.slug);org.d['default_effort']='low'
                    org.node('boss')['team_charter']='Crossed'
                    store.save_org(org)
                except Exception as e:errors.append(e)
            thread=threading.Thread(target=write);thread.start();thread.join(10)
            self.assertFalse(thread.is_alive());self.assertEqual(errors,[])
            return ctx._read(raw,self.slug,'leaf')
        with foreground_store._snapshot(self.slug) as (raw,stamp):
            view=project(raw)
        self.assertEqual(view.node('boss')['team_charter'],'Inherited rules')
        self.assertNotEqual(view.effective_effort('leaf'),'low')
        self.assertEqual(ctx.load(self.slug,'leaf').effective_effort('leaf'),'low')

    def test_legacy_and_first_turn_splice_use_exact_compatibility(self):
        full=store.load_org(self.slug)
        for field,value in [('_actors_typed',False),('kiosk',{'credits':10})]:
            altered=copy.deepcopy(full.d);altered[field]=value
            rows=[(nid,i,n) for i,(nid,n) in enumerate(altered['nodes'].items())]
            with self.assertRaises(ctx.CompatibilityRequired):ctx.IdentityContext(altered,rows,'leaf')
        org=store.load_org(self.slug);org.node('leaf')['cheap_compacted']=True
        store.save_org(org)
        with patch.object(store,'load_org',wraps=store.load_org) as fallback:
            self.assertIsInstance(ctx.load(self.slug,'leaf'),ledger.Org)
            fallback.assert_called_once_with(self.slug)

    def test_pinned_writer_falls_back_without_commit_or_rollback(self):
        full=store.load_org(self.slug)
        with patch.object(store._orgtx_local,'pinned',{self.slug:object()},create=True), \
             patch.object(store,'load_org',return_value=full) as fallback, \
             patch.object(foreground_store,'_snapshot',side_effect=AssertionError('deferred index')):
            self.assertIs(ctx.load(self.slug,'leaf'),full)
            fallback.assert_called_once_with(self.slug)

    def test_codex_manifest_prompt_and_effective_model_match(self):
        org=store.load_org(self.slug);org.node('leaf')['model']='luna'
        org.node('leaf')['scope'].update(model_version='6',effort='medium')
        org.d['default_effort']='high';store.save_org(org)
        full=store.load_org(self.slug);view=ctx.load(self.slug,'leaf')
        self.assertEqual(view.model_for('leaf'),full.model_for('leaf'))
        self.assertEqual(view.effective_effort('leaf'),full.effective_effort('leaf'))
        # No provider process or credential access: same captured launch spec.
        spec={'argv_head':['fixture-codex'],'cwd':sup.scratch_dir(self.slug,'leaf'),
              'config_overrides':[], 'env_extra':{},'codex_home':sup.scratch_dir(self.slug,'boss')}
        a=sup._codex_startup_manifest(full,'leaf',provider_spec=spec,
                                    account_override='fixture',lane_override='fixture')
        b=sup._codex_startup_manifest(view,'leaf',provider_spec=spec,
                                    account_override='fixture',lane_override='fixture')
        self.assertEqual(a,b)
        self.assertEqual(warmpool.identity_snapshot(full,'leaf',codex_manifest=a),
                         warmpool.identity_snapshot(view,'leaf',codex_manifest=b))

    def test_missing_or_retired_seat_never_reuses_process(self):
        with patch.object(warmpool,'warm_enabled',return_value=True), \
             patch.object(warmpool,'node_excluded',return_value=False):
            self.assertIsNone(warmpool.current_hash(self.slug,'missing'))
            self.assertIsNone(warmpool.current_hash(self.slug,'old'))

    def test_actual_boundary_uses_context_and_halt_killswitch(self):
        # Keep filesystem/provider values deterministic; real prompt, command,
        # selected-node reader and boundary control flow remain exercised.
        self.stack.enter_context(patch.object(sup,'spawn_env',return_value={}))
        self.stack.enter_context(patch.object(sup,'env_overrides',return_value={}))
        self.stack.enter_context(patch.object(warmpool,'warm_decision',return_value=(True,True)))
        self.stack.enter_context(patch.object(warmpool,'warm_enabled',return_value=True))
        self.stack.enter_context(patch.object(warmpool,'node_excluded',return_value=False))
        want=warmpool.ident_hash(store.load_org(self.slug),'leaf')
        with patch.object(store,'load_org',side_effect=AssertionError('whole org')):
            self.assertEqual(warmpool.current_hash(self.slug,'leaf'),want)
            self.assertEqual(warmpool.boundary_check(self.slug,'leaf',want),(True,True,''))
        org=store.load_org(self.slug);org.node('leaf')['halt']=True;store.save_org(org)
        self.assertFalse(warmpool.boundary_check(self.slug,'leaf',want)[0])
        org.node('leaf').pop('halt');org.d['killswitch']={'reason':'stop'};store.save_org(org)
        self.assertIsNone(warmpool.current_hash(self.slug,'leaf'))

if __name__ == '__main__': unittest.main()

