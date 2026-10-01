import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { useState } from 'react'
import { DesktopSettings } from '../src/canvas/desktopsettings'
import { AskCard } from '../src/canvas/asks'
import { DocGalleryModal } from '../src/canvas/gallery'
import App from '../src/App'
import { forgetModalPins, forgetModalOpenCache } from '../src/canvas/modalpin'
import { questionVisible } from '../src/notification-visibility'
import { useNativeNotifications } from '../src/notifications'
import type { NativeNotice } from '../src/desktop'
import type { AskInfo } from '../src/types'
import { DEFAULT_NOTIFICATIONS, notificationEnabled, notificationPreferences } from '../../../../packages/contracts/notifications'

const labels = ['Questions', 'Urgent mail', 'Terminal failures', 'Docket attention', 'All mail', 'New presented document', 'Agent frozen', 'Notify while Orgtree is focused']
const keys = ['notifyQuestions', 'notifyUrgentMail', 'notifyTerminalFailures', 'notifyDocketAttention', 'notifyAllMail', 'notifyDocuments', 'notifyFrozen', 'notifyWhileFocused'] as const
const response = (data: unknown) => ({ ok: true, headers: new Headers(), json: async () => data } as Response)
// ⚠ `notification-click` is a HELD type and is consumed through
// events/heldbus.ts, so a document has TWO listeners now — the bus and the
// hook. A single-slot `onEvent` fake keeps only one of them, and which one
// it keeps decides what the test measures. See heldevents.ts.
import { eventFanout, startBus } from './heldevents'
const native = (value?: unknown) => Object.defineProperty(window, 'orgtreeDesktop', { value, configurable: true })
const settle = () => inAct(async () => { await flush(30) })
const ask = { id: 'question-exact', node: 'agent', kind: 'question', status: 'open', question: 'Choose the approach' } as AskInfo
function geometry(el: HTMLElement, rect = { left: 10, top: 10, right: 300, bottom: 200, width: 290, height: 190 }) {
  el.getBoundingClientRect = () => rect as DOMRect
  el.getClientRects = () => [rect] as unknown as DOMRectList
}
/** jsdom's own `hasFocus()` is always false, so the window the user is IN is
 *  something a test states. Per the 2026-09-12 ruling that is the difference
 *  between a card that has reached them and one that merely exists on screen. */
function focused(doc: Document, value: boolean) {
  Object.defineProperty(doc, 'hasFocus', { configurable: true, value: () => value })
}

test('eight native settings use exact defaults, save separately and accept broadcasts over stale load', async () => {
  let resolve!: (value: unknown) => void
  const fan = eventFanout()
  const event = fan.emit
  let prefs = { ...DEFAULT_NOTIFICATIONS }
  const writes: unknown[] = []
  native({ getPreferences: () => new Promise(r => { resolve = r }), onEvent: fan.onEvent,
    setPreferences: async (patch: Partial<typeof prefs>) => { writes.push(patch); return prefs = { ...prefs, ...patch } } })
  const v = await mountView(<DesktopSettings />, el => el)
  try {
    await inAct(() => event({ type: 'preferences', data: prefs }))
    const masterSwitch = [...v.el.querySelectorAll<HTMLInputElement>('input')].find(e => e.getAttribute('aria-label') === 'Notifications')!
    assert.ok(masterSwitch)
    assert.equal(masterSwitch.checked, true)
    assert.equal(masterSwitch.disabled, false)
    const switches = labels.map(label => [...v.el.querySelectorAll<HTMLInputElement>('input')].find(e => e.getAttribute('aria-label') === label)!)
    assert.ok(switches.every(Boolean))
    assert.deepEqual(switches.map(e => e.checked), [true, true, true, true, false, false, false, false])
    for (let i = 0; i < keys.length; i++) {
      await inAct(async () => { switches[i]!.click(); await flush(6) })
      assert.deepEqual(writes.at(-1), { [keys[i]!]: !DEFAULT_NOTIFICATIONS[keys[i]!] })
    }
    await inAct(async () => { resolve(DEFAULT_NOTIFICATIONS); await flush(6) })
    assert.deepEqual(switches.map(e => e.checked), [false, false, false, false, true, true, true, true])
  } finally { await v.unmount(); native() }
})

