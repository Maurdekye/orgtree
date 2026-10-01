import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { treePresence, sweepAbsentDrafts, sweepAbsentPreferences } from '../src/treepresence'
import { draftKey, storeAttachments } from '../src/draftstore'
import { readHistory } from '../src/composerhistory'
import type { TreePayload } from '../src/types'

const selected = (missing: string[] = []): TreePayload => ({ slug: 'org', roots: [],
  foreground: { catalog_revision: 'c1', present: ['live', 'bearer'], missing },
} as unknown as TreePayload)
const visible = new Map([['live', {}]])

test('omission is unknown; separate lineage is present; only requested absence authorizes removal', () => {
  const p = treePresence(selected(['deleted', 'live']), 'org', visible)
  assert.equal(p.known('retired'), false)
  assert.equal(p.absent('retired'), false)
  assert.equal(p.has('bearer'), true)
  assert.equal(p.absent('bearer'), false)
  assert.equal(p.absent('deleted'), true)
  assert.equal(p.absent('live'), false, 'present rows defeat contradictory missing metadata')
  const next = treePresence(selected(), 'org', visible)
  assert.equal(next.absent('deleted'), false, 'old catalog absence is not accumulated')
})

test('mismatched org never proves deletion; legacy full tree still does', () => {
  assert.equal(treePresence(selected(['deleted']), 'other', visible).absent('deleted'), false)
  const legacy = { slug: 'org', roots: [] } as unknown as TreePayload
  assert.equal(treePresence(legacy, 'other', visible).absent('deleted'), false)
  assert.equal(treePresence(legacy, 'org', visible).absent('deleted'), true)
})

test('omitted agent keeps actual drafts and reply attachments; confirmed deletion strands only its text', () => {
  localStorage.clear()
  const key = draftKey('org', 'retired', 7)
  localStorage.setItem(key, 'Still composing')
  storeAttachments(key, [{ name: 'note', path: 'note.txt', bytes: 42 }])
  localStorage.setItem(`${key}-reply`, 'reply context')
  localStorage.setItem('orgtree-draft-org-retired', 'legacy text')
  const before = Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]))
  sweepAbsentDrafts('org', treePresence(selected(), 'org', visible).absent)
  assert.deepEqual(Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])), before)
  assert.deepEqual(readHistory('org', 'retired'), [])
  sweepAbsentDrafts('org', treePresence(selected(['retired']), 'org', visible).absent)
  assert.equal(localStorage.getItem(key), null)
  assert.equal(localStorage.getItem(`${key}-reply`), null)
  assert.equal(localStorage.getItem(`${key}-attachments`), null)
  assert.equal(localStorage.getItem('orgtree-draft-org-retired'), null)
  assert.deepEqual(readHistory('org', 'retired'), [{ text: 'Still composing', delivered: false }])
})

test('saved collapsed lines and pile fronts survive omission and prune only confirmed identities', () => {
  localStorage.clear()
  for (const suffix of ['eyemin', 'eyeseen']) {
    localStorage.setItem(`orgtree-${suffix}-org`, JSON.stringify(['live', 'retired', 'deleted']))
  }
  localStorage.setItem('orgtree-pile-org', JSON.stringify({ live: 'retired', unknownParent: 'otherFront', deleted: 'other' }))
  sweepAbsentPreferences('org', treePresence(selected(['deleted']), 'org', visible).absent)
  for (const suffix of ['eyemin', 'eyeseen']) {
    assert.deepEqual(JSON.parse(localStorage.getItem(`orgtree-${suffix}-org`)!), ['live', 'retired'])
  }
  assert.deepEqual(JSON.parse(localStorage.getItem('orgtree-pile-org')!), { live: 'retired', unknownParent: 'otherFront' })
})
