import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { WatchdogPanel } from '../src/canvas/modals'
import { watchdogTitle } from '../src/canvas/watchdogtitle'
import { watchdogGlyph, watchdogKindClass } from '../src/canvas/watchdogchip'
import type { Watchdog } from '../src/types'

// USER 2026-10-27 (m7a692fd13b1d): an app event watchdog shows that it is the
// app event type, which app, which panel and which event; names first, IDs
// secondary, and a deleted app or panel says so.
const noop = () => {}
const single = { id: 'liaison/caption-placements-test', owner: 'liaison', name: 'caption-placements-test',
  kind: 'app_listener', target: 'app-cap', state: 'armed', interval_s: 0, fired: 0, once: false, spent: false,
  at: '2026-10-27T07:00:00Z', events: [], event_name: 'placements.submitted', panel: 'panel-school', all_panels: false,
  app_name: 'Caption placement (events)', panel_name: 'Orgtree School 1 captions' } as unknown as Watchdog
const every = { ...single, id: 'liaison/every-copy', name: 'every-copy', panel: undefined, all_panels: true, panel_name: undefined } as unknown as Watchdog

async function panel(dog: Watchdog) {
  return mountView(<WatchdogPanel slug="synthetic" dog={dog} toast={noop} close={noop} />, host => host)
}
/** The value chip after a detail field label, by label text. */
function field(el: HTMLElement, label: string) {
  const heading = Array.from(el.querySelectorAll('.field-label')).find(node => node.textContent === label)
  assert.ok(heading, `field "${label}" is shown`)
  return heading.nextElementSibling as HTMLElement
}

test('a single-panel app event watchdog names its type, app, panel and event, IDs secondary', async t => {
  const view = await panel(single)
  t.after(() => view.unmount())
  assert.equal(view.el.querySelector('.wd-type')?.textContent, 'App event listener')
  const summary = view.el.querySelector('.wd-description')?.textContent ?? ''
  assert.match(summary, /placements\.submitted/)
  assert.match(summary, /Orgtree School 1 captions/)
  assert.match(summary, /Caption placement \(events\)/)
  assert.match(summary, /wakes liaison/)
  const app = field(view.el, 'app'), panelRow = field(view.el, 'panel'), event = field(view.el, 'event')
  assert.match(app.textContent ?? '', /^Caption placement \(events\)/, 'the app name leads')
  assert.equal(app.querySelector('.wd-source-id')?.textContent, 'app-cap', 'the app ID is secondary')
  assert.match(panelRow.textContent ?? '', /^Orgtree School 1 captions/, 'the panel name leads')
  assert.equal(panelRow.querySelector('.wd-source-id')?.textContent, 'panel-school')
  assert.equal(event.textContent, 'placements.submitted')
  assert.equal(Array.from(view.el.querySelectorAll('.wd-cmd')).some(node => node.textContent === 'app-cap'), false,
    'the raw app ID is no longer the target line')
})

test('an all-panels app event watchdog says all panels', async t => {
  const view = await panel(every)
  t.after(() => view.unmount())
  assert.equal(view.el.querySelector('.wd-type')?.textContent, 'App event listener')
  assert.match(view.el.querySelector('.wd-description')?.textContent ?? '', /every panel of the app “Caption placement \(events\)”, including panels added later/)
  const panelRow = field(view.el, 'panel')
  assert.match(panelRow.textContent ?? '', /^all panels/)
  assert.equal(panelRow.querySelector('.wd-source-id'), null, 'no panel ID for every copy')
})

test('a deleted app or panel says so, with its ID; unresolved names fall back to IDs', async t => {
  const gone = { ...single, app_name: undefined, panel_name: undefined, app_deleted: true, panel_deleted: true, state: 'paused' } as unknown as Watchdog
  let view = await panel(gone)
  try {
    assert.match(field(view.el, 'app').textContent ?? '', /^deleted app/)
    assert.equal(field(view.el, 'app').querySelector('.wd-source-id')?.textContent, 'app-cap')
    assert.match(field(view.el, 'panel').textContent ?? '', /^deleted panel/)
    assert.match(view.el.querySelector('.wd-description')?.textContent ?? '', /a deleted panel of a deleted app/)
  } finally { await view.unmount() }
  const unresolved = { ...single, app_name: undefined, panel_name: undefined } as unknown as Watchdog
  view = await panel(unresolved)
  try {
    assert.match(field(view.el, 'app').textContent ?? '', /^app-cap/, 'an unknown name never claims deletion')
    assert.doesNotMatch(view.el.textContent ?? '', /deleted/)
  } finally { await view.unmount() }
})

test('every chip marks the app event type and its tooltip names app, panel and event', () => {
  assert.equal(watchdogTitle(single), 'watchdog "caption-placements-test" (app event · app "Caption placement (events)" · panel "Orgtree School 1 captions" · event "placements.submitted") — armed; continuous')
  assert.equal(watchdogTitle(every), 'watchdog "every-copy" (app event · app "Caption placement (events)" · all panels · event "placements.submitted") — armed; continuous')
  assert.equal(watchdogGlyph(single), '▦', 'armed app event dogs wear the Apps grid glyph')
  assert.equal(watchdogGlyph({ ...single, state: 'paused' }), '◫', 'state glyphs still win')
  assert.match(watchdogKindClass(single), /\bapp-listener\b/)
})
