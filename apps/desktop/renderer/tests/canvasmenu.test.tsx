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
import { pinSurfaceKey, readPinSurfaces, updatePinSurface, removePinSurface } from '../src/canvas/pinspace'
import { installAppShortcuts } from '../src/shell/appshortcuts'
import { orgNavigationTooltip } from '../src/shell/orgnavigationbindings'
import type { CanvasShortcutActions } from '../src/shell/appshortcuts'
import { resetConvos } from '../src/convo'
import { getReaderAvailability } from '../src/api'
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
    auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true,
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
  const label = orgNavigationTooltip(title, title === HUD_FIT ? 'fitOrg' : title === HUD_SWITCHBOARD ? 'switchboard' : null)
  const b = host.querySelector<HTMLButtonElement>(`.zoomhud button[title="${label}"]`)
  assert.ok(b, `no HUD button "${label}"`)
  return b!
}
async function press(b: HTMLButtonElement) { await inAct(() => { b.click() }); await flush(); await advance(1600) }

const FIT = 'Fit the whole org', SWB = 'Jump to the switchboard', LAST = 'Focus last desk'

function uiTest(name: string, body: (host: HTMLElement, viewport: HTMLElement,
  render: (ids: string[]) => Promise<void>, shortcut: (key: string) => Promise<void>) => Promise<void>) {
  test(name, async (t: TestContext) => {
    localStorage.clear(); resetCanvasSessionForTests(); useFakeClock(); installFetch(new FakeServer())
    const unrect = stubViewportRect(), uncap = stubPointerCapture()
    const shortcutRef: { current: CanvasShortcutActions | null } = { current: null }
    const stopShortcuts = installAppShortcuts(window, () => ({
      fitOrg: () => shortcutRef.current?.fitOrg(),
      lastDesk: () => shortcutRef.current?.lastDesk(),
      switchboard: () => shortcutRef.current?.switchboard(),
      parentNode: () => shortcutRef.current?.parentNode(),
      childNode: () => shortcutRef.current?.childNode(),
      previousNode: () => shortcutRef.current?.previousNode(),
      nextNode: () => shortcutRef.current?.nextNode(),
      previousAgent: () => shortcutRef.current?.previousAgent(),
    }))
    const canvas = (ids: string[]) => <OrgCanvas tree={tree(ids)} op={() => Promise.resolve({} as never)}
      slug={SLUG} toast={noop} mailEvt={null} canvasShortcuts={shortcutRef} />
    const v = await mountView(canvas(['ceo', 'cto', 'cfo']), (el) => el)
    t.after(async () => {
      try { await escape() } catch { /* closed */ }
      stopShortcuts(); await v.unmount(); uncap(); unrect(); forgetPins(SLUG); resetConvos(); realClock(); localStorage.clear()
    })
    await flush(); await advance(2500)
    await body(v.el, v.el.querySelector('.viewport') as HTMLElement,
      async (ids) => { await v.render(canvas(ids)); await flush(); await advance(1600) },
      async (key) => {
        if (key !== 'F7') (document.activeElement as HTMLElement | null)?.blur?.()
        await inAct(() => { window.dispatchEvent(new KeyboardEvent('keydown', {
          key, shiftKey: true, bubbles: true, cancelable: true,
          altKey: key !== 'F7', code: key === 'S' ? 'KeyS' : '',
        })) })
        await flush(); await advance(1600)
      })
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

uiTest('Shift+Alt+Space uses the same whole-org fit action as the existing HUD button', async (host, _viewport, _render, shortcut) => {
  const zin = hud(host, 'zoom in')
  await press(zin); await press(zin)
  const zoomed = cam(host)
  await shortcut(' ')
  const viaShortcut = cam(host)
  assert.ok(!same(viaShortcut, zoomed), `positive control: Shift+Alt+Space moved from ${show(zoomed)}`)
  await press(zin); await press(zin)
  await press(hud(host, HUD_FIT))
  assert.ok(same(cam(host), viaShortcut), 'Shift+Alt+Space and the HUD fit share the same camera action')
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

uiTest('Shift+Alt+S uses the same switchboard focus action as the existing HUD button', async (host, _viewport, _render, shortcut) => {
  await shortcut('S')
  const viaShortcut = cam(host)
  assert.ok(host.querySelector('.eye-desk'), 'Shift+Alt+S opened the switchboard')
  await press(hud(host, HUD_FIT))
  assert.ok(!same(cam(host), viaShortcut), 'positive control: fit moved away from the switchboard')
  await press(hud(host, HUD_SWITCHBOARD))
  assert.ok(same(cam(host), viaShortcut), 'Shift+Alt+S and the HUD eye share the same camera action')
})

uiTest('actual canvas arrow routing wraps and earlier-agent history walks back without toggling', async (host, _viewport, _render, shortcut) => {
  await clickCard(cardOf(host, 'ceo'))
  await shortcut('ArrowRight')
  assert.equal(openDesk(host), 'cto')
  await shortcut('ArrowRight')
  assert.equal(openDesk(host), 'cfo')
  await shortcut('Backspace')
  assert.equal(openDesk(host), 'cto')
  await shortcut('Backspace')
  assert.equal(openDesk(host), 'ceo')
  await shortcut('ArrowLeft')
  assert.equal(openDesk(host), 'cfo', 'left from the first wraps to the last')
  await shortcut('ArrowRight')
  assert.equal(openDesk(host), 'ceo', 'right from the last wraps to the first')
  await shortcut('ArrowUp')
  assert.ok(host.querySelector('.eye-desk'), 'top-level Up focuses the switchboard')
  await shortcut('ArrowDown')
  assert.equal(openDesk(host), 'cto', 'Down selects the centre direct child')
})

uiTest('keyboard focus in a pinned desk changes the org navigation origin', async (host, _viewport, _render, shortcut) => {
  await clickCard(cardOf(host, 'cfo'))
  assert.equal(openDesk(host), 'cfo', 'positive control: the canvas starts elsewhere')
  await inAct(() => { addPin(SLUG, 'cto', { x: 30, y: 30, w: 420, h: 420 }) })
  await flush(); await advance(600)
  const button = document.querySelector<HTMLButtonElement>('.pinwin .cc-tabs button')
  assert.ok(button, 'the pinned cto desk has a tab strip')
  await inAct(() => button!.focus())
  await shortcut('ArrowLeft')
  assert.equal(openDesk(host), 'ceo', 'left is relative to focused cto, not the previous canvas destination')
})

uiTest('switchboard card Focus uses the same camera move as the HUD switchboard action', async host => {
  await rightClick(host.querySelector('.sq.user')!)
  await pick('Focus')
  const viaMenu = cam(host)
  assert.ok(host.querySelector('.eye-desk'))
  await press(hud(host, HUD_FIT))
  assert.ok(!same(cam(host), viaMenu))
  await press(hud(host, HUD_SWITCHBOARD))
  assert.ok(same(cam(host), viaMenu))
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
  assert.equal(host.querySelector('.sq.desk:not(.user)') === null, true, 'no desk open before the menu')
  await rightClick(viewport)
  assert.deepEqual(labels(), [FIT, SWB, `${LAST} (cto)`])
  assert.equal(items()[2]!.disabled, false)
  await pick(`${LAST} (cto)`)
  assert.equal(openDesk(host), 'cto', 'the cto desk is open again')
  assert.ok(same(cam(host), atCto), `same camera as clicking cto: ${show(cam(host))} vs ${show(atCto)}`)
})

uiTest('Shift+F7 focuses the last live desk using the same camera action as its context-menu entry', async (host, _viewport, _render, shortcut) => {
  await clickCard(cardOf(host, 'cto'))
  const atCto = cam(host)
  await press(hud(host, HUD_SWITCHBOARD))
  await press(hud(host, HUD_FIT))
  assert.equal(host.querySelector('.sq.desk:not(.user)') === null, true, 'positive control: no agent desk is open')
  await shortcut('F7')
  assert.equal(openDesk(host), 'cto')
  assert.ok(same(cam(host), atCto), `Shift+F7 camera ${show(cam(host))} vs last desk ${show(atCto)}`)
})

uiTest('org fit/switchboard and last-desk keys leave the camera alone while an org modal surface is open', async (host, _viewport, _render, shortcut) => {
  await clickCard(cardOf(host, 'cto'))
  const key = pinSurfaceKey(SLUG, 'shortcut-guard', true)
  const modal = document.createElement('div')
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')
  document.body.append(modal)
  await inAct(() => updatePinSurface(key, SLUG, { x: 20, y: 20, w: 400, h: 300 }, true))
  await flush()
  try {
    assert.ok(readPinSurfaces().some(surface => surface.key === key && surface.org === SLUG && surface.modal), 'modal surface is registered')
    await advance(2000)
    const before = cam(host)
    for (const functionKey of [' ', 'F7', 'S']) {
      await shortcut(functionKey)
      assert.ok(same(cam(host), before), `Shift+${functionKey} moved the camera under a modal`)
    }
  } finally { await inAct(() => removePinSurface(key)); modal.remove() }
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

// review-sol 2026-10-01: an unchanged tree refresh must not re-announce the
// camera's (older) desk as newly focused over the pinned desk used since
uiTest('"Focus last desk" keeps the pinned desk after a tree refresh while another desk stays open', async (host, viewport, render) => {
  await clickCard(cardOf(host, 'ceo'))
  assert.equal(openDesk(host), 'ceo', 'positive control: ceo desk open, and the camera stays there')
  await inAct(() => { addPin(SLUG, 'cto', { x: 30, y: 30, w: 420, h: 420 }) })
  await flush(); await advance(600)
  const input = document.querySelector<HTMLTextAreaElement>('.pinwin textarea')
  assert.ok(input, 'positive control: the pinned cto desk has a composer')
  await inAct(() => { input!.focus() })
  assert.equal(document.activeElement, input)
  await rightClick(viewport)
  assert.equal(items()[2]!.textContent?.trim(), `${LAST} (cto)`, 'positive control: cto is the last desk')
  await escape()
  await render(['ceo', 'cto', 'cfo'])      // the same org, fresh objects: a routine refresh
  assert.equal(openDesk(host), 'ceo', 'the ceo desk is still open under the camera')
  await rightClick(viewport)
  assert.equal(items()[2]!.textContent?.trim(), `${LAST} (cto)`, 'a refresh does not make ceo the last desk')
  await escape()
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
  assert.match(src, /title=\{orgNavigationTooltip\(HUD_SWITCHBOARD, 'switchboard'\)\}\n\s*onClick=\{hudSwitchboard\}/, 'eye button')
  assert.match(src, /title=\{orgNavigationTooltip\(HUD_FIT, 'fitOrg'\)\} onClick=\{hudFit\}/, 'fit button')
  assert.match(src, /label: sentence\(HUD_FIT\), title: orgNavigationTooltip\(HUD_FIT, 'fitOrg'\), onSelect: hudFit/, 'fit entry')
  assert.match(src, /label: sentence\(HUD_SWITCHBOARD\), title: orgNavigationTooltip\(HUD_SWITCHBOARD, 'switchboard'\), onSelect: hudSwitchboard/, 'switchboard entry')
})


test('desk availability rejects incomplete successful replies and the shared fixture models empty and own scopes', async t=>{
  const saved=globalThis.fetch
  t.after(()=>{globalThis.fetch=saved})
  for(const body of [{ok:true},null,{}, {work:{own:false,team:false}},
    {work:{own:false,team:false},presented:{own:false,team:'false'}}]) {
    globalThis.fetch=(async()=>new Response(JSON.stringify(body))) as typeof fetch
    await assert.rejects(getReaderAvailability('availability-contract','lead'),/availability response is incomplete/)
  }
  const server=new FakeServer();installFetch(server)
  assert.deepEqual(await getReaderAvailability('availability-contract','lead'),
    {work:{own:false,team:false},presented:{own:false,team:false}})
  server.workItems=[{slug:'review',reviewer:{node:'lead'}}]
  server.documents=[{id:'own',node:'lead',node_state:'live'}]
  assert.deepEqual(await getReaderAvailability('availability-contract','lead'),
    {work:{own:true,team:true},presented:{own:true,team:true}})
  assert.deepEqual(await getReaderAvailability('availability-contract','other'),
    {work:{own:false,team:false},presented:{own:false,team:false}})
})
