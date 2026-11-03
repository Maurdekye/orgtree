// The app menu has NO Modes section (USER 2026-11-03 m6164da08f4fa "also put the toggles in the display tab" meant MOVE;
// confirmed mb2d765cb0aa7 "i thought i mentioned removing these buttons in the app menu"). Streamer mode and Attract mode
// are switched only in App settings > Display (streamerblank.test.tsx pins those toggles). The menu ends at Changelog.
import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { OrgtreeMenu } from '../src/shell/menu'

const menu = (extra: Record<string, unknown> = {}) => <OrgtreeMenu orgs={[]} freshness="current" ageMs={0} error={null}
  currentOrg={null} onOpenOrg={() => {}} onNewWindow={() => {}} onCreateOrg={() => {}}
  onAppSettings={() => {}} onUsage={() => {}} onChangelog={() => {}} {...extra} />

test('the app menu draws no Modes heading, no mode rows and no trailing separator, even if modes are passed', async () => {
  const view = await mountView(menu({ modes: [
    { id: 'streamer', label: 'Streamer mode', on: false, onToggle: () => {} },
    { id: 'attract', label: 'Attract mode', on: true, onToggle: () => {} }] }), el => el)
  try {
    await inAct(() => view.el.querySelector<HTMLButtonElement>('.shell-menu-button')!.click())
    const panel = view.el.querySelector<HTMLElement>('.shell-menu-panel')!
    assert.equal(panel.querySelectorAll('.shell-menu-mode').length, 0)
    assert.equal([...panel.querySelectorAll('.shell-menu-group')].some(e => e.textContent === 'Modes'), false)
    assert.ok(!/Streamer mode|Attract mode/.test(panel.textContent ?? ''))
    const last = panel.lastElementChild as HTMLElement
    assert.notEqual(last.getAttribute('role'), 'separator', 'no empty separator at the end')
    assert.equal(last.textContent, 'Changelog…')
  } finally { await view.unmount() }
})
