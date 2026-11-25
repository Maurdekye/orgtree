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
import { DesktopSettings } from '../src/canvas/desktopsettings'
import { preferencesPatch } from '../../main/policy'
import type { DesktopPreferences } from '../../../../packages/contracts'
import { DEFAULT_NOTIFICATIONS } from '../../../../packages/contracts/notifications'
import { eventFanout } from './heldevents'
import { audienceGrantTooltip, EXTERN_WEAK, inboxDropChoice, orgInboxLines, type CanvasNode, inboxDropAction, inboxDropHint, ACTING_HOLDER_TIP, ORG_INBOX_TITLE, orgInboxTileTitle, orgInboxActingLine } from '../src/canvas/shared'

declare const __SRC_DIR__: string
const WEAK_TIP = "Weak link: can send mail as the org; new outside mail goes to the org mailbox's holder, and replies to its own mail come back to it"

test('W1 a weak link is drawn on the holder\'s path, in long dashes; an older engine draws holders only', () => {
  assert.equal(EXTERN_WEAK, '@extern-weak')
  assert.deepEqual(orgInboxLines({ holders: ['front'], weak: ['scout', 'kid'] }),
    [['front', 'edge aud-line'], ['scout', 'edge aud-line weak'], ['kid', 'edge aud-line weak']])
  assert.deepEqual(orgInboxLines({ holders: ['front'] }), [['front', 'edge aud-line']])
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  // USER 2026-11-25 09:30:29Z m70add47eb0b6 "the weak link dashed line needs to have much longer dashes": about 3x the
  // old 2 5 dash (round caps add the stroke width to each dash), and longer than every other dashed canvas line
  const rule = /\.edge\.aud-line\.weak\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  const dash = /stroke-dasharray:\s*([\d.]+)[\s,]+([\d.]+)/.exec(rule)
  assert.ok(dash, 'the weak line has a dash pattern')
  const [on, off] = [Number(dash![1]), Number(dash![2])]
  assert.ok(on >= 3 * 2 + 1.8 * 2 && off >= 5, `much longer dashes, a proportionate gap: ${on} ${off}`)
  const others = [...css.matchAll(/\.edge\.[^{}]*\{[^}]*stroke-dasharray:\s*([\d.]+)/g)].map(m => Number(m[1]))
  assert.ok(others.length > 3 && others.filter(d => d !== on).every(d => d < on), `the longest dash of the canvas lines: ${on} vs ${others}`)
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

test('W5 the drag setting: make it the holder (default), ask as before, or add a weak link when a holder exists', () => {
  // USER 2026-11-25 09:32:09Z m3f7018605789 + 09:35:46Z mcc0fb84c475f "keep it as ask each time"; edges decided by
  // @coordinator-opus (docket app-setting-dragging-an-agent-onto-the-org-mailb)
  const single = { holders: ['front'], weak: [] as string[], multi_holder_enabled: false }
  const multi = { ...single, multi_holder_enabled: true }
  const none = { holders: [] as string[], weak: [] as string[] }
  // ask: exactly the drop as it was (the question)
  assert.deepEqual(inboxDropAction(single, 'scout', 'agent', 'ask'), { kind: 'ask', current: 'front', multi: false, weakOk: true })
  assert.deepEqual(inboxDropAction(multi, 'scout', 'agent', 'ask'), { kind: 'ask', current: 'front', multi: true, weakOk: true })
  // make it the holder: at once, no question (moves with one holder allowed, adds one with several)
  for (const inbox of [single, multi]) assert.deepEqual(inboxDropAction(inbox, 'scout', 'agent', 'holder'), { kind: 'grant' })
  // add a weak link: at once when a holder exists
  for (const inbox of [single, multi]) assert.deepEqual(inboxDropAction(inbox, 'scout', 'agent', 'weak'), { kind: 'weak' })
  // no holder yet: every mode makes it the holder
  for (const mode of ['ask', 'holder', 'weak'] as const) assert.deepEqual(inboxDropAction(none, 'scout', 'agent', mode), { kind: 'grant' }, mode)
  // the holder itself: today's no-op re-grant, every mode
  for (const mode of ['ask', 'holder', 'weak'] as const) assert.deepEqual(inboxDropAction(single, 'front', 'agent', mode), { kind: 'grant' }, mode)
  // add a weak link to an agent that has one: nothing happens, and it says so
  const already = inboxDropAction({ ...single, weak: ['scout'] }, 'scout', 'agent', 'weak')
  assert.equal(already.kind, 'noop')
  assert.match((already as { why: string }).why, /scout already has a weak link/)
  // a project keeps today's drop in EVERY mode (the scope: "projects dropped on the mailbox keep today's behaviour";
  // bounced by @integ-sol-c ma5977cbd7e87: the default mode replaced a project's holder without the question)
  for (const mode of ['holder', 'ask', 'weak'] as const) {
    assert.deepEqual(inboxDropAction(single, 'intake', 'project', mode), { kind: 'ask', current: 'front', multi: false, weakOk: false }, mode)
  }
  // an engine without weak links keeps today's drop under "weak"
  const older = { holders: ['front'], multi_holder_enabled: false }
  assert.deepEqual(inboxDropAction(older, 'scout', 'agent', 'weak'), inboxDropAction(older, 'scout', 'agent', 'ask'))
})

test('W6 while an agent is dragged over the mailbox, the tile says what the drop will do', () => {
  const single = { holders: ['front'], weak: [] as string[], multi_holder_enabled: false }
  const multi = { ...single, multi_holder_enabled: true }
  const none = { holders: [] as string[], weak: [] as string[] }
  assert.equal(inboxDropHint(single, 'scout', 'agent', 'ask'), 'Drop to choose: scout replaces front, or gets a weak link')
  assert.equal(inboxDropHint(multi, 'scout', 'agent', 'ask'), 'Drop to choose: scout is added as a holder, or gets a weak link')
  assert.equal(inboxDropHint(single, 'scout', 'agent', 'holder'), 'Drop: scout becomes the holder, replacing front')
  assert.equal(inboxDropHint(multi, 'scout', 'agent', 'holder'), 'Drop: scout is added as a holder')
  assert.equal(inboxDropHint(single, 'scout', 'agent', 'weak'), 'Drop: scout gets a weak link')
  assert.equal(inboxDropHint(none, 'scout', 'agent', 'weak'), 'Drop: scout becomes the holder')
  assert.equal(inboxDropHint(single, 'front', 'agent', 'weak'), 'front already holds the org mailbox')
  assert.equal(inboxDropHint({ ...single, weak: ['scout'] }, 'scout', 'agent', 'weak'), 'scout already has a weak link to the org mailbox')
  for (const mode of ['holder', 'ask', 'weak'] as const) assert.equal(inboxDropHint(single, 'intake', 'project', mode), 'Drop to choose: intake replaces front', mode)
})

test('W7 App settings > Org mailbox: the drag setting, "Make it the holder" by default, saved through native preferences', async () => {
  // USER 2026-11-25 09:38:00Z md9ca7ea6df12 "make the default "make it the holder", and leave the other two as choosable alternatives"
  // validation in the main process: the three values, nothing else
  for (const v of ['ask', 'holder', 'weak']) assert.equal(preferencesPatch({ inboxDragMode: v }).inboxDragMode, v)
  for (const v of ['', 'replace', null, 1]) assert.throws(() => preferencesPatch({ inboxDragMode: v }))
  const writes: unknown[] = [], fan = eventFanout()
  let prefs = { ...DEFAULT_NOTIFICATIONS, notificationsEnabled: false } as DesktopPreferences
  Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: { onEvent: fan.onEvent, getPreferences: async () => prefs,
    setPreferences: async (patch: Partial<DesktopPreferences>) => { writes.push(patch); return prefs = { ...prefs, ...patch } } } })
  const view = await mountView(<DesktopSettings />, el => el)
  try {
    await inAct(async () => { await flush(12) })
    const select = view.el.querySelector<HTMLSelectElement>('select[aria-label="Dragging an agent onto the org mailbox"]')
    assert.ok(select, 'the drag setting exists')
    assert.equal(select.value, 'holder')
    assert.deepEqual([...select.options].map(o => [o.value, o.textContent]),
      [['holder', 'Make it the holder'], ['ask', 'Ask each time'], ['weak', 'Add a weak link if it already has a holder']])
    assert.equal(select.closest('.set-group')?.querySelector('.set-group-head')?.textContent?.trim().startsWith('Org mailbox'), true, 'in its own Org mailbox group')
    await inAct(async () => { select.value = 'weak'; select.dispatchEvent(new window.Event('change', { bubbles: true })); await flush(12) })
    assert.deepEqual(writes, [{ inboxDragMode: 'weak' }])
    await inAct(async () => { fan.emit({ type: 'preferences', data: { ...prefs, inboxDragMode: 'ask' } }); await flush(8) })
    assert.equal(select.value, 'ask')
  } finally { await view.unmount(); Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: undefined }) }
})

