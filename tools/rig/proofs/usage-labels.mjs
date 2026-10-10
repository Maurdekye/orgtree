// Proof: every account of a provider is named the same way on the Usage
// panel (docket usage-cards-the-two-openai-accounts-are-labelled, user
// screenshot 2026-10-10). Two Codex logins (the default sign-in and D) with
// readings shaped like the live engine's (provider "openai", a plan, credits on
// the default only), plus the Antigravity default (provider "google"):
//   1. Both Codex cards are headed "Codex" and their plan lines read "Codex
//      <plan>"; no card is headed or planned with a raw id ("openai", "google").
//   2. The Antigravity card is headed "Antigravity".
//   3. The credits line stays on the account that reports credits.
//   4. The engine's Codex and Antigravity peeks carry "Codex" / "Antigravity"
//      (3.x parity; the canned readings keep "openai"/"google" so the panel is
//      also shown to cope with the raw ids).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/usage-labels.mjs (with ORGTREE_RIG_UI)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Proof } from '../proof.mjs'
import { runDesktop } from '../desktop.mjs'

const later = h => new Date(Date.now() + h * 3600e3).toISOString()
const reading = (email, plan, extra = {}) => ({ available: true, provider: 'openai', plan, email, label: email,
  observed_at: new Date().toISOString(), ...extra, limits: [
    { kind: 'session', group: 'session', percent: 10, resets_at: later(3), is_active: false, model: null, label: 'Current session' },
    { kind: 'weekly_all', group: 'weekly_all', percent: 30, resets_at: later(72), is_active: true, model: null, label: 'Current week (all models)' },
  ] })
const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url')
function codexHome(dir, email) {
  fs.mkdirSync(dir, { recursive: true })
  const idToken = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ email })}.rig`
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: idToken } }))
  return dir
}

export default async function (rig) {
  const p = new Proof('usage-labels')
  const page = fileURLToPath(new URL('../desktop/usage-labels.cjs', import.meta.url))
  const usageDir = path.join(rig.data, 'rig-home', 'rig-usage')
  fs.mkdirSync(usageDir, { recursive: true })
  const put = (name, r) => fs.writeFileSync(path.join(usageDir, `${name}.json`), JSON.stringify(r))
  put('openai', reading('rig-codex@example.invalid', 'Pro', { credits: { balance: 12, unit: 'credits', unlimited: false } }))
  put('openai@codex-d', reading('rig-codex-d@example.invalid', 'Pro Lite'))
  put('google', { ...reading('rig-agy@example.invalid', 'Google AI Pro'), provider: 'google', account: 'google/primary' })
  const D = (await rig.api('POST', '/api/accounts', { provider: 'openai', kind: 'imported',
    path: codexHome(path.join(rig.data, 'rig-home', 'codex-d'), 'rig-codex-d@example.invalid') })).id
  for (const r of ['/api/codex/usage?force=true', '/api/antigravity/usage?force=true', `/api/accounts/${D}/usage?force=true`]) {
    await rig.api('GET', r).catch(() => null)
  }
  p.note('D usage (engine)', await rig.api('GET', `/api/accounts/${D}/usage`).catch(e => e.message))
  // the engine's host-lane peeks carry 3.x's display names (the full reading
  // sets the same constant after a live probe, which a canned reading skips)
  const peeks = { codex: await rig.api('GET', '/api/codex/usage/peek'), agy: await rig.api('GET', '/api/antigravity/usage/peek') }
  p.check('the Codex and Antigravity peeks read "Codex" and "Antigravity"', peeks.codex?.provider === 'Codex'
    && peeks.agy?.provider === 'Antigravity', peeks)
  if (!rig.run.ui) throw Error('usage-labels needs a UI bundle (ORGTREE_RIG_UI)')
  const ui = await runDesktop(rig, page, { preset: 'wide', out: path.join(p.dir, 'desktop') })
  const cards = ui.value?.cards ?? []
  const codex = cards.filter(c => /codex/i.test(c.head))
  p.check('two Codex cards, both headed "Codex"', ui.ok && codex.length === 2 && codex.every(c => c.label === 'Codex'), cards)
  p.check('their plan lines read "Codex Pro" and "Codex Pro Lite"', codex.some(c => /Codex Pro(?! Lite)/.test(c.text))
    && codex.some(c => /Codex Pro Lite/.test(c.text)), codex.map(c => c.text))
  p.check('no card is headed or planned with a raw id', cards.every(c => c.label !== 'openai' && c.label !== 'google'
    && !/\bopenai Pro\b|\bgoogle\b/.test(c.text)), cards)
  const agy = cards.find(c => /rig-agy@/.test(c.head))
  p.check('the Antigravity card is headed "Antigravity"', agy?.label === 'Antigravity', agy)
  const withCredits = codex.filter(c => /credit/i.test(c.text))
  p.check('the credits line stays on the account that reports credits', withCredits.length === 1
    && /rig-codex@/.test(withCredits[0].head), withCredits)
  const errors = (ui.value?.consoleErrors ?? []).filter(e => !/Electron Security Warning/.test(e))
  p.check('no console errors', errors.length === 0, errors)
  p.note('screenshots', ui.out)
  const result = p.summary()
  if (!result.passed) throw Error(JSON.stringify(result))
  return result
}
