// changelog-launch.test.mjs — the desktop's "first launch after an update"
// (apps/desktop/main/changelog-launch.ts; docket
// changelog-window-one-row-per-version-pinnable-po, USER 2026-10-24 22:13:55Z:
// "opens automatically after an update on first launch (not on fresh install)").
// The Changelog lists only published releases (USER 2026-10-25 09:01:38Z
// "Published only"), so it opens when it lists a newer one than this install
// last saw, not when the running version changes (coordinator m4455f7a604f2):
// an update between two local alphas that brings no newly published release
// opens nothing.
//
// The record lives in a temporary folder of its own; nothing reads or writes
// any real application data.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-changelog-launch-'))
const outfile = path.join(root, 'changelog-launch.cjs')
await build({ entryPoints: [path.join(repo, 'apps/desktop/main/changelog-launch.ts')], outfile, bundle: true,
  format: 'cjs', platform: 'node' })
const { changelogAfterLaunch, ChangelogLaunch, CHANGELOG_SEEN_FILE, newestListed } = createRequire(import.meta.url)(outfile)
test.after(() => fs.rmSync(root, { recursive: true, force: true }))

/** docs/releases.json's shape: the published releases, newest first */
const release = (version) => ({ version, published_at: '2026-10-24T05:23:13Z', tagged_at: '2026-10-24T02:58:37Z' })
const LIST = { releases: [release('4.4.4'), release('4.4.3')] }
const WITH_445 = { releases: [release('4.4.5'), ...LIST.releases] }

let n = 0
/** a fresh folder for one launch history; `seen` is what an earlier launch recorded */
const folder = (seen) => {
  const dir = path.join(root, `case-${++n}`)
  fs.mkdirSync(dir)
  const file = path.join(dir, CHANGELOG_SEEN_FILE)
  if (seen !== undefined) fs.writeFileSync(file, seen)
  return { file, read: () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).version : null }
}
const recorded = (version) => JSON.stringify({ version })

test('the newest version the Changelog lists: its newest published release, or a release build itself', () => {
  assert.equal(newestListed(LIST, '4.4.5-alpha.6'), '4.4.4', 'a local alpha lists only published releases')
  assert.equal(newestListed(LIST, '4.4.5'), '4.4.5', 'a release is built before it is published: its own build lists it')
  assert.equal(newestListed(LIST, '4.4.4'), '4.4.4')
  assert.equal(newestListed(WITH_445, '4.4.6-alpha.1'), '4.4.5')
  assert.equal(newestListed({ releases: [] }, '4.4.5-alpha.6'), null, 'nothing listed')
  assert.equal(newestListed(null, '4.4.5'), '4.4.5')
  assert.equal(newestListed({ releases: [{ version: 'junk' }, 7, null, { version: '4.4.5-alpha.2' }] }, '4.4.5-alpha.6'),
    null, 'entries that are no published version are skipped')
  // this checkout's own list, which the desktop bundles (main/index.ts)
  const own = JSON.parse(fs.readFileSync(path.join(repo, 'docs/releases.json'), 'utf8'))
  assert.equal(newestListed(own, '99.0.0-alpha.1'), own.releases[0].version)
})

test('the decision: a newer listed release than the one on record, or earlier runs and no record', () => {
  assert.equal(changelogAfterLaunch(null, '4.4.5', false), null, 'a fresh install opens nothing')
  assert.deepEqual(changelogAfterLaunch(null, '4.4.5', true), { from: null, to: '4.4.5' },
    'earlier runs and no record: an update from 4.4.4 or before, which kept none')
  assert.deepEqual(changelogAfterLaunch('4.4.4', '4.4.5', true), { from: '4.4.4', to: '4.4.5' })
  assert.deepEqual(changelogAfterLaunch('4.4.5-alpha.5', '4.4.5', true), { from: '4.4.5-alpha.5', to: '4.4.5' },
    'a release follows its own pre-releases (alpha.5 recorded the version it ran)')
  assert.equal(changelogAfterLaunch('4.4.5-alpha.5', '4.4.4', true), null,
    'a later alpha: 4.4.4 is still the newest published release, and alpha.5 listed it')
  assert.equal(changelogAfterLaunch('4.4.4', '4.4.4', true), null, 'no newly published release')
  assert.equal(changelogAfterLaunch('4.4.6', '4.4.5', true), null, 'a downgrade')
  assert.equal(changelogAfterLaunch('not a version', '4.4.5', true), null, 'a record that cannot be ordered')
  assert.equal(changelogAfterLaunch('4.4.4', null, true), null, 'a build that lists nothing')
})