test('exact question visibility follows clipping, hidden pages, resolution and adopted popout documents', async () => {
  const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  const v = await mountView(<div className="clip"><AskCard ask={ask} slug="one" toast={() => {}} /></div>, el => el)
  const popout = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true })
  focused(document, true)
  try {
    const card = v.el.querySelector<HTMLElement>('.askcard')!, clip = card.parentElement!
    geometry(card)
    assert.equal(questionVisible('one', ask.id), true)
    // TOAST UNLESS FOCUSED (user ruling 2026-09-12). A window the user is not
    // in has shown them nothing, second monitor or not.
    focused(document, false)
    assert.equal(questionVisible('one', ask.id), false,
      'a card on screen in an UNFOCUSED window has reached nobody and must still toast')
    focused(document, true)
    assert.equal(questionVisible('one', ask.id), true, 'and counts again once they are back in it')
    assert.equal(questionVisible('two', ask.id), false)
    assert.equal(questionVisible('one', 'another-question'), false)
    clip.style.overflowX = 'hidden'; clip.style.overflowY = 'hidden'
    geometry(clip, { left: 400, top: 400, right: 500, bottom: 500, width: 100, height: 100 })
    assert.equal(questionVisible('one', ask.id), false, 'offscreen/clipped desk is not visible')
    clip.style.overflowX = ''; clip.style.overflowY = ''; clip.style.display = 'none'
    assert.equal(questionVisible('one', ask.id), false)
    clip.style.display = ''
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    assert.equal(questionVisible('one', ask.id), false)
    popout.window.document.body.appendChild(popout.window.document.adoptNode(card))
    focused(popout.window.document as unknown as Document, false)
    assert.equal(questionVisible('one', ask.id), false, 'an unfocused popout is no more delivered than an unfocused main window')
    focused(popout.window.document as unknown as Document, true)
    assert.equal(questionVisible('one', ask.id), true, 'the FOCUSED popout counts even with a hidden main window')
    clip.appendChild(document.adoptNode(card))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    await v.render(<AskCard ask={{ ...ask, status: 'answered' }} slug="one" toast={() => {}} />)
    assert.equal(questionVisible('one', ask.id), false, 'nulled card is not an unanswered question')
  } finally {
    await v.unmount(); popout.window.close()
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility)
    else delete (document as unknown as Record<string, unknown>).visibilityState
  }
})

test('category switches, visible questions, new documents and stale clicks share one notification inventory', async () => {
  localStorage.clear()
  const oldFetch = globalThis.fetch, visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  const fan = eventFanout()
  const event = fan.emit
  let prefs = { ...DEFAULT_NOTIFICATIONS }, notices: NativeNotice[] = []
  const delivered: NativeNotice[] = [], opened: NativeNotice[] = [], synced: unknown[][] = []
  native({ getPreferences: async () => prefs, notify: async (n: NativeNotice) => { delivered.push(n); return true },
    syncNotifications: async (active: unknown[]) => { synced.push(active) }, onEvent: fan.onEvent })
  const stopBus = startBus()
  globalThis.fetch = async () => response({ notices, active: notices.map(({ org, id }) => ({ org, id })), truncated: false, total: notices.length })
  function View({ card = true }: { card?: boolean }) { useNativeNotifications(n => opened.push(n)); return card ? <AskCard ask={ask} slug="one" toast={() => {}} /> : null }
  const v = await mountView(<View />, el => el)
  const row = (kind: NativeNotice['kind'], id: string = kind): NativeNotice => ({ id, kind, org: 'one', title: kind, body: 'detail', agent: 'agent', generation: 2, source_id: kind === 'question' ? ask.id : id })
  focused(document, true)
  try {
    geometry(v.el.querySelector<HTMLElement>('.askcard')!)
    await settle()
    notices = ['question', 'urgent-mail', 'work-attention', 'routine', 'document', 'agent-frozen'].map(k => row(k as NativeNotice['kind']))
    await inAct(async () => { event({ type: 'notification-poll', data: null }); await flush(30) })
    assert.deepEqual(delivered.map(n => n.kind), ['urgent-mail', 'work-attention'])
    await v.render(<View card={false} />)
    prefs = { ...prefs, notifyAllMail: true, notifyDocuments: true, notifyFrozen: true }
    await inAct(async () => { event({ type: 'preferences', data: prefs }); await flush(30) })
    assert.deepEqual(delivered.map(n => n.kind), ['urgent-mail', 'work-attention', 'routine', 'agent-frozen'])
    assert.equal(delivered.some(n => n.kind === 'question'), false, 'closing a seen card does not alert late')
    notices.push(row('document', 'new-document'), { ...row('question', 'other-org-question'), org: 'two' })
    await inAct(async () => { event({ type: 'notification-poll', data: null }); await flush(30) })
    assert.deepEqual(delivered.slice(-2).map(n => n.id), ['new-document', 'other-org-question'])
    await inAct(async () => { event({ type: 'notification-click', data: delivered.at(-2) }); await flush(20) })
    assert.equal(opened[0]!.source_id, 'new-document')
    prefs = { ...prefs, notifyDocuments: false }
    await inAct(async () => { event({ type: 'preferences', data: prefs }); await flush(30) })
    assert.ok(!synced.at(-1)!.some(n => (n as NativeNotice).id === 'new-document'))
    await inAct(async () => { event({ type: 'notification-click', data: delivered.at(-2) }); await flush(20) })
    assert.equal(opened.length, 1, 'disabled source cannot navigate from an old OS handle')
    notices = []
    await inAct(async () => { event({ type: 'notification-poll', data: null }); await flush(30) })
    assert.deepEqual(synced.at(-1), [])
    await inAct(async () => { event({ type: 'notification-click', data: delivered.at(-1) }); await flush(20) })
    assert.equal(opened.length, 1)
  } finally {
    stopBus(); await v.unmount(); native(); globalThis.fetch = oldFetch
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility)
    else delete (document as unknown as Record<string, unknown>).visibilityState
  }
})

