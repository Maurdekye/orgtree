// USER 2026-11-03 17:29:08Z m65dc30c3f45a: "when attract mode focuses an agent desk, it defocuses whatever messagebox i may
// have been typing in at the time". Attract mode moves the view only and never keyboard focus.
import { FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { DeskChat } from '../src/canvas/desk'
import { canvasAttractRoutes } from '../src/attract/canvas'
import { resetConvos } from '../src/convo'
import { composerAgent, seedComposer } from './composerfocus-fixture'
import type { CanvasNode } from '../src/canvas/shared'

const noop = () => {}
/** a canvas (non-bare) agent desk: the composer takes the caret as it mounts, as when the user opens a desk */
const Desk = ({ id }: { id: string }) => {
  const node = { ...composerAgent, id } as CanvasNode
  return <DeskChat node={node} map={new Map([[id, node]])} slug="synthetic-attract-focus" op={async () => ({})} toast={noop} />
}
const routes = () => canvasAttractRoutes(() => ({
  enabled: true, slug: 'synthetic-attract-focus', tree: {} as any, map: new Map(), pinnedIds: () => new Set(),
  goToAgent: noop, fitAll: noop, openDoc: noop, readerIds: () => [], closeReader: noop,
}))

const field = (draft: string, from: number, to: number) => {
  const box = document.createElement('textarea')
  box.value = draft
  document.body.append(box)
  box.focus()
  box.setSelectionRange(from, to)
  return box
}

test('attract mode switching to a desk leaves the focused field, its draft and its selection alone; a desk the user opens still takes the caret', async t => {
  useFakeClock(); resetConvos(); installFetch(new FakeServer()); seedComposer()
  const r = routes()
  const typing = field('half a thought', 5, 6)
  const mounted: Array<{ unmount: () => Promise<void> }> = []
  t.after(async () => { for (const m of mounted) await m.unmount(); typing.remove(); r.stop?.(); resetConvos(); realClock() })

  // attract brings up an agent desk: the view moves, the caret stays
  await r.show({ kind: 'agent', id: 'desk-a', mark: '' })
  const a = await mountView(<Desk id="desk-a" />, el => el); mounted.push(a); await flush(5)
  const composerA = a.el.querySelector<HTMLTextAreaElement>('textarea')!
  assert.ok(composerA, 'the desk mounted its composer')
  assert.equal(document.activeElement, typing, 'focus stays in the message box being typed in')
  assert.equal(typing.value, 'half a thought', 'draft unchanged')
  assert.deepEqual([typing.selectionStart, typing.selectionEnd], [5, 6], 'caret and selection unchanged')

  // and on to the next desk
  r.hide({ kind: 'agent', id: 'desk-a', mark: '' })
  await r.show({ kind: 'agent', id: 'desk-b', mark: '' })
  const b = await mountView(<Desk id="desk-b" />, el => el); mounted.push(b); await flush(5)
  assert.equal(document.activeElement, typing, 'still the same field after a second switch')
  assert.deepEqual([typing.selectionStart, typing.selectionEnd], [5, 6])

  // the run ends (canvas interaction): a desk opened after that takes the caret as always
  r.stop?.()
  const c = await mountView(<Desk id="desk-c" />, el => el); mounted.push(c); await flush(5)
  assert.equal(document.activeElement, c.el.querySelector('textarea'), 'a desk opened with no attract target on screen keeps today\'s focus behaviour')
})
