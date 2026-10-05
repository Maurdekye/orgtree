import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useNativeNotifications } from '../src/notifications'
import { NativeNotifications } from '../../main/notifications'
import type { DesktopNotice } from '../src/notifications'
import { eventFanout } from './heldevents'

test('app notices preserve all categories, startup history, document baseline and native retry without polling', async () => {
  useFakeClock(); localStorage.clear()
  localStorage.setItem('orgtree-native-notices-v1', JSON.stringify([JSON.stringify(['notice-org', 'already-shown'])]))
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = { fetch: globals.fetch, WebSocket: globals.WebSocket }
  const fan = eventFanout(), sockets: Socket[] = [], requests: string[] = []
  const shown: DesktopNotice[] = [], attempts: string[] = [], closed: string[] = []
  let preferenceReads = 0
  const prefs = { notificationsEnabled: true, notifyQuestions: true, notifyUrgentMail: true,
    notifyTerminalFailures: true, notifyDocketAttention: true, notifyAllMail: true,
    notifyDocuments: true, notifyFrozen: true, notifyWhileFocused: true }
  const native = new NativeNotifications(data => {
    const events = new Map<string, () => void>()
    return {
      on(name: string, fn: () => void) { events.set(name, fn) },
      show() {
        attempts.push(data.id)
        if (data.id === 'retry-mail' && attempts.filter(x => x === data.id).length === 1) events.get('failed')?.()
        else { shown.push(data); events.get('show')?.() }
      },
      close() { closed.push(data.id) },
    }
  }, () => {})
  Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: {
    getPreferences: async () => {
      if (++preferenceReads === 1) throw new Error('temporary native preference failure')
      return prefs
    }, onEvent: fan.onEvent,
    notify: (data: unknown) => native.notify(data, prefs),
    syncNotifications: async (active: unknown) => native.sync(active),
  } })
  class Socket {
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor() { sockets.push(this) }
    close() { this.onclose?.() }
    frame(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
  }
  const epoch = 'app-notices'
  const registry = { type: 'registry_snapshot', epoch, cursor: { app_uuid: 'a', incarnation: 'i', rev: 1 }, records: [
    { entity: 'registry_org', id: '1', body: { org_id: 1, slug: 'notice-org', org_uuid: 'u', state: 'active' } },
  ] }
  const copy = { type: 'app_snapshot', epoch, seq: 1, registry, summaries: {}, notices: {}, runtime: { values: {}, orgs: {} } }
  globals.WebSocket = Socket
  globals.fetch = async (url: string) => {
    requests.push(String(url)); assert.equal(String(url), '/api/app/records')
    return { ok: true, headers: new Headers(), json: async () => copy }
  }
  const notice = (id: string, kind: DesktopNotice['kind']): DesktopNotice => ({
    id, org: 'notice-org', kind, title: id, body: 'Body', source_id: id,
    ...(kind === 'agent-frozen' ? { agent: 'agent', generation: 0 } : {}),
  })
  const prior = notice('already-shown', 'urgent-mail'), oldDoc = notice('old-document', 'document')
  const rows: DesktopNotice[] = [prior, oldDoc,
    ...(['question', 'urgent-mail', 'terminal-failure', 'work-attention', 'routine', 'agent-frozen'] as const).map(kind => notice(`new-${kind}`, kind))]
  function Probe() { useNativeNotifications(() => {}); return <div>notifications</div> }
  let view: Awaited<ReturnType<typeof mountView>> | undefined
  const publish = async (seq: number) => {
    await inAct(() => sockets.at(-1)!.frame({ type: 'org_notices', epoch, seq, org_id: 1,
      org_uuid: 'u', incarnation: 'i', rev: seq, notices: [...rows] }))
    await flush(20)
  }
  try {
    view = await mountView(<Probe />, el => el)
    await flush()
    await inAct(() => sockets[0].frame(copy)); await flush(20)
    assert.equal(shown.length, 0)
    await advance(5000); await flush(20)
    assert.equal(preferenceReads, 2, 'native preferences retry without another frame or engine request')
    await publish(2)
    assert.deepEqual(shown.map(n => n.id).sort(), rows.slice(2).map(n => n.id).sort())
    rows.push(notice('new-document', 'document'), notice('retry-mail', 'urgent-mail'))
    await publish(3)
    assert.equal(shown.filter(n => n.id === 'new-document').length, 1)
    assert.equal(shown.filter(n => n.id === 'retry-mail').length, 0)
    await advance(5000); await flush(20)
    assert.equal(shown.filter(n => n.id === 'retry-mail').length, 1, 'failed native delivery retries cached state')
    const delivered = shown.length
    await publish(4); await advance(120000); await flush()
    assert.equal(shown.length, delivered, 'repeated feed values and time do not display duplicates')
    assert.equal(requests.length, 1, 'only the initial capability/full-copy read, no notification endpoint or timer read')
    rows.length = 0; await publish(5)
    assert.ok(closed.includes('new-question'), 'resolved notices close native objects')
  } finally {
    await view?.unmount(); Object.assign(globals, saved)
    Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: undefined })
    realClock()
  }
})