test('Presentations notification selects an exact retired document on an older page and can select it again', async () => {
  const oldFetch = globalThis.fetch, calls: string[] = []
  // ⚠ THE GALLERY NO LONGER PAGES, IT WINDOWS (canvas/gallery.tsx): it reads
  // from offset 0 and widens `limit` until the list reaches what it is after,
  // so the fake has to do the endpoint's own arithmetic — `documents_list`
  // snaps a `locate` to `index // limit * limit` — instead of answering with
  // one fixed page. A fake that ignored `limit` would keep reporting the row's
  // old hundred-row page however wide the window grew, which no real server
  // does and which is the shape of an endless correction loop.
  const all = Array.from({ length: 105 }, (_, i) => ({
    id: i === 100 ? 'old-document' : `other-${i}`, node: 'retired',
    title: i === 100 ? 'Exact plan' : `Plan ${i}`, at: '2026-09-01',
    node_state: 'archived', evicted: false }))
  const row = all[100]!
  const query = (path: string) => new URL(path, 'http://host').searchParams
  globalThis.fetch = async url => {
    const path = String(url); calls.push(path)
    if (path.endsWith('/documents/old-document')) return response({ ...row, body: 'The exact plan body' })
    const q = query(path)
    const limit = Math.max(1, Math.min(Number(q.get('limit') || 100), 5000))
    const locate = q.get('locate') ?? ''
    let offset = Math.max(0, Number(q.get('offset') || 0))
    if (locate) offset = Math.floor(all.findIndex(r => r.id === locate) / limit) * limit
    return response({ documents: all.slice(offset, offset + limit), total: all.length,
      offset, located: locate, next_offset: offset + limit < all.length ? offset + limit : null })
  }
  let jump!: () => void
  function View() {
    const [target, setTarget] = useState<{ id: string; seq: number } | null>({ id: row.id, seq: 1 })
    jump = () => setTarget({ id: row.id, seq: 2 })
    return <DocGalleryModal slug="one" toast={() => {}} close={() => {}} jumpTo={target} onJumpHandled={() => setTarget(null)} />
  }
  const v = await mountView(<View />, el => el)
  try {
    await settle()
    assert.match(v.el.querySelector('.mailer-read')?.textContent ?? '', /The exact plan body/)
    assert.equal(v.el.querySelector<HTMLInputElement>('.gallery-showretired input')!.checked, true)
    const lists = calls.filter(p => /\/documents\?/.test(p))
    assert.ok(lists.length > 1 && lists.every(p => query(p).get('offset') === '0'),
      'the window is always read from the newest end, never moved to the row\'s own page')
    assert.ok(lists.some(p => Number(query(p).get('limit')) > 100),
      'and it widened until it reached a row that used to sit on the second page')
    await inAct(async () => { jump(); await flush(30) })
    assert.equal(v.el.querySelectorAll('.doc-gallery-row.on').length, 1)
  } finally { await v.unmount(); globalThis.fetch = oldFetch }
})

