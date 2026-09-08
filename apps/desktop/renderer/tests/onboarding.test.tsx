// First-run setup: the gate that decides when it appears, and the completion
// path that populates charter documents BEFORE persisting `onboarded`. These
// drive the rendered card through a fake desktop bridge and a stubbed fetch —
// a gate tested only as a boolean would say nothing about what the buttons do.
import { flush, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import React, { useState } from 'react'
import { Onboarding, onboardingCreate, showOnboarding } from '../src/canvas/onboarding'
import type { NativePreferences } from '../src/desktop'

const g = globalThis as unknown as Record<string, unknown>

const prefs = (over: Partial<NativePreferences> = {}): NativePreferences => ({
  visualTheme: 'orgtree', exitOnClose: false, startAtLogin: true,
  routineNotifications: false, onboarded: false, ...over,
})

function stubBridge(state: { prefs: NativePreferences; patches: unknown[] }) {
  const w = window as unknown as Record<string, unknown>
  w.orgtreeDesktop = {
    getPreferences: () => Promise.resolve({ ...state.prefs }),
    setPreferences: (patch: Partial<NativePreferences>) => {
      state.patches.push({ ...patch })
      state.prefs = { ...state.prefs, ...patch }
      return Promise.resolve({ ...state.prefs })
    },
    onEvent: () => () => {},
  }
  return () => { delete w.orgtreeDesktop }
}

function stubFetch(seen: { method: string; path: string }[],
                   fail: { now: boolean } = { now: false }) {
  g.fetch = (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    seen.push({ method: init?.method ?? 'GET', path })
    if (fail.now) {
      return Promise.resolve({
        ok: false, status: 503,
        json: () => Promise.resolve({ detail: 'engine declined (synthetic)' }),
        headers: { get: () => null },
      })
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ dir: 'x', created: [], existing: [] }),
      headers: { get: () => null },
    })
  }
}

test('gate: only a loaded, un-onboarded install with a KNOWN empty org list', () => {
  assert.equal(showOnboarding(prefs(), 0, true), true)
  assert.equal(showOnboarding(null, 0, true), false, 'preferences not loaded yet')
  assert.equal(showOnboarding(prefs(), 0, false), false, 'org list not fetched yet')
  assert.equal(showOnboarding(prefs(), 2, true), false, 'existing organizations')
  assert.equal(showOnboarding(prefs({ onboarded: true }), 0, true), false, 'already completed')
})

test('finish populates charter documents and then persists onboarded', async () => {
  const state = { prefs: prefs(), patches: [] as unknown[] }
  const restore = stubBridge(state)
  const seen: { method: string; path: string }[] = []
  stubFetch(seen)
  const view = await mountView(
    <Onboarding><div data-testid="neworg" /></Onboarding>,
    el => el.textContent ?? '')
  await flush()
  assert.ok(view.last().includes('Welcome to Orgtree'))
  const buttons = [...view.el.querySelectorAll('button')]
  const finish = buttons.find(b => b.textContent === 'finish setup')
  assert.ok(finish, 'finish button rendered')
  const { act } = await import('react')
  await act(async () => { finish!.click() })
  await flush()
  assert.deepEqual(seen, [{ method: 'POST', path: '/api/charters/populate' }],
    'charter documents are populated exactly once')
  assert.deepEqual(state.patches.at(-1), { onboarded: true })
  await view.unmount()
  restore()
})

test('a failed populate is shown, blocks the flag, and the button retries', async () => {
  const state = { prefs: prefs(), patches: [] as unknown[] }
  const restore = stubBridge(state)
  const seen: { method: string; path: string }[] = []
  const fail = { now: true }
  stubFetch(seen, fail)
  const view = await mountView(
    <Onboarding><div /></Onboarding>, el => el.textContent ?? '')
  await flush()
  const finish = [...view.el.querySelectorAll('button')]
    .find(b => b.textContent === 'finish setup')
  const { act } = await import('react')
  await act(async () => { finish!.click() })
  await flush()
  assert.ok(view.last().includes('Charter documents were not populated'),
    'the failure is visible on the card')
  assert.equal(state.patches.length, 0, 'onboarded is NOT written on failure')
  fail.now = false
  await act(async () => { finish!.click() })
  await flush()
  assert.deepEqual(state.patches.at(-1), { onboarded: true })
  assert.equal(seen.filter(s => s.path === '/api/charters/populate').length, 2)
  await view.unmount()
  restore()
})

