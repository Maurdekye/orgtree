import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolChip } from '../src/canvas/desk'
import { forgetWorkInflight } from '../src/api'
import { bumpLive } from '../src/livebus'

const call = { id: 'work-call', name: 'mcp__orgtree__orgtree_work', arg: 'update repair', result: '{}',
  refs: [{ kind: 'ticket' as const, id: 'repair', status_change: { from: 'open', to: 'review' } }] }
const render = (org = 'synthetic') => <ToolChip t={call} slug={org} nid="author" onWorkLink={() => {}} />
const response = (status?: string) => new Response(JSON.stringify({ references: status ? [{ slug: 'repair', title: 'Repair fixture', status }] : [] }),
  { status: 200, headers: { 'content-type': 'application/json' } })
const bump = () => inAct(async () => { bumpLive(); await new Promise(r => setTimeout(r, 160)) })

test('ticket accent follows current remote status while the captured transition stays historical', async t => {
  forgetWorkInflight(); let status = 'done'
  globalThis.fetch = async () => response(status)
  const v = await mountView(render(), el => el); t.after(() => v.unmount())
  assert.ok(v.el.querySelector('.tool-ref .ref-chip.ref-item.status-done'), 'current done state, not captured review')
  status = 'blocked'; await bump()
  assert.ok(v.el.querySelector('.tool-ref .ref-chip.ref-item.status-blocked'), 'remote live bump refreshes the accent')
  assert.equal(v.el.querySelector('.tool-work-transition')?.textContent, 'Open → Agent review')
})

test('duplicate inline ticket references share a refresh and deletion removes the coloured card', async t => {
  forgetWorkInflight(); let exists = true, reads = 0
  globalThis.fetch = async () => { ++reads; return response(exists ? 'in_progress' : undefined) }
  const v = await mountView(<>{render()}{render()}</>, el => el); t.after(() => v.unmount())
  assert.equal(v.el.querySelectorAll('.tool-ref .ref-chip.ref-item.status-in_progress').length, 2)
  assert.equal(reads, 1)
  exists = false; await bump()
  assert.equal(reads, 2, 'duplicate cards reuse the same current epoch lookup')
  assert.equal(v.el.querySelector('.tool-ref .ref-chip.ref-item') === null, true)
  assert.equal(v.el.querySelectorAll('.tool-ticket-plain').length, 2)
})

test('switching org never paints the previous org state while the new lookup is pending', async t => {
  forgetWorkInflight(); let release: (() => void) | undefined
  globalThis.fetch = async input => {
    if (String(input).includes('/other/')) await new Promise<void>(r => { release = r })
    return response(String(input).includes('/other/') ? 'approved' : 'done')
  }
  const v = await mountView(render(), el => el); t.after(() => v.unmount())
  assert.ok(v.el.querySelector('.tool-ref .ref-chip.ref-item.status-done'))
  await v.render(render('other'))
  assert.equal(v.el.querySelector('.tool-ref .ref-chip.ref-item.status-done') === null, true)
  await inAct(async () => { release?.(); await Promise.resolve() })
  assert.ok(v.el.querySelector('.tool-ref .ref-chip.ref-item.status-approved'))
})