test('the app routes an other-organization document click into its exact Presentations pane', async () => {
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
  const oldFetch = globalThis.fetch
  const g = globalThis as unknown as Record<string, unknown>
  g.history ??= window.history; g.location ??= window.location
  window.history.replaceState(null, '', '/')
  const fan = eventFanout()
  const notice: NativeNotice = { id: 'other-document', source_id: 'exact', org: 'other', kind: 'document', title: 'Exact document', body: 'New plan' }
  const doc = { id: 'exact', node: 'agent', title: 'Exact document', at: '2026-09-12', node_state: 'live', evicted: false }
  const root = { id: 'agent', title: 'agent', tier: 'haiku', model_id: 'haiku', generation: 2, state: 'live', seat: 1,
    grant: 0, free: 0, mail_pending: 0, documents: [], children: [], lineage: [], turns: [], audiences_held: [],
    scope: { tools: {}, add_dirs: [], permission_mode: 'default', org_visibility: 'team' } }
  native({ getPreferences: async () => ({ ...DEFAULT_NOTIFICATIONS, notifyDocuments: true }), notify: async () => false,
    syncNotifications: async () => {}, onEvent: fan.onEvent })
  const stopBus = startBus()
  globalThis.fetch = async url => {
    const path = String(url).split('?')[0]
    if (path === '/api/desktop/notifications') return response({ notices: [notice], total: 1, truncated: false, active: [notice].map(({ org, id }) => ({ org, id })) })
    if (path === '/api/orgs') return response([{ slug: 'other', name: 'Other', live: 1, seats: 1 }])
    if (path === '/api/orgs/other') return response({ slug: 'other', name: 'Other', roots: [root], max_top_grant: 1000,
      default_top_grant: 50, compact_at: 0, tiers: { haiku: 1 }, audience_requests: [], credit_requests: [],
      cost_usd_total: 0, audit: { live_nodes: 1, top_level_holds: 0, no_overdraft: true, problems: [] },
      epoch: 1, rev: 1, work_items_summary: { attention: 0, active: 0 }, asks: [], asks_open: 0, watchdogs: [], dirs: [] })
    if (path === '/api/providers') return response({ providers: [] })
    if (path === '/api/orgs/other/documents/exact') return response({ ...doc, body: 'Notification selected this precise document.' })
    if (path === '/api/orgs/other/documents') return response({ documents: [doc], total: 1, offset: 0, located: String(url).includes('locate=exact') ? 'exact' : '', next_offset: null })
    if (/inbox|mailbox|\/mail/.test(path!)) return response({ pending: [], delivered: [], history: [], messages: [], items: [], unread: 0 })
    if (/\/(work|items|asks|watchdogs|events|audiences)$/.test(path!)) return response([])
    return response({})
  }
  const v = await mountView(<App />, el => el)
  try {
    await settle()
    await inAct(async () => { fan.emit({ type: 'notification-click', data: notice }); await flush(60) })
    assert.equal(window.location.pathname, '/o/other')
    const pane = v.el.querySelector('.gallery-modal .mailer-read')
    assert.match(pane?.textContent ?? '', /Notification selected this precise document/)
    assert.equal(v.el.querySelectorAll('.gallery-modal').length, 1)
  } finally {
    stopBus(); await v.unmount(); native(); globalThis.fetch = oldFetch
    forgetModalPins(); forgetModalOpenCache(); window.history.replaceState(null, '', '/')
  }
})

test('a failed preference read retries from the native clock and honors the stored disabled category', async () => {
  localStorage.clear()
  const oldFetch = globalThis.fetch
  let reads = 0, delivered = 0, fetched = 0
  const fan = eventFanout()
  const event = fan.emit
  native({ getPreferences: async () => {
    if (++reads === 1) throw Error('temporary IPC error')
    return { ...DEFAULT_NOTIFICATIONS, notifyQuestions: false }
  }, notify: async () => { delivered++; return true }, syncNotifications: async () => {},
  onEvent: fan.onEvent })
  globalThis.fetch = async () => { fetched++; return response({ notices: [{ id: 'disabled', org: 'org', kind: 'question', title: 'Q', body: '?' }], total: 1, truncated: false }) }
  function View() { useNativeNotifications(() => {}); return null }
  const v = await mountView(<View />, el => el)
  try {
    await settle(); assert.equal(fetched, 0)
    await inAct(async () => { event({ type: 'notification-poll', data: null }); await flush(20) })
    assert.equal(reads, 2); assert.equal(fetched, 1); assert.equal(delivered, 0)
  } finally { await v.unmount(); native(); globalThis.fetch = oldFetch }
})

