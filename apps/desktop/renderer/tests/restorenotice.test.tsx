// restorenotice.test.tsx — what restoration could not bring back, said once.
//
// The settled rule: restore what is available, skip what is not, and say so
// briefly. Two halves reach one sentence from opposite directions — NATIVE
// knows which saved organization windows it did not open, THE RENDERER knows
// which saved panels inside an organization cannot be restored, because it
// holds the saved open-set and is the only side that can resolve a panel's
// target against the organization tree.
//
// The property that matters most here is the NEGATIVE one: a working
// restoration must say nothing at all. A notice that appears every launch is
// furniture, and the whole value of this one is that seeing it means
// something really did not come back.
//
// Run:  node apps/desktop/renderer/tests/run.mjs restorenotice
import { flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  panelSkip, readSkippedOrgs, restoreNotice, skippedPanels,
} from '../src/shell/restorenotice'
import type { SavedWindow } from '../src/windowlayout'
import { ORG_VIEW_EVENT, readOrgViewMode, writeOrgViewMode } from '../src/shell/viewmode'
import fs from 'node:fs'
import path from 'node:path'

declare const __SRC_DIR__: string

void flush   // imported for the jsdom side effect

const row = (kind: string, restore?: SavedWindow['restore'], open = true): SavedWindow => ({
  key: `k:${kind}`, kind, org: 'studio', open,
  rect: { x: 0, y: 0, width: 900, height: 760 },
  ...(restore ? { restore } : {}),
})
const nodes = (entries: [string, number][]) =>
  new Map(entries.map(([id, generation]) => [id, { generation }]))

// ------------------------------------------- §1 what can actually be checked

test('an agent that is gone is a skipped panel', () => {
  const skip = panelSkip(row('desk:x', { agent: 'writer', generation: 0 }), nodes([]))
  assert.deepEqual(skip, { kind: 'desk:x', agent: 'writer', reason: 'agent-gone' })
})

test('a REHIRED agent is a skipped panel too — a new generation is a new self', () => {
  // restoring the predecessor's desk would show somebody else's conversation
  // under the name the reader remembers
  const skip = panelSkip(row('desk:x', { agent: 'writer', generation: 0 }),
    nodes([['writer', 1]]))
  assert.deepEqual(skip, { kind: 'desk:x', agent: 'writer', reason: 'agent-replaced' })
})

test('an agent that is present at the same generation is NOT skipped', () => {
  assert.equal(panelSkip(row('desk:x', { agent: 'writer', generation: 2 }),
    nodes([['writer', 2]])), null)
})

test('a panel with no agent target is never called skipped', () => {
  // ⚠ THE LIMIT, ASSERTED RATHER THAN IMPLIED. A document or watchdog target
  // is not resolvable from the tree, so those rows are not checked and must
  // not be reported. A notice that names panels which were actually fine
  // teaches the reader to ignore the notice.
  assert.equal(panelSkip(row('inbox'), nodes([])), null, 'no target at all')
  assert.equal(panelSkip(row('gallery', { document: 'doc-1' }), nodes([])), null,
    'a document target is outside what this can resolve')
  assert.equal(panelSkip(row('watch', { watchdog: 'w-1' }), nodes([])), null,
    'and so is a watchdog target')
  assert.equal(panelSkip(row('desk:x', { agent: 'writer' }), nodes([])), null,
    'an agent target without a usable generation cannot be judged either')
})

test('only rows that were OPEN are candidates', () => {
  const rows = [
    row('desk:a', { agent: 'gone', generation: 0 }, false),
    row('desk:b', { agent: 'alsogone', generation: 0 }, true),
  ]
  const missed = skippedPanels(rows, nodes([]))
  assert.deepEqual(missed.map((m) => m.agent), ['alsogone'],
    'a closed row being unrestorable is not news')
})

// ------------------------------------------------------- §2 the sentence

test('nothing skipped says NOTHING — the common case is silence', () => {
  assert.equal(restoreNotice([], []), null)
  assert.equal(restoreNotice([], skippedPanels([row('inbox')], nodes([]))), null)
})

test('organizations alone, named while naming them helps', () => {
  assert.equal(restoreNotice(['studio'], []), 'studio could not be reopened.')
  assert.equal(restoreNotice(['a', 'b', 'c'], []), 'a, b, c could not be reopened.')
  // past three, a list stops being information and becomes a wall
  assert.equal(restoreNotice(['a', 'b', 'c', 'd'], []),
    '4 organizations could not be reopened.')
})

test('panels alone name the AGENT, which is what the reader recognises', () => {
  const missed = skippedPanels([
    row('desk:a', { agent: 'writer', generation: 0 }),
    row('desk:b', { agent: 'editor', generation: 0 }),
  ], nodes([]))
  assert.equal(restoreNotice([], missed),
    '2 panels could not be restored (writer, editor).')
})

test('two panels for ONE agent count as two panels but name it once', () => {
  const missed = skippedPanels([
    row('desk:a', { agent: 'writer', generation: 0 }),
    row('gallery', { agent: 'writer', generation: 0 }),
  ], nodes([]))
  assert.equal(restoreNotice([], missed),
    '2 panels could not be restored (writer).')
})

