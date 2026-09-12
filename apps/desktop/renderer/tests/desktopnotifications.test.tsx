import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { notificationInboxTarget, useNativeNotifications } from '../src/notifications'
import type { DesktopNotice } from '../src/notifications'
import type { NativeNotice } from '../src/desktop'
import { bumpLive } from '../src/livebus'
import { InboxPanel } from '../src/App'
import type { TreePayload } from '../src/types'

test('global attention reaches other orgs, retains exact click targets and stops after unmount', async () => {
  localStorage.clear(); useFakeClock()
  const original = globalThis.fetch
  const calls: string[] = [], delivered: NativeNotice[] = [], opened: DesktopNotice[] = [], synced: unknown[] = []
  let click: (event: { type: string; data: unknown }) => void = () => {}
  Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: {
    notify: async (n: NativeNotice) => { delivered.push(n); return true },
    syncNotifications: async (active: unknown) => { synced.push(active) },
    onEvent: (fn: typeof click) => { click = fn; return () => { click = () => {} } },
  } })
  let notices: DesktopNotice[] = [
    { id: 'global-id-a', org: 'other-org', source_id: 'ask-42', title: 'Question', body: 'Choose', kind: 'question', agent: 'writer' },
    { id: 'global-id-b', org: 'third-org', title: 'Attention', body: 'Review', kind: 'work-attention', item: 'check-this' },
  ]
  globalThis.fetch = async url => {
    calls.push(String(url))
    return { ok: true, headers: new Headers(), json: async () => ({ notices, total: notices.length, truncated: false }) } as Response
  }
  function View() { useNativeNotifications(n => opened.push(n)); return <div>owner</div> }
  const v = await mountView(<View />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    assert.deepEqual(calls, ['/api/desktop/notifications'])
    assert.deepEqual(delivered.map(n => n.org), ['other-org', 'third-org'])
    assert.equal(delivered[0]!.source_id, 'ask-42', 'the native contract retains the exact inbox target')
    await inAct(async () => { click({ type: 'notification-click', data: delivered[0] }); await flush(10) })
    assert.equal(opened[0]!.source_id, 'ask-42')
    assert.equal(notificationInboxTarget(opened[0]!), 'ask:ask-42', 'question targets the inbox ask row, preserving the complete raw source ID')
    assert.equal(notificationInboxTarget({ ...opened[0]!, kind: 'urgent-mail' }), 'ask-42', 'mail IDs are not rewritten as ask rows')
    assert.equal(opened[0]!.org, 'other-org')
    notices = []
    bumpLive(); await advance(200)
    assert.equal(calls.length, 3, 'activation rechecks the target and mutations refresh attention')
    assert.deepEqual(synced.at(-1), [], 'resolved requests are removed from the native alert inventory')
    await inAct(async () => { click({ type: 'notification-click', data: delivered[0] }); await flush(10) })
    assert.equal(opened.length, 1, 'a stale OS click cannot reopen a resolved question')
    await advance(6100)
    assert.equal(delivered.length, 2, 'dismissed notices do not create new notifications')
  } finally { await v.unmount(); globalThis.fetch = original; Object.defineProperty(window, 'orgtreeDesktop', { value: undefined, configurable: true }) }
  const stopped = calls.length
  await advance(7000)
  assert.equal(calls.length, stopped, 'no polling survives owner unmount')
  realClock()
})

test('desktop attention has one request in flight and no fetch without the native bridge', async () => {
  localStorage.clear(); useFakeClock()
  const original = globalThis.fetch
  let calls = 0, release: ((r: Response) => void) | undefined
  globalThis.fetch = () => { calls++; return new Promise<Response>(resolve => { release = resolve }) }
  function View() { useNativeNotifications(() => {}); return <div>owner</div> }
  let v = await mountView(<View />, el => el)
  try {
    await advance(7000); assert.equal(calls, 0, 'browser-only view is inert')
    await v.unmount()
    Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: { notify: async () => true, onEvent: () => () => {} } })
    v = await mountView(<View />, el => el)
    assert.equal(calls, 1, 'native positive control starts one request')
    await advance(13000); bumpLive(); await advance(200)
    assert.equal(calls, 1, 'timer and live bumps cannot overlap a pending request')
    await inAct(async () => { release!({ ok: true, headers: new Headers(), json: async () => ({ notices: [], total: 0, truncated: false }) } as Response); await flush(6) })
    assert.equal(calls, 2, 'a live bump during a request gets a fresh read after it finishes')
    await inAct(async () => { release!({ ok: true, headers: new Headers(), json: async () => ({ notices: [], total: 0, truncated: false }) } as Response); await flush(6) })
  } finally { await v.unmount(); globalThis.fetch = original; Object.defineProperty(window, 'orgtreeDesktop', { value: undefined, configurable: true }); realClock() }
})

