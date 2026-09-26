import './harness'
import { fireResize, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { DocketModal } from '../src/canvas/docket'
import type { TreePayload, WorkItem } from '../src/types'

const TREE = { slug: 'org1', name: 'Org 1', roots: [], asks: [], epoch: 1, rev: 1 } as unknown as TreePayload
const noop = () => {}
const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('.docket-row')]
const names = (host: HTMLElement) => rows(host).map(row => row.querySelector('.mfrom')!.textContent)

async function fixture(t: TestContext, count = 1000) {
  useFakeClock()
  window.localStorage.clear()
  const proto = window.HTMLElement.prototype
  let height = 240, width = 300
  const old = new Map(['clientHeight', 'clientWidth', 'offsetHeight', 'scrollIntoView'].map(key => [key, Object.getOwnPropertyDescriptor(proto, key)]))
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get() { return this.classList.contains('mailer-list') ? height : 0 } })
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get() { return this.classList.contains('mailer-list') ? width : 0 } })
  Object.defineProperty(proto, 'offsetHeight', { configurable: true, get() {
    if (this.classList.contains('docket-group-head')) return 30
    if (!this.classList.contains('docket-row')) return 0
    const index = Number(this.querySelector('.mfrom')?.textContent?.split('-')[1] ?? 0)
    return (width < 250 ? 72 : 48) + (index % 3) * 8
  } })
  Object.defineProperty(proto, 'scrollIntoView', { configurable: true, value: noop })
  const renderReads = new Map<string, number>()
  const items = Array.from({ length: count }, (_, i) => ({
    slug: 'ticket-' + i, rev: 1, kind: 'code', title: 'Task ' + i,
    objective: 'Measure the renderer.', status: 'in_progress', blocked_reason: null,
    archived: false, archived_at: null, owner: null, owner_current: true, owner_state: 'live',
    reviewer: null, participants: [], created_by: null, last_updater: null,
    at: '2026-09-26T08:00:00Z', updated_at: '2026-09-26T08:00:00Z',
    done_so_far: [], working_on_next: [], manual_attention: null, dismissals: [],
    questions: [], effective_attention: false,
    get attention_sources() { renderReads.set(this.slug, (renderReads.get(this.slug) ?? 0) + 1); return [] },
    acceptance: [], dependencies: [], evidence: [], delivery: null, accepted: null,
    superseded_by: null, history: [],
  } as WorkItem))
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => ({ ok: true, status: 200, headers: new Headers(),
    json: async () => ({ items, archived: [], backlogged: [], counts: { active: count, archived: 0, backlogged: 0 } }),
  })) as typeof fetch
  const panel = (jumpTo: string | null = null) => <DocketModal slug="org1" toast={noop} close={noop} tree={TREE} jumpTo={jumpTo} />
  const view = await mountView(panel(), host => host)
  t.after(async () => {
    await view.unmount()
    globalThis.fetch = originalFetch
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(proto, key, descriptor)
      else Reflect.deleteProperty(proto, key)
    }
    realClock()
  })
  await flush()
  const list = view.el.querySelector<HTMLDivElement>('.mailer-list')!
  return { view, list, panel, renderReads,
    resize: async (h: number, w: number) => { height = h; width = w; await inAct(() => fireResize(list)); await flush() },
    scroll: async (top: number) => { await inAct(() => { list.scrollTop = top; list.dispatchEvent(new window.Event('scroll')) }); await flush() },
  }
}

test('large docket mounts a bounded viewport and can reach its last item', async t => {
  const { view, list, panel } = await fixture(t, 2000)
  assert.ok(rows(view.el).length > 0 && rows(view.el).length < 30)
  assert.ok(names(view.el).includes('ticket-0'), 'initial viewport was really populated')
  await view.render(panel('ticket-1999'))
  await flush()
  assert.ok(list.scrollTop > 0, 'reference jump scrolls before the distant row mounts')
  assert.ok(names(view.el).includes('ticket-1999'), 'last item remains reachable')
  assert.ok(rows(view.el).length < 30)
  assert.equal(view.el.querySelector('.docket-slug-text')?.textContent, 'ticket-1999')
})

test('selecting a row does not render its unchanged neighbours', async t => {
  const { view, renderReads } = await fixture(t)
  const first = rows(view.el)[0]
  assert.ok((renderReads.get('ticket-0') ?? 0) > 0, 'read counter observed a real row mount')
  renderReads.clear()
  await inAct(() => first.click())
  await flush()
  assert.ok(first.classList.contains('on'), 'the selection changed')
  assert.ok((renderReads.get('ticket-0') ?? 0) > 0, 'selected row rendered')
  for (const [slug, reads] of renderReads) if (slug !== 'ticket-0') assert.equal(reads, 0, slug)
})

test('scrolling and resizing variable-height rows keeps the selection mounted in the detail pane', async t => {
  const { view, scroll, resize } = await fixture(t)
  await inAct(() => rows(view.el)[0].click())
  await scroll(12000)
  assert.ok(!names(view.el).includes('ticket-0'), 'old rows were unmounted')
  assert.equal(view.el.querySelector('.docket-slug-text')?.textContent, 'ticket-0', 'detail selection survives')
  const small = rows(view.el).length
  await resize(600, 300)
  assert.ok(rows(view.el).length > small, 'larger viewport mounts more rows')
  await resize(600, 220)
  assert.ok(rows(view.el).length > 0, 'narrower, taller rows remain visible')
  assert.ok(rows(view.el).every(row => row.offsetHeight >= 72), 'resize delivered changed row measurements')
  assert.ok(rows(view.el).length < 35)
  await scroll(0)
  assert.ok(names(view.el).includes('ticket-0'), 'returning to the beginning is still possible')
  assert.ok(rows(view.el).find(row => row.querySelector('.mfrom')?.textContent === 'ticket-0')?.classList.contains('on'))
})
