import { mountView, inAct } from './harness'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useWorkItems } from '../src/canvas/useworkitems'
import { useHistoricalWorkReferences } from '../src/canvas/workrefresolve'
import { forgetWorkInflight } from '../src/api'
import { bumpLive } from '../src/livebus'
import { WORK_FOREGROUND_FORMAT as format } from '../src/workforeground'

test('remote archive edits refresh mounted positive and negative references after live bumps', async t => {
  forgetWorkInflight()
  let revision = 'catalog-before', foregroundCalls = 0, referenceCalls = 0
  let references = [{ slug: 'old-ticket', title: 'Before' }]
  const index = new Map()
  // The PG archived-edit/rename controls prove this transport contract:
  // identical active rows/counts, a changed revision, and new exact answers.
  const active = { items: [], references: [],
    counts: { active: 0, archived: 1, attention: 0, backlogged: 0 } }
  globalThis.fetch = async input => {
    let body: unknown
    if (String(input).includes('work-items-foreground')) {
      ++foregroundCalls
      body = { format, revision, ...active }
    } else {
      ++referenceCalls
      body = { references }
    }
    return { ok: true, status: 200, headers: new Headers(), json: async () => body } as Response
  }
  function Probe() {
    const work = useWorkItems('org')
    const resolved = useHistoricalWorkReferences(work.value ? 'old-ticket new-ticket' : '',
      { org: 'org', boundedItems: true, workRevision: work.value?.revision }, index)
    return <div>{['old-ticket', 'new-ticket'].map(id => <span key={id} data-id={id}>
      {resolved.index?.get(id)?.title ?? resolved.world.itemOutcome?.(id)}</span>)}</div>
  }
  const view = await mountView(<Probe />, el => el)
  t.after(() => view.unmount())
  const title = (id: string) => view.el.querySelector(`[data-id="${id}"]`)?.textContent
  const bump = () => inAct(async () => {
    bumpLive(); await new Promise(resolve => setTimeout(resolve, 200))
  })
  assert.equal(title('old-ticket'), 'Before')
  assert.equal(title('new-ticket'), 'absent')
  assert.equal(referenceCalls, 1)
  await bump()
  assert.equal(referenceCalls, 1, 'unchanged revision reuses settled answers')
  revision = 'catalog-edited'
  references = [{ slug: 'old-ticket', title: 'After' }]
  await bump()
  assert.equal(title('old-ticket'), 'After')
  assert.equal(referenceCalls, 2, 'positive answer refreshed without local mutation invalidation')
  revision = 'catalog-renamed'
  references = [{ slug: 'new-ticket', title: 'Renamed' }]
  await bump()
  assert.equal(title('old-ticket'), 'absent', 'stale positive is gone')
  assert.equal(title('new-ticket'), 'Renamed', 'stale negative is gone')
  assert.equal(referenceCalls, 3)
  assert.equal(foregroundCalls, 4, 'each real live bump refetched foreground')
})
