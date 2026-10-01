// canvasmenu.test.tsx — user 2026-10-01: "add a context menu to clicking on the
// canvas itself that has entries mirroring the two buttons for fit the org and
// focus the switchboard", and "add a third entry to focus the last desk that
// was focused". Right-click on EMPTY canvas only; cards keep their own menus.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs canvasmenu
declare const __SRC_DIR__: string
import {
  advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { HUD_FIT, HUD_SWITCHBOARD, OrgCanvas, resetCanvasSessionForTests } from '../src/canvas/OrgCanvas'
import { addPin, forgetPins } from '../src/canvas/pins'
import { resetConvos } from '../src/convo'
import type { TreePayload } from '../src/types'

const noop = () => {}
const SLUG = 'cmenu'

function mk(id: string): unknown {
  return {
    id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  }
}
function tree(ids: string[]): TreePayload {
  return {
    slug: SLUG, name: SLUG, workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots: ids.map(mk), cost_usd_total: 0,
    audit: { live_nodes: ids.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null,
  } as unknown as TreePayload
}

const VP = { w: 1280, h: 800 }
function stubViewportRect(): () => void {
  const proto = window.HTMLElement.prototype
  const original = proto.getBoundingClientRect
  proto.getBoundingClientRect = function (this: HTMLElement) {
    return this.classList?.contains('viewport')
      ? { x: 0, y: 0, left: 0, top: 0, width: VP.w, height: VP.h, right: VP.w, bottom: VP.h, toJSON() {} } as DOMRect
      : original.call(this)
  }
  return () => { proto.getBoundingClientRect = original }
}
type Cap = { setPointerCapture?: unknown; releasePointerCapture?: unknown; hasPointerCapture?: unknown }
function stubPointerCapture(): () => void {
  const proto = (globalThis as unknown as { HTMLElement: { prototype: Cap } }).HTMLElement.prototype
  const had = { s: proto.setPointerCapture, r: proto.releasePointerCapture, h: proto.hasPointerCapture }
  proto.setPointerCapture = noop; proto.releasePointerCapture = noop; proto.hasPointerCapture = () => false
  return () => { proto.setPointerCapture = had.s; proto.releasePointerCapture = had.r; proto.hasPointerCapture = had.h }
}
const W = () => globalThis as unknown as { window: { PointerEvent: typeof PointerEvent; MouseEvent: typeof MouseEvent } }
const pointer = (type: string, x: number, y: number): Event => new (W().window.PointerEvent)(type, {
  bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
  button: 0, buttons: 1, clientX: x, clientY: y,
})
const rightClick = (el: Element, x = 900, y = 700) => inAct(() => {
  el.dispatchEvent(new (W().window.MouseEvent)('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y }))
})

interface Cam { x: number; y: number; z: number }
function cam(host: HTMLElement): Cam {
  const m = /translate\(([-\d.e+]+)px, ?([-\d.e+]+)px\) scale\(([-\d.e+]+)\)/
    .exec((host.querySelector('.space') as HTMLElement).style.transform)!
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }
}
const same = (a: Cam, b: Cam) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.z - b.z) < 0.001
const show = (c: Cam) => `(${c.x.toFixed(1)}, ${c.y.toFixed(1)}) @${c.z.toFixed(3)}`

const items = () => [...document.querySelectorAll<HTMLButtonElement>('.ctxmenu [role="menuitem"]')]
const labels = () => items().map((b) => b.textContent?.trim() ?? '')
const pick = async (label: string) => {
  const b = items().find((x) => x.textContent?.trim() === label)
  assert.ok(b, `no menu entry ${label}; menu has ${JSON.stringify(labels())}`)
  await inAct(() => { b!.click() })
  await flush(); await advance(1600)
}
const escape = () => inAct(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
})
const cardOf = (host: HTMLElement, name: string) => {
  const el = [...host.querySelectorAll('.sq')].find((c) => c.querySelector('.name')?.textContent === name)
  assert.ok(el, `no card for ${name}`)
  return el!
}
async function clickCard(el: Element) {
  await inAct(() => { el.dispatchEvent(pointer('pointerdown', 200, 200)) }); await flush()
  await inAct(() => { el.dispatchEvent(pointer('pointerup', 200, 200)) }); await flush()
  await advance(1600)
}
const openDesk = (host: HTMLElement) => host.querySelector('.sq.desk:not(.user)')?.getAttribute('data-first-use-agent') ?? null
const hud = (host: HTMLElement, title: string) => {
  const b = host.querySelector<HTMLButtonElement>(`.zoomhud button[title="${title}"]`)
  assert.ok(b, `no HUD button "${title}"`)
  return b!
}
async function press(b: HTMLButtonElement) { await inAct(() => { b.click() }); await flush(); await advance(1600) }

const FIT = 'Fit the whole org', SWB = 'Jump to the switchboard', LAST = 'Focus last desk'

function uiTest(name: string, body: (host: HTMLElement, viewport: HTMLElement, render: (ids: string[]) => Promise<void>) => Promise<void>) {
  test(name, async (t: TestContext) => {
    localStorage.clear(); resetCanvasSessionForTests(); useFakeClock(); installFetch(new FakeServer())
    const unrect = stubViewportRect(), uncap = stubPointerCapture()
    const canvas = (ids: string[]) => <OrgCanvas tree={tree(ids)} op={() => Promise.resolve({} as never)}
      slug={SLUG} toast={noop} mailEvt={null} />
    const v = await mountView(canvas(['ceo', 'cto', 'cfo']), (el) => el)
    t.after(async () => {
      try { await escape() } catch { /* closed */ }
      await v.unmount(); uncap(); unrect(); forgetPins(SLUG); resetConvos(); realClock(); localStorage.clear()
    })
    await flush(); await advance(2500)
    await body(v.el, v.el.querySelector('.viewport') as HTMLElement,
      async (ids) => { await v.render(canvas(ids)); await flush(); await advance(1600) })
  })
}

uiTest('right-click on empty canvas offers the two HUD moves and the last desk, in that order', async (host, viewport) => {
  await rightClick(viewport)
  assert.deepEqual(labels(), [FIT, SWB, LAST], 'the three entries, labelled from the buttons')
  assert.equal(items()[2]!.disabled, true, 'no desk focused yet: the last-desk entry is disabled')
  assert.equal(FIT.toLowerCase(), HUD_FIT, 'the fit entry reads the fit button\'s own words')
  assert.equal(SWB.toLowerCase(), HUD_SWITCHBOARD, 'and the switchboard entry the eye button\'s')
  await escape()
  // the world plane under the cards is background too
  await rightClick(host.querySelector('.space')!)
  assert.deepEqual(labels(), [FIT, SWB, LAST])
  await escape()
})

uiTest('"Fit the whole org" lands exactly where the fit button does', async (host, viewport) => {
  const zin = hud(host, 'zoom in')
  await press(zin); await press(zin)
  const zoomed = cam(host)
  await rightClick(viewport); await pick(FIT)
  const viaMenu = cam(host)
  assert.ok(!same(viaMenu, zoomed), `positive control: the fit moved the camera from ${show(zoomed)}`)
  await press(zin); await press(zin)
  await press(hud(host, HUD_FIT))
  assert.ok(same(cam(host), viaMenu), `button ${show(cam(host))} vs menu ${show(viaMenu)}`)
})

uiTest('"Jump to the switchboard" lands exactly where the eye button does', async (host, viewport) => {
  await rightClick(viewport); await pick(SWB)
  const viaMenu = cam(host)
  assert.ok(host.querySelector('.eye-desk'), 'the switchboard opened')
  await press(hud(host, HUD_FIT))
  assert.ok(!same(cam(host), viaMenu), 'positive control: fitting moved away from the switchboard')
  await press(hud(host, HUD_SWITCHBOARD))
  assert.ok(same(cam(host), viaMenu), `button ${show(cam(host))} vs menu ${show(viaMenu)}`)
})

uiTest('"Focus last desk" focuses the most recently focused agent desk, named in the label', async (host, viewport) => {
  await clickCard(cardOf(host, 'ceo'))
  await press(hud(host, HUD_FIT))
  await clickCard(cardOf(host, 'cto'))
  const atCto = cam(host)
  assert.equal(openDesk(host), 'cto', 'positive control: cto desk open')
  await press(hud(host, HUD_FIT))
  // the switchboard is not an agent desk and does not replace the last desk
  await press(hud(host, HUD_SWITCHBOARD))
  await press(hud(host, HUD_FIT))
  assert.equal(host.querySelector('.sq.desk:not(.user)'), null, 'no desk open before the menu')
  await rightClick(viewport)
  assert.deepEqual(labels(), [FIT, SWB, `${LAST} (cto)`])
  assert.equal(items()[2]!.disabled, false)
  await pick(`${LAST} (cto)`)
  assert.equal(openDesk(host), 'cto', 'the cto desk is open again')
  assert.ok(same(cam(host), atCto), `same camera as clicking cto: ${show(cam(host))} vs ${show(atCto)}`)
})

// review-sol 2026-10-01: a desk focused in its PINNED window is a focused desk
// too — the camera never goes there, so following the camera alone missed it
uiTest('"Focus last desk" follows a pinned desk focused in its own window', async (host, viewport) => {
  await clickCard(cardOf(host, 'ceo'))
  assert.equal(openDesk(host), 'ceo', 'positive control: ceo desk open on the canvas')
  await press(hud(host, HUD_FIT))
  await inAct(() => { addPin(SLUG, 'cto', { x: 30, y: 30, w: 420, h: 420 }) })
  await flush(); await advance(600)
  const input = [...document.querySelectorAll<HTMLTextAreaElement>('textarea')]
  assert.equal(input.length, 1, 'positive control: the pinned cto desk is the only composer on screen')
  await inAct(() => { input[0]!.focus() })
  assert.equal(document.activeElement, input[0], 'focus is in the pinned desk')
  await rightClick(viewport)
  assert.deepEqual(labels(), [FIT, SWB, `${LAST} (cto)`], 'the pinned desk is the last one focused')
  await pick(`${LAST} (cto)`)
  assert.notEqual(openDesk(host), 'ceo', 'and the entry does not open the older ceo desk')
})

uiTest('"Focus last desk" is disabled once that agent is gone from the org', async (host, viewport, render) => {
  await clickCard(cardOf(host, 'cto'))
  assert.equal(openDesk(host), 'cto', 'positive control: cto desk open')
  await press(hud(host, HUD_FIT))
  await render(['ceo', 'cfo'])
  await rightClick(viewport)
  const last = items()[2]!
  assert.equal(last.textContent?.trim(), LAST, 'no name once the agent is gone')
  assert.equal(last.disabled, true)
  await escape()
})

uiTest('right-click on an agent card keeps the card\'s own menu, without the canvas entries', async (host) => {
  await rightClick(cardOf(host, 'cfo'))
  const l = labels()
  assert.ok(l.length > 0, 'the card\'s own menu opened')
  for (const x of [FIT, SWB]) assert.ok(!l.includes(x), `card menu has no "${x}": ${JSON.stringify(l)}`)
  assert.ok(!l.some((x) => x.startsWith(LAST)), 'nor the last-desk entry')
  await escape()
  // and a press on the HUD is not "empty canvas" either
  await rightClick(hud(host, HUD_FIT))
  assert.ok(!labels().includes(FIT), 'the HUD is not background')
})

test('one handler each: the buttons and the menu entries call the same functions', () => {
  const src = readFileSync(path.join(__SRC_DIR__, 'canvas', 'OrgCanvas.tsx'), 'utf8').split('\r\n').join('\n')
  assert.match(src, /title=\{HUD_SWITCHBOARD\}\n\s*onClick=\{hudSwitchboard\}/, 'eye button')
  assert.match(src, /title=\{HUD_FIT\} onClick=\{hudFit\}/, 'fit button')
  assert.match(src, /label: sentence\(HUD_FIT\), onSelect: hudFit/, 'fit entry')
  assert.match(src, /label: sentence\(HUD_SWITCHBOARD\), onSelect: hudSwitchboard/, 'switchboard entry')
})