test('a document removed during navigation reports the missing target and consumes only that jump', async () => {
  const oldFetch = globalThis.fetch, warnings: string[][] = []
  let handled = 0
  globalThis.fetch = async () => ({ ok: false, status: 404, headers: new Headers(), json: async () => ({ detail: 'Document removed' }) } as Response)
  const v = await mountView(<DocGalleryModal slug="one" toast={messages => { warnings.push(messages) }} close={() => {}}
    jumpTo={{ id: 'removed', seq: 500 }} onJumpHandled={() => { handled++ }} />, el => el)
  try { await settle(); assert.deepEqual(warnings, [['Document removed']]); assert.equal(handled, 1) }
  finally { await v.unmount(); globalThis.fetch = oldFetch }
})

test('global Notifications switch defaults on, gates specific toggles in UI, preserves values and restores configuration', async () => {
  const fan = eventFanout()
  const event = fan.emit
  let prefs = { ...DEFAULT_NOTIFICATIONS, notifyQuestions: false, notifyUrgentMail: true, notifyDocketAttention: false, notifyAllMail: true, notifyDocuments: true }
  const writes: unknown[] = []
  native({
    getPreferences: async () => prefs,
    onEvent: fan.onEvent,
    setPreferences: async (patch: Partial<typeof prefs>) => { writes.push(patch); prefs = { ...prefs, ...patch }; return prefs },
  })
  const v = await mountView(<DesktopSettings />, el => el)
  try {
    await inAct(() => event({ type: 'preferences', data: prefs }))
    const masterSwitch = [...v.el.querySelectorAll<HTMLInputElement>('input')].find(e => e.getAttribute('aria-label') === 'Notifications')!
    assert.ok(masterSwitch)
    assert.equal(masterSwitch.checked, true, 'global Notifications switch defaults on')
    assert.equal(masterSwitch.disabled, false)

    const categorySwitches = labels.map(label => [...v.el.querySelectorAll<HTMLInputElement>('input')].find(e => e.getAttribute('aria-label') === label)!)
    assert.ok(categorySwitches.every(Boolean))
    assert.ok(categorySwitches.every(s => !s.disabled), 'all category toggles are enabled while master is on')
    assert.deepEqual(categorySwitches.map(s => s.checked), [false, true, true, false, true, true, false, false])

    // Click master switch to turn it off
    await inAct(async () => { masterSwitch.click(); await flush(6) })
    assert.deepEqual(writes.at(-1), { notificationsEnabled: false })

    // Simulate backend broadcast of disabled master switch
    prefs = { ...prefs, notificationsEnabled: false }
    await inAct(() => event({ type: 'preferences', data: prefs }))

    assert.equal(masterSwitch.checked, false)
    assert.equal(masterSwitch.disabled, false, 'master switch remains interactive while off')

    // While master switch is off, all individual category toggles remain visible but disabled
    assert.ok(categorySwitches.every(s => s.disabled), 'all specific category toggles are disabled while master is off')
    // Stored values are preserved and still reflected in the toggles
    assert.deepEqual(categorySwitches.map(s => s.checked), [false, true, true, false, true, true, false, false], 'category values preserved while disabled')

    // Click master switch to turn it back on
    await inAct(async () => { masterSwitch.click(); await flush(6) })
    assert.deepEqual(writes.at(-1), { notificationsEnabled: true })

    // Simulate backend broadcast of enabled master switch
    prefs = { ...prefs, notificationsEnabled: true }
    await inAct(() => event({ type: 'preferences', data: prefs }))

    assert.equal(masterSwitch.checked, true)
    assert.ok(categorySwitches.every(s => !s.disabled), 'all specific category toggles re-enabled when master is on')
    assert.deepEqual(categorySwitches.map(s => s.checked), [false, true, true, false, true, true, false, false], 'exact prior configuration restored')
  } finally { await v.unmount(); native() }
})

