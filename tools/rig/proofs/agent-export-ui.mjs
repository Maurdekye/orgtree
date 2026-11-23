// Export, Import here and Duplicate in a window, against a rig run's real engine
// (docs/rust-engine/agent-export.md). The engine's side is proven by agent-export.mjs; this
// one drives the three dialogs as a user does and keeps a capture of each step.
//
// Needs a run with a renderer bundle (`--ui <dir>`), which opens an offscreen Electron
// window: Session 0 or a private desktop only. The harness is muted and off the real
// clipboard (desktop/guards.cjs). Synthetic organization, fake CLIs.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'
import { SEED_SETTLE_TIMEOUT } from '../seed-settle.mjs'

export default async function (rig) {
  const p = new Proof('agent-export-ui')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns settle', timeout: SEED_SETTLE_TIMEOUT })
  const org = rig.org
  const orgId = rig.one(`SELECT id FROM ot.orgs WHERE slug='${org}'`).id
  const row = name => rig.one(`SELECT a.id, a.state, a.kind, p.name AS parent, a.grant_credits::float8 AS grant, a.extra->'ported' AS ported
    FROM ot.agents a LEFT JOIN ot.agents p ON p.id=a.parent_id WHERE a.org_id=${orgId} AND a.name='${name}'`)

  // what there is to see: transcripts, a folder with a secret in it, a node with few credits to import under
  for (const name of ['alice', 'bob']) {
    await rig.userMail(name, `Export tour: answer OK only (${name}).`)
    await rig.waitTurns(name, rig.turns(name).filter(t => t.ended_at).length + 1)
  }
  const folder = path.join(rig.data, 'scratch', org, 'alice')
  fs.mkdirSync(path.join(folder, 'reports'), { recursive: true })
  fs.writeFileSync(path.join(folder, 'notes.md'), '# Notes\n\nThe staging database: password = "correct-horse-battery"\n')
  fs.writeFileSync(path.join(folder, '.env'), 'API_TOKEN=abc123def456ghi789\n')
  fs.writeFileSync(path.join(folder, 'reports', 'week-47.md'), '# Week 47\n\nAll green.\n')
  await rig.op({ op: 'hire', name: 'dana', parent: 'boss', tier: 'sonnet', grant: 5, title: 'Takes the import' })
  // the user's own import then clamps the saved grants to what can be drawn, by the app's strategy
  await rig.api('PUT', '/api/app-settings/runtime', { credit_bubble_hire_enabled: false })

  const file = path.join(p.dir, 'alice-team.orgtree.zip')
  const plainFile = path.join(p.dir, 'carol.orgtree.zip')
  const result = await runDesktop(rig, fileURLToPath(new URL('../desktop/agent-export.cjs', import.meta.url)),
    { preset: 'wide', out: path.join(p.dir, 'desktop'), timeout: 420000, args: { node: 'alice', plain: 'carol', under: 'dana', copy: 'carol', file, plainFile } })
  p.file('desktop.json', result)
  const { steps = {}, said = {} } = result.value ?? {}
  p.check('the window script ran to its end', result.ok, result.error ?? result.electronOutput)
  p.check('the window was in Session 0, muted, with the clipboard stubbed', result.session?.electron === 0 && result.guards?.muted === true
    && result.guards?.clipboardStub === true, { session: result.session, guards: result.guards })
  for (const name of ['menu', 'export', 'exportPlain', 'import', 'duplicate', 'duplicateTeam', 'settings']) {
    p.check(`step ${name}`, steps[name] !== undefined && !String(steps[name]).startsWith('FAILED'), steps[name])
  }
  const isZip = f => fs.existsSync(f) && fs.readFileSync(f).subarray(0, 2).toString('latin1') === 'PK'
  p.check("a node's menu offers the three entries", JSON.stringify(steps.menu) === JSON.stringify(['Export…', 'Import here…', 'Duplicate…']), steps.menu)
  p.check('the export says how much it holds before anything is written', /2 agents/.test(said.estimate ?? ''), said.estimate)
  p.check('with secrets found and none taken out, it stops and names them', /^This export holds secrets\./.test(said.found ?? '') && /password or key/.test(said.found ?? '')
    && /credential file/.test(said.found ?? '') && /scratch folder of alice/.test(said.found ?? ''), said.found)
  // USER 2026-11-23 m84e35b23ed2e: no dialog between the export and its saving
  p.check('once answered, the file is saved by a download the window started itself, and no dialog is left', isZip(file)
    && steps.export?.download?.state === 'completed' && /\/exports\/[^/]+\/file$/.test(steps.export?.download?.url ?? '') && /^Saving alice/.test(said.exported ?? ''),
  { step: steps.export, said: said.exported })
  p.check('an export with nothing secret asks nothing: the download starts and the canvas is back', isZip(plainFile) && steps.exportPlain?.download?.state === 'completed'
    && said.foundPlain === false && /^Saving carol/.test(said.exportedPlain ?? ''), { step: steps.exportPlain, said: said.exportedPlain, found: said.foundPlain })
  p.check('the plan is one sentence with the spare credits lost in all', /^Creates alice-2 and 1 more under dana\. Costs 5 credits\. 3 spare credits are taken away\.$/.test(said.plan ?? ''), said.plan)
  p.check('the import dialog has nothing to choose a strategy with, no grant told one by one, and no word of where the file was exported',
    said.importSelects === 0 && !/was 6|grant shrunk|Take spare credits|exported|unpacked/.test(said.importDialog ?? ''), said.importDialog)
  const alice2 = row('alice-2')
  p.check('the import created what the plan said, under the node it was chosen on, and went straight back to the canvas', alice2?.state === 'live' && alice2?.parent === 'dana'
    && alice2?.grant === 3 && alice2?.ported?.was === 'alice' && row('bob-2')?.parent === 'alice-2' && /Imported: alice-2 and 1 node under it\./.test(said.imported ?? ''), { alice2, said: said.imported })
  const carol2 = row('carol-2')
  p.check('a duplicate with nothing to choose is made with no dialog, beside the original', carol2?.state === 'live' && carol2?.parent === 'boss' && carol2?.ported?.duplicate === true
    && said.copyDialogSeen === false && /Copied: carol-2\./.test(said.copied ?? ''), { carol2, said: said.copied, dialog: said.copyDialogSeen })
  p.check('a duplicate of a team asks how much of it, in a sentence', /Only alice/.test(said.copyDialog ?? '') && /Creates alice-\d+/.test(said.copyDialog ?? '')
    && !/docket items|not interrupted/.test(said.copyDialog ?? ''), said.copyDialog)
  const history = rig.sql(`SELECT kind, label FROM ot.undo_entries WHERE org_id=${orgId} AND kind='import' ORDER BY id`)
  p.check('both are entries of the undo history', history.length === 2 && /^Import alice-2/.test(history[0].label) && /^Duplicate carol-2/.test(history[1].label), history)
  const shots = (result.shots ?? []).map(s => s.name)
  p.check('a capture of every step', ['01-node-menu', '02-export-choose', '03-export-secrets-found', '04-export-saving-toast', '05-export-nothing-secret-choose',
    '06-export-nothing-secret-saving-toast', '07-import-choose', '08-import-plan', '09-canvas-after-import', '10-canvas-after-duplicate', '11-duplicate-team-plan',
    '12-settings-export-and-import'].every(name => shots.includes(name)), shots)
  // Electron prints its own content-security warning in an unpackaged run: not the app's
  const errors = (result.consoleErrors ?? []).filter(e => !/Electron Security Warning/.test(e))
  p.check('the window logged no error', errors.length === 0, errors)
  await rig.api('PUT', '/api/app-settings/runtime', { credit_bubble_hire_enabled: true })
  p.keep(rig, { grep: /export|import|portable|duplicate/i })
  return p.summary()
}
