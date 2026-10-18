import { FakeServer, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { TeamChromeFixture, CHROME_ORG } from './teamchrome-fixture'
import { AgentTray, trayRows } from '../src/canvas/agenttray'
import { DeskChat } from '../src/canvas/desk'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { resetConvos } from '../src/convo'
import type { TreePayload } from '../src/types'
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

for (const project of [false, true]) test(`${project ? 'project' : 'agent'} Team tab follows live direct children and returns to its default`, async t => {
  const oldFetch = globalThis.fetch
  installFetch(new FakeServer()); resetConvos(); localStorage.clear()
  const make = (id: string, parent?: string, extra = {}) => ({ id, title: id, parent, state: 'live', tier: 'sol',
    generation: 1, children: [], turns: [], seat: 2, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, ...extra } as CanvasNode)
  const root = make('tab-root', undefined, project ? { kind: 'project', tier: 'project' } : {})
  const first = make('first-child', root.id)
  const second = make('child-project', root.id, { kind: 'project', tier: 'project' })
  const grandchild = make('grandchild', second.id)
  const other = make('outside-child', 'someone-else')
  // The map is authoritative, including when an ancestor retains old child objects.
  const node = (children: CanvasNode[]) => {
    const map = new Map([root, other, ...children].map(n => [n.id, n]))
    const tree = { slug: 'team-tabs-synthetic', roots: [root] } as unknown as TreePayload
    const noop = () => {}
    return project ? <ProjectDesk bare node={root} map={map} tree={tree} slug={tree.slug} op={async () => ({})} toast={noop} onJump={noop} />
      : <DeskChat bare node={root} map={map} slug={tree.slug} op={async () => ({})} toast={noop} onJump={noop} />
  }
  const view = await mountView(node([{ ...first, state: 'archived' }]), el => el)
  t.after(async () => { await view.unmount(); resetConvos(); globalThis.fetch = oldFetch; localStorage.clear() })
  const team = () => view.el.querySelector<HTMLButtonElement>('[data-tab="team"]')
  const defaultTab = project ? 'desk' : 'chat'
  assert.equal(team() === null, true, 'archived and unrelated children do not expose Team')
  await view.render(node([first, second, grandchild]))
  assert.equal(team()?.querySelector('.tab-count')?.textContent, '2', 'direct live children only, including projects')
  await inAct(() => team()!.click())
  assert.ok(view.el.querySelector('.team-tabpanel'))
  await view.render(node([{ ...first, state: 'archived' }, second, grandchild]))
  assert.equal(team()?.querySelector('.tab-count')?.textContent, '1')
  assert.equal(team()?.classList.contains('on'), true, 'Team remains selected while a live child remains')
  await view.render(node([{ ...first, state: 'archived' }, { ...second, state: 'archived' }, grandchild]))
  assert.equal(team() === null, true, 'a remaining grandchild does not count as a direct child')
  assert.equal(view.el.querySelector('.team-tabpanel') === null, true)
  assert.equal(view.el.querySelector(`[data-tab="${defaultTab}"]`)?.classList.contains('on'), true)
  await view.render(node([first]))
  assert.equal(team()?.querySelector('.tab-count')?.textContent, '1')
  assert.equal(view.el.querySelector(`[data-tab="${defaultTab}"]`)?.classList.contains('on'), true, 'rehire does not restore the abandoned Team selection')
})
