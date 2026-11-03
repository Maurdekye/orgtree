// C13 (tray status summary) and C14 (progress panel: reported summary, todo content).
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { AgentTray } from '../src/canvas/agenttray'
import { ProgressView } from '../src/canvas/progress'
import type { CanvasNode } from '../src/canvas/shared'
import { RICH, expectRich, refs } from './fixtures/richformat'

// the runner defines __SRC_DIR__ (bundles run from node_modules/.orgtree-tests)
declare const __SRC_DIR__: string

test('RT-C13 the agent tray status summary renders rich text (inline)', async t => {
  const node = { id: 'alpha', state: 'live', kind: 'agent', tier: 'sonnet', children: [], turns: [],
    last_status: { status: 'working', summary: RICH, at: '2026-11-03T10:00:00Z' } } as unknown as CanvasNode
  const view = await mountView(<AgentTray map={new Map([['alpha', node]])} rows={[{ node, depth: 0 }] as never}
    query="" onQuery={() => {}} archived={false} onArchived={() => {}} onPick={() => {}} refs={refs} />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(2) })
  const text = view.el.querySelector('.tray-sum-text')
  assert.ok(text, 'the summary line rendered')
  expectRich(text!)
})

const model = {
  lane: 'claude', laneLabel: 'Claude', processNote: 'running', historical: false,
  todo: { supply: 'live', source: 'claude-todo', note: '', items: [{ status: 'pending', content: RICH }] },
  subagents: { note: '' },
  reported: { status: 'working', summary: RICH, note: '', stale: false },
  activity: { note: '', tail: [] },
}

test('RT-C14 the progress panel renders the todo content and the reported summary as rich text (inline)', async t => {
  localStorage.clear()
  const view = await mountView(<ProgressView model={model as never} refs={refs} />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(2) })
  const todo = view.el.querySelector('.todo-text')
  assert.ok(todo, 'the todo item rendered')
  expectRich(todo!)
  const fold = [...view.el.querySelectorAll('button.progress-fold')].find(b => /reported/.test(b.textContent ?? '')) as HTMLElement
  assert.ok(fold)
  if (fold.getAttribute('aria-expanded') !== 'true') await inAct(async () => { fold.click(); await flush(2) })
  const summary = view.el.querySelector('.progress-summary')
  assert.ok(summary, 'the reported summary rendered')
  expectRich(summary!)
})

test('RT-C13b the tray summary stays one ellipsis-clipped line: its Markdown is inline text, not an inline-block', async () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(css, /\.tray-sum-text \.md-inline \{[^}]*display: inline;[^}]*white-space: inherit/,
    'the tray summary overrides .md-inline (inline-block) and .md (white-space: normal)')
})

test('RT-C13c a multi-line summary shows on ONE line in the tray: no <br>, the words stay apart', async t => {
  const node = { id: 'alpha', state: 'live', kind: 'agent', tier: 'sonnet', children: [], turns: [],
    last_status: { status: 'working', summary: 'first line\nsecond **bold**', at: '2026-11-03T10:00:00Z' } } as unknown as CanvasNode
  const view = await mountView(<AgentTray map={new Map([['alpha', node]])} rows={[{ node, depth: 0 }] as never}
    query="" onQuery={() => {}} archived={false} onArchived={() => {}} onPick={() => {}} refs={refs} />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(2) })
  const text = view.el.querySelector('.tray-sum-text')!
  assert.equal(text.querySelectorAll('br').length, 0, 'no hard break in the one-line summary')
  assert.ok((text.textContent ?? '').includes('first line second bold'), `the lines are joined by a space: "${text.textContent}"`)
})