test('both halves become ONE sentence, not two notices about one restoration', () => {
  const missed = skippedPanels([row('desk:a', { agent: 'writer', generation: 0 })], nodes([]))
  assert.equal(restoreNotice(['studio'], missed),
    'studio could not be reopened; 1 panel could not be restored (writer).')
})

test('singulars read as singulars', () => {
  assert.equal(restoreNotice(['studio'], []), 'studio could not be reopened.')
  const one = skippedPanels([row('desk:a', { agent: 'w', generation: 0 })], nodes([]))
  assert.match(restoreNotice([], one) ?? '', /^1 panel could not be restored/)
})

// --------------------------------------------- §3 not trusting the payload

test('a malformed restore-skipped payload is not evidence that anything was skipped', () => {
  // ⚠ the one thing this notice must never do is claim a loss that did not
  // happen, so anything unreadable reads as "nothing skipped"
  assert.deepEqual(readSkippedOrgs(null), [])
  assert.deepEqual(readSkippedOrgs('nonsense'), [])
  assert.deepEqual(readSkippedOrgs({}), [])
  assert.deepEqual(readSkippedOrgs({ orgs: 'studio' }), [])
  assert.deepEqual(readSkippedOrgs({ orgs: [1, true, null] }), [], 'non-strings are dropped')
  assert.deepEqual(readSkippedOrgs({ orgs: ['studio', '', 'workshop'] }), ['studio', 'workshop'],
    'empty slugs are dropped rather than rendered as a blank name')
})

test('both payload shapes native might send are accepted', () => {
  assert.deepEqual(readSkippedOrgs(['studio']), ['studio'], 'the bare list')
  assert.deepEqual(readSkippedOrgs({ orgs: ['studio'] }), ['studio'], 'or the named field')
})

// ------------------------------------ §4 two writers on one view-mode key
//
// `shell/viewmode.ts` is temporary: v3-attention-opus publishes an equivalent
// module on the same `orgtree-org-view` key, and mine goes the day theirs is
// importable from this tree. While BOTH exist they have to agree, and two of
// the three ways they could disagree are silent.

test('the default is stored as ABSENCE, not as the string canvas', () => {
  localStorage.clear()
  // ⚠ the other module deletes the entry rather than writing 'canvas'. If one
  // writes the string and the other deletes it, they disagree about whether
  // the organization has ever been set at all.
  writeOrgViewMode('studio', 'attention')
  assert.deepEqual(JSON.parse(localStorage.getItem('orgtree-org-view')!), { studio: 'attention' })
  writeOrgViewMode('studio', 'canvas')
  assert.deepEqual(JSON.parse(localStorage.getItem('orgtree-org-view')!), {},
    'returning to the default removes the row')
  assert.equal(readOrgViewMode('studio'), 'canvas', 'and absence reads as canvas')
})

test('an unknown stored value reads as canvas rather than throwing', () => {
  localStorage.clear()
  localStorage.setItem('orgtree-org-view', JSON.stringify({ studio: 'sideways' }))
  assert.equal(readOrgViewMode('studio'), 'canvas')
  localStorage.setItem('orgtree-org-view', '{ not json')
  assert.equal(readOrgViewMode('studio'), 'canvas')
  localStorage.setItem('orgtree-org-view', JSON.stringify(['an', 'array']))
  assert.equal(readOrgViewMode('studio'), 'canvas')
})

test('a write announces itself on the shared channel', () => {
  // ⚠ THE BUG THIS FIXES. A `storage` event does NOT fire for a write made by
  // the same document, so without this channel a toggle in the compact header
  // would move the stored value and the other module would go on serving what
  // it had — indefinitely, since its reader had no reason to re-read.
  localStorage.clear()
  let fired = 0
  const on = () => { fired++ }
  window.addEventListener(ORG_VIEW_EVENT, on)
  try {
    writeOrgViewMode('studio', 'attention')
    assert.equal(fired, 1, 'the write is announced')
    writeOrgViewMode('studio', 'attention')
    assert.equal(fired, 1,
      'a no-op write announces NOTHING: it changed nothing, and the first real '
      + 'write already notified, so there is no missed signal to guard against')
    writeOrgViewMode('studio', 'canvas')
    assert.equal(fired, 2, 'returning to the default IS a change, and is announced')
  } finally { window.removeEventListener(ORG_VIEW_EVENT, on) }
})

test('the channel is a plain Event, which is what the harness actually has', () => {
  // v3-attention-opus measured their first version using CustomEvent, which is
  // not on the test harness's globals: it dispatched nothing at all and the
  // try/catch swallowed it. A signal that silently never fires is worse than
  // no signal, because everything downstream still looks wired up.
  assert.equal(ORG_VIEW_EVENT, 'orgtree:org-view')
  const src = fs.readFileSync(path.join(__SRC_DIR__, 'shell/viewmode.ts'), 'utf8')
  assert.match(src, /new Event\(ORG_VIEW_EVENT\)/)
  assert.doesNotMatch(src, /new CustomEvent/, 'CustomEvent is not available where this must work')
})
