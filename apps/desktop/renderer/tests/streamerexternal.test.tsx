// "external addresses arent reliably hidden in streamer mode" (USER 2026-11-04 19:33:17Z m55e27bc6539f): a chip that resolves to an
// @net:/@org: address shows a display name drawn by CSS from data-net-name (not a text node), so a text range could not blur it.
// Every renderer of such a chip must be blurred by what it RESOLVES to, whatever name it shows; the current org, agents and
// projects stay visible; with the External switch off nothing is blurred.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { HubContactChip } from '../src/canvas/agentmentions'
import { linkifyRefs } from '../src/canvas/refmd'
import { resetNetMentions, setNetRoster } from '../src/canvas/netmentions'
import { startStreamerMode } from '../src/streamer'
import type { NativePreferences } from '../src/desktop'
import type { NetBlock, NetPeer } from '../src/types'
import type { RefWorld } from '../src/canvas/reflinks'
import { DEFAULT_PREFERENCES, preferencesPatch } from '../../main/policy'

const native = window as unknown as { orgtreeDesktop?: unknown }
function installBridge(t: TestContext, start: Partial<NativePreferences>) {
  const previous = native.orgtreeDesktop
  let saved: NativePreferences = { ...DEFAULT_PREFERENCES, ...start }
  const listeners = new Set<(e: { type: string; data: unknown }) => void>()
  const broadcast = () => { for (const fn of [...listeners]) fn({ type: 'preferences', data: saved }) }
  native.orgtreeDesktop = {
    getPreferences: async () => saved,
    setPreferences: async (patch: Partial<NativePreferences>) => { saved = { ...saved, ...preferencesPatch(patch) }; broadcast(); return saved },
    onEvent: (fn: (e: { type: string; data: unknown }) => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
  }
  t.after(() => { native.orgtreeDesktop = previous })
  return { set: (patch: Partial<NativePreferences>) => { saved = { ...saved, ...patch }; broadcast() } }
}

const PEER = { slug: 'maurdekye.77ded7', org_name: 'Maurdekye', kind: 'person', online: true } as unknown as NetPeer
const net: NetBlock = { slug: 'acme.home.a1b2c3', hubs: [{ id: 'h', address: 'hub', name: 'h', version: '2.4.0', enabled: true, connected: true, queued: 0, roster: [PEER] }] } as unknown as NetBlock
const world: RefWorld = { org: 'acme', agents: new Map([['worker-alpha', 'worker-alpha']]), tierOf: () => 'haiku' }
const blurred = (el: Element | null) => !!el?.closest('[data-streamer-blur]')
// the text ranges the boundary hides (a Highlight double on the window, as in real Chromium)
const registry = new Map<string, Range[]>()
Object.defineProperty(window, 'CSS', { value: { highlights: registry }, configurable: true })
Object.defineProperty(window, 'Highlight', { value: class extends Array<Range> { constructor(...r: Range[]) { super(...r) } }, configurable: true })
const rangeHidden = () => (registry.get('streamer-sensitive') ?? []).map(r => r.toString())

test('every renderer of an @net:/@org: chip is blurred by its resolved address, named or not; current org, agents stay visible; switch off shows all', async t => {
  const bridge = installBridge(t, { streamerMode: true })
  setNetRoster('acme', net)
  const stop = startStreamerMode()
  const host = document.createElement('div'); host.className = 'md'
  host.innerHTML = '<p>to @net:maurdekye.77ded7 and @net:acme.home.a1b2c3 and @worker-alpha</p>'
  document.body.appendChild(host)
  linkifyRefs(host, world)
  const view = await mountView(<div><span id="react-ext"><HubContactChip address="@net:maurdekye.77ded7" /></span><span id="react-own"><HubContactChip address="@net:acme.home.a1b2c3" /></span></div>, el => el)
  t.after(async () => { stop(); host.remove(); await view.unmount(); resetNetMentions() })
  await inAct(async () => { await flush(10) })
  const md = (addr: string) => host.querySelector(`[data-hub-address="${addr}"]`)
  assert.ok(md('@net:maurdekye.77ded7')?.querySelector('[data-net-name="Maurdekye"]'), 'the markdown chip shows the display name')
  assert.equal(blurred(md('@net:maurdekye.77ded7')), true, 'markdown (tool row / message body) chip with a display name is blurred')
  assert.equal(blurred(view.el.querySelector('#react-ext [data-hub-address]')), true, 'React chip (row header sender) with a display name is blurred')
  assert.equal(blurred(md('@net:acme.home.a1b2c3')), false, 'the current org stays visible (markdown)')
  assert.equal(rangeHidden().some(t => t.includes('acme.home.a1b2c3')), false, 'and no text range hides the current org address either (markdown + React): ' + JSON.stringify(rangeHidden()))
  assert.equal(blurred(view.el.querySelector('#react-own [data-hub-address]')), false, 'the current org stays visible (React)')
  assert.equal(blurred(host.querySelector('[data-agent-nav="worker-alpha"]')), false, 'agent chips stay visible')
  assert.equal(document.documentElement.classList.contains('streamer-on'), true)
  await inAct(async () => { bridge.set({ streamerMode: false }); await flush(10) })
  assert.equal(blurred(md('@net:maurdekye.77ded7')), false, 'off: visible')
  assert.equal(blurred(view.el.querySelector('#react-ext [data-hub-address]')), false, 'off: visible')
})
