// Proof: orgtree_retool's folders (docket
// orgtree-retool-add-dirs-silently-replaces-an-age; user ruling 2026-10-10:
// giving a folder adds it, removing is a separate explicit option).
//   boss holds alpha, beta, gamma and delta; alice (under boss) holds alpha
//   and beta; bob (under alice) holds alpha and beta read-only.
//   state_inspect shows each agent's folders with their modes.
//   add_dirs adds: boss gives alice gamma and she keeps alpha and beta, the
//   result lists gamma as added, bob keeps his folders, and alice's next CLI
//   start carries all three.
//   add_dirs naming a held folder changes its mode: alice's alpha becomes
//   read-only, and bob's alpha is clamped with it (`clamped`, a warning).
//   remove_dirs removes: alice loses beta and so does bob, and the result
//   and alice's notice say so. Removing a folder she does not hold, or one
//   also in add_dirs, is refused and changes nothing. A held folder named
//   with other case and separators is the same folder.
//   The user gives bob gamma read/write: alice, who holds it read-only, is
//   raised (`raised`), and bob keeps alpha.
//   A rehire's add_dirs still sets the whole list (3.x).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/retool-dirs.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('retool-dirs')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const root = path.join(rig.data, 'rig-org-folders')
  const [alpha, beta, gamma, delta] = ['alpha', 'beta', 'gamma', 'delta'].map(n => path.join(root, n))
  for (const d of [alpha, beta, gamma, delta]) fs.mkdirSync(d, { recursive: true })
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { org_dirs: [{ path: root, mode: 'rw' }] })
  const setDirs = (name, dirs) => rig.api('POST', `/api/orgs/${rig.org}/nodes/${name}/scope`, { add_dirs: dirs })
  await setDirs('boss', [alpha, beta, gamma, delta].map(d => ({ path: d, mode: 'rw' })))
  await setDirs('alice', [{ path: alpha, mode: 'rw' }, { path: beta, mode: 'rw' }])
  await setDirs('bob', [{ path: alpha, mode: 'rw' }, { path: beta, mode: 'ro' }])
  await setDirs('carol', [{ path: alpha, mode: 'rw' }, { path: beta, mode: 'rw' }])
  const orgId = `(SELECT id FROM ot.orgs WHERE slug = '${rig.org}' AND state = 'active')`
  const scopeOf = name => rig.one(`SELECT scope FROM ot.agents WHERE name = '${name}' AND state = 'live' AND org_id = ${orgId}`)?.scope
  const list = ds => (ds ?? []).map(d => `${path.basename(d.path ?? '')}:${d.mode}`).sort().join(',')
  const dirs = name => list(scopeOf(name)?.add_dirs)
  const same = (x, y) => path.resolve(x ?? '').toLowerCase() === path.resolve(y ?? '').toLowerCase()
  const parse = r => { try { return JSON.parse(r?.text ?? '') } catch { return null } }
  // a result's change list as name:from>to or name:mode, sorted
  const changes = ds => (ds ?? []).map(d => `${path.basename(d.path ?? '')}:${d.from ? `${d.from}>${d.to}` : d.mode}`).sort().join(',')
  const none = ds => !(ds ?? []).length
  const retool = async args => { const r = await rig.tool('boss', 'orgtree_retool', { node: 'alice', ...args }); return { ...r, out: parse(r) } }
  p.check('setup: alice holds alpha and beta, bob alpha and beta read-only', dirs('alice') === 'alpha:rw,beta:rw' && dirs('bob') === 'alpha:rw,beta:ro',
    { alice: dirs('alice'), bob: dirs('bob') })

  // ---------------------------------------------------------------- state_inspect
  const insp = parse(await rig.tool('boss', 'orgtree_state_inspect', { nodes: ['alice', 'bob'] }))
  const shown = (r, name) => list(r?.nodes?.find(n => n.name === name)?.scope?.add_dirs)
  p.check('orgtree_state_inspect shows alice\'s and bob\'s folders with their modes', shown(insp, 'alice') === 'alpha:rw,beta:rw' && shown(insp, 'bob') === 'alpha:rw,beta:ro',
    { alice: shown(insp, 'alice'), bob: shown(insp, 'bob'), scope: insp?.nodes?.[0]?.scope })

  // ---------------------------------------------------------------- add_dirs adds
  const add = await retool({ add_dirs: [{ path: gamma, mode: 'ro' }] })
  p.check('boss gives alice gamma read-only: she keeps alpha and beta', add.ok && dirs('alice') === 'alpha:rw,beta:rw,gamma:ro', { text: add.text?.slice(0, 600), alice: dirs('alice') })
  p.check('the result lists gamma as added, nothing changed or removed', changes(add.out?.folders?.added) === 'gamma:ro' && none(add.out?.folders?.changed)
    && none(add.out?.folders?.removed), add.out?.folders)
  p.check('bob keeps his folders; nobody is clamped and there is no warning', dirs('bob') === 'alpha:rw,beta:ro' && !add.out?.clamped && !add.out?.warnings,
    { bob: dirs('bob'), out: add.out })
  const ended = rig.turns('alice').filter(t => t.ended_at).length
  await rig.userMail('alice', 'Hello alice.')
  await rig.waitTurns('alice', ended + 1)
  const started = rig.fakeLog('alice').filter(l => l.kind === 'start').at(-1)?.add_dirs ?? []
  // Launch also grants built-in skills and org/team workspaces. Count only
  // this proof's configured folders; the automatic folders are legitimate.
  const configured = started.filter(s => same(path.dirname(s), root))
  p.check('alice\'s next CLI start carries alpha, beta and gamma', configured.length === 3 && [alpha, beta, gamma].every(d => configured.some(s => same(s, d))), started)

  // ---------------------------------------------------------------- a mode change clamps beneath
  const narrow = await retool({ add_dirs: [{ path: alpha, mode: 'ro' }] })
  p.check('add_dirs naming alpha, which alice holds, makes it read-only and keeps her other folders', narrow.ok && dirs('alice') === 'alpha:ro,beta:rw,gamma:ro',
    { text: narrow.text?.slice(0, 600), alice: dirs('alice') })
  p.check('the result lists alpha as changed from rw to ro', changes(narrow.out?.folders?.changed) === 'alpha:rw>ro' && none(narrow.out?.folders?.added)
    && none(narrow.out?.folders?.removed), narrow.out?.folders)
  const nBob = (narrow.out?.clamped ?? []).find(c => c.node === 'bob')
  p.check('bob\'s alpha is clamped to read-only, and the result lists him under `clamped` with a warning', dirs('bob') === 'alpha:ro,beta:ro'
    && changes(nBob?.changed) === 'alpha:rw>ro' && none(nBob?.removed)
    && (narrow.out?.warnings ?? []).some(w => /beneath alice: bob \(1 made read-only\)/.test(w)), { bob: dirs('bob'), clamped: narrow.out?.clamped, warnings: narrow.out?.warnings })

  // ---------------------------------------------------------------- remove_dirs removes
  const notices = () => rig.sql(`SELECT ev::text AS ev FROM ot.mail WHERE org_id = ${orgId} AND recipient_name = 'alice' AND ev::text LIKE '%scope_changed%' ORDER BY id`)
  const noticed = notices().length
  const rm = await retool({ remove_dirs: [beta] })
  p.check('boss removes beta from alice: she keeps alpha and gamma', rm.ok && dirs('alice') === 'alpha:ro,gamma:ro', { text: rm.text?.slice(0, 600), alice: dirs('alice') })
  p.check('the result lists beta as removed', changes(rm.out?.folders?.removed) === 'beta:rw' && none(rm.out?.folders?.added) && none(rm.out?.folders?.changed), rm.out?.folders)
  const rBob = (rm.out?.clamped ?? []).find(c => c.node === 'bob')
  p.check('bob loses beta with her, and the result lists him under `clamped` with a warning', dirs('bob') === 'alpha:ro' && changes(rBob?.removed) === 'beta:ro'
    && (rm.out?.warnings ?? []).some(w => /beneath alice: bob \(1 removed\)/.test(w)), { bob: dirs('bob'), clamped: rm.out?.clamped, warnings: rm.out?.warnings })
  const fresh = notices().slice(noticed)
  p.check('alice gets a notice that her folders changed', fresh.length === 1 && /folders/.test(fresh[0]?.ev ?? ''), fresh)
  const insp2 = parse(await rig.tool('boss', 'orgtree_state_inspect', { node: 'bob' }))
  p.check('state_inspect now shows bob with alpha read-only only', shown(insp2, 'bob') === 'alpha:ro', insp2?.nodes?.[0]?.scope)

  // ---------------------------------------------------------------- refusals
  const notHeld = await retool({ remove_dirs: [delta] })
  p.check('removing delta, which alice does not hold, is refused naming her folders, and changes nothing', !notHeld.ok
    && /alice holds no folder/.test(notHeld.text ?? '') && /alpha \(ro\)/.test(notHeld.text ?? '') && /gamma \(ro\)/.test(notHeld.text ?? '')
    && dirs('alice') === 'alpha:ro,gamma:ro', { text: notHeld.text?.slice(0, 400), alice: dirs('alice') })
  const both = await retool({ add_dirs: [{ path: delta, mode: 'rw' }], remove_dirs: [delta] })
  p.check('a folder in both add_dirs and remove_dirs is refused, and changes nothing', !both.ok && /both add_dirs and remove_dirs/.test(both.text ?? '')
    && dirs('alice') === 'alpha:ro,gamma:ro', { text: both.text?.slice(0, 300), alice: dirs('alice') })

  // ---------------------------------------------------------------- one folder, however it is written
  const spelled = alpha.toUpperCase().split(path.sep).join('/')
  const relax = await retool({ add_dirs: [{ path: spelled, mode: 'rw' }] })
  p.check('add_dirs naming alpha in other case and separators changes its mode, with no second entry', relax.ok && dirs('alice') === 'alpha:rw,gamma:ro'
    && changes(relax.out?.folders?.changed) === 'alpha:ro>rw' && none(relax.out?.folders?.added), { text: relax.text?.slice(0, 400), alice: dirs('alice'), spelled })
  p.check('a grant does not give bob back what a narrowing took', dirs('bob') === 'alpha:ro', { bob: dirs('bob') })

  // ---------------------------------------------------------------- a deep grant raises the middle
  const deep = await rig.op({ op: 'retool', node: 'bob', add_dirs: [{ path: gamma, mode: 'rw' }] })
    .then(r => ({ ok: true, r }), e => ({ ok: false, detail: String(e.body?.detail ?? e.message).slice(0, 300) }))
  p.check('the user gives bob gamma read/write: he keeps alpha', deep.ok && dirs('bob') === 'alpha:ro,gamma:rw', { deep: deep.ok || deep.detail, bob: dirs('bob') })
  p.check('the result lists gamma as added for bob', changes(deep.r?.folders?.added) === 'gamma:rw', deep.r?.folders)
  const raisedAlice = (deep.r?.raised ?? []).find(c => c.node === 'alice')
  p.check('alice, who held gamma read-only, is raised to read/write, listed under `raised` and `cascaded`', dirs('alice') === 'alpha:rw,gamma:rw'
    && changes(raisedAlice?.changed) === 'gamma:ro>rw' && (deep.r?.cascaded ?? []).includes('alice'), { alice: dirs('alice'), raised: deep.r?.raised, cascaded: deep.r?.cascaded })

  // ---------------------------------------------------------------- a rehire sets the whole list
  const retired = await rig.tool('boss', 'orgtree_retire', { node: 'carol' })
  const back = await rig.tool('boss', 'orgtree_rehire', { node: 'carol', add_dirs: [{ path: delta, mode: 'ro' }] })
  p.check('boss rehires carol with add_dirs = [delta]: her list is delta alone, as in 3.x', retired.ok && back.ok && dirs('carol') === 'delta:ro',
    { retire: retired.text?.slice(0, 200), rehire: back.text?.slice(0, 300), carol: dirs('carol') })

  p.keep(rig, { agents: ['alice'], grep: /retool|scope|rehire/i })
  return p.summary()
}
