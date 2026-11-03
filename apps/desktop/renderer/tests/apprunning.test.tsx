// apprunning.test.tsx — USER 2026-10-31 10:18:32Z m8d5facfeae29 ("also panels that are running (or apps with any panels
// running) should have a highlight on them"), m9a790bb7a155 ("if an app has a panel but its dead then the highligth should
// be dark grey"), m16901ed8c657 ("and if an app has no panels then it should not have a highlight").
// A @panel: chip, an @app: chip and an app row of the Apps list show one of three states:
//   running  an @panel: chip whose panel runs (visible or hidden); an @app: chip, or app row, with at least one running panel;
//   dead     a panel that exists but is not running; an app that has panels, none of them running (dark grey);
//   none     an app with no panels at all; a panel or app that is not there stays an unresolved reference.
// USER 2026-10-31 12:50:40Z m29a112a68005 "Tint like unread": it is drawn as a tinted background (running the accent, dead a dark grey of
// the theme's neutral greys, none no tint), on the chip flare the unread highlights use (refnames.ts RefFlare, `ref-flare` + a class), and
// there is no dot. The unread highlight is an edge and the run state a background, so the two never share a property.
//   §1 the chips, in React and Markdown; §2 they follow the org's live apps frame; §3 the Apps list's app and panel rows follow the
//   same three states; §4 the stylesheet draws the run state as the unread edge's own rule (the same narrow left edge, USER 2026-10-31 16:25:16Z m4c09dab3ee56 "Left edge like unread" + "Provider colour", which replaced "Tint like unread"), coloured with the provider-tinted --accent for running and a dark grey for dead, with no background and no dot.
// Each test uses its own org slug: answers are kept per org.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useMemo } from 'react'
import { flush, inAct, mountView } from './harness'
import { RefProse, useRefRoutes } from '../src/canvas/reflinks'
import { RefMdBody } from '../src/canvas/refmd'
import { md } from '../src/canvas/shared'
import { AppsButton, AppsWorkspace } from '../src/canvas/apps/ui'
import { customAppsFeed } from '../src/canvas/apps/store'

declare const __SRC_DIR__: string
const tick = async () => { for (let i = 0; i < 8; i++) await flush() }

type Panel = { id: string; app: string; label: string; rev: number; open: boolean; running: boolean; run_generation: number; state: Record<string, unknown>; event_seq: number; placement: Record<string, unknown>; created_at: string; used_at: string; updated_at: string }
const panel = (id: string, app: string, label: string, open: boolean, running: boolean, at: string): Panel => ({ id, app, label, rev: 1, open, running, run_generation: 1, state: {}, event_seq: 0,
  placement: { mode: 'float', x: 40, y: 40, width: 360, height: 280 }, created_at: at, used_at: at, updated_at: at })
const app = (id: string, name: string, created_at: string) => ({ id, name, description: name + ' app', rev: 1, permission_rev: 1, width: 320, height: 240, capabilities: [], permissions: {}, created_by: 'maker', created_at, updated_at: created_at,
  definition: { name, description: name + ' app', html: '<p>x</p>', capabilities: [], width: 320, height: 240 }, is_new: false })

/** The engine as these surfaces read it. `notes` has one panel running hidden and one off, `clock` has one panel and it is off, `empty` has none. */
function engine(t: test.TestContext) {
  const apps = [app('notes', 'Notes', '2026-10-26T08:00:00Z'), app('clock', 'Clock', '2026-10-25T08:00:00Z'), app('empty', 'Empty', '2026-10-24T08:00:00Z')]
  const panels = [panel('one', 'notes', 'Panel 1', false, false, '2026-10-26T08:05:00Z'), panel('two', 'notes', 'Panel 2', false, true, '2026-10-26T08:06:00Z'),
    panel('tick', 'clock', 'Panel 1', false, false, '2026-10-25T08:05:00Z')]
  const original = globalThis.fetch
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  globalThis.fetch = (async (raw: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://local')
    const input = init?.method === 'POST' ? JSON.parse(String(init.body)) : JSON.parse(url.searchParams.get('request') ?? '{}')
    const one = () => panels.find(p => p.id === input.panel)!
    const recent = (id: string) => panels.filter(p => p.app === id).sort((a, b) => b.used_at.localeCompare(a.used_at))[0]
    let out: unknown
    if (input.action === 'refs') {
      out = {
        apps: (input.apps ?? []).map((id: string) => apps.find(a => a.id === id)).filter(Boolean).map((a: ReturnType<typeof app>) => ({ id: a.id, name: a.name, recent: recent(a.id)?.label ?? null,
          panels: panels.filter(p => p.app === a.id).length, running: panels.filter(p => p.app === a.id && p.running).length })),
        panels: (input.panels ?? []).map((id: string) => panels.find(p => p.id === id)).filter(Boolean).map((p: Panel) => ({ id: p.id, app: p.app, app_name: apps.find(a => a.id === p.app)!.name, label: p.label, open: p.open, running: p.running })),
      }
    } else if (input.action === 'list') {
      const all = input.kind === 'apps' ? apps : panels.filter(p => (input.open === undefined || p.open === input.open) && (input.running === undefined || p.running === input.running))
      out = { items: all, next_cursor: null, new_count: 0 }
    } else if (input.action === 'app_get') out = apps.find(a => a.id === input.app)
    else if (input.action === 'panel_get') out = one()
    else if (input.action === 'events') out = { events: [], next_cursor: null, oldest_retained: null }
    else if (input.action === 'runtime') out = { items: [], next_cursor: null }
    else if (input.action === 'session_close') out = { closed: true }
    else if (input.action === 'heartbeat') out = { stop: [], sample_epoch: 0 }
    else if (input.action === 'panel_stop') { const p = one(); p.running = false; p.open = false; p.rev++; out = p }
    else if (input.action === 'panel_start') { const p = one(); p.running = true; p.rev++; out = p }
    else throw Error('Unexpected ' + input.action)
    return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original; delete (document as unknown as Record<string, unknown>).hidden })
  return { apps, panels }
}

