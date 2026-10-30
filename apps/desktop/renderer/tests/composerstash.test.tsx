// composerstash.test.tsx - THE STORE BEHIND "UP NEVER LOSES THE DRAFT" (docket
// pressing-up-into-message-history-throws-away-the; USER 2026-10-30 08:14:27Z
// mdad6a41f1f3e). The interaction tests are composerhistorykeep.test.tsx; this
// file holds the persisted stash to the same identity rules as the history
// beside it: per agent and without a generation, moved by a rename, and a
// removed node's stash goes to its history as a message that was never sent,
// never into the void.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs composerstash

import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { resetConvos } from '../src/convo'
import { preserveRemovedDrafts, renameDrafts } from '../src/draftstore'
import { clearStash, historyKey, readHistory, readStash, stashKey, writeStash } from '../src/composerhistory'

const stash = (text: string, at = 0) => ({ text, start: 1, end: 1, at })

test('a stash round-trips, and an empty draft is never stored', () => {
  localStorage.clear()
  writeStash('org', 'writer', stash('half a thought', 2))
  assert.deepEqual(readStash('org', 'writer'), { text: 'half a thought', start: 1, end: 1, at: 2 })
  writeStash('org', 'writer', stash(''))
  assert.equal(readStash('org', 'writer'), null, 'nothing to protect, so nothing kept')
  assert.equal(localStorage.getItem(stashKey('org', 'writer')), null)
  writeStash('org', 'writer', stash('again'))
  clearStash('org', 'writer')
  assert.equal(readStash('org', 'writer'), null)
})

test('corrupt or foreign storage reads as no stash', () => {
  localStorage.clear()
  for (const raw of ['not json', '{}', '{"text":3}', '{"text":"x","start":0,"end":0,"at":-1}', 'null', '[]']) {
    localStorage.setItem(stashKey('org', 'writer'), raw)
    assert.equal(readStash('org', 'writer'), null, raw)
  }
})

test('the stash is per agent, whatever the generation', () => {
  localStorage.clear()
  writeStash('org', 'writer', stash('mine'))
  assert.equal(readStash('org', 'other'), null)
  assert.equal(readStash('elsewhere', 'writer'), null)
})

test('a rename moves the stash with the history', () => {
  localStorage.clear()
  localStorage.setItem(historyKey('org', 'old'), JSON.stringify([{ text: 'sent', delivered: true }]))
  writeStash('org', 'old', stash('unsent'))
  renameDrafts('org', 'old', 'renamed')
  assert.equal(readStash('org', 'old'), null)
  assert.deepEqual(readStash('org', 'renamed'), stash('unsent'))
  assert.equal(readHistory('org', 'renamed').length, 1)
  // a stash alone moves too
  writeStash('org', 'lone', stash('only a stash'))
  renameDrafts('org', 'lone', 'lone2')
  assert.deepEqual(readStash('org', 'lone2'), stash('only a stash'))
})

test('a removed node\'s stash goes into its history as a message never sent', () => {
  localStorage.clear()
  writeStash('org', 'gone', stash('the draft I had set aside'))
  writeStash('org', 'kept', stash('still on its desk'))
  writeStash('elsewhere', 'gone', stash('another org'))
  preserveRemovedDrafts('org', { has: id => id === 'kept' })
  assert.deepEqual(readHistory('org', 'gone'), [{ text: 'the draft I had set aside', delivered: false }])
  assert.equal(readStash('org', 'gone'), null)
  assert.deepEqual(readStash('org', 'kept'), stash('still on its desk'), 'a present node keeps its stash')
  assert.deepEqual(readStash('elsewhere', 'gone'), stash('another org'), 'another org is not this one\'s business')
})

test('a stash that outlived its history is kept as an undelivered entry when the desk opens', async (t) => {
  localStorage.clear(); resetConvos()
  writeStash('org', 'writer', stash('a draft with no history left to walk'))
  installFetch(new FakeServer())
  const writer: CanvasNode = {
    id: 'writer', generation: 2, state: 'live', tier: 'haiku', children: [],
    seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
  }
  const view = await mountView(<DeskChat node={writer} map={new Map([[writer.id, writer]])} slug="org"
    op={async () => ({})} toast={() => {}} bare />, el => el)
  t.after(async () => { await view.unmount(); localStorage.clear(); resetConvos() })
  await inAct(async () => { await flush(3) })
  assert.deepEqual(readHistory('org', 'writer'), [{ text: 'a draft with no history left to walk', delivered: false }])
  assert.equal(readStash('org', 'writer'), null, 'and no half-finished walk is left behind')
  assert.equal((view.el.querySelector('textarea') as HTMLTextAreaElement).value, '', 'the box is not filled behind the user\'s back')
})