test('pagination reaches every urgent item and persistent dedup survives remount beyond 1000 items', async () => {
  localStorage.clear(); useFakeClock()
  const original = globalThis.fetch
  const rows: DesktopNotice[] = Array.from({ length: 1002 }, (_, i) => ({
    id: `paged-${i}`, org: 'elsewhere', agent: 'writer', source_id: `mail-${i}`,
    kind: 'urgent-mail', title: 'Urgent message', body: `Action ${i}`,
  }))
  const delivered: NativeNotice[] = [], opened: DesktopNotice[] = []
  let click: (event: { type: string; data: unknown }) => void = () => {}
  Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: {
    notify: async (n: NativeNotice) => { delivered.push(n); return true },
    syncNotifications: async () => {},
    onEvent: (fn: typeof click) => { click = fn; return () => {} },
  } })
  globalThis.fetch = async url => {
    const offset = Number(new URL(String(url), 'http://localhost').searchParams.get('offset') ?? 0)
    const end = offset + 200
    return { ok: true, headers: new Headers(), json: async () => ({
      notices: rows.slice(offset, end), total: rows.length, truncated: end < rows.length,
      next_offset: end < rows.length ? end : null, active: rows.map(({ org, id }) => ({ org, id })),
    }) } as Response
  }
  function View() { useNativeNotifications(n => opened.push(n)); return <div>owner</div> }
  let v = await mountView(<View />, el => el)
  try {
    await inAct(async () => { await flush(60) })
    assert.equal(delivered.length, rows.length)
    rows.push({ id: 'native-clock', source_id: 'clock-mail', org: 'elsewhere', kind: 'urgent-mail', title: 'New urgent mail', body: 'Needs attention' })
    assert.equal(document.hidden, true, 'the owner document is hidden in this fixture')
    await inAct(async () => { click({ type: 'notification-poll', data: null }); await flush(60) })
    assert.equal(delivered.at(-1)!.id, 'native-clock', 'the native tick discovers new mail without a renderer timer or visible window')
    assert.equal(delivered.length, rows.length, 'unresolved items never churn out of history')
    await v.unmount()
    v = await mountView(<View />, el => el)
    await inAct(async () => { await flush(60) })
    assert.equal(delivered.length, rows.length, 'reloading the renderer keeps the dedup history')
    const { source_id: _source, ...oldNativeNotice } = rows[500]!
    await inAct(async () => { click({ type: 'notification-click', data: oldNativeNotice }); await flush(60) })
    assert.equal(notificationInboxTarget(opened[0]!), 'mail-500', 'even a pre-refresh opaque ID resolves to the exact source')
  } finally { await v.unmount(); globalThis.fetch = original; Object.defineProperty(window, 'orgtreeDesktop', { value: undefined, configurable: true }); realClock() }
})

test('a withdrawal while the attention read is pending discards that stale response', async () => {
  localStorage.clear(); useFakeClock()
  const original = globalThis.fetch
  let release: (r: Response) => void = () => {}, calls = 0, delivered = 0
  Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: {
    notify: async () => { delivered++; return true }, onEvent: () => () => {},
  } })
  const response = (notices: DesktopNotice[]) => ({ ok: true, headers: new Headers(), json: async () => ({ notices, total: notices.length, truncated: false }) } as Response)
  globalThis.fetch = () => ++calls === 1 ? new Promise(resolve => { release = resolve }) : Promise.resolve(response([]))
  function View() { useNativeNotifications(() => {}); return null }
  const v = await mountView(<View />, el => el)
  try {
    bumpLive(); await advance(200)
    await inAct(async () => {
      release(response([{ id: 'withdrawn-during-read', source_id: 'q1', org: 'org', kind: 'question', title: 'Question', body: 'Old question' }]))
      await flush(15)
    })
    assert.equal(calls, 2)
    assert.equal(delivered, 0)
  } finally { await v.unmount(); globalThis.fetch = original; Object.defineProperty(window, 'orgtreeDesktop', { value: undefined, configurable: true }); realClock() }
})

test('a notification question opens the exact request from the Sent folder without a mail lookup', async () => {
  localStorage.clear(); useFakeClock()
  const original = globalThis.fetch, lookups: string[] = []
  Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} })
  const ask = { id: 'q-batch', node: 'writer', kind: 'batch', status: 'open', at: '2026-09-12T10:00:00Z',
    tabs: [{ kind: 'question', question: 'Which option should we use?' }], revs: { ask: 1 } }
  const tree = { slug: 'fixture', roots: [{ id: 'writer', state: 'live', tier: 'haiku', children: [],
    grant: 0, free: 0, seat: 1, scope: { tools: {}, add_dirs: [] }, ask }], asks: [ask] } as unknown as TreePayload
  globalThis.fetch = async url => {
    const path = String(url); lookups.push(path)
    return { ok: true, headers: new Headers(), json: async () => path.endsWith('/inbox')
      ? { pending: [], delivered: [], sent: [] } : {} } as Response
  }
  const panel = (jumpTo: string | null) => <InboxPanel slug="fixture" tree={tree} toast={() => {}} close={() => {}} jumpTo={jumpTo} />
  const v = await mountView(panel(null), el => el)
  try {
    await inAct(async () => { await flush(10) })
    const sent = [...v.el.querySelectorAll('button')].find(b => /^sent$/i.test(b.textContent?.trim() ?? ''))
    assert.ok(sent, 'the folder control exists')
    await inAct(() => sent.click())
    assert.equal(v.el.querySelector('.askcard'), null)
    await v.render(panel('ask:q-batch'))
    await inAct(async () => { await flush(10) })
    assert.match(v.el.querySelector('.askcard')?.textContent ?? '', /Which option should we use/)
    assert.ok(!lookups.some(p => p.includes('/mail/') && p.includes('ask')), 'synthetic request rows do not request a nonexistent mail')
  } finally { await v.unmount(); globalThis.fetch = original; realClock() }
})
