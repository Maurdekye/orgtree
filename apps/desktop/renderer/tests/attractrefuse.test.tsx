// App settings > Display > Modes: "Refuse questions to the user while attract mode runs"
// (USER 2026-11-03 13:10:58Z m46c12a448a66). Kept out of streamerblank.test.tsx so the two
// files do not both grow at the end; the helpers below are small copies of that file's.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { AccountsPanel } from '../src/canvas/accounts'
import type { NativePreferences } from '../src/desktop'
import { DEFAULT_PREFERENCES, preferencesPatch } from '../../main/policy'
import { startStreamerMode } from '../src/streamer'

const g = globalThis as unknown as Record<string, unknown>
const native = window as unknown as { orgtreeDesktop?: unknown }
function stubFetch(): void {
  g.fetch = (url: string, init?: RequestInit) => {
    const p = new URL(String(url), 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    const payload = p === '/api/accounts' ? { version: 2, primary: null, keys: [], assignments: {}, accounts: [] }
      : p === '/api/providers' ? { providers: [] }
        : p === '/api/app-settings/runtime' && method === 'GET'
          ? { warming_enabled: true, verbose_logging: false, verbose_logging_pinned: false }
          : p === '/api/app/records' ? { type: 'app_snapshot', epoch: 'e', seq: 1, registry: { type: 'registry_snapshot', epoch: 'e', cursor: { app_uuid: 't', incarnation: 'e', rev: 1 }, records: [] }, summaries: {}, notices: {}, runtime: { orgs: {}, values: {} } }
            : null
    if (!payload) return Promise.reject(new Error(`unexpected ${method} ${p}`))
    return Promise.resolve(new Response(JSON.stringify(payload)))
  }
}
function installBridge(t: TestContext) {
  const previous = native.orgtreeDesktop
  let saved: NativePreferences = { ...DEFAULT_PREFERENCES }
  const writes: Partial<NativePreferences>[] = []
  const listeners = new Set<(e: { type: string; data: unknown }) => void>()
  const broadcast = () => { for (const fn of [...listeners]) fn({ type: 'preferences', data: saved }) }
  native.orgtreeDesktop = {
    getPreferences: async () => saved,
    setPreferences: async (patch: Partial<NativePreferences>) => {
      writes.push(patch); saved = { ...saved, ...preferencesPatch(patch) }; broadcast(); return saved
    },
    onEvent: (fn: (e: { type: string; data: unknown }) => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
  }
  t.after(() => { native.orgtreeDesktop = previous })
  const elsewhere = (patch: Partial<NativePreferences>) => { saved = { ...saved, ...patch }; broadcast() }
  return { writes, elsewhere }
}

test('App settings › Display › Modes has a "Refuse questions to the user while attract mode runs" toggle under the start-after row: default on, one app-wide preference', async (t) => {
  const { WebSocket } = g
  g.WebSocket = class { onclose: (() => void) | null = null; close() { this.onclose?.() } }
  t.after(() => { g.WebSocket = WebSocket })
  const bridge = installBridge(t)
  stubFetch()
  const stop = startStreamerMode()
  t.after(() => { stop(); delete g.fetch })
  const view = await mountView(<AccountsPanel toast={() => {}} close={() => {}} initialTab="display" />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(10) })
  const host = view.el.querySelector<HTMLElement>('#app-settings-panel-display')!
  const row = host.querySelector<HTMLElement>('[data-settings-field="attractRefuseQuestions"]')
  assert.ok(row, 'the refuse-questions row')
  assert.equal(host.querySelector('[data-settings-field="attractIdleSeconds"]')!.nextElementSibling, row, 'directly under the start-after row')
  assert.match(row!.textContent ?? '', /Refuse questions to the user while attract mode runs/)
  const box = row!.querySelector<HTMLInputElement>('input[type="checkbox"], [role="switch"]')!
  const on = () => box.getAttribute('aria-checked') ?? String(box.checked)
  assert.equal(on(), 'true', 'default on')
  await inAct(async () => { box.click(); await flush(8) })
  assert.deepEqual(bridge.writes, [{ attractRefuseQuestions: false }])
  await inAct(async () => { bridge.elsewhere({ attractRefuseQuestions: true }); await flush(8) })
  assert.equal(on(), 'true', 'follows other windows')
})