function Surface({ slug, text, markdown }: { slug: string; text: string; markdown?: boolean }) {
  const agents = useMemo(() => new Map<string, unknown>(), [])
  const refs = useRefRoutes(slug, agents, {})
  return markdown ? <RefMdBody className="md" html={md(text)} world={refs.world} onOpen={refs.onOpen} />
    : <p className="prose"><RefProse text={text} world={refs.world} onOpen={refs.onOpen} /></p>
}
/** what each app or panel chip of the surface shows, in document order: its flare classes and its hover text */
const chipsOf = (el: Element) => [...el.querySelectorAll<HTMLElement>('.ref-chip.ref-app, .ref-chip.ref-panel')].map(c => ({
  text: (c.textContent ?? '').slice(0, 24), flare: [...c.classList].filter(k => k === 'ref-flare' || k === 'run-on' || k === 'run-dead').join(' '), title: c.title }))

const TEXT = (slug: string) => `@app:${slug}/notes @app:${slug}/clock @app:${slug}/empty @panel:${slug}/two @panel:${slug}/one @panel:${slug}/gone`
const EXPECT = [
  { text: 'Notes', flare: 'ref-flare run-on', title: 'Running · Open Panel 2' },
  { text: 'Clock', flare: 'ref-flare run-dead', title: 'Off · Open Panel 1' },
  { text: 'Empty', flare: '', title: 'Create a panel for Empty' },
  { text: 'Notes · Panel 2', flare: 'ref-flare run-on', title: 'Running · hidden' },
  { text: 'Notes · Panel 1', flare: 'ref-flare run-dead', title: 'Off' },
]

test('§1 an @app: / @panel: chip is running, dead (dark grey) or none, in React and in Markdown; a missing target stays unresolved', async t => {
  const slug = 'run-chips'
  engine(t)
  const view = await mountView(<><div className="react"><Surface slug={slug} text={TEXT(slug)} /></div><div className="markdown"><Surface slug={slug} text={TEXT(slug)} markdown /></div></>, el => el)
  t.after(() => view.unmount())
  await inAct(tick)
  for (const where of ['react', 'markdown']) {
    const chips = chipsOf(view.el.querySelector('.' + where)!)
    assert.deepEqual(chips.slice(0, 5), EXPECT, `${where}: running, dead and none`)
    assert.equal(chips[5]!.flare, '', `${where}: a panel that is not there has no state`)
    assert.ok(view.el.querySelector(`.${where} .ref-chip.ref-panel.ref-absent`), `${where}: it stays an unresolved reference`)
  }
})

test('§2 the chips follow the org\'s live apps frame as panels start and stop', async t => {
  const slug = 'run-live', e = engine(t)
  const view = await mountView(<Surface slug={slug} text={TEXT(slug)} />, el => el)
  t.after(() => view.unmount())
  await inAct(tick)
  const flares = () => chipsOf(view.el).slice(0, 5).map(c => c.flare.replace('ref-flare ', '') || 'none')
  assert.deepEqual(flares(), ['run-on', 'run-dead', 'none', 'run-on', 'run-dead'])
  e.panels[1]!.running = false                                  // the last running panel of Notes stops
  await inAct(async () => { assert.equal(customAppsFeed(slug, { type: 'custom_apps_changed' }), true); await tick() })
  assert.deepEqual(flares(), ['run-dead', 'run-dead', 'none', 'run-dead', 'run-dead'], 'the app is dead once its last panel stopped')
  e.panels[0]!.running = true                                   // another one starts
  await inAct(async () => { customAppsFeed(slug, { type: 'custom_apps_changed' }); await tick() })
  assert.deepEqual(flares(), ['run-on', 'run-dead', 'none', 'run-dead', 'run-on'])
})

