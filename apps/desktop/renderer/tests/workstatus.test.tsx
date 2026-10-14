import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Msg, ToolChip } from '../src/canvas/desk'
import { statusLabel } from '../src/canvas/docketstatus'
import type { ChatMessage, ToolChip as ToolData } from '../src/types'

globalThis.fetch = async () => new Response(JSON.stringify({ references: [{ slug: 'fix-x', title: 'Fixture ticket', status: 'done' }] }),
  { status: 200, headers: { 'Content-Type': 'application/json' } })

const chip = (change?: { from: string; to: string }): ToolData => ({
  id: 'status-call', name: 'mcp__orgtree__orgtree_work', arg: 'update fix-x', result: '{"updated":"fix-x"}',
  refs: [{ kind: 'ticket', id: 'fix-x', ...(change ? { status_change: change } : {}) }],
})
const transition = (el: Element) => el.querySelector('.tline .tool-work-transition')

test('changed tool calls show both actual states using docket wording and colour classes', async t => {
  const view = await mountView(<ToolChip t={chip({ from: 'in_progress', to: 'blocked' })} slug="org" nid="worker" />,
    el => el.textContent ?? '')
  t.after(() => view.unmount())
  for (const [from, to] of [['in_progress', 'blocked'], ['blocked', 'done'], ['done', 'in_progress'],
    ['in_progress', 'dropped'], ['open', 'superseded'], ['review', 'approved'], ['approved', 'deploy_ready'], ['backlogged', 'open']]) {
    await view.render(<ToolChip t={chip({ from, to })} slug="org" nid="worker" />)
    const label = transition(view.el)!
    assert.ok(label, `${from} → ${to} must render inline`)
    assert.equal(label.textContent, `${statusLabel(from)} → ${statusLabel(to)}`)
    assert.equal(label.querySelector(`.docket-status.status-${from}`)?.textContent, statusLabel(from))
    assert.equal(label.querySelector(`.docket-status.status-${to}`)?.textContent, statusLabel(to))
    assert.equal(label.getAttribute('aria-label'), `Ticket status changed: ${statusLabel(from)} → ${statusLabel(to)}`)
  }
})

test('legacy, no-op, unknown and missing states show no extra transition', async t => {
  const view = await mountView(<ToolChip t={chip()} slug="org" nid="worker" />, el => el.textContent ?? '')
  t.after(() => view.unmount())
  for (const value of [chip(), chip({ from: 'done', to: 'done' }), chip({ from: 'unknown', to: 'done' }),
    chip({ from: 'blocked', to: 'unknown' }), chip({ from: '', to: 'done' }), chip({ from: 'blocked', to: '' })]) {
    await view.render(<ToolChip t={value} slug="org" nid="worker" />)
    assert.equal(transition(view.el), null)
    assert.ok(view.el.querySelector('.tool-ticket-plain'), 'legacy ticket remains visible')
  }
})

test('failed/refused calls suppress even stale transition metadata', async t => {
  const view = await mountView(<ToolChip t={{ ...chip({ from: 'blocked', to: 'done' }), error: 'refused' }} slug="org" nid="worker" />,
    el => el.textContent ?? '')
  t.after(() => view.unmount())
  assert.equal(transition(view.el), null)
  assert.ok(view.el.querySelector('.terrtxt'))
})

test('writing/running preview inputs cannot invent a previous state', async t => {
  const { result: _result, ...preview } = chip()
  const view = await mountView(<ToolChip t={{ ...preview, writing_started_at: '2026-10-14T12:00:00Z',
    preview_input: { status: 'done', previous_status: 'blocked' } }} slug="org" nid="worker" />, el => el.textContent ?? '')
  t.after(() => view.unmount())
  assert.equal(transition(view.el), null)
  await view.render(<ToolChip t={{ ...preview, started_at: '2026-10-14T12:00:00Z' }} slug="org" nid="worker" />)
  assert.equal(transition(view.el), null)
})

test('ticket opening and context-menu identity remain beside the transition without folding the call', async t => {
  const opened: string[] = []
  const view = await mountView(<ToolChip t={chip({ from: 'blocked', to: 'done' })} slug="org" nid="worker"
    onWorkLink={work => opened.push(work.slug)} />, el => el.textContent ?? '')
  t.after(() => view.unmount())
  await flush()
  const ticket = view.el.querySelector<HTMLButtonElement>('.tool-ticket')!
  assert.ok(ticket)
  assert.equal(ticket.getAttribute('data-object-id'), 'fix-x')
  await inAct(() => ticket.click())
  assert.deepEqual(opened, ['fix-x'])
  await inAct(() => (transition(view.el) as HTMLElement).click())
  assert.equal(view.el.querySelector('.respre-json'), null, 'inline links/status must not expand the tool')
})

test('shared message rendering keeps the same captured transition after serialize and reload', async t => {
  const original: ChatMessage = { role: 'assistant', text: '', ts: '2026-10-14T12:00:00Z', seq: 1,
    tools: [chip({ from: 'in_progress', to: 'blocked' })] }
  const view = await mountView(<Msg m={original} slug="org" nid="worker" />, el => el.textContent ?? '')
  t.after(() => view.unmount())
  assert.equal(transition(view.el)?.textContent, 'In progress → Blocked')
  await view.render(<Msg m={JSON.parse(JSON.stringify(original))} slug="org" nid="worker" />)
  assert.equal(transition(view.el)?.textContent, 'In progress → Blocked')
  assert.equal(view.el.querySelectorAll('.tool-work-transition').length, 1)
})