test('notificationPreferences and notificationEnabled enforce safe defaults, preservation and master gating', () => {
  // 1. Fresh unconfigured preferences default All mail to off and notificationsEnabled to true
  const fresh = notificationPreferences({})
  assert.equal(fresh.notificationsEnabled, true, 'global switch defaults to on')
  assert.equal(fresh.notifyAllMail, false, 'All mail defaults to off')
  assert.equal(fresh.notifyQuestions, true)
  assert.equal(fresh.notifyUrgentMail, true)
  assert.equal(fresh.notifyTerminalFailures, true)
  assert.equal(fresh.notifyDocketAttention, true)
  assert.equal(fresh.notifyDocuments, false)
  assert.equal(fresh.notifyFrozen, false)
  assert.equal(fresh.notifyWhileFocused, false)

  // 2. Existing explicit choices are preserved
  const explicit = notificationPreferences({ notifyQuestions: false, notifyUrgentMail: false, notifyAllMail: true, notificationsEnabled: false })
  assert.equal(explicit.notificationsEnabled, false)
  assert.equal(explicit.notifyQuestions, false)
  assert.equal(explicit.notifyUrgentMail, false)
  assert.equal(explicit.notifyAllMail, true)

  // 3. Legacy routineNotifications migrates safely
  const legacyMigrate = notificationPreferences({ routineNotifications: true })
  assert.equal(legacyMigrate.notifyAllMail, true, 'legacy routineNotifications true migrates to notifyAllMail true')
  assert.equal(legacyMigrate.notificationsEnabled, true)

  // Explicit notifyAllMail false wins over legacy routineNotifications true
  const legacyExplicit = notificationPreferences({ notifyAllMail: false, routineNotifications: true })
  assert.equal(legacyExplicit.notifyAllMail, false)

  // 4. notificationEnabled authoritatively returns false for all kinds when notificationsEnabled is false
  const kinds = ['question', 'urgent-mail', 'terminal-failure', 'work-attention', 'routine', 'document', 'agent-frozen'] as const
  const enabledPrefs = notificationPreferences({ notifyQuestions: true, notifyUrgentMail: true, notifyDocketAttention: true, notifyAllMail: true, notifyDocuments: true, notifyFrozen: true })
  for (const kind of kinds) assert.equal(notificationEnabled(kind, enabledPrefs), true, `${kind} enabled when master is on`)

  const disabledPrefs = { ...enabledPrefs, notificationsEnabled: false }
  for (const kind of kinds) assert.equal(notificationEnabled(kind, disabledPrefs), false, `${kind} suppressed when master is off`)
})

test('master notifications switch off suppresses native polling dispatch and click navigation in useNativeNotifications', async () => {
  localStorage.clear()
  const oldFetch = globalThis.fetch, visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  const fan = eventFanout()
  const event = fan.emit
  let prefs = { ...DEFAULT_NOTIFICATIONS, notifyAllMail: true, notifyDocuments: true }
  const delivered: NativeNotice[] = [], opened: NativeNotice[] = [], synced: unknown[][] = []
  native({
    getPreferences: async () => prefs,
    notify: async (n: NativeNotice) => { delivered.push(n); return true },
    syncNotifications: async (active: unknown[]) => { synced.push(active) },
    onEvent: fan.onEvent,
  })
  const row = (kind: NativeNotice['kind'], id: string = kind): NativeNotice => ({ id, kind, org: 'one', title: kind, body: 'detail', agent: 'agent', generation: 2, source_id: id })
  const notices = [row('question', 'q1'), row('urgent-mail', 'u1'), row('routine', 'r1')]
  globalThis.fetch = async () => response({ notices, active: notices.map(({ org, id }) => ({ org, id })), truncated: false, total: notices.length })

  function View() { useNativeNotifications(n => opened.push(n)); return null }
  const v = await mountView(<View />, el => el)
  try {
    await settle()
    assert.deepEqual(delivered.map(n => n.id), ['q1', 'u1', 'r1'])

    // Turn master notifications switch off
    prefs = { ...prefs, notificationsEnabled: false }
    await inAct(async () => { event({ type: 'preferences', data: prefs }); await flush(30) })
    assert.deepEqual(synced.at(-1), [], 'syncNotifications cleared native alerts on master off')

    const countBefore = delivered.length
    notices.push(row('urgent-mail', 'u2'), row('question', 'q2'))
    await inAct(async () => { event({ type: 'notification-poll', data: null }); await flush(30) })
    assert.equal(delivered.length, countBefore, 'no notifications delivered while master switch is off')

    await inAct(async () => { event({ type: 'notification-click', data: delivered[0] }); await flush(20) })
    assert.equal(opened.length, 0, 'click navigation suppressed while master switch is off')

    // Turn master notifications switch back on
    prefs = { ...prefs, notificationsEnabled: true }
    await inAct(async () => { event({ type: 'preferences', data: prefs }); await flush(30) })
    assert.ok(delivered.some(n => n.id === 'u2'), 'delivery resumes for eligible notices after master re-enabled')
  } finally {
    await v.unmount(); native(); globalThis.fetch = oldFetch
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility)
    else delete (document as unknown as Record<string, unknown>).visibilityState
  }
})
