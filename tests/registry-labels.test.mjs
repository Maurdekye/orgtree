/** A registered account row's two display names.
 *
 * User report (screenshot 2026-09-11): the primary usage section reads
 * `Claude Code · <email>` with `Claude max` under it, while a second signed-in
 * account three rows down reads `Claude · claude-0 · <email>` — a different
 * product name for the same harness, and no tier.
 *
 * ⚠ THE TWO NAMES ARE NOT ONE NAME. Fixing the heading by renaming the single
 * map to 'Claude Code' would have made the plan line read "Claude Code max"
 * beside the primary's "Claude max". The heading names the harness; the plan
 * line names the subscription. Both directions are asserted below, so a future
 * collapse back into one map fails here rather than in a screenshot.
 *
 * Bundled with esbuild the way update-notice-ui.test.mjs does it — the module
 * under test is plain TS with no React, so no DOM is needed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-registry-labels-'))
const output = path.join(dir, 'registrylabels.cjs')
await build({
  entryPoints: [path.join(root, 'apps/desktop/renderer/src/registrylabels.ts')],
  outfile: output, bundle: true, platform: 'node', format: 'cjs',
})
const labels = createRequire(import.meta.url)(output)
const { registryProviderName, registryPlanName } = labels

test('a secondary Claude row is headed with the same product as the primary', () => {
  // App.tsx renders the primary section's heading as the literal 'Claude Code'.
  assert.equal(registryProviderName('claude'), 'Claude Code')
})

test('the plan line still names the subscription, not the harness', () => {
  // UsageBars renders `{u.provider ?? 'Claude'} {u.plan}`; the primary payload
  // carries no provider, so it falls back to 'Claude' and reads "Claude max".
  assert.equal(registryPlanName('claude'), 'Claude')
})

test('the heading and the plan line are deliberately different for claude', () => {
  // ⚠ The regression guard. One map cannot satisfy both lines.
  assert.notEqual(registryProviderName('claude'), registryPlanName('claude'))
})

test('a secondary row never reads "Claude Code max"', () => {
  const planLine = `${registryPlanName('claude')} max`
  assert.equal(planLine, 'Claude max')
  assert.ok(!planLine.includes('Claude Code'))
})

test('the other providers keep one name for both lines', () => {
  // POSITIVE CONTROL for the test above: the split is specific to Anthropic,
  // where the harness and the subscription really are different products. If
  // every provider had been split, the assertion would be meaningless.
  for (const id of ['openai', 'google']) {
    assert.equal(registryProviderName(id), registryPlanName(id))
  }
  assert.equal(registryProviderName('openai'), 'Codex')
  assert.equal(registryProviderName('google'), 'Antigravity')
})

test('an unknown provider falls through to its raw id, not to a guess', () => {
  assert.equal(registryProviderName('mystery'), 'mystery')
  assert.equal(registryPlanName('mystery'), 'mystery')
})

test.after(() => { fs.rmSync(dir, { recursive: true, force: true }) })
