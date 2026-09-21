// Per-organization MAIN WINDOW placement: the v2 -> v3 file migration, per-org
// lookup, and the reuse of the existing monitor-fit behavior. Popout geometry
// and the open-panel set are the renderer's (see the module header); nothing
// here stores them, and that division is asserted at the end of this file.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-org-placement-test-'))
const req = createRequire(import.meta.url)
async function load(entry, name) {
  const out = path.join(temp, name + '.cjs')
  await build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'cjs' })
  return req(out)
}
const { OrgPlacement, migratePlacementFile, placementKey, orgOfKey, HOMEPAGE_KEY } =
  await load('apps/desktop/main/org-placement.ts', 'org-placement')
const { fitWindow } = await load('apps/desktop/main/window-placement.ts', 'window-placement')

const SCREEN = [{ x: 0, y: 0, width: 1920, height: 1080 }]
const bounds = (x, y, width = 800, height = 600) => ({ x, y, width, height })
const placement = (x, y, maximized = false) => ({ bounds: bounds(x, y), maximized })
const fakeWindow = (saved, { minimized = false, destroyed = false } = {}) => ({
  isDestroyed: () => destroyed,
  isMinimized: () => minimized,
  isMaximized: () => saved.maximized,
  getNormalBounds: () => saved.bounds,
})
let files = 0
const newFile = () => path.join(temp, `placement-${++files}.json`)

// ----------------------------------------------------------------- migration

test('the v2 single-placement file becomes the default geometry, not a discarded file', () => {
  const migrated = migratePlacementFile({ bounds: bounds(100, 50), maximized: true })
  assert.deepEqual(migrated, { version: 2, default: { bounds: bounds(100, 50), maximized: true }, windows: [] })
})

test('a damaged or absent file produces an empty schema rather than an exception', () => {
  for (const raw of [undefined, null, 'nonsense', 42, [], {}, { bounds: { x: 'a' }, maximized: true }, { bounds: bounds(1, 1), maximized: 'yes' }]) {
    assert.deepEqual(migratePlacementFile(raw), { version: 2, windows: [] }, JSON.stringify(raw))
  }
})

test('a v3 file keeps only entries that are actually usable', () => {
  const migrated = migratePlacementFile({
    version: 2,
    default: { bounds: bounds(0, 0), maximized: false },
    windows: [
      { key: 'org:acme', placement: placement(10, 10) },
      { key: '', placement: placement(10, 10) },              // no key
      { key: 'org:beta', placement: { bounds: bounds(0, 0, 0, 5), maximized: false } },  // zero width
      'not an object',
    ],
    // a popout section written by an older draft of this schema is dropped:
    // that fact belongs to the renderer now and native must not carry a copy
    popouts: [{ org: 'acme', name: 'desk-1', placement: placement(20, 20) }],
  })
  assert.deepEqual(migrated.windows, [{ key: 'org:acme', placement: placement(10, 10) }])
  assert.equal('popouts' in migrated, false)
  assert.deepEqual(migrated.default, { bounds: bounds(0, 0), maximized: false })
})

test('a real v2 file on disk is migrated on first read and the position survives', () => {
  const file = newFile()
  fs.writeFileSync(file, JSON.stringify({ bounds: bounds(300, 200), maximized: false }))
  const store = new OrgPlacement(file)
  assert.deepEqual(store.restoreWindow('org:acme', SCREEN), { bounds: bounds(300, 200), maximized: false },
    'an organization with no record of its own starts where the old single window was')
})

// --------------------------------------------------------------------- keys

test('only restorable windows have a placement key', () => {
  assert.equal(placementKey({ kind: 'org', org: 'acme' }), 'org:acme')
  assert.equal(placementKey({ kind: 'homepage' }), HOMEPAGE_KEY)
  assert.equal(placementKey({ kind: 'create' }), undefined, 'a creation draft is never persisted')
  assert.equal(orgOfKey('org:acme'), 'acme')
  assert.equal(orgOfKey(HOMEPAGE_KEY), undefined)
})

