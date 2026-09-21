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
import { ORG_VIEW_EVENT, orgView, setOrgView } from '../src/attention/mode'
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

// ------------------------------- §4 ONE writer on the view-mode key, now
//
// The shell shipped a temporary `shell/viewmode.ts` on the `orgtree-org-view`
// key so the compact header was not blocked on a module in another worktree.
// v3-attention-opus's `attention/mode.ts` is importable from this tree now, so
// the stand-in IS DELETED and theirs is the only reader and writer.
//
// The properties of the surviving module — default stored as absence, a
// foreign value reading as the default, its own writes announced — belong to
// it and are pinned in attentionmode.test.tsx (§1.1, §1.3, §5.2). What is
// pinned HERE is the thing this branch is responsible for and that nothing
// else would catch: that the stand-in has not come back, and that the shell's
// two consumers really do import theirs.

test('the temporary shell module is gone, with no second writer left behind', () => {
  // ⚠ THE FAILURE THIS CATCHES IS NOT A BROKEN IMPORT — it is a WORKING one.
  // Two modules on one key both compile and both appear to work; they diverge
  // only once one of them writes, which no typechecker and no unit test of
  // either module alone can see. So the assertion is about the file existing
  // at all.
  assert.equal(fs.existsSync(path.join(__SRC_DIR__, 'shell/viewmode.ts')), false,
    'shell/viewmode.ts was the stand-in and must not be reintroduced')
  const users = ['App.tsx', 'shell/modetoggle.tsx']
  for (const f of users) {
    const src = fs.readFileSync(path.join(__SRC_DIR__, f), 'utf8')
    assert.doesNotMatch(src, /from '\.{1,2}\/(shell\/)?viewmode'/,
      f + ' must not import the stand-in')
    assert.match(src, /from '\.{1,2}\/attention\/mode'/,
      f + ' takes the view key from attention/mode')
  }
})

/** source with its comments removed, so a rule about what the CODE does is not
 *  tripped by prose that explains the rule. (The first version of the test
 *  below failed on its own explanatory comment, which is a fair warning about
 *  how much a raw source scan actually asserts.) */
const code = (file: string): string =>
  fs.readFileSync(path.join(__SRC_DIR__, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

test('the shell writes the view key only through that module', () => {
  // the stand-in reached localStorage directly; nothing in the shell may name
  // this key again, or the single-writer rule is back to being a comment
  for (const f of ['App.tsx', 'shell/modetoggle.tsx', 'shell/header.tsx']) {
    assert.doesNotMatch(code(f), /orgtree-org-view/,
      f + ' names the storage key in code, which only attention/mode may do')
  }
})

test('the channel is a plain Event, which is what the harness actually has', () => {
  // v3-attention-opus measured their first version using CustomEvent, which is
  // not on the test harness's globals: it dispatched nothing at all and the
  // try/catch swallowed it. A signal that silently never fires is worse than
  // no signal, because everything downstream still looks wired up. Kept here
  // because the shell's toggle is what dispatches it in practice.
  assert.equal(ORG_VIEW_EVENT, 'orgtree:org-view')
  localStorage.clear()
  let fired = 0
  const on = () => { fired++ }
  window.addEventListener(ORG_VIEW_EVENT, on)
  try {
    setOrgView('studio', 'attention')
    assert.equal(fired, 1, 'a real Event reached a real listener')
    assert.equal(orgView('studio'), 'attention')
  } finally { window.removeEventListener(ORG_VIEW_EVENT, on) }
})
