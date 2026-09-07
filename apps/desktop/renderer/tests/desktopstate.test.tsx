import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { DesktopSettings } from '../src/canvas/desktopsettings'
import { Connections } from '../src/canvas/connections'
import { MovableSurface, PopoutButton } from '../src/popout'
import { notifyOnce } from '../src/notifications'
import { captureWindow, closeSavedWindow, popupFeatures, savedDeskIdentities, savedWindows, saveWindow, WINDOW_LAYOUT_KEY, windowLayoutKey } from '../src/windowlayout'
import type { NativeDesktop, NativePreferences } from '../src/desktop'
import type { TreePayload } from '../src/types'
import { forgetModalPins, ModalOverlapSettings, MODAL_OVERLAP_KEY, PinFrame, pinModal, setModalOverlap } from '../src/canvas/modalpin'

function native(value?: Partial<NativeDesktop>) {
  Object.defineProperty(window, 'orgtreeDesktop', { value, configurable: true })
}

test('native settings save through bridge and adopt tray changes; failure leaves previous value', async () => {
  let prefs: NativePreferences = { startAtLogin: true, exitOnClose: false, routineNotifications: false }
  let event: (e: { type: string; data: unknown }) => void = () => {}
  let fail = false
  const writes: unknown[] = []
  native({ getPreferences: async () => prefs, onEvent: fn => { event = fn as typeof event; return () => {} },
    setPreferences: async patch => { writes.push(patch); if (fail) throw Error('Cannot save preferences'); return prefs = { ...prefs, ...patch } } })
  const v = await mountView(<DesktopSettings />, el => el)
  try {
    await inAct(async () => { await flush(5) })
    const switches = [...v.el.querySelectorAll<HTMLInputElement>('input')]
    assert.deepEqual(switches.map(x => x.checked), [true, false, false])
    await inAct(async () => { switches[1]!.click(); await flush(5) })
    assert.deepEqual(writes, [{ exitOnClose: true }])
    assert.equal(switches[1]!.checked, true)
    await inAct(async () => { event({ type: 'preferences', data: { ...prefs, startAtLogin: false } }) })
    assert.equal(switches[0]!.checked, false)
    fail = true
    await inAct(async () => { switches[2]!.click(); await flush(5) })
    assert.equal(switches[2]!.checked, false)
    assert.match(v.el.textContent!, /Cannot save preferences/)
  } finally { await v.unmount(); native() }
})

test('Connections renders real peers and sends sanitized remote settings without local owner credentials', async () => {
  const requests: { url: string; body: unknown }[] = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    return { ok: true, headers: new Headers(), json: async () => ({}) } as Response
  }
  const tree = { slug: 'fixture', net: { slug: 'fixture-address', hubs: [
    { id: 'local', address: 'local', name: 'Local', enabled: true, connected: true, queued: 0, roster: [] },
    { id: 'peer', address: 'https://peer.example', enabled: true, connected: true, queued: 2,
      peer_token: 'must-never-render', roster: [{ slug: 'friend', org_name: 'Other org', online: true }] },
  ] } } as unknown as TreePayload
  const v = await mountView(<Connections tree={tree} toast={() => {}} adding="" setAdding={() => {}} />, el => el)
  try {
    assert.match(v.el.textContent!, /Other org.*friend.*Online/)
    assert.match(v.el.textContent!, /2 queued/)
    assert.doesNotMatch(v.el.textContent!, /must-never-render|reveal secret/)
    const toggles = v.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    await inAct(async () => { toggles[1]!.click(); await flush(5) })
    assert.deepEqual(requests[0]!.body, { net_hubs: [{ id: 'peer', address: 'https://peer.example', enabled: false }] })
    assert.ok(requests.every(r => !r.url.endsWith('/net')))
  } finally { await v.unmount(); globalThis.fetch = original }
})

test('notice delivery deduplicates only shown notices and retries disabled or failed delivery', async () => {
  localStorage.clear()
  let calls = 0, enabled = false
  native({ notify: async () => { calls++; return enabled } })
  const notice = { id: 'fixture-once', title: 'Question', body: 'Choose', org: 'fixture', kind: 'question' as const }
  assert.equal(await notifyOnce(notice), false)
  enabled = true
  assert.equal(await notifyOnce(notice), true)
  assert.equal(await notifyOnce(notice), false)
  assert.equal(calls, 2)
  native()
})

test('window layout filters invalid geometry and preserves full desk generation identity', () => {
  localStorage.clear(); native({})
  localStorage.setItem(WINDOW_LAYOUT_KEY, JSON.stringify([{ key: 'bad', kind: 'desk:x', org: 'org', open: true, rect: { x: 0, y: 0, width: -1, height: 800 } }]))
  assert.deepEqual(savedWindows(), [])
  const kind = 'desk:["org","writer",3]', key = windowLayoutKey(kind, 'org')
  saveWindow({ key, kind, org: 'org', open: true, rect: { x: -600, y: 120, width: 800, height: 700 } })
  assert.deepEqual(savedDeskIdentities('org'), [['org', 'writer', 3]])
  assert.match(popupFeatures(key), /left=-600,top=120,width=800,height=700/)
  closeSavedWindow(key)
  assert.deepEqual(savedDeskIdentities('org'), [])
  assert.equal(savedWindows()[0]!.rect.x, -600)
  native()
})