// The sequence App actually performs: while setup is showing, creating the
// first organization runs onboardingCreate, which completes setup BEFORE the
// caller's refresh flips the gate and unmounts the card. A completion left
// in a child effect would never fire — the card is gone by then — which is
// exactly what this host reproduces.
function Host({ errors }: { errors: string[] }) {
  const [orgCount, setOrgCount] = useState(0)
  const create = () =>
    onboardingCreate(() => Promise.resolve({ slug: 'first' }), m => errors.push(m))
      .then(r => { setOrgCount(1); return r })
  return showOnboarding(prefs(), orgCount, true)
    ? <Onboarding><button data-testid="create" onClick={() => void create()}>create</button></Onboarding>
    : <div>desk</div>
}

test('creating the first organization completes setup before the card unmounts', async () => {
  const state = { prefs: prefs(), patches: [] as unknown[] }
  const restore = stubBridge(state)
  const seen: { method: string; path: string }[] = []
  stubFetch(seen)
  const errors: string[] = []
  const view = await mountView(<Host errors={errors} />, el => el.textContent ?? '')
  await flush()
  assert.ok(view.last().includes('Welcome to Orgtree'))
  const { act } = await import('react')
  const create = view.el.querySelector('[data-testid="create"]') as HTMLButtonElement
  await act(async () => { create.click() })
  await flush()
  assert.equal(view.last(), 'desk', 'the card unmounted after creation')
  assert.deepEqual(seen, [{ method: 'POST', path: '/api/charters/populate' }])
  assert.deepEqual(state.patches, [{ onboarded: true }],
    'the flag was written even though the card never saw orgCount > 0')
  assert.deepEqual(errors, [])
  await view.unmount()
  restore()
})

test('a populate failure on the create path is surfaced and leaves the flag unset', async () => {
  const state = { prefs: prefs(), patches: [] as unknown[] }
  const restore = stubBridge(state)
  const seen: { method: string; path: string }[] = []
  stubFetch(seen, { now: true })
  const errors: string[] = []
  const view = await mountView(<Host errors={errors} />, el => el.textContent ?? '')
  await flush()
  const { act } = await import('react')
  const create = view.el.querySelector('[data-testid="create"]') as HTMLButtonElement
  await act(async () => { create.click() })
  await flush()
  assert.equal(view.last(), 'desk', 'the organization still opens')
  assert.equal(state.patches.length, 0, 'onboarded stays unset for a later retry')
  assert.deepEqual(errors, ['engine declined (synthetic)'])
  await view.unmount()
  restore()
})

test('the Settings recovery action retries after a failed populate', async () => {
  const seen: { method: string; path: string }[] = []
  const fail = { now: true }
  stubFetch(seen, fail)
  const { CharterDocumentsSetting } = await import('../src/canvas/chartersettings')
  const view = await mountView(<CharterDocumentsSetting />, el => el.textContent ?? '')
  const { act } = await import('react')
  const button = view.el.querySelector('button') as HTMLButtonElement
  await act(async () => { button.click() })
  await flush()
  assert.ok(view.last().includes('Charter documents were not populated'),
    'failure is visible with a retry instruction')
  fail.now = false
  await act(async () => { button.click() })
  await flush()
  assert.ok(view.last().includes('nothing to create'),
    'retry succeeds and reports the outcome')
  assert.equal(seen.filter(s => s.path === '/api/charters/populate').length, 2)
  await view.unmount()
})

test('theme choice previews and persists through the bridge', async () => {
  const state = { prefs: prefs(), patches: [] as unknown[] }
  const restore = stubBridge(state)
  stubFetch([])
  const view = await mountView(
    <Onboarding><div /></Onboarding>, el => el.textContent ?? '')
  await flush()
  const claude = [...view.el.querySelectorAll('button[role="radio"]')]
    .find(b => b.textContent?.includes('Claude'))
  assert.ok(claude, 'theme options rendered')
  const { act } = await import('react')
  await act(async () => { (claude as HTMLButtonElement).click() })
  await flush()
  assert.deepEqual(state.patches[0], { visualTheme: 'claude' })
  assert.equal(document.documentElement.style.getPropertyValue('--accent'), '#d97757')
  await view.unmount()
  restore()
})
