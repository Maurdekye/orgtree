import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { notificationInboxTarget, useNativeNotifications } from '../src/notifications'
import type { DesktopNotice } from '../src/notifications'
import type { NativeNotice } from '../src/desktop'
import { bumpLive } from '../src/livebus'

test('global attention reaches other orgs, retains exact click targets and stops after unmount', async () => {
  localStorage.clear(); useFakeClock()
  const original = globalThis.fetch
  const calls: string[] = [], delivered: NativeNotice[] = [], opened: DesktopNotice[] = []
  let click: (event: { type: string; data: unknown }) => void = () => {}
  Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: {
    notify: async (n: NativeNotice) => { delivered.push(n); return true },
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
    assert.equal('source_id' in delivered[0]!, false, 'native IPC receives only its declared fields')
    await inAct(() => { click({ type: 'notification-click', data: delivered[0] }) })
    assert.equal(opened[0]!.source_id, 'ask-42')
    assert.equal(notificationInboxTarget(opened[0]!), 'ask:ask-42', 'question targets the inbox ask row, preserving the complete raw source ID')
    assert.equal(notificationInboxTarget({ ...opened[0]!, kind: 'urgent-mail' }), 'ask-42', 'mail IDs are not rewritten as ask rows')
    assert.equal(opened[0]!.org, 'other-org')
    notices = []
    bumpLive(); await advance(200)
    assert.equal(calls.length, 2, 'mutations refresh attention without waiting for the timer')
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
  } finally { await v.unmount(); globalThis.fetch = original; Object.defineProperty(window, 'orgtreeDesktop', { value: undefined, configurable: true }); realClock() }
})
