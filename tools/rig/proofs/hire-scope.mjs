// Proof: the folders and tools a new hire gets (3.x hire defaults, PLAN I6).
//   The user hires without naming folders: under a superior the hire gets
//   the superior's folders, at the top level the organization's; its CLI
//   is started with them.
//   A folder the superior does not hold, or holds read-only when read/write
//   is asked, is refused at hire (3.x №30), instead of being stored where
//   it can never take effect.
//   An agent's hire has no defaults: it states folders, every tool and the
//   visibility, and cannot pass on a tool it does not hold.
//   A user's hire asking for a tool or more visibility than the superior
//   holds is clamped to the superior's, with a warning; an agent asking for
//   more visibility for its hire than it holds is refused (D-021).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/hire-scope.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('hire-scope')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const root = path.join(rig.data, 'rig-org-folders')
  const [a, b, c] = ['alpha', 'beta', 'gamma'].map(n => path.join(root, n))
  for (const d of [a, b, c]) fs.mkdirSync(d, { recursive: true })
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { org_dirs: [{ path: root, mode: 'rw' }] })
  // boss holds alpha read/write and beta read-only, and no web tool
  await rig.api('POST', `/api/orgs/${rig.org}/nodes/boss/scope`, { add_dirs: [{ path: a, mode: 'rw' }, { path: b, mode: 'ro' }], tools: { web: false } })
  const scopeOf = name => rig.one(`SELECT scope FROM ot.agents WHERE name = '${name}' AND state = 'live'
    AND org_id = (SELECT id FROM ot.orgs WHERE slug = '${rig.org}' AND state = 'active')`)?.scope
  const dirs = name => (scopeOf(name)?.add_dirs ?? []).map(d => `${path.basename(d.path)}:${d.mode}`).sort().join(',')
  const tryOp = body => rig.op(body).then(r => ({ ok: true, r }), e => ({ ok: false, status: e.status, detail: String(e.body?.detail ?? e.message).slice(0, 200) }))
  const same = (x, y) => path.resolve(x ?? '').toLowerCase() === path.resolve(y ?? '').toLowerCase()

  // ---------------------------------------------------------------- the user hires
  const ava = await tryOp({ op: 'hire', name: 'ava', parent: 'boss', tier: 'haiku', title: 'Inherits' })
  p.check('user hire under boss without folders: ava gets boss\'s folders', ava.ok && dirs('ava') === 'alpha:rw,beta:ro', { hire: ava.ok || ava.detail, dirs: dirs('ava') })
  await rig.userMail('ava', 'Hello ava.')
  await rig.waitTurns('ava', 1)
  const started = rig.fakeLog('ava').filter(l => l.kind === 'start').at(-1)?.add_dirs ?? []
  p.check('ava: her CLI is started with those folders', started.some(d => same(d, a)) && started.some(d => same(d, b)), started)
  const top = await tryOp({ op: 'hire', name: 'tod', tier: 'haiku', title: 'Top-level, inherits the org' })
  p.check('user hire at the top level without folders: tod gets the organization\'s folders', top.ok && dirs('tod') === 'rig-org-folders:rw',
    { hire: top.ok || top.detail, dirs: dirs('tod') })
  const notHeld = await tryOp({ op: 'hire', name: 'ben', parent: 'boss', tier: 'haiku', title: 'Asks for gamma', add_dirs: [{ path: c, mode: 'rw' }] })
  p.check('user hire under boss with a folder boss does not hold is refused, and no agent is made', !notHeld.ok && /does not hold/.test(notHeld.detail ?? '')
    && !scopeOf('ben'), notHeld)
  const rwOnRo = await tryOp({ op: 'hire', name: 'cyd', parent: 'boss', tier: 'haiku', title: 'Asks beta rw', add_dirs: [{ path: b, mode: 'rw' }] })
  p.check('user hire asking read/write on a folder boss holds read-only is refused', !rwOnRo.ok && /read-only/.test(rwOnRo.detail ?? '') && !scopeOf('cyd'), rwOnRo)
  const inner = path.join(a, 'sub')
  fs.mkdirSync(inner, { recursive: true })
  const within = await tryOp({ op: 'hire', name: 'dee', parent: 'boss', tier: 'haiku', title: 'Asks a folder inside alpha', add_dirs: [{ path: inner, mode: 'ro' }] })
  p.check('user hire with a folder inside one boss holds is taken as asked', within.ok && dirs('dee') === 'sub:ro', { hire: within.ok || within.detail, dirs: dirs('dee') })

  // ---------------------------------------------------------------- an agent hires
  const bare = await rig.tool('boss', 'orgtree_hire', { name: 'eli', tier: 'haiku', grant: 0, charter: 'You help boss.' })
  p.check('boss hiring without stating folders, tools and visibility is refused (agent hires have no defaults)', !bare.ok
    && /no defaults/.test(bare.text ?? '') && /add_dirs/.test(bare.text ?? '') && /tools/.test(bare.text ?? '') && !scopeOf('eli'), bare.text?.slice(0, 300))
  const tools = { bash: true, edit: true, subagents: false, mcp: [] }
  const web = await rig.tool('boss', 'orgtree_hire', { name: 'fay', tier: 'haiku', grant: 0, charter: 'You help boss.',
    add_dirs: [], tools: { ...tools, web: true }, org_visibility: 'team' })
  p.check('boss cannot pass on the web tool he does not hold', !web.ok && /web/.test(web.text ?? '') && !scopeOf('fay'), web.text?.slice(0, 200))
  const ok = await rig.tool('boss', 'orgtree_hire', { name: 'gus', tier: 'haiku', grant: 0, charter: 'You help boss.',
    add_dirs: [{ path: a, mode: 'ro' }], tools: { ...tools, web: false }, org_visibility: 'team' })
  p.check('boss hiring with everything stated and within his own scope works', ok.ok && dirs('gus') === 'alpha:ro', { text: ok.text?.slice(0, 200), dirs: dirs('gus') })

  // ---------------------------------------------------------------- tools and visibility clamps (D-021)
  const ivo = await tryOp({ op: 'hire', name: 'ivo', parent: 'boss', tier: 'haiku', title: 'Asks web and full visibility',
    tools: { web: true }, org_visibility: 'full' })
  const ivoScope = scopeOf('ivo')
  const warned = (ivo.r?.warnings ?? []).join(' | ')
  p.check('user hire asking for a tool boss lacks: the hire is clamped to boss\'s tools, with a warning', ivo.ok && ivoScope?.tools?.web === false
    && /tool grants clamped to the parent's own: web/.test(warned), { warnings: ivo.r?.warnings, web: ivoScope?.tools?.web })
  const bossVis = scopeOf('boss')?.org_visibility ?? 'subtree'
  p.check('user hire asking for more visibility than boss holds: clamped to boss\'s, with a warning', ivoScope?.org_visibility === bossVis
    && new RegExp(`org_visibility clamped to the parent's own \\(${bossVis}\\)`).test(warned), { vis: ivoScope?.org_visibility, bossVis, warnings: ivo.r?.warnings })
  const wide = await rig.tool('boss', 'orgtree_hire', { name: 'jon', tier: 'haiku', grant: 0, charter: 'You help boss.',
    add_dirs: [], tools: { ...tools, web: false }, org_visibility: 'full' })
  p.check('boss asking for more visibility than he holds for his hire is refused (D-021)', !wide.ok && /exceeds the parent's own/.test(wide.text ?? '')
    && !scopeOf('jon'), wide.text?.slice(0, 200))

  p.keep(rig, { agents: ['ava'], grep: /hire|scope/i })
  return p.summary()
}