test('§3 the Apps list\'s app rows show the same three states, and follow a power change', async t => {
  const slug = 'run-list', e = engine(t)
  const view = await mountView(<><AppsButton slug={slug} /><AppsWorkspace slug={slug} /></>, el => el)
  t.after(() => view.unmount())
  await inAct(tick)
  await inAct(async () => { view.el.querySelector<HTMLButtonElement>('.apps-button')!.click(); await tick() })
  const state = () => Object.fromEntries([...document.querySelectorAll<HTMLElement>('.custom-apps-menu-group')].map(g => [g.querySelector('.custom-apps-open b')!.textContent,
    [...(g.querySelector('.custom-apps-menu-app')?.classList ?? [])].filter(k => k === 'run-on' || k === 'run-dead').join('') || 'none']))
  const panelRows = () => Object.fromEntries([...document.querySelectorAll<HTMLElement>('.custom-apps-saved-row')].map(r => [r.textContent!.trim().slice(0, 7) + '/' + r.closest('.custom-apps-menu-group')!.querySelector('.custom-apps-open b')!.textContent,
    [...r.classList].filter(k => k === 'run-on' || k === 'run-dead').join('') || 'none']))
  assert.equal(document.querySelector('.custom-app-state.run-on, .custom-app-state.run-dead, .custom-apps-menu .custom-app-dot.run-on'), null, 'no dot')
  assert.deepEqual(state(), { Notes: 'run-on', Clock: 'run-dead', Empty: 'none' })
  assert.deepEqual(panelRows(), { 'Panel 1/Notes': 'run-dead', 'Panel 2/Notes': 'run-on', 'Panel 1/Clock': 'run-dead' }, 'the panel rows follow their own run state')
  await inAct(async () => { document.querySelector<HTMLButtonElement>('[aria-label="Power off Panel 2"]')!.click(); await tick() })
  assert.equal(e.panels[1]!.running, false)
  await inAct(async () => { customAppsFeed(slug, { type: 'custom_apps_changed' }); await tick() })
  assert.deepEqual(state(), { Notes: 'run-dead', Clock: 'run-dead', Empty: 'none' }, 'powering off the last running panel turns the app dark grey')
})

test('§4 the stylesheet draws the run state as the unread edge (one rule), accent for running, dark grey for dead, no background', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const body = (selector: string) => { const at = css.indexOf(selector + ' {') >= 0 ? css.indexOf(selector + ' {') : css.indexOf(selector + ', '); return at < 0 ? '' : css.slice(at, css.indexOf('}', at)) }   // the run-state token rules are shared with the Apps rows (appsrunedge)
  assert.doesNotMatch(css, /\.ref-flare[^{]*\.run-(on|dead)[^{]*::before/, 'no dot before the chip')
  const edge = body(':is(.ref-chip.ref-chip, .docket-modal .docket-ref.docket-ref).ref-flare')
  assert.match(edge, /box-shadow:\s*inset 3px 0 0 var\(--ref-flare-color/, 'the one edge rule (the unread edge) draws it')
  assert.doesNotMatch(css, /:not\(\.run-on, \.run-dead\)/, 'the edge rule no longer skips the run states: they reuse it')
  assert.match(body('.ref-flare.run-on'), /--ref-flare-color:\s*var\(--accent\)/, 'running: the provider-tinted accent')
  assert.match(body('.ref-flare.run-dead'), /--ref-flare-color:\s*color-mix\(in srgb, var\(--dim\) \d+%, black\)/, 'dead: a dark grey of the theme')
  assert.doesNotMatch(body('.ref-flare.run-on') + body('.ref-flare.run-dead'), /background|box-shadow|padding/, 'a run state sets only its edge colour: no fill, no second edge, no own padding')
  assert.match(css, /\.ref-flare:is\(\.doc-new, \.mail-new\)\s*\{\s*--ref-flare-color:\s*var\(--accent\)/, 'unread shares the run edge colour, the provider-tinted accent')
  const apps = readFileSync(path.join(__SRC_DIR__, 'canvas', 'apps', 'apps.css'), 'utf8').replace(/\r\n/g, '\n')
  assert.doesNotMatch(apps, /\.custom-app-state\.run-/, 'the app row has no dot any more')
  // 2026-11-03 (USER mc25f7c358e7b "No marking"): Apps rows carry no run-state styling at all (appsrunedge.test.tsx)
  assert.doesNotMatch(apps, /\.custom-apps-(menu-app|saved-row)\.run-/)
})
