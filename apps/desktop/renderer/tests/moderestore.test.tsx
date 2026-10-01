// moderestore.test.tsx — restore-previous-windows returns to the Attention view.
// Mounts the real hook. Run:  cd apps/desktop/renderer && node tests/run.mjs moderestore
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inAct, mountView } from './harness'
import { Preferences } from '../../main/preferences'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useModeRestore } from '../src/attention/moderestore'
import { forgetAttentionMode, orgView, setOrgView, useOrgView } from '../src/attention/mode'
import type { NativePreferences } from '../src/desktop'

const prefs = (p: Partial<NativePreferences>): NativePreferences => p as NativePreferences
const reset = () => { localStorage.clear(); forgetAttentionMode() }

type Persist = (slug: string, view: 'attention' | 'canvas') => void
function Probe({ slug, p, persist }: { slug: string; p: NativePreferences | null; persist: Persist }) {
  const view = useOrgView(slug)
  useModeRestore(slug, view, p, persist)
  return <i data-view={view} />
}
const seen = (el: HTMLElement) => el.querySelector('i')!.getAttribute('data-view')

async function boot(local: 'attention' | 'canvas', native: Partial<NativePreferences>) {
  reset(); if (local === 'attention') setOrgView('acme', 'attention')
  const saved: [string, string][] = []
  const persist: Persist = (slug, v) => { saved.push([slug, v]) }
  const view = await mountView(<Probe slug="acme" p={null} persist={persist} />, seen)
  assert.equal(saved.length, 0, 'nothing is decided before preferences arrive')
  await view.render(<Probe slug="acme" p={prefs(native)} persist={persist} />)
  return { view, saved }
}

test('native Attention restores Attention with the local view key gone', async () => {
  const { view, saved } = await boot('canvas', { startupMode: 'restore', attentionOrgs: ['acme'], canvasOrgs: [] })
  assert.equal(view.last(), 'attention'); assert.equal(orgView('acme'), 'attention')
  assert.deepEqual(saved, [])
  await view.unmount()
})

test('native Canvas (empty list) beats a stale local Attention', async () => {
  const { view, saved } = await boot('attention', { startupMode: 'restore', attentionOrgs: [], canvasOrgs: ['acme'] })
  assert.equal(view.last(), 'canvas')
  assert.deepEqual(saved, [], 'the saved Canvas is not overwritten')
  await view.unmount()
})

test('a window closed in Canvas reopens in Canvas', async () => {
  const { view } = await boot('canvas', { startupMode: 'restore', attentionOrgs: ['other'], canvasOrgs: ['acme'] })
  assert.equal(view.last(), 'canvas')
  await view.unmount()
})

test('older native preferences without attentionOrgs keep the local view and record it', async () => {
  const { view, saved } = await boot('attention', { startupMode: 'restore' })
  assert.equal(view.last(), 'attention')
  assert.deepEqual(saved, [['acme', 'attention']])
  await view.unmount()
})

test('homepage startup does not restore; the live view is recorded instead', async () => {
  const { view, saved } = await boot('canvas', { startupMode: 'homepage', attentionOrgs: ['acme'], canvasOrgs: [] })
  assert.equal(view.last(), 'canvas')
  assert.deepEqual(saved, [['acme', 'canvas']])
  await view.unmount()
})

test('a user switch after startup is mirrored and never undone by the restore', async () => {
  const { view, saved } = await boot('canvas', { startupMode: 'restore', attentionOrgs: ['acme'], canvasOrgs: [] })
  assert.equal(view.last(), 'attention')
  await inAct(() => setOrgView('acme', 'canvas'))
  assert.equal(view.last(), 'canvas')
  await view.render(<Probe slug="acme" p={prefs({ startupMode: 'restore', attentionOrgs: ['acme'], canvasOrgs: [] })} persist={(sl, v) => saved.push([sl, v])} />)
  assert.equal(view.last(), 'canvas')
  assert.ok(saved.some(([sl, v]) => sl === 'acme' && v === 'canvas'), 'Canvas was recorded')
  await view.unmount()
})

test('an older-app upgrade with several org windows keeps the saved Attention', async () => {
  reset(); setOrgView('beta', 'attention')
  const saved: [string, string][] = []
  const persist: Persist = (slug, v) => { saved.push([slug, v]) }
  // the first window (alpha, local Canvas) opens and records Canvas natively
  const alpha = await mountView(<Probe slug="alpha" p={prefs({ startupMode: 'restore' })} persist={persist} />, seen)
  assert.deepEqual(saved, [['alpha', 'canvas']])
  await alpha.unmount()
  // the second window (beta, local Attention) now reads those preferences
  const now = prefs({ startupMode: 'restore', attentionOrgs: [], canvasOrgs: ['alpha'] })
  const beta = await mountView(<Probe slug="beta" p={now} persist={persist} />, seen)
  assert.equal(beta.last(), 'attention', 'beta has no native record, so its local Attention stands')
  assert.deepEqual(saved[1], ['beta', 'attention'])
  await beta.unmount()
})

test('the main process changes one org at a time, so a stale window cannot erase another record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modeprefs-'))
  try {
    const file = path.join(dir, 'prefs.json')
    const prefs = new Preferences(file)
    // two windows read the same early snapshot, then each records its own org
    prefs.set({ orgView: { slug: 'alpha', view: 'attention' } })
    prefs.set({ orgView: { slug: 'beta', view: 'canvas' } })
    const now = new Preferences(file).get()
    assert.deepEqual(now.attentionOrgs, ['alpha'])
    assert.deepEqual(now.canvasOrgs, ['beta'])
    // whole lists sent by a window are ignored, and moving an org moves it between lists
    prefs.set({ attentionOrgs: [], canvasOrgs: [] })
    assert.deepEqual(prefs.get().attentionOrgs, ['alpha'])
    prefs.set({ orgView: { slug: 'alpha', view: 'canvas' } })
    const after = new Preferences(file).get()
    assert.deepEqual(after.attentionOrgs, [])
    assert.deepEqual(after.canvasOrgs, ['beta', 'alpha'])
    assert.equal('orgView' in after, false, 'the patch key is never stored')
    assert.throws(() => prefs.set({ orgView: { slug: '', view: 'canvas' } }))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