test('W8 failover: the acting weak link is marked on its canvas line and its mailbox badge', async t => {
  // USER 2026-11-25 m872c7d4f0973; @coordinator-opus edge 5: an "acting holder" label/tooltip on its chip and line
  assert.deepEqual(orgInboxLines({ holders: ['front'], weak: ['scout', 'kid'], acting: 'scout' }),
    [['front', 'edge aud-line'], ['scout', 'edge aud-line weak acting'], ['kid', 'edge aud-line weak']])
  assert.deepEqual(orgInboxLines({ holders: ['front'], weak: ['scout'], acting: null }), [['front', 'edge aud-line'], ['scout', 'edge aud-line weak']])
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(css, /\.edge\.aud-line\.weak\.acting\s*\{/, 'the acting line has its own look')
  const map = new Map<string, CanvasNode>([['scout', { id: 'scout', kind: 'agent', state: 'live' } as CanvasNode],
    ['kid', { id: 'kid', kind: 'agent', state: 'live' } as CanvasNode]])
  const rows = await mountView(<AudienceHolderRows ids={['scout', 'kid']} nodes={map} label="weak links" audienceTarget={EXTERN_WEAK}
    acting="scout" onRemove={() => {}} />, el => el)
  t.after(() => rows.unmount())
  await flush()
  const [scout, kid] = [...rows.el.querySelectorAll<HTMLElement>('.aud-badge')]
  assert.ok(scout.classList.contains('acting'), scout.className)
  assert.match(scout.textContent ?? '', /acting holder/)
  assert.equal(scout.title, ACTING_HOLDER_TIP + '\n' + WEAK_TIP)
  assert.ok(!kid.classList.contains('acting') && !/acting/.test(kid.textContent ?? ''), 'only the acting link')
  assert.equal(kid.title, WEAK_TIP)
})

test('W9 failover: the org mailbox tile names the acting holder in its title and a small line', () => {
  // @coordinator-opus me3ba3bf828a2: the line stays a style mark; the label goes on the tile the line ends at
  assert.equal(orgInboxTileTitle(null), ORG_INBOX_TITLE)
  assert.equal(orgInboxTileTitle('scout'), ORG_INBOX_TITLE + '\nActing holder: @scout (no holder can receive mail now)')
  assert.equal(orgInboxActingLine(null), null)
  assert.equal(orgInboxActingLine('scout'), 'acting: scout')
  const canvas = readFileSync(path.join(__SRC_DIR__, 'canvas', 'OrgCanvas.tsx'), 'utf8')
  assert.match(canvas, /title=\{orgInboxTileTitle\(tree\.org_inbox\?\.acting\)\}/, 'the tile takes its title from the helper')
  assert.match(canvas, /className="oi-acting"/, 'and shows the acting line')
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(css, /\.sq\.orginbox \.oi-acting\s*\{/, 'styled outside the fixed-height tile body')
})
