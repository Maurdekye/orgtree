// The app menu's Modes group: sibling on/off toggles that share one shape
// (USER 2026-11-02 mc8e118c58de9 "1 app menu toggle"; symmetry rule USER
// 2026-10-29 mb6da9f3ee862). Streamer mode and Attract mode both live here.
import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { OrgtreeMenu } from '../src/shell/menu'
import type { ShellMenuMode } from '../src/shell/menu'

const menu = (modes?: ShellMenuMode[]) => <OrgtreeMenu orgs={[]} freshness="current" ageMs={0} error={null}
  currentOrg={null} onOpenOrg={() => {}} onNewWindow={() => {}} onCreateOrg={() => {}}
  onAppSettings={() => {}} onUsage={() => {}} onChangelog={() => {}} modes={modes} />

test('§1 Modes group lists sibling toggles below Changelog, each a checkbox item reading On/Off', async () => {
  const calls: string[] = []
  const modes: ShellMenuMode[] = [
    { id: 'streamer', label: 'Streamer mode', on: false, onToggle: () => calls.push('streamer') },
    { id: 'attract', label: 'Attract mode', on: true, onToggle: () => calls.push('attract') },
  ]
  const view = await mountView(menu(modes), el => el)
  try {
    const button = view.el.querySelector<HTMLButtonElement>('.shell-menu-button')!
    await inAct(() => button.click())
    const labels = [...view.el.querySelectorAll('.shell-menu-panel .shell-menu-group, .shell-menu-panel .shell-menu-label')]
      .map(e => e.textContent)
    assert.deepEqual(labels.slice(labels.indexOf('Changelog…')), ['Changelog…', 'Modes', 'Streamer mode', 'Attract mode'])
    const rows = [...view.el.querySelectorAll<HTMLButtonElement>('.shell-menu-mode')]
    assert.deepEqual(rows.map(r => r.getAttribute('role')), ['menuitemcheckbox', 'menuitemcheckbox'])
    assert.deepEqual(rows.map(r => r.getAttribute('aria-checked')), ['false', 'true'])
    assert.deepEqual(rows.map(r => r.dataset.mode), ['streamer', 'attract'])
    assert.deepEqual(rows.map(r => r.querySelector('.shell-menu-value')!.textContent), ['Off', 'On'])
    // the same class and children as the other entries: one component, one pattern
    assert.ok(rows.every(r => r.classList.contains('shell-menu-item')))
    await inAct(() => rows[1]!.click())
    assert.equal(view.el.querySelector('.shell-menu-panel'), null, 'a toggle closes the menu like every entry')
    assert.deepEqual(calls, ['attract'])
  } finally { await view.unmount() }
})

test('§2 the arrow keys reach the Modes rows; no modes draws no group', async () => {
  const view = await mountView(menu([{ id: 'attract', label: 'Attract mode', on: false, onToggle: () => {} }]), el => el)
  try {
    const button = view.el.querySelector<HTMLButtonElement>('.shell-menu-button')!
    await inAct(() => button.click())
    const panel = view.el.querySelector<HTMLElement>('.shell-menu-panel')!
    const last = [...panel.querySelectorAll<HTMLElement>('[role="menuitem"]')].at(-1)!
    last.focus()
    await inAct(() => { last.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    assert.equal((document.activeElement as HTMLElement | null)?.dataset.mode, 'attract')
    await inAct(() => button.click())
  } finally { await view.unmount() }
  const bare = await mountView(menu(), el => el)
  try {
    await inAct(() => bare.el.querySelector<HTMLButtonElement>('.shell-menu-button')!.click())
    const groups = [...bare.el.querySelectorAll('.shell-menu-group')].map(e => e.textContent)
    assert.equal(groups.includes('Modes'), false)
  } finally { await bare.unmount() }
})