test('quiet login defers restoring until manual show, then the same composer DOM moves and returns', async () => {
  localStorage.clear()
  let shown: (event: { type: string; data: unknown }) => void = () => {}
  native({ getWindowState: async () => ({ visible: false, restoreWindows: false }),
    onEvent: fn => { shown = fn as typeof shown; return () => {} } })
  const child = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const cw = child.window as unknown as Window
  Object.defineProperties(cw, { screenX: { value: 200 }, screenY: { value: 180 }, outerWidth: { value: 830 }, outerHeight: { value: 700 } })
  cw.focus = () => {}; cw.requestAnimationFrame = () => 1; cw.cancelAnimationFrame = () => {}
  const originalOpen = window.open
  let features = ''
  window.open = (_u, _n, f) => { features = f ?? ''; return cw }
  const originalObserver = globalThis.MutationObserver
  globalThis.MutationObserver = child.window.MutationObserver
  const key = windowLayoutKey('fixture', 'org')
  captureWindow(key, 'fixture', 'org', cw)
  const v = await mountView(<MovableSurface kind="fixture" org="org" title="Fixture">
    <input aria-label="saved composer" defaultValue="draft and reply kept" /><PopoutButton />
  </MovableSurface>, el => el)
  try {
    await inAct(async () => { await flush(10) })
    const initial = v.el.querySelector('input')
    assert.ok(initial, 'quiet login keeps the composer mounted in hidden main')
    assert.equal(cw.document.querySelector('input'), null, 'login must not open a popout')
    await inAct(async () => { shown({ type: 'main-window-shown', data: { visible: true, restoreWindows: true } }); await flush(10) })
    const input = cw.document.querySelector<HTMLInputElement>('input')!
    assert.ok(input, 'positive control: the child owns the real composer')
    assert.equal(input, initial)
    assert.equal(input.value, 'draft and reply kept')
    assert.match(features, /left=200,top=180,width=830,height=700/)
    const back = cw.document.querySelector<HTMLButtonElement>('button[aria-label="Return to main window"]')!
    await inAct(async () => { back.click(); await flush(5) })
    assert.equal(v.el.querySelector('input'), input, 'same DOM node returns; no second composer')
    assert.equal(savedWindows()[0]!.open, false)
  } finally { await v.unmount(); window.open = originalOpen; globalThis.MutationObserver = originalObserver; native(); child.window.close() }
})

test('pinned modal fades only over the focused desk; toggle, amount and non-overlap change real style', async () => {
  localStorage.clear(); forgetModalPins(); setModalOverlap({ enabled: true, opacity: 0.7 })
  pinModal('fade-fixture', { x: 50, y: 50, w: 500, h: 400 })
  const desk = document.createElement('div'); desk.className = 'sq desk'; document.body.appendChild(desk)
  const original = window.HTMLElement.prototype.getBoundingClientRect
  let overlap = true
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this === desk) return { left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400, x: 0, y: 0, toJSON() {} }
    if (this.classList.contains('fade-fixture')) return { left: overlap ? 50 : 500, top: 50, right: overlap ? 550 : 1000, bottom: 450, width: 500, height: 400, x: 50, y: 50, toJSON() {} }
    return original.call(this)
  }
  const v = await mountView(<><ModalOverlapSettings /><PinFrame kind="fade-fixture" title="Fixture" panel="settings fade-fixture" close={() => {}}>Readable content</PinFrame></>, el => el)
  try {
    await inAct(async () => { await flush(5) })
    const panel = document.querySelector<HTMLElement>('.fade-fixture')!
    assert.equal(panel.style.opacity, '0.7')
    await inAct(() => { setModalOverlap({ enabled: true, opacity: 0.4 }) })
    assert.equal(panel.style.opacity, '0.4')
    assert.equal(JSON.parse(localStorage.getItem(MODAL_OVERLAP_KEY)!).opacity, 0.4)
    await inAct(() => { v.el.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click() })
    assert.equal(panel.style.opacity, '')
    assert.equal(v.el.querySelector<HTMLInputElement>('input[type="range"]')!.disabled, true)
    overlap = false
    await inAct(() => { setModalOverlap({ enabled: true, opacity: 0.7 }); window.dispatchEvent(new Event('resize')) })
    assert.equal(panel.style.opacity, '')
  } finally { await v.unmount(); desk.remove(); window.HTMLElement.prototype.getBoundingClientRect = original; forgetModalPins() }
})
