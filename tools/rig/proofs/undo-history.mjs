// The user's persistent undo history (docs/rust-engine/undo-history.md;
// docket undo-history-engine-foundation-durable-journal-a). Scratch rig only:
// fake CLIs, the rig's own database, no provider calls.
//
// Proves, through the HTTP routes the windows use:
//   1. a user move records one entry; undo restores the exact parent and
//      live-sibling order, redo restores the move, both through the forward ops
//   2. a new action clears redo; a gesture is one entry and one transaction
//      (a refusing step applies nothing); back-references name the newborn
//   3. hire undo retires an agent that never ran without asking; one that ran
//      asks first, and a stale confirmation asks again; redo rehires the same
//      record in its slot
//   4. retire undo rehires exactly the archived team in place; redo retires it
//   5. retool (model, effort, charter) undo/redo restore before/after values
//   6. refuse-then-older: a change made outside the history refuses that
//      entry with its reason and nothing else; the next undo moves on
//   7. agent tool actions, no-ops and duplicate request ids never record;
//      a stale id answers history_moved; two windows consume an entry once
//   7b. a grant's side effects (ancestors and the org's folders raised, a
//      folder clamped beneath) are restored exactly, or the undo refuses
//   8. the bound of 100 per org; the history survives an engine restart;
//      no entry data in any answer or in the feed record
// RED controls: the tree differs before each undo (so a restored match is
// meaningful), and every conflict check is made against a real change.
import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('undo-history')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns settle', timeout: 60000 })
  const org = rig.org
  const orgId = rig.one(`SELECT id FROM ot.orgs WHERE slug='${org}'`).id
  const api = (method, route, body) => rig.api(method, route, body)
    .then(json => ({ ok: true, json }), e => ({ ok: false, status: e.status, json: e.body, text: e.message }))
  const hist = () => rig.api('GET', `/api/orgs/${org}/undo-history`)
  const undo = (id, confirm) => api('POST', `/api/orgs/${org}/undo-history/undo`, confirm ? { id, confirm } : { id })
  const redo = id => api('POST', `/api/orgs/${org}/undo-history/redo`, { id })
  const op = body => api('POST', `/api/orgs/${org}/ops`, body)
  const gesture = body => api('POST', `/api/orgs/${org}/gesture`, body)
  const scope = (node, body) => api('POST', `/api/orgs/${org}/nodes/${node}/scope`, body)
  const entries = () => rig.one(`SELECT count(*)::int AS n FROM ot.undo_entries WHERE org_id=${orgId}`).n
  // the tree as the canvas shows it: every live agent's parent and live sibling rank
  const tree = () => {
    const rows = rig.sql(`SELECT a.name, p.name AS parent FROM ot.agents a LEFT JOIN ot.agents p ON p.id=a.parent_id
      WHERE a.org_id=${orgId} AND a.state='live' ORDER BY a.parent_id NULLS FIRST, a.sibling_order, a.id`)
    return rows.map(r => `${r.name}<${r.parent ?? 'user'}`).join(' ')
  }
  const kids = parent => rig.sql(`SELECT name FROM ot.agents WHERE org_id=${orgId} AND state='live'
    AND parent_id IS NOT DISTINCT FROM ${parent ? `(SELECT id FROM ot.agents WHERE org_id=${orgId} AND name='${parent}')` : 'NULL'}
    ORDER BY sibling_order, id`).map(r => r.name).join(',')
  const row = name => rig.one(`SELECT id, state, tier, charter, scope, parent_id, generation FROM ot.agents WHERE org_id=${orgId} AND name='${name}'`)
  const leak = j => /"(data|before|after|fields|members|moved)"/.test(JSON.stringify(j ?? {}))

  // ---- 0. the seed's own hires (POST /ops) recorded; then an empty history
  const seeded = rig.sql(`SELECT kind, label FROM ot.undo_entries WHERE org_id=${orgId} ORDER BY id`)
  p.check("0. the fixture's user hires through /ops recorded one hire entry each", seeded.length === 4
    && seeded.every(e => e.kind === 'hire') && seeded[0].label === 'Hire boss', seeded)
  rig.exec(`DELETE FROM ot.undo_entries WHERE org_id=${orgId}`)
  let h = await hist()
  p.check('0. a fresh org has nothing to undo or redo', h.undo === null && h.redo === null && h.bound === 100
    && Array.isArray(h.entries) && h.entries.length === 0, h)
  let r = await undo(1)
  p.check('0. undo with nothing recorded answers 404 history_empty', !r.ok && r.status === 404 && r.json?.code === 'history_empty', r.json)

  // ---- 1. a move
  const s0 = tree()
  r = await op({ op: 'move', node: 'carol', new_parent: 'alice' })
  const s1 = tree()
  const moveEntry = r.json?.history_entry
  p.check('1. a user move answers its history entry', r.ok && moveEntry?.kind === 'move' && moveEntry?.label === 'Move carol under alice', r.json)
  p.check('1. RED control: the move changed the tree', s0 !== s1, { s0, s1 })
  h = await hist()
  p.check('1. the undo target is the move', h.undo?.id === moveEntry?.id && h.undo?.confirm_required === false, h.undo)
  r = await undo(moveEntry.id)
  p.check('1. undo answers undone', r.ok && r.json?.status === 'undone' && r.json?.id === moveEntry.id, r.json)
  p.check('1. undo restores the exact parent and sibling order', tree() === s0, { want: s0, got: tree() })
  p.check('1. after undo the move is the redo target and nothing is left to undo', r.json?.history?.redo?.id === moveEntry.id
    && r.json?.history?.undo === null, r.json?.history)
  r = await redo(moveEntry.id)
  p.check('1. redo answers redone and restores the moved tree', r.ok && r.json?.status === 'redone' && tree() === s1, { got: tree(), want: s1 })
  r = await undo(moveEntry.id)
  p.check('1. undo again restores the original tree', r.ok && tree() === s0, tree())

  // ---- 2. new action clears redo; gestures
  r = await op({ op: 'reorder', node: 'carol', index: 0 })
  h = await hist()
  p.check('2. a new action clears redo', r.ok && h.redo === null && !h.entries.some(e => e.state === 'undone')
    && h.undo?.id === r.json?.history_entry?.id && h.undo?.label === 'Reorder carol', h)
  const reorderEntry = r.json.history_entry
  r = await undo(reorderEntry.id)
  p.check('2. reorder undo restores order', r.ok && tree() === s0, tree())

  const beforeGesture = tree()
  const nBefore = entries()
  r = await gesture({ label: 'Hire gina first', request_id: 'g-1', steps: [
    { op: 'hire', name: 'gina', parent: 'boss', tier: 'haiku', title: 'Gesture hire' },
    { op: 'reorder', node: '$0.node', index: 0 },
  ] })
  p.check('2. a hire with its placement is one gesture, one entry', r.ok && r.json?.history_entry?.kind === 'hire'
    // the undone reorder was cleared by this new action: one out, one in
    && r.json?.history_entry?.label === 'Hire gina first' && entries() === nBefore
    && Array.isArray(r.json?.results) && r.json.results.length === 2, r.json)
  p.check('2. the back-reference placed the newborn first', kids('boss').startsWith('gina,'), kids('boss'))
  const ginaEntry = r.json.history_entry
  const gina = row('gina')
  r = await gesture({ label: 'Hire gina first', request_id: 'g-1', steps: [
    { op: 'hire', name: 'gina', parent: 'boss', tier: 'haiku' }, { op: 'reorder', node: '$0.node', index: 0 }] })
  p.check('2. a repeated request id is not applied again and names the agent it made', r.ok && r.json?.duplicate === true
    && r.json?.history_entry?.id === ginaEntry.id && r.json?.results?.[0]?.node === 'gina'
    && rig.sql(`SELECT 1 FROM ot.agents WHERE org_id=${orgId} AND name='gina'`).length === 1, r.json)
  const atomBefore = tree()
  const atomEntries = entries()
  r = await gesture({ steps: [{ op: 'move', node: 'carol', new_parent: 'alice' }, { op: 'move', node: 'nobody-here', new_parent: 'boss' }] })
  p.check('2. a gesture whose step refuses applies nothing and records nothing', !r.ok && tree() === atomBefore && entries() === atomEntries, r.text)
  r = await gesture({ steps: [{ op: 'move', node: 'carol', new_parent: 'alice' }, { op: 'scope', node: 'carol', effort: 'high' }] })
  p.check('2. a mixed gesture is refused 400 gesture_mixed before anything runs', !r.ok && r.status === 400
    && r.json?.code === 'gesture_mixed' && tree() === atomBefore, r.json)
  r = await gesture({ steps: [{ op: 'reorder', node: '$1.node', index: 0 }, { op: 'reorder', node: 'carol', index: 0 }] })
  p.check('2. a reference to a later step is refused 400 gesture_ref', !r.ok && r.json?.code === 'gesture_ref', r.json)

  // ---- 3. hire undo / confirm / redo
  r = await undo(ginaEntry.id)
  p.check('3. a hire that never ran is retired without asking', r.ok && r.json?.status === 'undone' && row('gina').state === 'archived', r.json)
  p.check('3. hire undo leaves the tree as before the gesture', tree() === beforeGesture, { got: tree(), want: beforeGesture })
  r = await redo(ginaEntry.id)
  const gina2 = row('gina')
  p.check('3. redo rehires the same record in its slot (never a fresh namesake)', r.ok && gina2.state === 'live' && gina2.id === gina.id
    && kids('boss').startsWith('gina,') && rig.sql(`SELECT 1 FROM ot.agents WHERE org_id=${orgId} AND name='gina'`).length === 1, { r: r.json, kids: kids('boss') })

  r = await op({ op: 'hire', name: 'hank', parent: 'boss', tier: 'haiku', title: 'Worked hire' })
  const hankEntry = r.json.history_entry
  await rig.userMail('hank', 'Undo proof: answer OK only.')
  await rig.waitTurns('hank', 1)
  h = await hist()
  p.check('3. a hire whose agent ran says so on the undo target', h.undo?.id === hankEntry.id && h.undo?.confirm_required === true, h.undo)
  r = await undo(hankEntry.id)
  const token1 = r.json?.confirm
  const turns1 = r.json?.turns
  p.check('3. undoing it asks first (turns counted) and changes nothing', r.ok && r.json?.status === 'confirm' && r.json?.agent === 'hank'
    && r.json?.turns >= 1 && typeof token1 === 'string' && row('hank').state === 'live', r.json)
  await rig.userMail('hank', 'Undo proof: answer OK again.')
  await rig.waitTurns('hank', 2)
  r = await undo(hankEntry.id, token1)
  p.check('3. a confirmation made before another turn asks again with the new count', r.ok && r.json?.status === 'confirm'
    && r.json?.turns > turns1 && r.json?.confirm !== token1 && row('hank').state === 'live', r.json)
  r = await undo(hankEntry.id, r.json.confirm)
  p.check('3. the fresh confirmation retires it', r.ok && r.json?.status === 'undone' && row('hank').state === 'archived', r.json)

  // ---- 4. retire a team and undo it
  const t0 = tree()
  const ids0 = rig.sql(`SELECT id, name FROM ot.agents WHERE org_id=${orgId} AND name IN ('alice','bob')`)
  r = await op({ op: 'retire', node: 'alice' })
  const retireEntry = r.json?.history_entry
  p.check('4. retiring a seat with reports records one retire entry for its team', r.ok && retireEntry?.kind === 'retire'
    && retireEntry?.label === 'Retire alice and its team' && row('bob').state === 'archived', r.json)
  p.check('4. RED control: the team left the tree', tree() !== t0)
  r = await undo(retireEntry.id)
  p.check('4. undo rehires exactly the team, each under its parent in its place', r.ok && tree() === t0, { got: tree(), want: t0 })
  const ids1 = rig.sql(`SELECT id, name FROM ot.agents WHERE org_id=${orgId} AND name IN ('alice','bob')`)
  p.check('4. the same records came back', JSON.stringify(ids0) === JSON.stringify(ids1), { ids0, ids1 })
  r = await redo(retireEntry.id)
  p.check('4. redo retires the same team again', r.ok && row('alice').state === 'archived' && row('bob').state === 'archived', r.json)
  r = await undo(retireEntry.id)
  p.check('4. and undo brings it back once more', r.ok && tree() === t0, tree())

  // ---- 5. retool
  const c0 = row('carol')
  r = await gesture({ label: 'Settings: carol', steps: [
    { op: 'switch_model', node: 'carol', tier: 'sonnet' },
    { op: 'scope', node: 'carol', effort: 'high', charter: 'Undo proof charter.' },
  ] })
  const retoolEntry = r.json?.history_entry
  const c1 = row('carol')
  p.check('5. a settings save with a model switch is one retool entry', r.ok && retoolEntry?.kind === 'retool'
    && c1.tier === 'sonnet' && c1.scope?.effort === 'high' && c1.charter === 'Undo proof charter.', { r: r.json, c1 })
  r = await undo(retoolEntry.id)
  const c2 = row('carol')
  p.check('5. undo restores the model, the absent effort and the old charter', r.ok && c2.tier === c0.tier
    && (c2.scope?.effort ?? null) === (c0.scope?.effort ?? null) && (c2.charter ?? '') === (c0.charter ?? ''), { c0, c2, r: r.json })
  r = await redo(retoolEntry.id)
  const c3 = row('carol')
  p.check('5. redo restores the after values', r.ok && c3.tier === 'sonnet' && c3.scope?.effort === 'high' && c3.charter === 'Undo proof charter.', c3)

  // ---- 6. refuse-then-older
  const nE = entries()
  const tool = await rig.tool('boss', 'orgtree_retool', { node: 'carol', charter: 'Changed by an agent.' })
  p.check('6. an agent tool action never records', tool.ok !== false && entries() === nE, tool)
  r = await op({ op: 'move', node: 'gina', new_parent: 'carol' })
  const ginaMove = r.json.history_entry
  r = await undo(ginaMove.id)
  p.check('6. the newest entry undoes normally', r.ok && r.json?.status === 'undone')
  // a new action cleared the gina move's redo; now the retool entry is next (gina's move came after it)
  r = await op({ op: 'reorder', node: 'gina', index: 1 })
  const unrelated = r.json.history_entry
  r = await undo(unrelated.id)
  h = await hist()
  p.check('6. the next undo target is the retool entry', r.ok && h.undo?.id === retoolEntry.id, h.undo)
  const before6 = row('carol')
  r = await undo(retoolEntry.id)
  p.check('6. a field changed outside the history refuses that entry 409 history_conflict with its reason', !r.ok && r.status === 409
    && r.json?.code === 'history_conflict' && /charter/.test(r.json?.reason ?? '') && r.json?.id === retoolEntry.id, r.json)
  const after6 = row('carol')
  p.check('6. the refusal changed nothing else', JSON.stringify(before6) === JSON.stringify(after6), { before6, after6 })
  h = await hist()
  p.check('6. the refused entry stays listed with its reason and the next older entry is the target',
    h.entries.find(e => e.id === retoolEntry.id)?.state === 'refused' && h.undo?.id !== retoolEntry.id
    && (h.undo === null || h.undo.id < retoolEntry.id), h)

  // ---- 7. moved / concurrent / no-op
  const target = (await hist()).undo
  r = await undo((target?.id ?? 0) + 999)
  p.check('7. a stale id answers 409 history_moved and changes nothing', !r.ok && r.status === 409 && r.json?.code === 'history_moved', r.json)
  if (target) {
    const both = await Promise.all([undo(target.id), undo(target.id)])
    const done = both.filter(x => x.ok && x.json?.status === 'undone').length
    const moved = both.filter(x => !x.ok && x.json?.code === 'history_moved').length
    p.check('7. two windows sending the same undo consume the entry once', done === 1 && moved === 1, both.map(b => b.json))
  }
  const nNoop = entries()
  r = await op({ op: 'move', node: 'carol', new_parent: kids('boss').split(',').includes('carol') ? 'boss' : 'alice' })
  p.check('7. a no-op records nothing', r.ok && r.json?.unchanged === true && r.json?.history_entry === null && entries() === nNoop, r.json)
  r = await op({ op: 'rename', node: 'gina', name: 'gina' })
  p.check('7. operations outside the history are not recorded', entries() === nNoop)

  // ---- 7b. side effects of a grant (coordinator 2026-10-14 19:07Z)
  const folder = path.join(rig.data, 'undo-proof', 'shared')
  fs.mkdirSync(folder, { recursive: true })
  const scopesNow = () => JSON.stringify(rig.sql(`SELECT name, scope FROM ot.agents WHERE org_id=${orgId} AND state<>'deleted' ORDER BY id`))
  const orgDirs = () => JSON.stringify(rig.one(`SELECT settings->'dirs' AS d FROM ot.orgs WHERE id=${orgId}`)?.d ?? null)
  const g0 = scopesNow()
  const d0 = orgDirs()
  r = await scope('carol', { add_dirs: [...(row('carol').scope?.add_dirs ?? []), { path: folder, mode: 'rw' }] })
  const grantEntry = r.json?.history_entry
  const g1 = scopesNow()
  const d1 = orgDirs()
  p.check("7b. RED control: the grant raised boss and the org's folders", r.ok && grantEntry?.kind === 'retool' && g1 !== g0 && d1 !== d0,
    { r: r.json, d0, d1 })
  r = await undo(grantEntry.id)
  p.check("7b. undo lowers the raised ancestors and the org's folders exactly", r.ok && scopesNow() === g0 && orgDirs() === d0,
    { r: r.json, d: orgDirs() })
  r = await redo(grantEntry.id)
  p.check('7b. redo raises them again exactly', r.ok && scopesNow() === g1 && orgDirs() === d1, r.json)
  r = await op({ op: 'retool', node: 'boss', remove_dirs: [folder] })
  const clampEntry = r.json?.history_entry
  const g2 = scopesNow()
  p.check("7b. RED control: removing boss's folder clamped it from carol", r.ok && clampEntry?.kind === 'retool'
    && !JSON.stringify(row('carol').scope?.add_dirs ?? []).includes('undo-proof'), r.json)
  r = await undo(clampEntry.id)
  p.check('7b. undo hands the clamped folder back beneath, exactly', r.ok && scopesNow() === g1 && orgDirs() === d1, r.json)
  r = await redo(clampEntry.id)
  p.check('7b. redo clamps it again', r.ok && scopesNow() === g2, r.json)
  const toolChange = await rig.tool('boss', 'orgtree_retool', { node: 'carol', org_visibility: 'team' })
  const g3 = scopesNow()
  r = await undo(clampEntry.id)
  p.check('7b. a clamped row changed since refuses the undo with its reason, restoring nothing', !r.ok && r.json?.code === 'history_conflict'
    && /carol/.test(r.json?.reason ?? '') && scopesNow() === g3, { tool: toolChange, r: r.json })

  // ---- 8. data never leaves; feed record; bound; restart
  h = await hist()
  p.check('8. no entry data in the history answer', !leak(h), h)
  const snap = await rig.api('GET', `/api/orgs/${org}/records`)
  const rec = snap?.records?.find(x => x.body && Object.hasOwn(x.body, 'undo_history'))?.body?.undo_history
  p.check('8. the feed carries the undo record (rev and both targets, no data)', rec && typeof rec.rev === 'number'
    && 'undo' in rec && 'redo' in rec && !leak(rec), rec)
  for (let i = 0; i < 104; i++) {
    const res = await op({ op: 'reorder', node: 'carol', index: i % 2 })
    if (!res.ok) { p.check('8. bound filler reorder', false, res.text); break }
  }
  p.check('8. the history keeps at most 100 entries per org', entries() === 100, entries())
  h = await hist()
  const keep = JSON.stringify(h.entries)
  await rig.restart()
  const h2 = await hist()
  p.check('8. the history survives an engine restart', JSON.stringify(h2.entries) === keep && h2.undo?.id === h.undo?.id)
  const tr = tree()
  r = await undo(h2.undo.id)
  p.check('8. and undo still works after it', r.ok && r.json?.status === 'undone' && tree() !== tr, r.json)
  p.file('final-history.json', await hist())
  p.keep(rig, { grep: /undo|gesture|history/i })
  return p.summary()
}
