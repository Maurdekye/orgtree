// apptitle.test.tsx — the app calls itself 'Orgtree', one way, everywhere a
// title is visible (user 2026-09-10: the home header said 'orgtree' while
// the sidebar shouted an uppercase 'ORGTREE' behind a spark glyph), and the
// sidebar badge beside the name is the RUNNING APP VERSION — e.g.
// "2.0.0-alpha.8" — in the seat the backend build hash used to hold. A
// plain browser has no app version and never invents one: it keeps the
// backend hash, or shows nothing at all.
//
// The badge is a real mounted component; the title spellings live in JSX
// literals and one CSS transform, which jsdom cannot reach through a full
// App mount (FakeServer backs node chat, not the whole org API) — those are
// bound at their source, the same way the wiring suites bind main-process
// shape.
//
// Run:  cd frontend && node tests/run.mjs apptitle
import { mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { TitleBadge } from '../src/App'
import { THEMES } from '../src/themes'
import type { HostPayload } from '../src/types'

declare const __SRC_DIR__: string   // injected by run.mjs (see agentstray.test.tsx)
const src = (name: string) => fs.readFileSync(path.join(__SRC_DIR__, name), 'utf8')

const BUILD: HostPayload['build'] = {
  commit: 'abc1234', branch: 'main', started_at: '2026-09-10T12:00:00Z',
} as HostPayload['build']

async function badge(t: TestContext, el: React.ReactElement) {
  useFakeClock()
  const view = await mountView(el, (host) => host)
  t.after(async () => { await view.unmount(); realClock() })
  return view.el.querySelector('.build-badge')
}

test('the desktop shell\'s app version is the visible badge; the engine hash keeps the tooltip', async (t) => {
  const el = await badge(t, <TitleBadge appVersion="2.0.0-alpha.8" build={BUILD} />)
  assert.ok(el, 'the badge renders')
  assert.equal(el!.textContent, '2.0.0-alpha.8')
  assert.match(el!.getAttribute('title') ?? '', /running app version 2\.0\.0-alpha\.8/)
  assert.match(el!.getAttribute('title') ?? '', /engine main@abc1234/,
    'the hash the badge replaced is still one hover away')
})

test('a plain browser keeps the engine hash and never invents a version', async (t) => {
  const el = await badge(t, <TitleBadge appVersion={null} build={BUILD} />)
  assert.ok(el, 'the fallback badge renders')
  assert.equal(el!.textContent, 'main@abc1234')
  const none = await badge(t, <TitleBadge appVersion={null} build={null} />)
  assert.equal(none, null, 'nothing known, nothing shown')
  const unknown = await badge(t, <TitleBadge appVersion={null}
    build={{ ...BUILD, commit: 'unknown' } as HostPayload['build']} />)
  assert.equal(unknown, null, 'an unknown commit is not a badge either')
})

test('the default themes wear the user\'s exact display names; ids and Custom stay', () => {
  // user 2026-09-10 13:29 — label-only rename; the keys ARE the stored ids
  // and both pickers (settings + onboarding) render this one table
  assert.deepEqual(
    Object.fromEntries(Object.entries(THEMES).map(([id, t]) => [id, t.label])),
    { orgtree: 'Orgtree Grey', claude: 'Claude Terracotta', codex: 'Codex Teal',
      antigravity: 'Antigravity Blue', openrouter: 'OpenRouter Lavender' })
  assert.match(src('themes.tsx'), /<option value="custom">Custom<\/option>/,
    'the custom theme choice survives the rename')
})

test('every visible app title reads exactly Orgtree — no case drift, no spark glyph', () => {
  const app = src('App.tsx')
  assert.match(app, /<h1>Orgtree\r?\n/, 'the sidebar title')
  assert.equal([...app.matchAll(/<h2>Orgtree<\/h2>/g)].length, 2,
    'both native window headers (home and fallback orgbar)')
  assert.match(app, /\$\{tree\.name\} — Orgtree` : 'Orgtree'/, 'the tab title')
  assert.doesNotMatch(app, /<h[12]>[^<]*orgtree/,
    'no lowercase orgtree remains in a visible heading')
  assert.doesNotMatch(app, /<h1><SparkIcon/, 'the sidebar spark glyph is gone')
  const css = src('styles.css')
  const h1 = /aside h1, \.welcome-card h1 \{\r?\n([^}]*)\}/.exec(css)
  assert.ok(h1, 'the sidebar title rule exists')
  assert.doesNotMatch(h1![1]!, /text-transform/,
    'no transform may rewrite the one spelling the titles share')
})
