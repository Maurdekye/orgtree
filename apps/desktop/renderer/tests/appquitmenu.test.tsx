// "Quit Orgtree" in the app's own menu, on every platform (USER 2026-11-19 m8b45545c043f "Yes, everywhere": opened only
// in the Steam overlay there is no tray, and closing the window leaves the background service running). It is the
// menu's last entry, under a separator, with the tray's own wording, and it does nothing but call its handler: the one
// quit path lives in the main process (tests/app-quit.test.mjs).
import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { OrgtreeMenu } from '../src/shell/menu'

const menu = (extra: Record<string, unknown> = {}) => <OrgtreeMenu orgs={[]} freshness="current" ageMs={0} error={null}
  currentOrg={null} onOpenOrg={() => {}} onNewWindow={() => {}} onCreateOrg={() => {}}
  onAppSettings={() => {}} onUsage={() => {}} onUsageHistory={() => {}} onChangelog={() => {}} {...extra} />
const open = async (view: { el: HTMLElement }) => {
  await inAct(() => view.el.querySelector<HTMLButtonElement>('.shell-menu-button')!.click())
  return view.el.querySelector<HTMLElement>('.shell-menu-panel')!
}

test('Quit Orgtree is the last entry of the app menu, under a separator, and calls the quit handler once', async () => {
  let quits = 0
  const view = await mountView(menu({ onQuit: () => { quits++ } }), el => el)
  try {
    const panel = await open(view)
    const last = panel.lastElementChild as HTMLElement
    assert.equal(last.getAttribute('role'), 'menuitem')
    assert.equal(last.textContent, 'Quit Orgtree', 'the tray\'s own wording')
    assert.equal(last.previousElementSibling?.getAttribute('role'), 'separator')
    assert.equal(last.previousElementSibling?.previousElementSibling?.textContent, 'Changelog…')
    assert.equal(panel.querySelectorAll('[role="separator"]').length, 2)
    await inAct(() => last.click())
    assert.equal(quits, 1)
    assert.equal(view.el.querySelector('.shell-menu-panel'), null, 'the menu closes like after any other entry')
  } finally { await view.unmount() }
})

test('without a quit handler (a browser, no desktop bridge) the menu has no Quit entry and no extra separator', async () => {
  const view = await mountView(menu(), el => el)
  try {
    const panel = await open(view)
    assert.ok(!/Quit Orgtree/.test(panel.textContent ?? ''))
    assert.equal((panel.lastElementChild as HTMLElement).textContent, 'Changelog…')
    assert.equal(panel.querySelectorAll('[role="separator"]').length, 1)
  } finally { await view.unmount() }
})
