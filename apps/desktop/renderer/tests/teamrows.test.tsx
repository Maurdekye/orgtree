import { FakeServer, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { TeamChromeFixture, CHROME_ORG } from './teamchrome-fixture'
import { AgentTray, trayRows } from '../src/canvas/agenttray'
import { forgetModalPins, forgetModalOpenCache, pinModal } from '../src/canvas/modalpin'
import type { CanvasNode } from '../src/canvas/shared'

test('project rows reserve no blank status line in actual pinned Agents and Team panels', async t => {
  const oldFetch = globalThis.fetch
  installFetch(new FakeServer()); localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
  pinModal('agent-list', { x: 20, y: 30, w: 420, h: 450 }, CHROME_ORG)
  pinModal('agent-team', { x: 460, y: 30, w: 420, h: 450 }, CHROME_ORG)
  const view = await mountView(<TeamChromeFixture />, el => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = oldFetch
    localStorage.clear(); forgetModalPins(); forgetModalOpenCache() })
  await inAct(() => view.el.querySelector<HTMLButtonElement>('.tray-toggle')!.click())
  for (const panel of ['.team-panel', '.tray-panel:not(.team-panel)']) {
    const root = document.querySelector(`${panel} .tray-row[data-copy-agent-name="build-team"]`)!
    assert.ok(root, 'the fixture must contain its real project root')
    assert.equal(root.querySelector('.tray-sum') === null, true, 'an empty project summary creates the gap before its first member')
    assert.ok(root.querySelector('.project-mark'), 'retain the shared project icon')
  }
})

test('project summaries with content and ordinary agent status placeholders are retained', async t => {
  const make = (id: string, extra: object) => ({ id, title: id, state: 'live', tier: 'sol', children: [], turns: [], ...extra } as CanvasNode)
  const nodes = [make('project-with-summary', { kind: 'project', tier: 'project', last_status: { status: 'done', summary: 'Kept project summary' } }),
    make('agent-without-summary', {})]
  const map = new Map(nodes.map(n => [n.id, n]))
  const noop = () => {}
  const view = await mountView(<AgentTray map={map} rows={trayRows(map)} query="" onQuery={noop}
    archived={false} onArchived={noop} onPick={noop} />, el => el)
  t.after(() => view.unmount())
  assert.ok(view.el.querySelector('[data-copy-agent-name="project-with-summary"] .tray-sum')?.textContent?.includes('Kept project summary'))
  assert.equal(view.el.querySelectorAll('[data-copy-agent-name="agent-without-summary"] .tray-sum').length, 1)
})
