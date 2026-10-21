import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import { compatibilityWorkFixture } from './workcompat.fixture'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ReactElement } from 'react'
import { AgentDocketView, DocketModal } from '../src/canvas/docket'
import { AgentDocketModal } from '../src/canvas/agentdocket'
import { TeamDocketModal } from '../src/canvas/teamdocket'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { OwnedDeskChat } from '../src/canvas/desk'
import { rememberDesk } from '../src/canvas/desktabs'
import { resetConvos } from '../src/convo'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload, WorkItem } from '../src/types'

const noop = () => {}
const item = (slug: string, extra: Partial<WorkItem> = {}): WorkItem => ({
  slug, title: slug, objective: 'Detail ' + slug, rev: 1, kind: 'code', status: 'open', archived: false,
  owner: { node: 'worker', generation: 1 }, owner_current: true, participants: [], questions: [],
  done_so_far: [], working_on_next: [], dependencies: [], evidence: [], history: [], dismissals: [],
  acceptance: [], attention_sources: [], effective_attention: false, manual_attention: null,
  at: '2026-10-21T12:00:00Z', updated_at: '2026-10-21T12:00:00Z', docket_at: '2026-10-21T12:00:00Z',
  ...extra,
} as WorkItem)
const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id, title: id, state: 'live', tier: 'sol', model_id: 'sol', children: [], seat: 1, grant: 0,
  free: 0, scope: { tools: {}, add_dirs: [] }, turns: [], lineage: [], audiences_held: [],
  mail_pending: 0, generation: 1, ...extra,
} as unknown as CanvasNode)
const selected = (el: HTMLElement) => el.querySelector('.docket-row.on .mfrom')?.textContent ?? null
const rowNames = (el: HTMLElement) => [...el.querySelectorAll('.docket-row .mfrom')].map(e => e.textContent)
const row = (el: HTMLElement, name: string) => {
  const found = [...el.querySelectorAll<HTMLElement>('.docket-row')].find(e => e.querySelector('.mfrom')?.textContent === name)
  assert.ok(found, 'row exists: ' + name)
  return found
}
const click = async (el: HTMLElement) => inAct(async () => { el.click(); await flush(8) })
type Surface = 'org' | 'agent modal' | 'team modal' | 'project modal' | 'agent desk' | 'project desk'
let serial = 0

async function scenario(body: (ctx: {
  slug: string; served: { items: WorkItem[]; archived: WorkItem[]; backlogged: WorkItem[] }
  mount: (surface: Surface, jumpTo?: string) => Promise<Awaited<ReturnType<typeof mountView>>>
  direct: (mine: WorkItem[] | null, nid?: string, org?: string, archived?: boolean) => ReactElement
  mountDirect: (mine: WorkItem[] | null) => Promise<Awaited<ReturnType<typeof mountView>>>
  org: (jumpTo?: string) => ReactElement
}) => Promise<void>) {
  useFakeClock()
  window.localStorage.removeItem('orgtree.docket.group')
  window.localStorage.removeItem('orgtree.docket.sort')
  const slug = 'opening-all-' + ++serial
  const worker = node('worker'), boss = node('boss', { children: [worker] })
  const project = node('project', { kind: 'project', tier: 'project', children: [worker] })
  const tree = { slug, name: slug, roots: [boss, project], tiers: { sol: 1 }, asks: [], epoch: 1, rev: 1 } as unknown as TreePayload
  const facts = new Map(), map = new Map([boss, project, worker].map(n => [n.id, n]))
  const refs = { world: { org: slug, items: undefined, agents: new Map([['worker', 'sol']]), handles: new Set(['item', 'agent'] as const) }, onOpen: noop }
  const original = globalThis.fetch
  installFetch(new FakeServer())
  const fallback = globalThis.fetch
  const served = { items: [item('child', { parent: 'parent' }), item('parent'), item('second')], archived: [] as WorkItem[], backlogged: [] as WorkItem[] }
  const ok = (payload: unknown) => Promise.resolve(new Response(JSON.stringify(payload)))
  const compatible = compatibilityWorkFixture(((url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url), one = /\/work-items\/([^/?]+)$/.exec(path)
    if (one) return ok({ item: [...served.items, ...served.archived, ...served.backlogged].find(it => it.slug === one[1]) })
    if (path.includes('/work-items')) return ok({ ...served, counts: { active: served.items.length, archived: served.archived.length, backlogged: served.backlogged.length } })
    return fallback(url, init)
  }) as typeof fetch)
  // http/docket.rs::page interprets agent=<project> as its subtree. The
  // compatibility adapter knows only agent identities; model that server rule.
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) =>
    compatible(String(url).replace('agent=project', 'team=project'), init)) as typeof fetch
  const org = (jumpTo?: string) => <DocketModal slug={slug} tree={tree} toast={noop} close={noop} jumpTo={jumpTo} />
  const direct = (mine: WorkItem[] | null, nid = 'worker', scope = slug, archived = false) => <AgentDocketView
    slug={scope} nid={nid} mine={mine} facts={facts} toast={noop} refs={refs} showArchived={archived} />
  let view: Awaited<ReturnType<typeof mountView>> | undefined
  const mount = async (element: ReactElement) => {
    view = await mountView(element, el => el)
    await inAct(async () => { await flush(20) })
    return view
  }
  try {
    await body({ slug, served, direct, org, mountDirect: mine => mount(direct(mine)), mount: (surface, jumpTo) => {
      if (surface === 'org') return mount(org(jumpTo))
      if (surface === 'agent modal') return mount(<AgentDocketModal slug={slug} nid="worker" tree={tree} toast={noop} close={noop} refs={refs} />)
      if (surface === 'team modal') return mount(<TeamDocketModal slug={slug} nid="boss" tree={tree} toast={noop} close={noop} refs={refs} />)
      if (surface === 'project modal') return mount(<AgentDocketModal slug={slug} nid="project" tree={tree} toast={noop} close={noop} refs={refs} />)
      const nd = surface === 'agent desk' ? worker : project
      rememberDesk(slug, nd.id, 'tab', 'docket')
      return surface === 'agent desk'
        ? mount(<OwnedDeskChat node={nd} map={map} slug={slug} toast={noop} op={async () => ({})} />)
        : mount(<ProjectDesk node={nd} map={map} slug={slug} tree={tree} toast={noop} refs={refs} op={async () => ({})} />)
    } })
  } finally {
    await view?.unmount()
    globalThis.fetch = original
    resetConvos()
    realClock()
  }
}

