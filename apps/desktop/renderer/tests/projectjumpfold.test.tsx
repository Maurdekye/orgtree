import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createPortal } from 'react-dom'
import { FakeServer, flush, inAct, installFetch, JSDOM, mountView } from './harness'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { DESK_JUMP_FOLD_LIMIT, JUMP_FOLD_KEY, setJumpFoldOn, type CanvasNode } from '../src/canvas/shared'
import { SurfaceDocumentOwner } from '../src/popout'
import type { TreePayload } from '../src/types'

async function fixture(t: TestContext, count: number, host = 'canvas') {
  localStorage.removeItem(JUMP_FOLD_KEY)
  installFetch(new FakeServer())
  const member = (id: string, kind = 'agent'): CanvasNode => ({ id, kind, state: 'live', tier: kind === 'project' ? 'project' : 'haiku',
    children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } } as CanvasNode)
  const node = { ...member('project', 'project'), parent: 'boss', children: Array.from({ length: count }, (_, i) =>
    member('member' + i, i === 0 ? 'project' : 'agent')) }
  const boss = member('boss')
  const tree = { slug: 'org', roots: [boss, node] } as unknown as TreePayload
  const jumped: string[] = []
  const popup = host === 'pop-out' ? new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' }) : null
  const doc = popup?.window.document ?? document
  const body = <div data-host={host}><ProjectDesk node={node} slug="org" tree={tree}
    map={new Map([[boss.id, boss], [node.id, node]])} op={async () => ({})} toast={() => {}}
    refs={{ world: { org: 'org' } } as never} bare={host !== 'canvas'} onJump={id => jumped.push(id)} /></div>
  const view = await mountView(popup
    ? <SurfaceDocumentOwner owner={doc}>{createPortal(body, doc.body)}</SurfaceDocumentOwner> : body, el => el)
  t.after(async () => { await view.unmount(); popup?.window.close(); localStorage.removeItem(JUMP_FOLD_KEY) })
  await inAct(async () => { await flush(4) })
  const el = doc.querySelector<HTMLElement>('[data-host]')!
  // the parent's link is one of the header cards (user 2026-10-19 19:02Z);
  // the members keep their own row above the message box, on every tab (19:58Z)
  assert.equal(el.querySelector('.cc-head .project-head-cards .desk-nav-chip')?.getAttribute('data-copy-agent-name'), 'boss')
  const rows = el.querySelectorAll<HTMLElement>('.desk-nav')
  assert.equal(rows.length, 1, 'the member row stays separate from the header row')
  return { row: rows[0]!, jumped }
}

for (const host of ['canvas', 'pinned', 'pop-out', 'Attention']) {
  test(`${host}: 17 project member cards use the agent collapse and expansion control`, async t => {
    const { row, jumped } = await fixture(t, DESK_JUMP_FOLD_LIMIT + 1, host)
    const fold = row.querySelector<HTMLButtonElement>('[data-audience-fold]')
    assert.ok(fold, 'more than 16 member cards start collapsed')
    assert.equal(fold.textContent, '17 jump cards')
    assert.equal(fold.getAttribute('aria-expanded'), 'false')
    assert.equal(row.querySelectorAll('.desk-nav-chip').length, 0)
    await inAct(() => { fold.click() })
    assert.equal(fold.getAttribute('aria-expanded'), 'true')
    assert.equal(row.querySelectorAll('.desk-nav-chip').length, 17)
    await inAct(() => { row.querySelector<HTMLButtonElement>('[data-copy-agent-name="member0"]')!.click() })
    assert.deepEqual(jumped, ['member0'], 'nested project members retain navigation')
    await inAct(() => { fold.click() })
    assert.equal(row.querySelectorAll('.desk-nav-chip').length, 0, 'collapse hides all members again')
  })
}

test('exactly 16 project cards stay visible', async t => {
  const { row } = await fixture(t, DESK_JUMP_FOLD_LIMIT)
  assert.equal(!!row.querySelector('[data-audience-fold]'), false)
  assert.equal(row.querySelectorAll('.desk-nav-chip').length, 16)
})

test('the shared collapse preference updates an already open project desk', async t => {
  const { row } = await fixture(t, DESK_JUMP_FOLD_LIMIT + 1)
  await inAct(() => { setJumpFoldOn(false) })
  assert.equal(!!row.querySelector('[data-audience-fold]'), false)
  assert.equal(row.querySelectorAll('.desk-nav-chip').length, 17)
  await inAct(() => { setJumpFoldOn(true) })
  assert.equal(row.querySelectorAll('.desk-nav-chip').length, 0, 'reenabling the setting collapses the cards')
  assert.equal(row.querySelector('[data-audience-fold]')?.getAttribute('aria-expanded'), 'false')
})
