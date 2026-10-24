// changelog-launch.test.mjs — the desktop's "first launch after an update"
// (apps/desktop/main/changelog-launch.ts; docket
// changelog-window-one-row-per-version-pinnable-po, USER 2026-10-24 22:13:55Z:
// "opens automatically after an update on first launch (not on fresh install)").
//
// The record lives in a temporary folder of its own; nothing reads or writes
// any real application data.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-changelog-launch-'))
const outfile = path.join(root, 'changelog-launch.cjs')
await build({ entryPoints: ['apps/desktop/main/changelog-launch.ts'], outfile, bundle: true, format: 'cjs', platform: 'node' })
const { changelogAfterLaunch, ChangelogLaunch, CHANGELOG_SEEN_FILE } = createRequire(import.meta.url)(outfile)
test.after(() => fs.rmSync(root, { recursive: true, force: true }))

let n = 0
/** a fresh folder for one launch history; `seen` is what an earlier launch recorded */
const folder = (seen) => {
  const dir = path.join(root, `case-${++n}`)
  fs.mkdirSync(dir)
  const file = path.join(dir, CHANGELOG_SEEN_FILE)
  if (seen !== undefined) fs.writeFileSync(file, seen)
  return { file, read: () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).version : null }
}

test('the decision: an update is a newer version than the one on record, or earlier runs and no record', () => {
  assert.equal(changelogAfterLaunch(null, '4.4.5', false), null, 'a fresh install opens nothing')
  assert.deepEqual(changelogAfterLaunch(null, '4.4.5', true), { from: null, to: '4.4.5' },
    'earlier runs and no record: an update from a version before the record existed')
  assert.deepEqual(changelogAfterLaunch('4.4.4', '4.4.5', true), { from: '4.4.4', to: '4.4.5' })
  assert.deepEqual(changelogAfterLaunch('4.4.5-alpha.3', '4.4.5-alpha.4', true), { from: '4.4.5-alpha.3', to: '4.4.5-alpha.4' })
  assert.deepEqual(changelogAfterLaunch('4.4.5-alpha.4', '4.4.5', true), { from: '4.4.5-alpha.4', to: '4.4.5' },
    'a release follows its own pre-releases')
  assert.equal(changelogAfterLaunch('4.4.5', '4.4.5', true), null, 'the same version again')
  assert.equal(changelogAfterLaunch('4.4.5', '4.4.4', true), null, 'a downgrade')
  assert.equal(changelogAfterLaunch('not a version', '4.4.5', true), null, 'a record that cannot be ordered')
})

test('a fresh install records its version and tells no window, now or at the next launch', () => {
  const f = folder()
  const launch = new ChangelogLaunch(f.file, '4.4.5', false)
  assert.equal(f.read(), '4.4.5', 'recorded at startup')
  assert.equal(launch.take(), null)
  assert.equal(new ChangelogLaunch(f.file, '4.4.5', true).take(), null, 'the next launch of it')
})

test('the first launch after an update tells the first window once, and records it only then', () => {
  const f = folder(JSON.stringify({ version: '4.4.4' }))
  new ChangelogLaunch(f.file, '4.4.5', true) // a launch whose windows never asked (started in the background)
  assert.equal(f.read(), '4.4.4', 'not recorded before a window has taken it')
  const launch = new ChangelogLaunch(f.file, '4.4.5', true)
  assert.deepEqual(launch.take(), { from: '4.4.4', to: '4.4.5' }, 'so the next launch still tells its first window')
  assert.equal(f.read(), '4.4.5')
  assert.equal(launch.take(), null, 'a later window of the same launch')
  assert.equal(new ChangelogLaunch(f.file, '4.4.5', true).take(), null, 'a later launch')
})

test('an update from a build that kept no record is told too; a damaged record reads as none', () => {
  const none = folder()
  assert.deepEqual(new ChangelogLaunch(none.file, '4.4.5', true).take(), { from: null, to: '4.4.5' })
  assert.equal(none.read(), '4.4.5')
  const damaged = folder('{"version":')
  assert.deepEqual(new ChangelogLaunch(damaged.file, '4.4.5', true).take(), { from: null, to: '4.4.5' })
  const foreign = folder(JSON.stringify(['4.4.4']))
  assert.equal(new ChangelogLaunch(foreign.file, '4.4.5', false).take(), null,
    'a foreign record on a machine with no earlier run is still a fresh install')
})

test('a downgrade opens nothing and records the version it runs, so the upgrade back is told again', () => {
  const f = folder(JSON.stringify({ version: '4.4.6' }))
  assert.equal(new ChangelogLaunch(f.file, '4.4.5', true).take(), null)
  assert.equal(f.read(), '4.4.5')
  assert.deepEqual(new ChangelogLaunch(f.file, '4.4.6', true).take(), { from: '4.4.5', to: '4.4.6' })
})

test('a record that cannot be written never stops the launch', () => {
  const dir = path.join(root, `blocked-${++n}`)
  fs.mkdirSync(dir)
  // the record's own path is a folder, so neither the temporary file's rename nor a read can succeed
  const file = path.join(dir, CHANGELOG_SEEN_FILE)
  fs.mkdirSync(file)
  const launch = new ChangelogLaunch(file, '4.4.5', true)
  assert.deepEqual(launch.take(), { from: null, to: '4.4.5' })
  assert.equal(launch.take(), null, 'still told only once')
})