for (const surface of ['org', 'agent modal', 'team modal', 'project modal', 'agent desk', 'project desk'] as const) {
  test(`${surface}: opens the first displayed nested row and preserves clear across refresh`, async () => {
    await scenario(async ({ served, mount }) => {
      const view = await mount(surface)
      assert.equal(rowNames(view.el)[0], 'parent', 'positive control: nesting promotes the parent')
      assert.equal(selected(view.el), 'parent')
      assert.ok(view.el.querySelector('.mailer-read')?.textContent?.includes('Detail parent'))
      await click(row(view.el, 'parent'))
      assert.equal(selected(view.el), null, 'click selected row deliberately clears')
      served.items = [item('newest', { updated_at: '2026-10-21T15:00:00Z' }), ...served.items]
      await inAct(async () => { await advance(15000); await flush(20) })
      assert.equal(selected(view.el), null, 'refresh must not select again')
      await click(row(view.el, 'second'))
      assert.equal(selected(view.el), 'second', 'explicit later choice still works')
    })
  })
}

for (const group of ['none', 'status', 'agent']) test(`node docket initial order follows ${group} grouping and chosen sort`, async () => {
  await scenario(async ({ mountDirect, served }) => {
    window.localStorage.setItem('orgtree.docket.group', group)
    window.localStorage.setItem('orgtree.docket.sort', 'created')
    const list = [item('older', { at: '2026-10-20T00:00:00Z' }), ...served.items]
    const view = await mountDirect(list)
    assert.equal(selected(view.el), rowNames(view.el)[0])
    assert.equal(selected(view.el), 'second', 'created sort uses descending slug when stamps tie')
  })
})

test('node docket waits for initial load, then keeps the user choice through reordered data', async () => {
  await scenario(async ({ mountDirect, direct, served }) => {
    const view = await mountDirect(null)
    assert.equal(selected(view.el), null)
    await view.render(direct(served.items))
    await inAct(async () => { await flush(8) })
    assert.equal(selected(view.el), 'parent')
    await click(row(view.el, 'second'))
    await view.render(direct([item('newest', { updated_at: '2026-10-21T15:00:00Z' }), ...served.items]))
    assert.equal(selected(view.el), 'second')
  })
})

test('node docket consumes an empty first load, but a fresh open selects again', async () => {
  await scenario(async ({ mountDirect, direct, served }) => {
    const view = await mountDirect([])
    assert.equal(selected(view.el), null)
    await view.render(direct(served.items))
    assert.equal(selected(view.el), null, 'later arrivals do not re-arm opening')
    await view.render(<div />)
    await view.render(direct(served.items))
    await inAct(async () => { await flush(8) })
    assert.equal(selected(view.el), 'parent')
  })
})

test('node/org scope changes select that scope first row, without inheriting a clear', async () => {
  await scenario(async ({ mountDirect, direct, served, slug }) => {
    const view = await mountDirect(served.items)
    await click(row(view.el, 'parent'))
    await view.render(direct([item('new-node')], 'other'))
    assert.equal(selected(view.el), 'new-node')
    await click(row(view.el, 'new-node'))
    await view.render(direct([item('new-org')], 'other', slug + '-different'))
    assert.equal(selected(view.el), 'new-org')
  })
})

test('node docket selects a shown archived row when it is the first shown ticket', async () => {
  await scenario(async ({ mountDirect, direct }) => {
    const archived = [item('archived-first', { archived: true, status: 'done' })]
    const view = await mountDirect(null)
    await view.render(direct(archived, 'worker', undefined, true))
    assert.equal(selected(view.el), 'archived-first')
    assert.ok(view.el.querySelector('.mailer-read')?.textContent?.includes('Detail archived-first'))
  })
})

test('ticket reference wins over opening default and remains selected after refresh', async () => {
  await scenario(async ({ mount, served }) => {
    const view = await mount('org', 'second')
    assert.equal(selected(view.el), 'second')
    served.items.unshift(item('newest', { updated_at: '2026-10-21T15:00:00Z' }))
    await inAct(async () => { await advance(5000); await flush(15) })
    assert.equal(selected(view.el), 'second')
  })
})
