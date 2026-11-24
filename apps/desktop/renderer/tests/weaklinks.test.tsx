// Weak links to the org mailbox (USER 2026-11-24 18:56:37Z m020bbd1926c3; docket
// weak-org-mailbox-links-several-agents-may-send-a): drawn dotted, offered by the mailbox drop, listed in the
// mailbox panel and as a desk chip; an engine that doesn't list them gets no weak-link UI.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { HeldAudienceChips } from '../src/canvas/desk'
import { AudienceHolderRows } from '../src/canvas/mail'
import { InboxReplaceConfirm } from '../src/canvas/inboxreplace'
import { audienceGrantTooltip, EXTERN_WEAK, inboxDropChoice, orgInboxLines, type CanvasNode } from '../src/canvas/shared'

declare const __SRC_DIR__: string
const WEAK_TIP = "Weak link: can send mail as the org; new outside mail goes to the org mailbox's holder, and replies to its own mail come back to it"

test('W1 a weak link is drawn on the holder\'s path, dotted; an older engine draws holders only', () => {
  assert.equal(EXTERN_WEAK, '@extern-weak')
  assert.deepEqual(orgInboxLines({ holders: ['front'], weak: ['scout', 'kid'] }),
    [['front', 'edge aud-line'], ['scout', 'edge aud-line weak'], ['kid', 'edge aud-line weak']])
  assert.deepEqual(orgInboxLines({ holders: ['front'] }), [['front', 'edge aud-line']])
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(css, /\.edge\.aud-line\.weak\s*\{[^}]*stroke-dasharray:\s*2 5/, 'dotted')
})

test('W2 the mailbox drop asks, and offers an agent a weak link only on an engine that knows them', () => {
  const single = { holders: ['front'], weak: [] as string[], multi_holder_enabled: false }
  assert.deepEqual(inboxDropChoice(single, 'scout', 'agent'), { current: 'front', multi: false, weakOk: true })
  assert.deepEqual(inboxDropChoice(single, 'intake', 'project'), { current: 'front', multi: false, weakOk: false }, 'projects hold no weak link')
  assert.equal(inboxDropChoice(single, 'front', 'agent'), null, 'already the holder')
  assert.equal(inboxDropChoice({ holders: [], weak: [] }, 'scout', 'agent'), null, 'no holder yet: it becomes the holder')
  const multi = { ...single, multi_holder_enabled: true }
  assert.deepEqual(inboxDropChoice(multi, 'scout', 'agent'), { current: 'front', multi: true, weakOk: true }, 'several holders allowed: holder or weak link')
  assert.equal(inboxDropChoice(multi, 'intake', 'project'), null, 'a project is added as a holder at once, as before')
  assert.deepEqual(inboxDropChoice({ ...single, weak: ['scout'] }, 'scout', 'agent'), { current: 'front', multi: false, weakOk: false }, 'already weak: only the primary is left to offer')
  const older = { holders: ['front'], multi_holder_enabled: false }
  assert.deepEqual(inboxDropChoice(older, 'scout', 'agent'), { current: 'front', multi: false, weakOk: false }, 'an older engine: no weak link')
  assert.equal(inboxDropChoice({ ...older, multi_holder_enabled: true }, 'scout', 'agent'), null, 'older engine, several holders: as before')
})

test('W3 the drop dialog\'s "Add a weak link" grants the weak link, and only when offered', async t => {
  let weak = 0, replaced = 0
  const view = await mountView(<InboxReplaceConfirm id="scout" current="front" onConfirm={() => { replaced++ }}
    onWeak={() => { weak++ }} close={() => {}} />, el => el)
  t.after(() => view.unmount())
  await flush()
  const text = document.body.textContent ?? ''
  assert.match(text, /Replace front as the org mailbox's holder with scout\?/)
  assert.match(text, /Or give scout a weak link: it may send mail as the org, and new outside mail still goes to front\./)
  const add = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Add a weak link')!
  await inAct(() => { add.click() })
  assert.equal(weak, 1)
  assert.equal(replaced, 0)
})

test('W3 several holders allowed: the dialog says add, as holder or weak link', async t => {
  const view = await mountView(<InboxReplaceConfirm id="scout" current="front" multi onConfirm={() => {}}
    onWeak={() => {}} close={() => {}} />, el => el)
  t.after(() => view.unmount())
  await flush()
  const labels = [...document.querySelectorAll<HTMLButtonElement>('button')].map(b => b.textContent)
  assert.ok(labels.includes('Add as holder') && labels.includes('Add a weak link'), labels.join('|'))
  assert.match(document.body.textContent ?? '', /Add scout to the org mailbox\?/)
})

test('W3 without onWeak the dialog is today\'s replace confirm', async t => {
  const view = await mountView(<InboxReplaceConfirm id="intake" current="front" onConfirm={() => {}} close={() => {}} />, el => el)
  t.after(() => view.unmount())
  await flush()
  assert.ok(![...document.querySelectorAll('button')].some(b => b.textContent === 'Add a weak link'))
  assert.doesNotMatch(document.body.textContent ?? '', /weak link/)
})

test('W4 the desk chip and the mailbox panel name a weak link and revoke it', async t => {
  assert.equal(audienceGrantTooltip(EXTERN_WEAK, 'agent'), WEAK_TIP)
  const map = new Map<string, CanvasNode>([['scout', { id: 'scout', kind: 'agent', state: 'live' } as CanvasNode]])
  const chips = await mountView(<HeldAudienceChips slug="demo" toast={() => {}} map={map}
    node={{ id: 'scout', audiences_held: [EXTERN_WEAK], audiences_explicit: [EXTERN_WEAK] }} />, el => el)
  t.after(() => chips.unmount())
  const badge = chips.el.querySelector<HTMLElement>('.badge')!
  assert.equal(badge.textContent?.trim(), 'org mailbox (weak)')
  assert.ok(badge.classList.contains('weak-link'), badge.className)
  assert.equal(badge.title, WEAK_TIP)
  assert.ok(badge.querySelector('.chip-x'), 'an explicit grant can be revoked')
  const removed: string[] = []
  const rows = await mountView(<AudienceHolderRows ids={['scout']} nodes={map} label="weak links" audienceTarget={EXTERN_WEAK}
    onRemove={id => removed.push(id)} />, el => el)
  t.after(() => rows.unmount())
  await flush()
  const chip = rows.el.querySelector<HTMLElement>('.aud-badge')!
  assert.equal(chip.title, WEAK_TIP)
  await inAct(() => { chip.querySelector<HTMLButtonElement>('.chip-x')!.click() })
  assert.deepEqual(removed, ['scout'])
})
