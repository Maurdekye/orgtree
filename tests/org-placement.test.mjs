// Per-organization MAIN WINDOW placement.
//
// The property this file exists to protect is that GEOMETRY and MEMBERSHIP are
// two different facts. Geometry is where a window was, remembered indefinitely
// for anything ever positioned. Membership is the much smaller set startup
// actually reopens. Restoring from geometry would reopen every organization
// the user has ever visited, every launch — so most of the tests below are
// about keeping one from standing in for the other.
//
// Popout geometry and the open-panel set are the renderer's (see the module
// header); nothing here stores them, and that division is asserted at the end.
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
const { planRestore } = await load('apps/desktop/main/org-windows.ts', 'org-windows')

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
/** Open a window: remember where it is AND that it should reopen. */
const open = (store, key, at) => { store.captureWindow(key, fakeWindow(at)); store.openedWindow(key) }

// ----------------------------------------------------------------- migration

test('the v2 single-placement file becomes the default geometry, not a discarded file', () => {
  const migrated = migratePlacementFile({ bounds: bounds(100, 50), maximized: true })
  assert.deepEqual(migrated,
    { version: 2, default: { bounds: bounds(100, 50), maximized: true }, geometry: [], session: [] })
})

test('a damaged or absent file produces an empty schema rather than an exception', () => {
  for (const raw of [undefined, null, 'nonsense', 42, [], {}, { bounds: { x: 'a' }, maximized: true }, { bounds: bounds(1, 1), maximized: 'yes' }]) {
    assert.deepEqual(migratePlacementFile(raw), { version: 2, geometry: [], session: [] }, JSON.stringify(raw))
  }
})

test('a v3 file keeps only entries that are actually usable', () => {
  const migrated = migratePlacementFile({
    version: 2,
    default: { bounds: bounds(0, 0), maximized: false },
    geometry: [
      { key: 'org:acme', placement: placement(10, 10) },
      { key: '', placement: placement(10, 10) },                                       // no key
      { key: 'org:beta', placement: { bounds: bounds(0, 0, 0, 5), maximized: false } }, // zero width
      'not an object',
    ],
    session: ['org:acme', 'org:acme', 'org:beta', '', 42],
    // a popout section written by an older draft of this schema is dropped:
    // that fact belongs to the renderer now and native must not carry a copy
    popouts: [{ org: 'acme', name: 'desk-1', placement: placement(20, 20) }],
  })
  assert.deepEqual(migrated.geometry, [{ key: 'org:acme', placement: placement(10, 10) }])
  assert.deepEqual(migrated.session, ['org:acme'],
    'membership is de-duplicated and cannot name a window with no usable geometry')
  assert.equal('popouts' in migrated, false)
  assert.deepEqual(migrated.default, { bounds: bounds(0, 0), maximized: false })
})

test('an earlier draft that could not tell geometry from membership contributes NO membership', () => {
  // That draft stored one `windows` array and restoration read it directly,
  // which is the bug this split exists to fix. Reading it as "reopen all of
  // these" on upgrade would perform that bug once, at the worst moment.
  const migrated = migratePlacementFile({
    version: 2,
    windows: [{ key: 'org:acme', placement: placement(10, 10) }, { key: 'org:beta', placement: placement(20, 20) }],
  })
  assert.equal(migrated.geometry.length, 2, 'the positions are kept')
  assert.deepEqual(migrated.session, [], 'but nothing is reopened on the strength of them')
})

test('a real v2 file on disk is migrated on first read and the position survives', () => {
  const file = newFile()
  fs.writeFileSync(file, JSON.stringify({ bounds: bounds(300, 200), maximized: false }))
  const store = new OrgPlacement(file)
  assert.deepEqual(store.restoreWindow('org:acme', SCREEN), { bounds: bounds(300, 200), maximized: false },
    'an organization with no record of its own starts where the old single window was')
  assert.deepEqual(store.sessionWindows(), [], 'and one old rectangle does not mean "reopen something"')
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
  open(store, 'org:acme', placement(10, 10))
  open(store, 'org:beta', placement(800, 400, true))
  open(store, HOMEPAGE_KEY, placement(200, 200))

  const reopened = new OrgPlacement(file)
  assert.deepEqual(reopened.restoreWindow('org:acme', SCREEN), placement(10, 10))
  assert.deepEqual(reopened.restoreWindow('org:beta', SCREEN), placement(800, 400, true))
  assert.deepEqual(reopened.restoreWindow(HOMEPAGE_KEY, SCREEN), placement(200, 200))
  assert.deepEqual(reopened.sessionWindows(), ['org:acme', 'org:beta', HOMEPAGE_KEY],
    'and they reopen in the order they were opened')
})

// ------------------------------------------- geometry is not membership