test('an update between local alphas that lists no newer published release opens nothing', () => {
  const f = folder(recorded('4.4.5-alpha.5')) // what alpha.5 recorded: the version it ran
  assert.equal(new ChangelogLaunch(f.file, LIST, '4.4.5-alpha.6', true).take(), null)
  assert.equal(f.read(), '4.4.5-alpha.5', 'the record is kept, never lowered')
  const g = folder(recorded('4.4.4'))
  assert.equal(new ChangelogLaunch(g.file, LIST, '4.4.5-alpha.7', true).take(), null, '4.4.4 seen, 4.4.4 the newest')
  assert.equal(g.read(), '4.4.4')
  assert.deepEqual(new ChangelogLaunch(f.file, LIST, '4.4.5', true).take(), { from: '4.4.5-alpha.5', to: '4.4.5' },
    'the release itself is new')
  assert.equal(f.read(), '4.4.5')
})

test('an alpha whose list gained a published release opens on that release', () => {
  const f = folder(recorded('4.4.4'))
  assert.deepEqual(new ChangelogLaunch(f.file, WITH_445, '4.4.6-alpha.1', true).take(), { from: '4.4.4', to: '4.4.5' })
  assert.equal(f.read(), '4.4.5')
  assert.equal(new ChangelogLaunch(f.file, WITH_445, '4.4.6-alpha.2', true).take(), null, 'the next alpha')
})

test('a fresh install records the newest listed release and tells no window, now or at the next launch', () => {
  const f = folder()
  const launch = new ChangelogLaunch(f.file, LIST, '4.4.5-alpha.6', false)
  assert.equal(f.read(), '4.4.4', 'recorded at startup')
  assert.equal(launch.take(), null)
  assert.equal(new ChangelogLaunch(f.file, LIST, '4.4.5-alpha.6', true).take(), null, 'the next launch of it')
  assert.deepEqual(new ChangelogLaunch(f.file, LIST, '4.4.5', true).take(), { from: '4.4.4', to: '4.4.5' },
    'the release after it')
})

test('the first launch after an update tells the first window once, and records it only then', () => {
  const f = folder(recorded('4.4.4'))
  new ChangelogLaunch(f.file, LIST, '4.4.5', true) // a launch whose windows never asked (started in the background)
  assert.equal(f.read(), '4.4.4', 'not recorded before a window has taken it')
  const launch = new ChangelogLaunch(f.file, LIST, '4.4.5', true)
  assert.deepEqual(launch.take(), { from: '4.4.4', to: '4.4.5' }, 'so the next launch still tells its first window')
  assert.equal(f.read(), '4.4.5')
  assert.equal(launch.take(), null, 'a later window of the same launch')
  assert.equal(new ChangelogLaunch(f.file, LIST, '4.4.5', true).take(), null, 'a later launch')
})

test('an update from a build that kept no record is told; a damaged record reads as none', () => {
  const none = folder()
  assert.deepEqual(new ChangelogLaunch(none.file, LIST, '4.4.5', true).take(), { from: null, to: '4.4.5' })
  assert.equal(none.read(), '4.4.5')
  const damaged = folder('{"version":')
  assert.deepEqual(new ChangelogLaunch(damaged.file, LIST, '4.4.5', true).take(), { from: null, to: '4.4.5' })
  const foreign = folder(JSON.stringify(['4.4.4']))
  assert.equal(new ChangelogLaunch(foreign.file, LIST, '4.4.5', false).take(), null,
    'a foreign record on a machine with no earlier run is still a fresh install')
  const odd = folder(recorded('not a version'))
  assert.equal(new ChangelogLaunch(odd.file, LIST, '4.4.5', true).take(), null, 'a record that cannot be ordered')
  assert.equal(odd.read(), '4.4.5', '...is replaced by the newest listed release')
  const empty = folder()
  assert.equal(new ChangelogLaunch(empty.file, { releases: [] }, '4.4.5-alpha.6', true).take(), null,
    'a build that lists nothing has nothing to tell')
  assert.equal(empty.read(), null, 'or to record')
})

test('a downgrade opens nothing and keeps the record, so going back up opens nothing either', () => {
  const f = folder(recorded('4.4.6'))
  assert.equal(new ChangelogLaunch(f.file, LIST, '4.4.5', true).take(), null)
  assert.equal(f.read(), '4.4.6', 'the newest release this install listed stays on record')
  const with446 = { releases: [release('4.4.6'), ...WITH_445.releases] }
  assert.equal(new ChangelogLaunch(f.file, with446, '4.4.6', true).take(), null, 'already listed here before')
})

test('a record that cannot be written never stops the launch', () => {
  const dir = path.join(root, `blocked-${++n}`)
  fs.mkdirSync(dir)
  // the record's own path is a folder, so neither the temporary file's rename nor a read can succeed
  const file = path.join(dir, CHANGELOG_SEEN_FILE)
  fs.mkdirSync(file)
  const launch = new ChangelogLaunch(file, LIST, '4.4.5', true)
  assert.deepEqual(launch.take(), { from: null, to: '4.4.5' })
  assert.equal(launch.take(), null, 'still told only once')
})
