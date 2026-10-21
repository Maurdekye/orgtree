import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const settingsFile = path.join(root, 'engine/rs/orgtree-engine/src/http/settings.rs')
const settings = readFileSync(settingsFile, 'utf8')
const bundled = settings.match(/const BUNDLED:[\s\S]*?= &\[([\s\S]*?)\];/)[1]
const entries = [...bundled.matchAll(/\("([^"]+)",\s*include_str!\("([^"]+)"\)\)/g)]

test('every shipped charter, including liaison, is registered with its actual content file', () => {
  const files = readdirSync(path.join(root, 'engine/docs/charters')).filter(f => f.endsWith('.md')).sort()
  const registered = entries.map(([, name]) => name).sort()
  assert.ok(registered.includes('liaison.md'), 'the liaison must be selectable and populatable')
  assert.deepEqual(registered, files, 'bundled lookup/population must offer every shipped charter exactly once')
  for (const [, name, relative] of entries) {
    assert.equal(path.resolve(path.dirname(settingsFile), relative), path.join(root, 'engine/docs/charters', name))
    assert.ok(readFileSync(path.resolve(path.dirname(settingsFile), relative), 'utf8').trim())
  }
})

test('whole-file preset introductions describe the role without manual charter-copy instructions', () => {
  for (const [, name, relative] of entries) {
    const content = readFileSync(path.resolve(path.dirname(settingsFile), relative), 'utf8')
    const intro = content.split(/\r?\n---\r?\n/, 1)[0]
    assert.doesNotMatch(intro, /paste this|give this to|copy (?:this|it) into/i, name)
    assert.ok([...content].length <= 100_000, `${name} must fit the endpoint's full-content limit`)
  }
})