// ------------------------------------------------------------ per-org state

test('each organization keeps its own window position, independently', () => {
  const file = newFile()
  const store = new OrgPlacement(file)
  store.captureWindow('org:acme', fakeWindow(placement(10, 10)))
  store.captureWindow('org:beta', fakeWindow(placement(800, 400, true)))
  store.captureWindow(HOMEPAGE_KEY, fakeWindow(placement(200, 200)))

  const reopened = new OrgPlacement(file)
  assert.deepEqual(reopened.restoreWindow('org:acme', SCREEN), placement(10, 10))
  assert.deepEqual(reopened.restoreWindow('org:beta', SCREEN), placement(800, 400, true))
  assert.deepEqual(reopened.restoreWindow(HOMEPAGE_KEY, SCREEN), placement(200, 200))
  assert.deepEqual(reopened.savedWindows().map(entry => entry.key), ['org:acme', 'org:beta', HOMEPAGE_KEY],
    'restore order is the order they were saved in')
})

test('an organization that is gone leaves nothing behind to restore', () => {
  const file = newFile()
  const store = new OrgPlacement(file)
  store.captureWindow('org:acme', fakeWindow(placement(10, 10)))
  store.captureWindow('org:beta', fakeWindow(placement(50, 50)))
  store.forgetOrg('acme')
  const reopened = new OrgPlacement(file)
  assert.deepEqual(reopened.savedWindows().map(entry => entry.key), ['org:beta'])
})

// ------------------------------------------------------- existing behaviors

test('restoring reuses the existing monitor-fit behavior, with no algorithm of its own', () => {
  const file = newFile()
  const store = new OrgPlacement(file)
  // saved on a second monitor that is no longer attached
  store.captureWindow('org:acme', fakeWindow({ bounds: bounds(3000, 200), maximized: false }))
  const restored = new OrgPlacement(file).restoreWindow('org:acme', SCREEN)
  assert.deepEqual(restored.bounds, fitWindow(bounds(3000, 200), SCREEN),
    "the answer is fitWindow's, verbatim")
  assert.equal(restored.bounds.x + restored.bounds.width <= 1920, true, 'and it lands on the screen that exists')
})

test('a minimized or destroyed window is not captured, exactly as before', () => {
  const file = newFile()
  const store = new OrgPlacement(file)
  store.captureWindow('org:acme', fakeWindow(placement(10, 10), { minimized: true }))
  store.captureWindow('org:beta', fakeWindow(placement(10, 10), { destroyed: true }))
  assert.deepEqual(new OrgPlacement(file).savedWindows(), [])
})

test('an unchanged position does not rewrite the file', () => {
  const file = newFile()
  const store = new OrgPlacement(file)
  store.captureWindow('org:acme', fakeWindow(placement(10, 10)))
  const first = fs.statSync(file).mtimeMs
  const bytes = fs.readFileSync(file, 'utf8')
  store.captureWindow('org:acme', fakeWindow(placement(10, 10)))
  assert.equal(fs.readFileSync(file, 'utf8'), bytes)
  assert.equal(fs.statSync(file).mtimeMs, first)
})

test('native stores no popout geometry at all, by agreement with the shell owner', () => {
  // The ownership split agreed 2026-09-21: the renderer already keys its own
  // store by [org, kind] and shares it across every window of this origin, so
  // a native copy would be a second writer for one fact. This asserts the
  // ABSENCE, because a quietly reintroduced native popout store is exactly the
  // regression the split exists to prevent.
  for (const name of ['capturePopout', 'restorePopout', 'savedPopouts', 'forgetPopout', 'rememberOpenPopouts']) {
    assert.equal(name in OrgPlacement.prototype, false, name)
  }
  const file = newFile()
  const store = new OrgPlacement(file)
  store.captureWindow('org:acme', fakeWindow(placement(10, 10)))
  assert.equal(fs.readFileSync(file, 'utf8').includes('popout'), false)
})
