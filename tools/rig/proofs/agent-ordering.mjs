// Isolated real tool/domain proof. No live hierarchy or provider calls.
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('agent-ordering')
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns settle', timeout: 60000 })
  const orgId = rig.one(`SELECT id FROM ot.orgs WHERE slug='${rig.org}'`).id
  const sibs = parent => rig.sql(`SELECT name FROM ot.agents WHERE org_id=${orgId} AND state='live'
    AND parent_id IS NOT DISTINCT FROM ${parent ? `(SELECT id FROM ot.agents WHERE org_id=${orgId} AND name='${parent}')` : 'NULL'}
    ORDER BY sibling_order,id`).map(r => r.name)
  const joined = parent => sibs(parent).join(',')
  const state = () => rig.sql(`SELECT name,parent_id,sibling_order,state,seat,grant_credits,account,scope
    FROM ot.agents WHERE org_id=${orgId} ORDER BY id`)
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const scope = { add_dirs: [], tools: { bash: true, web: true, edit: true, subagents: false, mcp: [] }, org_visibility: 'team' }
  const hire = (name, index, extra = {}) => rig.tool('boss', 'orgtree_hire', {
    name, tier: 'haiku', grant: 0, charter: 'Isolated ordering proof helper.', index, ...scope, ...extra })
  const reorder = (as, node, index, extra = {}) => rig.tool(as, 'orgtree_reorder', { node, index, ...extra })
  const refusedWithoutWrites = async (label, fn, pattern) => {
    const before = state()
    const r = await fn()
    p.check(label, !r.ok && (!pattern || pattern.test(r.text ?? '')) && same(before, state()), r.text?.slice(0, 240))
    return r
  }
  const op = body => rig.op(body).then(json => ({ ok: true, json }), e => ({ ok: false, text: e.message }))

  // Immediate and deep descendants; no changes to parent/scope/credit/account.
  const original = state().map(({ sibling_order, ...r }) => r)
  let r = await reorder('boss', 'carol', 0)
  p.check('direct descendant moves first; result reports final index/count', r.ok && joined('boss') === 'carol,alice'
    && r.json.index === 0 && r.json.live_sibling_count === 2, r.json)
  r = await reorder('boss', 'bob', 0)
  p.check('deep only child index zero succeeds', r.ok && joined('alice') === 'bob', r.json)
  p.check('reorder preserves topology/scope/credits/accounts', same(original, state().map(({ sibling_order, ...a }) => a)))
  await rig.op({ op: 'hire', name: 'outside', tier: 'haiku' })
  for (const [as, node, label] of [
    ['boss', 'boss', 'self'], ['alice', 'boss', 'superior'], ['alice', 'carol', 'peer'], ['boss', 'outside', 'unrelated root'],
  ]) await refusedWithoutWrites(`reorder denies ${label}`, () => reorder(as, node, 0), /yourself|below you/)
  for (const bad of [undefined, -1, 0.5, '0', null, true, 2, 999999999999999999999]) {
    await refusedWithoutWrites(`reorder rejects index ${JSON.stringify(bad)}`, () => reorder('boss', 'carol', bad), /index/)
  }
  await refusedWithoutWrites('reorder rejects parent-changing input', () => reorder('boss', 'carol', 0, { new_parent: 'alice' }), /only sibling/)
  await refusedWithoutWrites('reorder rejects conflicting index/before', () => reorder('boss', 'carol', 0, { before: 'alice' }), /one placement/)
  await rig.op({ op: 'reorder', node: 'carol', after: 'alice' })
  p.check('existing user before/after ordering remains supported', joined('boss') === 'alice,carol')
  r = await rig.tool('boss', 'orgtree_state_inspect', {})
  const rows = r.json?.nodes ?? []
  p.check('inspection exposes accurate ordered metadata', r.ok && rows.find(a => a.name === 'alice')?.sibling_index === 0
    && rows.find(a => a.name === 'carol')?.sibling_index === 1 && rows.find(a => a.name === 'boss')?.live_child_count === 2, rows)

  for (const [name, index, expected] of [
    ['first', 0, 'first,alice,carol'], ['middle', 2, 'first,alice,middle,carol'], ['last', 4, 'first,alice,middle,carol,last'],
  ]) {
    r = await hire(name, index)
    p.check(`hire ${name} commits at explicit index`, r.ok && joined('boss') === expected && r.json.index === index, r.json)
  }
  r = await reorder('boss', 'middle', 4)
  p.check('agent reorder moves last using final index', r.ok && joined('boss') === 'first,alice,carol,last,middle', r.json)
  r = await reorder('boss', 'middle', 2)
  p.check('agent reorder moves to middle using final index', r.ok && joined('boss') === 'first,alice,middle,carol,last', r.json)
  for (const [i, bad] of [undefined, -1, 1.5, '1', null, false, 6].entries()) {
    await refusedWithoutWrites(`hire rejects index ${JSON.stringify(bad)} atomically`, () => hire(`bad-${i}`, bad), /index/)
  }
  for (const field of ['grant', 'charter', 'add_dirs', 'tools', 'org_visibility']) {
    await refusedWithoutWrites(`hire still requires explicit ${field}`, () => hire(`missing-${field.replaceAll('_', '-')}`, 0,
      { [field]: undefined }), /explicit|defaults/)
  }
  await refusedWithoutWrites('explicit user destination cannot silently hire under caller', () => hire('bad-root-destination', 0,
    { target: 'user' }), /only the user hires/)
  const staffArgs = { title: 'Ordering staff refusal', objective: 'Isolated ordering proof.', name: 'staff-bad', tier: 'haiku', grant: 0,
    charter: 'Isolated staff proof helper.', ...scope }
  const workCount = () => rig.one(`SELECT count(*)::int AS n FROM ot.work_items WHERE org_id=${orgId}`).n
  const beforeWork = workCount()
  await refusedWithoutWrites('staff hire omission refuses before seat commit', () => rig.tool('boss', 'orgtree_staff', staffArgs), /index/)
  p.check('staff refusal also commits no docket item', workCount() === beforeWork)
  r = await rig.tool('boss', 'orgtree_staff', { ...staffArgs, name: 'staff-ok', index: 1, title: 'Ordering staff success' })
  p.check('staff seat and item commit together at selected index', r.ok && sibs('boss')[1] === 'staff-ok'
    && workCount() === beforeWork + 1 && r.json.hire.index === 1, r.json)
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'staff turn settles', timeout: 60000 })

  // Archived siblings consume no slot, including filtered inspection requests.
  await rig.op({ op: 'retire', node: 'carol' })
  await refusedWithoutWrites('archived target cannot be reordered', () => reorder('boss', 'carol', 0), /live target/)
  r = await rig.tool('boss', 'orgtree_state_inspect', { include_archived: true, nodes: ['alice', 'carol'] })
  p.check('archived row index is null; live index counts full set before filtering', r.ok
    && r.json.nodes.find(a => a.name === 'carol')?.sibling_index === null
    && r.json.nodes.find(a => a.name === 'alice')?.sibling_index === sibs('boss').indexOf('alice'), r.json)
  await refusedWithoutWrites('rehire refuses a supplied new-hire index', () => rig.tool('boss', 'orgtree_rehire', { node: 'carol', index: 0 }), /rehire retains/)
  r = await rig.tool('boss', 'orgtree_rehire', { node: 'carol' })
  p.check('rehire without index remains accepted', r.ok && sibs('boss').includes('carol'), r.json)
  await rig.op({ op: 'retire', node: 'carol' })
  r = await hire('empty-first', 0, { target: 'bob' })
  p.check('hire index zero under empty parent succeeds', r.ok && joined('bob') === 'empty-first', r.json)
  r = await hire('only-superior', 0, { hire_type: 'superior', target: 'empty-first', add_dirs: undefined, tools: undefined, org_visibility: undefined })
  p.check('superior hire over only child accepts index zero', r.ok && joined('bob') === 'only-superior'
    && joined('only-superior') === 'empty-first', r.json)
  r = await hire('superior-mid', 1, { hire_type: 'superior', target: 'middle', add_dirs: undefined, tools: undefined, org_visibility: undefined })
  p.check('superior hire index excludes anchor and reparents it', r.ok && sibs('boss')[1] === 'superior-mid'
    && joined('superior-mid') === 'middle' && !sibs('boss').includes('middle'), r.json)
  await refusedWithoutWrites('agent cannot insert superior above root', () => hire('above-root', 0,
    { hire_type: 'superior', target: 'boss', add_dirs: undefined, tools: undefined, org_visibility: undefined }), /top.level|top level/)
  await refusedWithoutWrites('superior hire rejects conflicting capability input', () => hire('bad-superior', 0,
    { hire_type: 'superior', target: 'alice' }), /inherits target scope/)

  // User/internal default append remains unchanged, including top-level hires.
  const previous = sibs(null)
  await rig.op({ op: 'hire', name: 'user-default', tier: 'haiku' })
  p.check('non-agent root omission retains append', same(sibs(null), [...previous, 'user-default']))
  r = await op({ op: 'hire', name: 'user-root-first', tier: 'haiku', index: 0 })
  p.check('explicit root index zero succeeds', r.ok && sibs(null)[0] === 'user-root-first', r)

  // Tied midpoint and floating-point exhaustion are normalized atomically.
  rig.exec(`UPDATE ot.agents SET sibling_order=1 WHERE org_id=${orgId}
    AND parent_id=(SELECT id FROM ot.agents WHERE org_id=${orgId} AND name='boss') AND state='live'`)
  const tied = sibs('boss')
  const moved = tied.at(-1)
  r = await reorder('boss', moved, 1)
  const expected = tied.filter(a => a !== moved); expected.splice(1, 0, moved)
  p.check('equal sibling orders normalize preserving requested position', r.ok && same(sibs('boss'), expected), r.json)
  for (let i = 0; i < 60; i++) {
    r = await reorder('boss', i % 2 ? 'last' : 'first', 1)
    if (!r.ok) break
  }
  p.check('repeated midpoint insertion remains exact after precision exhaustion', r.ok && sibs('boss')[1] === 'last', r.json)

  const count = sibs('boss').length
  const concurrent = await Promise.all([hire('concurrent-a', 0), hire('concurrent-b', 0)])
  p.check('concurrent hires serialize with valid zero-based results and no lost seats', concurrent.every(a => a.ok && a.json.index === 0)
    && sibs('boss').length === count + 2 && sibs('boss').slice(0, 2).every(n => n.startsWith('concurrent-')), concurrent)
  const cr = await Promise.all([reorder('boss', 'concurrent-a', 0), reorder('boss', 'concurrent-b', 0)])
  p.check('concurrent sibling reorders retain all seats and deterministic order', cr.every(a => a.ok)
    && sibs('boss').length === count + 2 && new Set(sibs('boss')).size === count + 2, cr)

  await rig.api('POST', `/api/orgs/${rig.org}/nodes/boss/scope`, { tools: { orgtree: { team: false } } })
  r = await reorder('boss', 'alice', 0)
  p.check('reorder obeys team tool-group denial', !r.ok && /tool|scope|grant|available/.test(r.text ?? ''), r.text)
  p.keep(rig, { grep: /ordering|reorder|serializ|conflicted/ })
  return p.summary()
}
