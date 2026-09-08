// First-run setup: the gate that decides when it appears, and the completion
// path that populates charter documents BEFORE persisting `onboarded`. These
// drive the rendered card through a fake desktop bridge and a stubbed fetch —
// a gate tested only as a boolean would say nothing about what the buttons do.
import { flush, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { Onboarding, showOnboarding } from '../src/canvas/onboarding'
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

function stubFetch(seen: { method: string; path: string }[]) {
  g.fetch = (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    seen.push({ method: init?.method ?? 'GET', path })
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
    <Onboarding orgCount={0}><div data-testid="neworg" /></Onboarding>,
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

test('creating the first organization completes setup without pressing finish', async () => {
  const state = { prefs: prefs(), patches: [] as unknown[] }
  const restore = stubBridge(state)
  const seen: { method: string; path: string }[] = []
  stubFetch(seen)
  const view = await mountView(
    <Onboarding orgCount={0}><div /></Onboarding>, el => el.textContent ?? '')
  await flush()
  assert.equal(state.prefs.onboarded, false)
  await view.render(<Onboarding orgCount={1}><div /></Onboarding>)
  await flush()
  assert.deepEqual(state.patches.at(-1), { onboarded: true })
  assert.ok(seen.some(s => s.path === '/api/charters/populate'))
  await view.unmount()
  restore()
})

test('theme choice previews and persists through the bridge', async () => {
  const state = { prefs: prefs(), patches: [] as unknown[] }
  const restore = stubBridge(state)
  stubFetch([])
  const view = await mountView(
    <Onboarding orgCount={0}><div /></Onboarding>, el => el.textContent ?? '')
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
