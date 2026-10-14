// Actual orgtree_work MCP mutations, persisted chips and a fresh /chat read.
// Fake Claude + disposable synthetic DB only; no real providers or live data.
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('work-status-transition')
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns idle', timeout: 60000 })
  const slug = 'rig-status-transition', by = 'rig-status-replacement'
  const progress = { done_so_far: ['Synthetic progress'], working_on_next: [] }
  const step = (id, action, args = {}) => ({ id, tool: 'orgtree_work', args: { action, slug, ...args } })
  const cases = [
    { step: step('status-create', 'create', { slug: undefined, title: 'Rig status transition', objective: 'Synthetic transcript status fixture.', owner: 'boss' }) },
    { step: step('status-replacement', 'create', { slug: undefined, title: 'Rig status replacement', objective: 'Synthetic replacement.', owner: 'boss' }) },
    { step: step('status-start', 'update', { ...progress, status: 'in_progress', previous_status: 'bogus' }), from: 'open', to: 'in_progress' },
    { step: step('status-noop', 'update', { ...progress, status: 'in_progress' }) },
    { step: step('status-progress', 'update', progress) },
    { step: step('status-blocked', 'update', { ...progress, status: 'blocked', blocked_reason: 'Synthetic fixture; this proof unblocks it.' }), from: 'in_progress', to: 'blocked' },
    { step: step('status-refused', 'update', { ...progress, expected_rev: -1, status: 'done' }), failed: true },
    { step: step('status-accept', 'accept'), from: 'blocked', to: 'done' },
    { step: step('status-reopen-default', 'update', { ...progress, reopen: true }), from: 'done', to: 'in_progress' },
    { step: step('status-drop', 'update', { ...progress, status: 'dropped', dropped_reason: 'Synthetic cancellation; proof will reopen.' }), from: 'in_progress', to: 'dropped' },
    { step: step('status-reopen-explicit', 'update', { ...progress, reopen: true, status: 'approved' }), from: 'dropped', to: 'approved' },
    { step: step('status-supersede', 'supersede', { by }), from: 'approved', to: 'superseded' },
    { step: step('status-archive', 'archive') },
    { step: step('status-archive-again', 'archive') },
    { step: step('status-read', 'get') },
  ]
  rig.scenario({ agents: { boss: { turns: [{ match: 'STATUS-TRANSITION-PROOF', steps: [
    ...cases.map(c => c.step), { text: 'STATUS-TRANSITION-PROOF-DONE' },
  ] }] } }, default: { turns: [{ steps: [{ text: 'OK.' }] }] } })
  const logStart = rig.fakeLog('boss').length
  await rig.userMail('boss', 'STATUS-TRANSITION-PROOF')
  const chat = () => rig.api('GET', `/api/orgs/${rig.org}/nodes/boss/chat?last=100`)
  await rig.waitFor(async () => {
    const c = await chat()
    return !c.busy && c.messages.some(m => m.text?.includes('STATUS-TRANSITION-PROOF-DONE'))
  }, { what: 'all scripted docket calls settle', timeout: 90000 })
  const stored = rig.sql(`SELECT body FROM ot.convo WHERE agent_id IN
    (SELECT a.id FROM ot.agents a JOIN ot.orgs o ON o.id=a.org_id WHERE o.slug='${rig.org}' AND a.name='boss')`)
    .flatMap(r => r.body.tools ?? [])
  const reloaded = (await chat()).messages.flatMap(m => m.tools ?? [])
  const results = rig.fakeLog('boss').slice(logStart).filter(row => row.kind === 'tool_result' && row.tool === 'orgtree_work')
  p.check('fixture executed each scripted tool exactly once', results.length === cases.length, { actual: results.length, expected: cases.length })
  for (const [index, c] of cases.entries()) {
    const id = c.step.id, result = results[index]
    const chip = stored.find(t => t.id === id), reload = reloaded.find(t => t.id === id)
    let body
    try { body = JSON.parse(result?.text ?? '') } catch { body = null }
    const changes = chip?.refs?.filter(r => r.status_change) ?? []
    if (c.from) {
      p.check(`${id}: result carries the real transaction before/after`, result && !result.is_error
        && body?.previous_status === c.from && body?.status === c.to, body)
      p.check(`${id}: persisted ticket reference carries the exact transition`, !!chip && changes.length === 1
        && changes[0].kind === 'ticket' && changes[0].id === slug
        && changes[0].status_change.from === c.from && changes[0].status_change.to === c.to, changes)
      p.check(`${id}: fresh chat retains the same captured transition`, !!reload && !!chip
        && reload.refs?.some(r => r.kind === 'ticket' && r.id === slug
          && r.status_change?.from === c.from && r.status_change?.to === c.to)
        && JSON.stringify(reload.refs) === JSON.stringify(chip.refs), reload?.refs)
    } else {
      p.check(`${id}: ${c.failed ? 'refused' : 'non-status'} call adds no transition`, !!chip && !!reload
        && (c.failed ? !!result?.is_error && !!chip.error : result && !result.is_error)
        && !body?.previous_status && changes.length === 0 && !reload.refs?.some(r => r.status_change), { body, refs: chip?.refs, error: chip?.error })
    }
  }
  const final = rig.one(`SELECT status, archived_at FROM ot.work_items WHERE slug='${slug}'
    AND org_id IN (SELECT id FROM ot.orgs WHERE slug='${rig.org}')`)
  p.check('archival preserves superseded status rather than inventing an archived status', final?.status === 'superseded' && !!final.archived_at, final)
  const concurrent = await rig.tool('boss', 'orgtree_work', { action: 'create', title: 'Rig concurrent status',
    objective: 'Synthetic lock-order before-state check.', owner: 'boss' })
  p.check('concurrent fixture creates without a fictitious previous status', concurrent.ok
    && concurrent.json?.slug === 'rig-concurrent-status' && !concurrent.json.previous_status, concurrent.json)
  const paired = await Promise.all(['in_progress', 'approved'].map(status => rig.tool('boss', 'orgtree_work', {
    action: 'update', slug: 'rig-concurrent-status', ...progress, status,
  })))
  const ordered = paired.map(r => r.json).filter(Boolean).sort((a, b) => a.rev - b.rev)
  p.check('concurrent results form the actual serialized before/after chain', paired.every(r => r.ok)
    && ordered.length === 2 && ordered[0].previous_status === 'open'
    && ordered[1].previous_status === ordered[0].status && ordered[0].status !== ordered[1].status, ordered)
  p.file('persisted-and-reloaded.json', { cases, stored: stored.filter(t => t.id?.startsWith('status-')),
    reloaded: reloaded.filter(t => t.id?.startsWith('status-')), results, final, concurrent: ordered })
  p.keep(rig, { agents: ['boss'] })
  p.note('Actual synthetic MCP/transaction/transcript/chat capture; no installed app or real provider/device claim.')
  return p.summary()
}
