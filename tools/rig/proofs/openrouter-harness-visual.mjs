// Proof (visual): App settings › Harnesses and the OpenRouter key dialog's
// harness selector, through the real engine and this worktree's renderer
// (docket openrouter-choose-the-harness-claude-code-codex-p). The rig's fake
// CLI stands in for every harness; the proof takes Antigravity's and Codex's
// away for the screenshots, so the page shows both states and the key saved on
// Codex shows a saved choice since uninstalled.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/openrouter-harness-visual.mjs --ui <dir>
//      (dir from `node tools/rig/build-ui.mjs`)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Proof } from '../proof.mjs'
import { runDesktop } from '../desktop.mjs'
import { setup as keysSetup } from './openrouter-keys.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

export async function setup() {
  const s = await keysSetup()
  return { ...s, name: 'openrouter-harness-visual' }
}

export default async function (rig) {
  const p = new Proof('openrouter-harness-visual')
  if (!rig.run.ui) {
    p.check('a --ui bundle was given (this proof is visual only)', false)
    return p.summary()
  }
  // "installed" is only settled once the engine's first discovery pass has
  // landed (OpenCode is known only through it): read the registry after it,
  // never before (batch round 430 compared the page to a pre-discovery read)
  await rig.waitFor(async () => (await rig.api('GET', '/api/providers')).checking === false,
    { what: 'the first provider discovery to land', timeout: 60000 })
  await rig.api('POST', '/api/openrouter/keys', { key: 'sk-or-rig-not-a-real-key-TWO222', label: 'team', harness: 'codex-cli' })
  // nothing runs Antigravity or Codex here, so their fake CLIs can simply be
  // moved away
  const gone = ['agy.exe', 'codex.exe'].map((f) => path.join(rig.dir, 'bin', f))
  for (const f of gone) fs.renameSync(f, f + '.gone')
  let reg, regAfter, r
  try {
    reg = (await rig.api('GET', '/api/harnesses')).harnesses ?? []
    r = await runDesktop(rig, path.join(here, '../desktop/openrouter-harness-visual.cjs'),
      { out: path.join(p.dir, 'desk'), timeout: 120000 })
    regAfter = (await rig.api('GET', '/api/harnesses')).harnesses ?? []
  } finally {
    for (const f of gone) fs.renameSync(f + '.gone', f)
  }
  p.check('the desktop script ran', r.ok, r.ok ? undefined : r)
  const states = (x) => x.map((h) => [h.id, h.installed])
  p.check('control: the engine’s installed states did not change while the page was read',
    JSON.stringify(states(reg)) === JSON.stringify(states(regAfter)), { before: states(reg), after: states(regAfter) })
  const v = r.value ?? {}
  p.check('the settings open on the Harnesses tab', v.selected === 'Harnesses', v.selected)
  p.check('every App settings tab fits the strip at the default window width (nothing cut off)',
    !!v.strip && v.strip.scroll <= v.strip.client, v.strip)
  p.check('the page lists every registry harness by name, in registry order',
    JSON.stringify((v.entries ?? []).map((e) => e.name)) === JSON.stringify(reg.map((h) => h.name)), { page: v.entries?.map((e) => e.name), reg: reg.map((h) => h.name) })
  p.check('each entry says installed exactly when the engine does',
    reg.every((h, i) => v.entries?.[i]?.installed === h.installed), reg.map((h) => [h.id, h.installed]))
  p.check('control: the page shows both states (Antigravity and Codex taken away, the rest installed)',
    reg.some((h) => h.installed) && reg.find((h) => h.id === 'antigravity')?.installed === false
      && reg.find((h) => h.id === 'codex-cli')?.installed === false, reg.map((h) => [h.id, h.installed]))
  // every OpenRouter harness is listed (user 2026-10-13 22:20Z): the
  // installed ones first and choosable, a disabled separator, then the ones
  // not installed, disabled
  const forOr = reg.filter((h) => (h.providers ?? []).some((x) => (x.id ?? x) === 'openrouter'))
  const there = forOr.filter((h) => h.installed), absent = forOr.filter((h) => !h.installed)
  const want = [...there.map((h) => ({ value: h.id, disabled: false })),
    ...(there.length && absent.length ? [{ value: '__harness-separator__', disabled: true }] : []),
    ...absent.map((h) => ({ value: h.id, disabled: true }))]
  const got = (v.options ?? []).map((o) => ({ value: o.value, disabled: o.disabled }))
  p.check('the key dialog lists every OpenRouter harness: installed ones first and choosable, the rest disabled',
    JSON.stringify(got) === JSON.stringify(want), { options: v.options, want })
  p.check('a key saved on Codex, since uninstalled, still shows Codex (disabled, "not installed")',
    v.value === 'codex-cli' && (v.options ?? []).some((o) => o.value === 'codex-cli' && o.disabled && /not installed/.test(o.text)), { value: v.value })
  p.check('the key dialog carries the "Which harnesses are supported?" link', v.link === true)
  p.check('the link opens App settings › Harnesses', v.after === 'Harnesses', v.after)
  p.keep(rig, { grep: /harness|panic/i })
  return p.summary()
}