test('NEGATIVE CONTROL: startup reopens what was open, not every organization ever positioned', () => {
  const file = newFile()
  const store = new OrgPlacement(file)
  open(store, 'org:acme', placement(10, 10))
  open(store, 'org:beta', placement(50, 50))
  open(store, 'org:gamma', placement(90, 90))
  store.closedWindow('org:beta')         // the user closed beta during the session

  const reopened = new OrgPlacement(file)
  assert.deepEqual(reopened.sessionWindows(), ['org:acme', 'org:gamma'])
  assert.equal(reopened.geometry().length, 3, 'all three positions are still remembered')
})

test('closing an organization drops it from the next startup but KEEPS where it was', () => {
  const file = newFile()
  const store = new OrgPlacement(file)
  open(store, 'org:acme', placement(120, 90, true))
  store.closedWindow('org:acme')

  const reopened = new OrgPlacement(file)
  assert.deepEqual(reopened.sessionWindows(), [], 'it does not come back on its own')
  assert.deepEqual(reopened.restoreWindow('org:acme', SCREEN), placement(120, 90, true),
    'but opening it by hand puts the window back where the user left it')
})

test('reopening a window already in the reopen set does not duplicate or reorder it', () => {
  const file = newFile()
  const store = new OrgPlacement(file)
  open(store, 'org:acme', placement(10, 10))
  open(store, 'org:beta', placement(50, 50))
  store.openedWindow('org:acme')
  assert.deepEqual(store.sessionWindows(), ['org:acme', 'org:beta'])
})

// ------------------------------------------------------------------ shutdown

test('a quit records the open set BEFORE teardown, and teardown cannot rewrite it', () => {
  const file = newFile()
  const store = new OrgPlacement(file)
  open(store, 'org:acme', placement(10, 10))
  open(store, 'org:beta', placement(50, 50))
  open(store, HOMEPAGE_KEY, placement(90, 90))

  // the quit captures what is open at this instant...
  store.beginShutdown(['org:acme', 'org:beta', HOMEPAGE_KEY])
  // ...and then teardown closes every one of them. Those closes are NOT the
  // user closing windows, and if they counted as such the next launch would
  // restore nothing at all.
  for (const key of ['org:acme', 'org:beta', HOMEPAGE_KEY]) store.closedWindow(key)

  const reopened = new OrgPlacement(file)
  assert.deepEqual(reopened.sessionWindows(), ['org:acme', 'org:beta', HOMEPAGE_KEY])
})

test('a window closed deliberately before the quit stays closed through it', () => {
  const file = newFile()
  const store = new OrgPlacement(file)
  open(store, 'org:acme', placement(10, 10))
  open(store, 'org:beta', placement(50, 50))
  store.closedWindow('org:beta')
  store.beginShutdown(['org:acme'])      // beta is genuinely not open any more
  store.closedWindow('org:acme')         // teardown
  assert.deepEqual(new OrgPlacement(file).sessionWindows(), ['org:acme'])
})

test('the shutdown capture is de-duplicated and ignores empty keys', () => {
  const file = newFile()
  const store = new OrgPlacement(file)
  open(store, 'org:acme', placement(10, 10))
  store.beginShutdown(['org:acme', 'org:acme', '', undefined])
  assert.deepEqual(new OrgPlacement(file).sessionWindows(), ['org:acme'])
})

// ------------------------------------------------- deletion vs unavailability

test('NEGATIVE CONTROL: planning a restore neither drops nor forgets anything', () => {
  // User ruling 2026-09-21: an organization that cannot be opened comes back as
  // its own window in the unavailable state, so identity, geometry and reopen
  // membership must all survive the launch that could not reach it. Recovery
  // in place is the whole point, and it needs the record intact.
  const file = newFile()
  const store = new OrgPlacement(file)
  open(store, 'org:acme', placement(10, 10))
  open(store, 'org:beta', placement(50, 50))

  const saved = store.sessionWindows().map(key => ({ org: orgOfKey(key) }))
  const plan = planRestore(saved)
  assert.deepEqual(plan.windows, [{ org: 'acme' }, { org: 'beta' }],
    'both reopen, whatever the catalog would have said about either')

  const untouched = new OrgPlacement(file)
  assert.deepEqual(untouched.sessionWindows(), ['org:acme', 'org:beta'])
  assert.deepEqual(untouched.restoreWindow('org:beta', SCREEN), placement(50, 50))
})

test('a really deleted organization leaves nothing behind', () => {
  const file = newFile()
  const store = new OrgPlacement(file)
  open(store, 'org:acme', placement(10, 10))
  open(store, 'org:beta', placement(50, 50))
  store.forgetDeletedOrg('acme')
  const reopened = new OrgPlacement(file)
  assert.deepEqual(reopened.sessionWindows(), ['org:beta'])
  assert.deepEqual(reopened.geometry().map(entry => entry.key), ['org:beta'])
  assert.equal(reopened.restoreWindow('org:acme', SCREEN), undefined, 'and no default stands in for it')
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
  assert.deepEqual(new OrgPlacement(file).geometry(), [])
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
  open(store, 'org:acme', placement(10, 10))
  assert.equal(fs.readFileSync(file, 'utf8').includes('popout'), false)
})
