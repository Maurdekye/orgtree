// release-list.test.mjs — docs/releases.json, the Changelog's list of published
// releases (docket changelog-window-one-row-per-version-pinnable-po). The engine
// bundles it with docs/release-notes-<version>.md (engine/rs/orgtree-engine/src/
// changelog.rs); docs/ci-release.md says when a release is added.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => fs.readFileSync(path.join(repo, relative), 'utf8')
const list = JSON.parse(read('docs/releases.json'))
const FINAL = /^\d+\.\d+\.\d+$/
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const cmp = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}
const notesFiles = fs.readdirSync(path.join(repo, 'docs'))
  .map((name) => /^release-notes-(.+)\.md$/.exec(name)?.[1]).filter(Boolean)

test('every listed release is a final version with its notes, two UTC times, newest first, once', () => {
  assert.ok(Array.isArray(list.releases) && list.releases.length >= 52, 'the 52 releases published before the panel')
  const seen = new Set()
  for (const [i, r] of list.releases.entries()) {
    assert.deepEqual(Object.keys(r).sort(), ['published_at', 'tagged_at', 'version'], JSON.stringify(r))
    assert.match(r.version, FINAL, 'a final version: GitHub pre-releases stay out')
    assert.ok(!seen.has(r.version), `${r.version} is listed twice`)
    seen.add(r.version)
    assert.match(r.published_at, UTC, `${r.version} published_at`)
    assert.match(r.tagged_at, UTC, `${r.version} tagged_at`)
    assert.ok(Date.parse(r.tagged_at) <= Date.parse(r.published_at), `${r.version}: tagged after it was published`)
    assert.ok(notesFiles.includes(r.version), `${r.version} has no docs/release-notes-${r.version}.md`)
    assert.ok(read(`docs/release-notes-${r.version}.md`).trim().length > 0, `${r.version}: empty notes`)
    if (i > 0) assert.ok(cmp(list.releases[i - 1].version, r.version) > 0, `${r.version} is out of order`)
  }
})

test('a final release older than the version in development is listed once it has notes', () => {
  const developing = JSON.parse(read('package.json')).version.split(/[-+]/)[0]
  const listed = new Set(list.releases.map((r) => r.version))
  const missing = notesFiles.filter((v) => FINAL.test(v) && cmp(v, developing) < 0 && !listed.has(v))
  assert.deepEqual(missing, [], `released notes not in docs/releases.json (docs/ci-release.md, "Add it to the Changelog")`)
})
