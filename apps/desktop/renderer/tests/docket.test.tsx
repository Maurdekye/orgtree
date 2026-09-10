// docket.test.tsx — test suite for the native work docket and inbox navigation.
import './harness'
import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { AgentDocketView, DocketModal, DocketToolbarButton } from '../src/canvas/docket'
import { ago } from '../src/canvas/shared'
import { InboxPanel, SenderChip } from '../src/App'
// The inbox now scrolls to its oldest unread on mount; jsdom has no layout.
window.HTMLElement.prototype.scrollIntoView = () => {}
import { NodeInboxModal, OrgInboxModal } from '../src/canvas/mail'
import type { AskInfo, CanvasNode, MailEntry, MailPayload, OrgInboxEntry, TreePayload, TreeNode, WorkItem } from '../src/types'

interface Call { method: string; url: string; body?: unknown }

function mockWorkItems(activeItems: WorkItem[], archivedItems: WorkItem[] = [],
                       extraCalls?: Call[], backlogItems: WorkItem[] = []): Call[] {
  const calls: Call[] = extraCalls ?? [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    ((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const path = String(url)
      // allow-attachments-in-contextual-reply-composers: `uploadFile` posts
      // the raw File as `body`, never JSON — `JSON.parse` on that would
      // throw, so it must be checked before the JSON branch, not folded
      // into it
      const isUpload = method === 'POST' && path.includes('/upload')
      const body = isUpload ? undefined : init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url: path, body })
      const headers = new Headers()
      const ok = (payload: unknown) => Promise.resolve(
        { ok: true, status: 200, headers, json: () => Promise.resolve(payload) })

      if (isUpload) {
        // real de-duplication (colliding names get a numeric suffix) is
        // server-side and not modelled here — same limit as harness.ts's
        // FakeServer /upload stub
        const name = new URL(path, 'http://localhost').searchParams.get('name') ?? 'file'
        return ok({ path: `uploads/${name}`, bytes: 0 })
      }
      if (method === 'POST' && path.includes('/dismiss-attention')) {
        const m = path.match(/\/work-items\/([^/]+)\/dismiss-attention$/)
        const id = m ? m[1] : ''
        const found = [...activeItems, ...archivedItems, ...backlogItems]
          .find((x) => x.slug === id)
        return ok({ item: found ? { ...found, manual_attention: null, status: 'blocked' } : null })
      }
      if (method === 'POST' && path.includes('/reply')) {
        const m = path.match(/\/work-items\/([^/]+)\/reply$/)
        const id = m ? m[1] : ''
        const found = [...activeItems, ...archivedItems].find((x) => x.slug === id)
        // the server replies to the item's OWNER (ledger.work_reply_target),
        // so the mock answers about the owner too — a mock that still spoke
        // about the last updater would let the panel name one agent while the
        // reply reached another and nothing here would notice
        const isDeferred = found?.owner?.node === 'archived-agent'
        return ok({ accepted: true, to: found?.owner?.node ?? 'agent', deferred: isDeferred })
      }
      if (method === 'GET' && path.includes('/work-items')) {
        // the two filters are INDEPENDENT query flags, and a group is served
        // only when its flag is set — the same contract ledger.work_list keeps
        const wantArch = path.includes('archived=1')
        const wantBack = path.includes('backlogged=1')
        return ok({
          items: activeItems,
          ...(wantArch ? { archived: archivedItems } : {}),
          ...(wantBack ? { backlogged: backlogItems } : {}),
          counts: {
            attention: activeItems.filter((x) => x.effective_attention).length,
            active: activeItems.filter((x) => x.status !== 'backlogged').length,
            archived: archivedItems.length,
            backlogged: backlogItems.length,
          },
          now: '2026-09-05T10:00:00.000Z',
        })
      }
      if (method === 'GET' && path.includes('/inbox')) {
        return ok({ pending: [], delivered: [], sent: [] })
      }
      return ok({})
    }) as typeof fetch
  return calls
}

// ⚠ ROWS ARE NAMED BY SLUG NOW (user 2026-09-05), not by title. A fixture that
// gives each item a distinct TITLE but leaves the default slug would render N
// rows all reading "test-work-item", and every ordering, grouping and
// "which row is this" assertion below would go vacuous while still passing.
// So a test that names a title and not a slug gets that title as its slug.
// Tests that care about slug SHAPE (kebab, substrings, boundaries) pass one
// explicitly, and the reference-linking suite uses realistic slugs throughout.
/** the row whose name line reads `t` — BY TITLE, never by index (grouping is a
 *  persisted preference, so an index silently follows the previous test) */
const rowFor = (el: HTMLElement, t: string) => rows(el)[titles(el).indexOf(t)] as HTMLElement

const mkItem = (o: Partial<WorkItem>): WorkItem => ({
  ...mkItemBase(o),
  ...(o.title !== undefined && o.slug === undefined ? { slug: o.title } : {}),
})

const mkItemBase = (o: Partial<WorkItem>): WorkItem => ({
  slug: 'test-work-item',
  rev: 1,
  kind: 'code',
  title: 'Test Work Item',
  objective: 'Test objective',
  status: 'in_progress',
  blocked_reason: null,
  archived: false,
  archived_at: null,
  owner: { node: 'agent1', generation: 1 },
  owner_current: true,
  owner_state: 'live',
  reviewer: null,
  participants: [],
  created_by: { node: 'agent1', generation: 1 },
  at: '2026-09-05T08:00:00.000Z',
  updated_at: '2026-09-05T09:00:00.000Z',
  done_so_far: ['First step completed'],
  working_on_next: ['Second step in progress'],
  docket_at: '2026-09-05T09:00:00.000Z',
  last_updater: { node: 'agent1', generation: 1 },
  manual_attention: null,
  dismissals: [],
  questions: [],
  effective_attention: false,
  attention_sources: [],
  acceptance: [],
  dependencies: [],
  evidence: [],
  delivery: null,
  accepted: null,
  superseded_by: null,
  history: [],
  ...o,
})

const mkTree = (o?: Partial<TreePayload>): TreePayload => ({
  slug: 'org1',
  name: 'Org 1',
  epoch: 1,
  rev: 1,
  roots: [],
  work_items_summary: { attention: 0, active: 0 },
  user_inbox_count: 0,
  user_inbox_urgent_count: 0,
  asks: [],
  asks_open: 0,
  ...o,
})

function uiTest(name: string, body: (mount: (v: React.ReactElement)
  => Promise<{ el: HTMLElement; render: (v: React.ReactElement) => Promise<unknown> }>)
  => Promise<void>) {
  test(name, async (t: TestContext) => {
    useFakeClock()
    let open: { el: HTMLElement; unmount: () => Promise<void> } | null = null
    t.after(async () => { try { await open?.unmount() } finally { realClock() } })
    await body(async (v) => {
      const view = await mountView(v, (host) => host)
      open = view
      // `render` re-renders the SAME root with new props — mounting a second
      // view would test a fresh component, which is the opposite of asking
      // what happens to state that is already there
      return { el: view.el, render: view.render }
    })
  })
}

const noop = () => {}
const rows = (el: HTMLElement) => [...el.querySelectorAll('.mailrow.docket-row')]
const pane = (el: HTMLElement) => el.querySelector('.mailer-read')
const showArchivedBox = (el: HTMLElement) =>
  el.querySelector('.docket-showarchived input') as HTMLInputElement
/** the arrangement is a PERSISTED preference, so a test that asserts the
 *  default must clear it first — otherwise it silently inherits whatever the
 *  previous test chose, and "the default is No group" stops being tested */
const forgetGroupChoice = () => window.localStorage.removeItem('orgtree.docket.group')
const showBacklogBox = (el: HTMLElement) =>
  el.querySelector('.docket-showbacklog input') as HTMLInputElement
const groupSelect = (el: HTMLElement) =>
  el.querySelector('.docket-group-select') as HTMLSelectElement
const titles = (el: HTMLElement) =>
  rows(el).map((r) => r.querySelector('.l1 .mfrom')?.textContent ?? '')
const headings = (el: HTMLElement) =>
  [...el.querySelectorAll('.docket-group-head > span:first-child')]
    .map((h) => h.textContent ?? '')
/** drive the <select> the way a user does, through its change handler */
async function chooseGroup(el: HTMLElement, value: string) {
  const sel = groupSelect(el)
  await inAct(() => {
    sel.value = value
    sel.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await flush()
}

const docketModal = (extra?: Partial<{
  close: () => void
  onFocusAgent: (id: string) => void
  tree: TreePayload
  toast: (lines: string[]) => void
  slug: string
  jumpTo: string | null
  jumpSeq: number
}>) => (
  <DocketModal slug={extra?.slug ?? 'org1'} toast={extra?.toast ?? noop}
    close={extra?.close ?? noop} jumpTo={extra?.jumpTo ?? null}
    jumpSeq={extra?.jumpSeq}
    tree={extra?.tree ?? mkTree()} onFocusAgent={extra?.onFocusAgent} />
)

uiTest('§1 an empty org says so rather than rendering a blank panel', async (mount) => {
  mockWorkItems([])
  const { el } = await mount(docketModal())
  await flush()
  assert.equal(rows(el).length, 0)
  assert.match(el.textContent ?? '', /no work items yet/)
})

uiTest('§2 the row is NAMED BY ITS SLUG, and carries status, time and the assignment', async (mount) => {
  mockWorkItems([mkItem({
    slug: 'build-the-work-docket',
    title: 'Build the work docket',
    status: 'in_progress',
    docket_at: '2026-09-05T09:55:00.000Z',
    owner: { node: 'luna-reserve', generation: 1 },
    last_updater: { node: 'codex-checklist', generation: 1 },
  })])
  const { el } = await mount(docketModal())
  await flush()
  assert.equal(rows(el).length, 1)
  const r = rows(el)[0]!
  assert.equal(r.querySelector('.l1 .mfrom')?.textContent, 'build-the-work-docket')
  assert.ok((r.querySelector('.l1 .mtime')?.textContent ?? '').length > 0)
  assert.match(r.querySelector('.l2')?.textContent ?? '', /In progress/)
  // ASSIGNMENT IS OWNERSHIP (user 2026-09-05): the name in the row is who
  // HOLDS the item, not whoever wrote the last update.
  assert.equal(r.querySelector('.l2 .docket-updater')?.textContent, 'luna-reserve')
  // THE DESCRIPTIVE TITLE IS NOT PRINTED IN THE LIST (user 2026-09-05) — it is
  // the row's hover text and nothing else. Asserting only "the slug is there"
  // would pass on a row that printed both.
  assert.equal(r.getAttribute('title'), 'Build the work docket')
  assert.ok(!(r.textContent ?? '').includes('Build the work docket'),
    'the descriptive title is still printed in the list row')
})

uiTest('§3 the left row names the ASSIGNMENT, not the last updater', async (mount) => {
  // The two names are DIFFERENT in this fixture on purpose: the row printed
  // the last updater until 2026-09-05, so a fixture where owner and updater
  // agree would pass on either behaviour and pin nothing.
  mockWorkItems([mkItem({
    title: 'Item A',
    owner: { node: 'astras-entrance-exam', generation: 1 },
    last_updater: { node: 'luna-reserve', generation: 1 },
  }), mkItem({
    title: 'Item B',
    owner: null,
    last_updater: { node: 'luna-reserve', generation: 1 },
  })])
  const { el } = await mount(docketModal())
  await flush()
  const r = rows(el)[0]!
  assert.equal(r.querySelector('.l2 .docket-updater')?.textContent, 'astras-entrance-exam')
  assert.ok(!r.querySelector('.l2')?.textContent?.includes('luna-reserve'),
    'the row is still printing the last updater')
  // an item nobody holds SAYS SO — an empty slot reads as "still loading"
  const r2 = rows(el)[1]!
  assert.equal(r2.querySelector('.l2 .docket-updater')?.textContent, 'Unassigned')
})

uiTest('§4 active, attention and archived rows get correct classes and labels', async (mount) => {
  mockWorkItems([
    mkItem({ title: 'Active Item', status: 'in_progress', effective_attention: false, archived: false }),
    mkItem({ title: 'Attn Item', status: 'blocked', effective_attention: true, attention_sources: ['manual'], archived: false }),
  ], [
    mkItem({ title: 'Archived Item', status: 'done', effective_attention: false, archived: true }),
  ])
  const { el } = await mount(docketModal())
  await flush()
  // Reveal archived
  await inAct(() => showArchivedBox(el).click())
  await flush()

  const rList = rows(el)
  assert.equal(rList.length, 3)
  assert.ok(rList[0]!.classList.contains('active'))
  assert.match(rList[0]!.querySelector('.l2')?.textContent ?? '', /In progress/)

  assert.ok(rList[1]!.classList.contains('attention'))
  assert.match(rList[1]!.querySelector('.l2')?.textContent ?? '', /Needs attention/)

  assert.ok(rList[2]!.classList.contains('archived'))
  assert.match(rList[2]!.querySelector('.l2')?.textContent ?? '', /Done/)
})

uiTest('§5 show archived checkbox toggles archived items below active retaining recency order', async (mount) => {
  mockWorkItems([
    mkItem({ title: 'Active 1' }),
  ], [
    mkItem({ title: 'Archived 1', archived: true }),
    mkItem({ title: 'Archived 2', archived: true }),
  ])
  const { el } = await mount(docketModal())
  await flush()
  assert.equal(rows(el).length, 1, 'archived hidden initially')

  await inAct(() => showArchivedBox(el).click())
  await flush()
  const rList = rows(el)
  assert.equal(rList.length, 3, 'archived shown below active')
  assert.equal(rList[0]!.querySelector('.l1 .mfrom')?.textContent, 'Active 1')
  assert.equal(rList[1]!.querySelector('.l1 .mfrom')?.textContent, 'Archived 1')
  assert.equal(rList[2]!.querySelector('.l1 .mfrom')?.textContent, 'Archived 2')
})

uiTest('§6 right pane displays done so far and working on / next lists, with None when empty', async (mount) => {
  mockWorkItems([mkItem({
    title: 'Item with partial lists',
    done_so_far: ['Created schemas', 'Added endpoints'],
    working_on_next: [],
  })])
  const { el } = await mount(docketModal())
  await flush()
  await inAct(() => (rows(el)[0] as HTMLElement).click())
  await flush()

  const p = pane(el)!
  assert.ok(p, 'pane rendered')
  const lists = p.querySelectorAll('.docket-list')
  assert.equal(lists.length, 2)

  const doneHeading = lists[0]!.querySelector('.docket-list-heading')?.textContent
  assert.equal(doneHeading, 'DONE SO FAR')
  const doneItems = [...lists[0]!.querySelectorAll('li')].map((li) => li.textContent)
  assert.deepEqual(doneItems, ['Created schemas', 'Added endpoints'])

  const nextHeading = lists[1]!.querySelector('.docket-list-heading')?.textContent
  assert.equal(nextHeading, 'WORKING ON / NEXT')
  const nextEmpty = lists[1]!.querySelector('.docket-list-empty')?.textContent
  assert.equal(nextEmpty, 'None')
})

uiTest('§7 right pane assignment name is a clickable agent jump that closes modal', async (mount) => {
  let focused: string | null = null
  let closed = false
  mockWorkItems([mkItem({
    title: 'Work Item',
    owner: { node: 'luna-reserve', generation: 1 },
    last_updater: { node: 'codex-checklist', generation: 1 },
  })])
  const { el } = await mount(docketModal({
    close: () => { closed = true },
    onFocusAgent: (id) => { focused = id },
  }))
  await flush()
  await inAct(() => (rows(el)[0] as HTMLElement).click())
  await flush()

  const sub = el.querySelector('.docket-pane-sub')!
  assert.match(sub.textContent ?? '', /Assigned to/,
    'the subtitle still reads as "updated by"')
  const subOwner = sub.querySelector('button.cc-name-jump') as HTMLButtonElement
  assert.ok(subOwner, 'clickable assignment link in subtitle')
  assert.equal(subOwner.textContent?.trim(), 'luna-reserve')
  await inAct(() => subOwner.click())
  assert.ok(closed, 'modal was closed on agent click')
  assert.equal(focused, 'luna-reserve', 'focused the agent the item is assigned to')
})

uiTest('§8 manual attention box renders reason and clickable author', async (mount) => {
  let focused: string | null = null
  let closed = false
  mockWorkItems([mkItem({
    title: 'Work Item',
    effective_attention: true,
    attention_sources: ['manual'],
    manual_attention: {
      reason: 'Need user confirmation on wire format',
      at: '2026-09-05T09:40:00.000Z',
      by: { node: 'codex-checklist', generation: 1 },
      set_rev: 2,
    },
  })])
  const { el } = await mount(docketModal({
    close: () => { closed = true },
    onFocusAgent: (id) => { focused = id },
  }))
  await flush()
  await inAct(() => (rows(el)[0] as HTMLElement).click())
  await flush()

  const attnBox = el.querySelector('.docket-attention-box')
  assert.ok(attnBox, 'attention box rendered')
  assert.match(attnBox.textContent ?? '', /Need user confirmation on wire format/)

  const authorBtn = attnBox.querySelector('button.cc-name-jump') as HTMLButtonElement
  assert.ok(authorBtn, 'author button rendered')
  assert.equal(authorBtn.textContent?.trim(), 'codex-checklist')
  await inAct(() => authorBtn.click())
  assert.ok(closed)
  assert.equal(focused, 'codex-checklist')
})

uiTest('§9 question box renders attached AskCard and clickable asker', async (mount) => {
  let focused: string | null = null
  let closed = false
  const ask: AskInfo = {
    id: 'ask-1',
    node: 'luna-route-check',
    at: '2026-09-05T09:30:00.000Z',
    work_items: ['w1'],
    tabs: [{ index: 0, question: 'Should we keep v3 format?', work_item: 'w1' }],
  }
  const tree = mkTree({ asks: [ask], asks_open: 1 })
  mockWorkItems([mkItem({
    title: 'Work Item',
    effective_attention: true,
    attention_sources: ['question'],
    questions: [{
      ask_id: 'ask-1',
      node: 'luna-route-check',
      rev: 1,
      at: '2026-09-05T09:30:00.000Z',
      tabs: [{ index: 0, question: 'Should we keep v3 format?' }],
    }],
  })])
  const { el } = await mount(docketModal({
    tree,
    close: () => { closed = true },
    onFocusAgent: (id) => { focused = id },
  }))
  await flush()
  await inAct(() => (rows(el)[0] as HTMLElement).click())
  await flush()

  const qBox = el.querySelector('.docket-question-box')
  assert.ok(qBox, 'question box rendered')
  const askerBtn = qBox.querySelector('.docket-question-head button.cc-name-jump') as HTMLButtonElement
  assert.ok(askerBtn, 'asker jump link rendered')
  assert.equal(askerBtn.textContent?.trim(), 'luna-route-check')

  await inAct(() => askerBtn.click())
  assert.ok(closed)
  assert.equal(focused, 'luna-route-check')
})

uiTest('§10 batch note appears when ask covers other items too', async (mount) => {
  const ask: AskInfo = {
    id: 'ask-multi',
    node: 'agent-asker',
    at: '2026-09-05T09:30:00.000Z',
    work_items: ['w1', 'w2'],
    tabs: [
      { index: 0, question: 'Question about w1', work_item: 'w1' },
      { index: 1, question: 'Question about w2', work_item: 'w2' },
    ],
  }
  const tree = mkTree({ asks: [ask], asks_open: 1 })
  mockWorkItems([mkItem({
    title: 'Work Item',
    effective_attention: true,
    attention_sources: ['question'],
    questions: [{
      ask_id: 'ask-multi',
      node: 'agent-asker',
      rev: 1,
      at: '2026-09-05T09:30:00.000Z',
      tabs: [{ index: 0, question: 'Question about w1' }],
    }],
  })])
  const { el } = await mount(docketModal({ tree }))
  await flush()
  await inAct(() => (rows(el)[0] as HTMLElement).click())
  await flush()

  const note = el.querySelector('.docket-question-note')
  assert.ok(note, 'note rendered')
  assert.match(note.textContent ?? '', /this batch also covers other items — answering it resolves every tab at once/)
})

uiTest('§11 dismiss manual attention button calls endpoint with set_rev and updates refreshed row state', async (mount) => {
  let toasted: string[] = []
  let itemState = mkItem({
    title: 'Work Item',
    status: 'blocked',
    effective_attention: true,
    attention_sources: ['manual'],
    manual_attention: {
      reason: 'Need review',
      at: '2026-09-05T09:00:00.000Z',
      by: { node: 'agent1', generation: 1 },
      set_rev: 7,
    },
  })
  const calls: { url: string; method: string; body?: unknown }[] = []
  const headers = new Headers()
  const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, headers, json: () => Promise.resolve(body) })

  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
    const path = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url: path, method, body })
    if (path.includes('/work-items/') && path.includes('/dismiss-attention')) {
      itemState = {
        ...itemState,
        effective_attention: false,
        attention_sources: [],
        manual_attention: null,
      }
      return ok({ ok: true, dismissed: true })
    }
    if (path.includes('/work-items')) {
      return ok({
        items: [itemState],
        counts: { attention: itemState.effective_attention ? 1 : 0, active: 1, archived: 0 },
        now: '2026-09-05T12:00:00.000Z',
      })
    }
    return ok({})
  }) as typeof fetch

  const { el } = await mount(docketModal({ toast: (t) => { toasted = t } }))
  await flush()

  // Row starts in attention state
  let row = el.querySelector('.mailrow') as HTMLElement
  assert.ok(row.classList.contains('attention'), 'row starts with attention class')
  assert.match(row.querySelector('.l2')?.textContent ?? '', /Needs attention/)

  const dismissBtn = el.querySelector('.mailrow .docket-dismiss') as HTMLButtonElement
  assert.ok(dismissBtn, 'dismiss button on row')
  await inAct(() => dismissBtn.click())
  await flush()

  const dismissCalls = calls.filter((c) => c.method === 'POST' && c.url.includes('/dismiss-attention'))
  assert.equal(dismissCalls.length, 1)
  assert.deepEqual(dismissCalls[0]!.body, { set_rev: 7 })
  assert.match(toasted[0] ?? '', /dismissed the attention flag/)

  // Refreshed row turns to its underlying status ('Blocked') and loses attention styling
  row = el.querySelector('.mailrow') as HTMLElement
  assert.ok(row.classList.contains('active'), 'row now has active class')
  assert.ok(!row.classList.contains('attention'), 'row lost attention class')
  assert.match(row.querySelector('.l2')?.textContent ?? '', /Blocked/)
  assert.doesNotMatch(row.querySelector('.l2')?.textContent ?? '', /Needs attention/)
  assert.equal(el.querySelector('.docket-dismiss'), null, 'dismiss button gone after clearing manual flag')
})

uiTest('§11b question+manual attention item stays in attention state after manual dismiss', async (mount) => {
  let toasted: string[] = []
  let itemState = mkItem({
    title: 'Multi-Attention Item',
    status: 'blocked',
    effective_attention: true,
    attention_sources: ['question', 'manual'],
    manual_attention: {
      reason: 'Urgent check',
      at: '2026-09-05T09:00:00.000Z',
      by: { node: 'agent2', generation: 1 },
      set_rev: 12,
    },
    questions: [{
      ask_id: 'q1',
      node: 'agent2',
      rev: 1,
      at: '2026-09-05T09:00:00.000Z',
      tabs: [{ index: 0, question: 'Continue?' }],
    }],
  })
  const headers = new Headers()
  const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, headers, json: () => Promise.resolve(body) })

  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
    const path = String(url)
    if (path.includes('/dismiss-attention')) {
      itemState = {
        ...itemState,
        effective_attention: true,
        attention_sources: ['question'],
        manual_attention: null,
      }
      return ok({ ok: true, dismissed: true })
    }
    if (path.includes('/work-items')) {
      return ok({
        items: [itemState],
        counts: { attention: 1, active: 1, archived: 0 },
        now: '2026-09-05T12:00:00.000Z',
      })
    }
    return ok({})
  }) as typeof fetch

  const { el } = await mount(docketModal({ toast: (t) => { toasted = t } }))
  await flush()

  let row = el.querySelector('.mailrow') as HTMLElement
  assert.ok(row.classList.contains('attention'))
  assert.match(row.querySelector('.l2')?.textContent ?? '', /Needs attention/)

  const dismissBtn = el.querySelector('.mailrow .docket-dismiss') as HTMLButtonElement
  assert.ok(dismissBtn, 'dismiss button on row')
  await inAct(() => dismissBtn.click())
  await flush()

  assert.match(toasted[0] ?? '', /dismissed the attention flag/)

  // Stays attention after dismiss because question is still attached
  row = el.querySelector('.mailrow') as HTMLElement
  assert.ok(row.classList.contains('attention'), 'row still has attention class due to remaining question')
  assert.match(row.querySelector('.l2')?.textContent ?? '', /Needs attention/)
  assert.equal(el.querySelector('.docket-dismiss'), null, 'dismiss button gone because manual flag was cleared')
})

uiTest('§12 dismiss button is ABSENT when attention is question-only', async (mount) => {
  mockWorkItems([mkItem({
    title: 'Work Item',
    effective_attention: true,
    attention_sources: ['question'],
    manual_attention: null,
  })])
  const { el } = await mount(docketModal())
  await flush()
  assert.equal(el.querySelector('.docket-dismiss'), null, 'no dismiss button for question-only attention')
})

uiTest('§13 general reply box targets the ASSIGNMENT and handles deferred (archived) recipient', async (mount) => {
  let toasted: string[] = []
  // the backend routes an item reply to the OWNER and to nobody else
  // (ledger.work_reply_target), so the label and the button must name the
  // same agent the mail will actually reach
  const calls = mockWorkItems([mkItem({
    id: 'w-arch',
    title: 'Work Item',
    owner: { node: 'archived-agent', generation: 1 },
    last_updater: { node: 'somebody-else', generation: 1 },
  })])
  const { el } = await mount(docketModal({ toast: (t) => { toasted = t } }))
  await flush()
  await inAct(() => (rows(el)[0] as HTMLElement).click())
  await flush()

  const replyLabel = el.querySelector('.docket-reply-label')
  assert.match(replyLabel?.textContent ?? '', /Reply to archived-agent · assigned to this item/)
  assert.ok(!(replyLabel?.textContent ?? '').includes('somebody-else'),
    'the reply box is still offering the last updater')

  const textarea = el.querySelector('.mail-reply textarea') as HTMLTextAreaElement
  assert.ok(textarea, 'textarea exists')
  await inAct(() => {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    nativeSetter?.call(textarea, 'Great work!')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()

  const sendBtn = el.querySelector('.mail-reply-send') as HTMLButtonElement
  assert.ok(!sendBtn.disabled)
  await inAct(() => sendBtn.click())
  await flush()

  const replyCalls = calls.filter((c) => c.method === 'POST' && c.url.includes('/reply'))
  assert.equal(replyCalls.length, 1)
  assert.deepEqual(replyCalls[0]!.body, { body: 'Great work!', to: 'archived-agent' })
  assert.match(toasted[0] ?? '', /archived-agent is archived — the reply waits for rehire/)
})

// allow-attachments-in-contextual-reply-composers. The docket's "ticket"
// reply is the ONE of the three contextual composers whose BACKEND also
// needed a change (work_item_reply had no attachments field at all before
// this feature — test_work_item_reply_attachments.py covers that side
// directly); this is the frontend half of the same feature, through the
// real MailReplyBox + the real upload call, not a hand-built attach chip.
uiTest('§13c the reply box attaches a real staged file and sends its path with '
  + 'the reply', async (mount) => {
  const calls = mockWorkItems([mkItem({ id: 'w-att', title: 'Work Item',
    owner: { node: 'owner-agent', generation: 1 } })])
  const { el } = await mount(docketModal())
  await flush()
  await inAct(() => (rows(el)[0] as HTMLElement).click())
  await flush()

  const attachBtn = el.querySelector('.mail-reply .cc-attach') as HTMLButtonElement
  assert.ok(attachBtn, 'positive control: the attach button is rendered at all')
  assert.equal(attachBtn.disabled, false,
    'a resolved recipient (owner-agent) means the attach button must be live')

  const fileInput = el.querySelector('.mail-reply input[type="file"]') as HTMLInputElement
  // a plain text file (not an image) exercises the `.attach-chip` branch
  // directly — the image branch (`AttachThumb`, `.attach-thumbwrap`) is
  // the SAME staging/removal logic behind a different rendering, already
  // covered structurally by desk.tsx's own composer tests
  const file = new File(['evidence bytes'], 'evidence.txt', { type: 'text/plain' })
  await inAct(() => {
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
    fileInput.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()

  const uploadCalls = calls.filter((c) => c.method === 'POST' && c.url.includes('/upload'))
  assert.equal(uploadCalls.length, 1, 'the file actually uploaded, not just staged locally')
  assert.match(uploadCalls[0]!.url, /name=evidence\.txt/)

  const chip = el.querySelector('.attach-row .attach-chip')
  assert.ok(chip, 'a staged-attachment chip appears once the upload resolves')
  assert.match(chip!.textContent ?? '', /evidence\.txt/)

  const textarea = el.querySelector('.mail-reply textarea') as HTMLTextAreaElement
  await inAct(() => {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    nativeSetter?.call(textarea, 'see attached')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()

  const sendBtn = el.querySelector('.mail-reply-send') as HTMLButtonElement
  assert.equal(sendBtn.disabled, false)
  await inAct(() => sendBtn.click())
  await flush()

  const replyCalls = calls.filter((c) => c.method === 'POST' && c.url.includes('/reply'))
  assert.equal(replyCalls.length, 1)
  // `to` survives alongside the attachment — the acceptance wording's own
  // "preserving reply context" — same as §13's existing assertion shape
  assert.deepEqual(replyCalls[0]!.body,
    { body: 'see attached', to: 'owner-agent', attachments: ['uploads/evidence.txt'] })
})

uiTest('§13d CONTROL: an owner whose state is `missing` disables the attach '
  + 'button the same way it disables send — a reply with nowhere to land '
  + 'must not stage an upload with nowhere to land either', async (mount) => {
  // ⚠ NOT ownerless: docket.tsx only renders the WHOLE reply section
  // (MailReplyBox included) when `assignee || recipients.length > 0 ||
  // replyTo` — a truly ownerless item renders no reply box at all, which
  // would make this its own different (and less interesting) test. This
  // fixture keeps a real owner but marks it unreachable, which is the
  // `unavailable`/`sendDisabled` state the attach button is supposed to
  // share.
  mockWorkItems([mkItem({ id: 'w-missing', title: 'Work Item',
    owner: { node: 'ghost-agent', generation: 1 }, owner_state: 'missing' })])
  const { el } = await mount(docketModal())
  await flush()
  await inAct(() => (rows(el)[0] as HTMLElement).click())
  await flush()
  const sendBtn = el.querySelector('.mail-reply-send') as HTMLButtonElement
  assert.ok(sendBtn, 'positive control: the reply box renders at all')
  assert.equal(sendBtn.disabled, true, 'positive control: this fixture really is unavailable')
  const attachBtn = el.querySelector('.mail-reply .cc-attach') as HTMLButtonElement
  assert.ok(attachBtn, 'positive control: the attach button still renders')
  assert.equal(attachBtn.disabled, true,
    'an unavailable recipient means nowhere to upload TO — same rule as sendDisabled')
})

uiTest('§13b reply box preserves draft on HTTP failure and clears on successful retry', async (mount) => {
  let toasted: string[] = []
  let shouldFail = true
  const calls: { url: string; method: string; body?: unknown }[] = []
  const headers = new Headers()
  const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, headers, json: () => Promise.resolve(body) })
  const err = (status: number, detail: string) => Promise.resolve({
    ok: false, status, statusText: detail, headers,
    json: () => Promise.resolve({ detail }),
  })

  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
    const path = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url: path, method, body })
    if (path.includes('/reply')) {
      if (shouldFail) {
        return err(500, 'temporary network failure')
      }
      return ok({ ok: true, deferred: false })
    }
    if (path.includes('/work-items')) {
      return ok({
        items: [mkItem({
          id: 'w-retry',
          title: 'Retry Item',
          owner: { node: 'target-agent', generation: 1 },
          last_updater: { node: 'target-agent', generation: 1 },
        })],
        counts: { attention: 0, active: 1, archived: 0 },
        now: '2026-09-05T12:00:00.000Z',
      })
    }
    return ok({})
  }) as typeof fetch

  const { el } = await mount(docketModal({ toast: (t) => { toasted = t } }))
  await flush()
  await inAct(() => (rows(el)[0] as HTMLElement).click())
  await flush()

  const textarea = el.querySelector('.mail-reply textarea') as HTMLTextAreaElement
  const sendBtn = el.querySelector('.mail-reply-send') as HTMLButtonElement

  await inAct(() => {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    nativeSetter?.call(textarea, 'Draft message to preserve')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
  assert.equal(textarea.value, 'Draft message to preserve')

  // First attempt: fails with 500
  await inAct(() => sendBtn.click())
  await flush()

  assert.match(toasted[0] ?? '', /error: temporary network failure/)
  // Draft MUST be preserved in textarea!
  assert.equal(textarea.value, 'Draft message to preserve', 'draft preserved on HTTP failure')
  assert.ok(!sendBtn.disabled, 'send button re-enabled after failure')

  // Second attempt: succeeds
  shouldFail = false
  toasted = []
  await inAct(() => sendBtn.click())
  await flush()

  assert.match(toasted[0] ?? '', /sent to target-agent/)
  // Draft MUST be cleared on success!
  assert.equal(textarea.value, '', 'draft cleared on successful retry')
})

uiTest('§14 InboxPanel sender chip is clickable agent jump that closes inbox', async (mount) => {
  let focused: string | null = null
  let closed = false
  const tree = mkTree({
    roots: [{ id: 'worker-1', tier: 'sonnet', state: 'live', parent: null, children: [] } as unknown as TreeNode],
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (() => Promise.resolve({
    ok: true, status: 200, headers: new Headers(),
    json: () => Promise.resolve({
      pending: [{ id: 'm1', from: 'worker-1', to: '@user', at: '2026-09-05T09:00:00.000Z', body: 'Hello user' }],
      delivered: [],
      sent: [],
    }),
  })) as typeof fetch

  const { el } = await mount(
    <InboxPanel slug="org1" tree={tree} toast={noop} jumpTo={null}
      close={() => { closed = true }}
      onFocusAgent={(id) => { focused = id }} />
  )
  await flush()
  const mRow = el.querySelector('.mailer-list .mailrow') as HTMLElement
  assert.ok(mRow, 'mail row exists')
  assert.ok(mRow.classList.contains('on'), 'oldest unread opens selected')

  const jumpBtn = el.querySelector('.mailer-read .mailer-head button.cc-name-jump') as HTMLButtonElement
  assert.ok(jumpBtn, 'clickable agent jump button in mailer-head')
  assert.match(jumpBtn.textContent ?? '', /worker-1/)
  await inAct(() => jumpBtn.click())
  assert.ok(closed, 'inbox closed on jump')
  assert.equal(focused, 'worker-1', 'focused agent')
})

uiTest('§15 InboxPanel system and user senders are NOT clickable jumps', async (mount) => {
  const tree = mkTree();
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (() => Promise.resolve({
    ok: true, status: 200, headers: new Headers(),
    json: () => Promise.resolve({
      pending: [{ id: 'm-sys', from: 'system', to: '@user', at: '2026-09-05T09:00:00.000Z', body: 'System note' }],
      delivered: [],
      sent: [],
    }),
  })) as typeof fetch

  const { el } = await mount(
    <InboxPanel slug="org1" tree={tree} toast={noop} jumpTo={null}
      close={noop} onFocusAgent={noop} />
  )
  await flush()
  const mRow = el.querySelector('.mailer-list .mailrow') as HTMLElement
  assert.ok(mRow.classList.contains('on'), 'oldest unread opens selected')
  assert.match(el.querySelector('.mailer-body')?.textContent ?? '', /System note/)

  const jumpBtn = el.querySelector('.mailer-read .mailer-head button.cc-name-jump')
  assert.equal(jumpBtn, null, 'system sender is not clickable')
})

uiTest('§16 NodeInboxModal counterparty is clickable agent jump that closes modal', async (mount) => {
  let focused: string | null = null
  let closed = false
  const node: CanvasNode = { id: 'agent-a', tier: 'sonnet', state: 'live', role: 'Worker', x: 0, y: 0 } as CanvasNode
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (() => Promise.resolve({
    ok: true, status: 200, headers: new Headers(),
    json: () => Promise.resolve({
      pending: [{ id: 'm1', from: 'agent-peer', to: 'agent-a', at: '2026-09-05T09:00:00.000Z', body: 'Peer message' }],
      delivered: [],
      sent: [],
    }),
  })) as typeof fetch

  const { el } = await mount(
    <NodeInboxModal node={node} slug="org1" jumpTo={null}
      close={() => { closed = true }}
      // the tree's answer for this id. Without a resolver MailList claims no
      // local jump at all — a handler alone used to be read as "yes", which is
      // the phantom jump mailsender §12 removes.
      hasAgent={(id) => id === 'agent-peer'}
      onFocusAgent={(id) => { focused = id }} />
  )
  await flush()
  const mRow = el.querySelector('.mailer-list .mailrow') as HTMLElement
  assert.ok(mRow, 'mail row exists')
  await inAct(() => mRow.click())
  await flush()

  const jumpBtn = el.querySelector('.mailer-read .mailer-head button.cc-name-jump') as HTMLButtonElement
  assert.ok(jumpBtn, 'counterparty agent button exists')
  assert.equal(jumpBtn.textContent?.trim(), 'agent-peer')
  await inAct(() => jumpBtn.click())
  assert.ok(closed, 'modal closed')
  assert.equal(focused, 'agent-peer')
})

uiTest('§17 OrgInboxModal inbox sender is external peer and stays plain (no agent jump)', async (mount) => {
  let focused: string | null = null
  let closed = false
  const map = new Map<string, CanvasNode>();
  (globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string) => {
    const path = String(url)
    const headers = new Headers()
    const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, headers, json: () => Promise.resolve(body) })
    if (path.includes('/org_inbox')) {
      return ok({
        entries: [
          { id: 'oi-1', peer: 'external-client', by: null, dir: 'in', at: '2026-09-05T09:00:00.000Z', body: 'Incoming external' },
        ],
        total: 1,
        unread: 1,
      })
    }
    return ok({})
  }) as typeof fetch

  const orgInbox: TreePayload['org_inbox'] = {
    unread: 1,
    entries: [
      { id: 'oi-1', peer: 'external-client', by: null, dir: 'in', at: '2026-09-05T09:00:00.000Z', body: 'Incoming external' } as unknown as OrgInboxEntry,
    ],
  }
  const { el } = await mount(
    <OrgInboxModal inbox={orgInbox} map={map} slug="org1" toast={noop}
      close={() => { closed = true }}
      onFocusAgent={(id) => { focused = id }} />
  )
  await flush()
  const mRow = el.querySelector('.mailer-list .mailrow') as HTMLElement
  assert.ok(mRow, 'org inbox row exists')
  await inAct(() => mRow.click())
  await flush()

  // External peer in inbox is plain text, NEVER a clickable agent jump
  const jumpBtn = el.querySelector('.mailer-read .mailer-head button.cc-name-jump')
  assert.equal(jumpBtn, null, 'external peer has no focus jump')
  const senderB = el.querySelector('.mailer-read .mailer-head b')
  assert.equal(senderB?.textContent?.trim(), 'external-client', 'external peer renders as plain text')
  assert.equal(closed, false)
  assert.equal(focused, null)
})

uiTest('§18 OrgInboxModal outbox @by links resolvable local agent, while recipient stays plain', async (mount) => {
  let focused: string | null = null
  let closed = false
  const map = new Map<string, CanvasNode>([
    ['agent-sender', { id: 'agent-sender', tier: 'sonnet', state: 'live', x: 0, y: 0, w: 100, h: 100, rx: 0, ry: 0, text: '' } as unknown as CanvasNode],
  ]);
  (globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string) => {
    const path = String(url)
    const headers = new Headers()
    const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, headers, json: () => Promise.resolve(body) })
    if (path.includes('/org_inbox')) {
      return ok({
        entries: [
          { id: 'oi-out-1', peer: 'external-client', by: 'agent-sender', dir: 'out', at: '2026-09-05T09:00:00.000Z', body: 'Outbound body' },
        ],
        total: 1,
        unread: 0,
      })
    }
    return ok({})
  }) as typeof fetch

  const orgInbox: TreePayload['org_inbox'] = {
    unread: 0,
    entries: [
      { id: 'oi-out-1', peer: 'external-client', by: 'agent-sender', dir: 'out', at: '2026-09-05T09:00:00.000Z', body: 'Outbound body' } as unknown as OrgInboxEntry,
    ],
  }
  const { el } = await mount(
    <OrgInboxModal inbox={orgInbox} map={map} slug="org1" toast={noop}
      close={() => { closed = true }}
      onFocusAgent={(id) => { focused = id }} />
  )
  await flush()
  // switch to sent folder
  const sentBtn = [...el.querySelectorAll('.mail-folders button')].find((b) => b.textContent?.includes('sent')) as HTMLElement
  assert.ok(sentBtn, 'sent folder button exists')
  await inAct(() => sentBtn.click())
  await flush()

  const mRow = el.querySelector('.mailer-list .mailrow') as HTMLElement
  assert.ok(mRow, 'outbox mail row exists')
  await inAct(() => mRow.click())
  await flush()

  // Only the local agent @agent-sender is a clickable jump; external recipient stays plain!
  const jumpBtns = [...el.querySelectorAll('.mailer-read .mailer-head button.cc-name-jump')] as HTMLButtonElement[]
  assert.equal(jumpBtns.length, 1, 'only resolvable local sender is a clickable jump')
  assert.equal(jumpBtns[0]!.textContent?.trim(), '@agent-sender')

  await inAct(() => jumpBtns[0]!.click())
  assert.ok(closed, 'clicking jump closes modal')
  assert.equal(focused, 'agent-sender', 'focuses local agent')
})

uiTest('§19 multiple questions on an item render separate question boxes with respective askers', async (mount) => {
  const tree = mkTree({
    asks: [
      { id: 'a1', node: 'asker-1', at: '2026-09-05T09:00:00.000Z', tabs: [{ index: 0, question: 'Q1' }] },
      { id: 'a2', node: 'asker-2', at: '2026-09-05T09:05:00.000Z', tabs: [{ index: 0, question: 'Q2' }] },
    ],
    asks_open: 2,
  })
  mockWorkItems([mkItem({
    title: 'Item with 2 questions',
    effective_attention: true,
    attention_sources: ['question'],
    questions: [
      { ask_id: 'a1', node: 'asker-1', rev: 1, at: '2026-09-05T09:00:00.000Z', tabs: [{ index: 0, question: 'Q1' }] },
      { ask_id: 'a2', node: 'asker-2', rev: 1, at: '2026-09-05T09:05:00.000Z', tabs: [{ index: 0, question: 'Q2' }] },
    ],
  })])
  const { el } = await mount(docketModal({ tree }))
  await flush()
  await inAct(() => (rows(el)[0] as HTMLElement).click())
  await flush()

  const qBoxes = el.querySelectorAll('.docket-question-box')
  assert.equal(qBoxes.length, 2, 'two distinct question boxes rendered')
  assert.match(qBoxes[0]!.textContent ?? '', /Question from asker-1/)
  assert.match(qBoxes[1]!.textContent ?? '', /Question from asker-2/)
})

uiTest('§20 production DocketToolbarButton displays orange attention count or muted active count', async (mount) => {
  let clicked = false
  // Attention case
  const view1 = await mountView(<DocketToolbarButton summary={{ attention: 3, active: 5 }} onClick={() => { clicked = true }} />, (e) => e)
  const badge1 = view1.el.querySelector('.eye-count')!
  assert.ok(badge1.classList.contains('docket-attn'), 'orange styling applied when attention > 0')
  assert.equal(badge1.textContent?.trim(), '3')
  await inAct(() => (view1.el.querySelector('button') as HTMLButtonElement).click())
  assert.ok(clicked, 'click triggers onClick')
  await view1.unmount()

  // Quiet case
  const view2 = await mountView(<DocketToolbarButton summary={{ attention: 0, active: 7 }} />, (e) => e)
  const badge2 = view2.el.querySelector('.eye-count')!
  assert.ok(!badge2.classList.contains('docket-attn'), 'no orange class when attention is 0')
  assert.equal(badge2.textContent?.trim(), '7', 'shows active count when attention is 0')
  await view2.unmount()

  // Zero active: no badge rendered, but button, icon, title and onClick survive
  let clickedZero = false
  const view3 = await mountView(<DocketToolbarButton summary={{ attention: 0, active: 0 }} onClick={() => { clickedZero = true }} />, (e) => e)
  const btn3 = view3.el.querySelector('button.docket-bell') as HTMLButtonElement
  assert.ok(btn3, 'button survives when count is 0')
  assert.equal(btn3.getAttribute('title'), 'work docket', 'title attribute correct when attention is 0')
  assert.ok(btn3.querySelector('svg'), 'docket icon is rendered')
  const badge3 = view3.el.querySelector('.eye-count')
  assert.equal(badge3, null, 'badge is not rendered when count is 0')
  assert.equal(btn3.textContent?.trim(), '', 'no stray digit rendered when count is 0')
  await inAct(() => btn3.click())
  assert.ok(clickedZero, 'click triggers onClick when count is 0')
  await view3.unmount()

  // First-paint / uninitialized cases: summary omitted and summary null
  const view4 = await mountView(<DocketToolbarButton />, (e) => e)
  const btn4 = view4.el.querySelector('button.docket-bell') as HTMLButtonElement
  assert.ok(btn4, 'button survives when summary is omitted')
  assert.equal(btn4.getAttribute('title'), 'work docket')
  assert.equal(view4.el.querySelector('.eye-count'), null, 'no badge when summary is omitted')
  assert.equal(btn4.textContent?.trim(), '', 'no stray digit rendered when summary is omitted')
  await view4.unmount()

  const view5 = await mountView(<DocketToolbarButton summary={null} />, (e) => e)
  const btn5 = view5.el.querySelector('button.docket-bell') as HTMLButtonElement
  assert.ok(btn5, 'button survives when summary is null')
  assert.equal(btn5.getAttribute('title'), 'work docket')
  assert.equal(view5.el.querySelector('.eye-count'), null, 'no badge when summary is null')
  assert.equal(btn5.textContent?.trim(), '', 'no stray digit rendered when summary is null')
  await view5.unmount()
})

uiTest('§21 show archived toggle preserves detail selection and in-flight draft without full-panel reload', async (mount) => {
  mockWorkItems([
    mkItem({ title: 'Active Item', status: 'in_progress', last_updater: { node: 'agent1', generation: 1 } }),
  ], [
    mkItem({ title: 'Archived Item', status: 'done', archived: true }),
  ])
  const { el } = await mount(docketModal())
  await flush()

  // Select active item w1
  await inAct(() => (rows(el)[0] as HTMLElement).click())
  await flush()

  const textarea = el.querySelector('.mailer-read textarea') as HTMLTextAreaElement
  assert.ok(textarea, 'textarea rendered in detail pane')
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  await inAct(() => {
    nativeSetter?.call(textarea, 'in-flight draft reply')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  assert.equal(textarea.value, 'in-flight draft reply')

  // Toggle Show archived ON
  await inAct(() => showArchivedBox(el).click())
  await flush()

  // Verify full-panel reload did NOT happen (no loading... screen)
  assert.ok(!el.textContent?.includes('loading…'), 'panel does not flash loading on archive toggle')
  // Verify rows appended
  assert.equal(rows(el).length, 2, 'archived row appended')
  // Verify detail pane is STILL open on w1
  assert.ok(el.querySelector('.mailer-read'), 'detail pane remains open')
  const retainedTextarea = el.querySelector('.mailer-read textarea') as HTMLTextAreaElement
  assert.ok(retainedTextarea, 'textarea still exists in detail pane')
  assert.equal(retainedTextarea.value, 'in-flight draft reply', 'draft preserved across archive toggle')

  // Toggle Show archived OFF
  await inAct(() => showArchivedBox(el).click())
  await flush()

  assert.equal(rows(el).length, 1, 'archived row removed')
  const stillTextarea = el.querySelector('.mailer-read textarea') as HTMLTextAreaElement
  assert.ok(stillTextarea, 'detail pane still open')
  assert.equal(stillTextarea.value, 'in-flight draft reply', 'draft still preserved')
})

uiTest('§22 entry styling colors entries by status', async (mount) => {
  mockWorkItems([
    mkItem({ title: 'In Progress Item', status: 'in_progress' }),
    mkItem({ title: 'Blocked Item', status: 'blocked' }),
    mkItem({ title: 'Review Item', status: 'review' }),
    mkItem({ title: 'Open Item', status: 'open' }),
    mkItem({ title: 'Done Item', status: 'done' }),
  ])
  const { el } = await mount(docketModal())
  await flush()

  const rList = rows(el)
  assert.equal(rList.length, 5)

  assert.ok(rList[0]!.classList.contains('status-in_progress'), 'has status-in_progress class')
  assert.ok(rList[0]!.querySelector('.docket-status.status-in_progress'), 'status element has status-in_progress class')

  assert.ok(rList[1]!.classList.contains('status-blocked'), 'has status-blocked class')
  assert.ok(rList[1]!.querySelector('.docket-status.status-blocked'), 'status element has status-blocked class')

  assert.ok(rList[2]!.classList.contains('status-review'), 'has status-review class')
  assert.ok(rList[2]!.querySelector('.docket-status.status-review'), 'status element has status-review class')

  assert.ok(rList[3]!.classList.contains('status-open'), 'has status-open class')
  assert.ok(rList[3]!.querySelector('.docket-status.status-open'), 'status element has status-open class')

  assert.ok(rList[4]!.classList.contains('status-done'), 'has status-done class')
  assert.ok(rList[4]!.querySelector('.docket-status.status-done'), 'status element has status-done class')
})

uiTest('§23 three grouping modes; archive and backlog stay last in every one', async (mount) => {
  // the server hands rows back newest-first with a total order already applied
  mockWorkItems([
    mkItem({ title: 'In Progress New', status: 'in_progress', docket_at: '2026-09-05T10:40:00.000Z', owner: { node: 'ana', generation: 1 } }),
    mkItem({ title: 'Open New', status: 'open', docket_at: '2026-09-05T10:30:00.000Z', owner: { node: 'bo', generation: 1 } }),
    mkItem({ title: 'Blocked Mid', status: 'blocked', docket_at: '2026-09-05T10:20:00.000Z', owner: null }),
    mkItem({ title: 'In Progress Old', status: 'in_progress', docket_at: '2026-09-05T10:00:00.000Z', owner: { node: 'ana', generation: 1 } }),
  ], [
    mkItem({ title: 'Archived One', status: 'done', archived: true }),
  ], undefined, [
    mkItem({ title: 'Backlog One', status: 'backlogged' }),
  ])
  forgetGroupChoice()
  const { el } = await mount(docketModal())
  await flush()
  await inAct(() => showArchivedBox(el).click())
  await flush()
  await inAct(() => showBacklogBox(el).click())
  await flush()

  const opts = [...groupSelect(el).options].map((o) => o.value)
  assert.deepEqual(opts, ['none', 'status', 'agent'], 'exactly three arrangements')
  assert.equal(groupSelect(el).value, 'none', 'no grouping by default')

  // NO GROUP: the order the server chose, untouched, then the appended groups
  assert.deepEqual(titles(el), ['In Progress New', 'Open New', 'Blocked Mid',
    'In Progress Old', 'Backlog One', 'Archived One'])
  assert.deepEqual(headings(el),
    ['Backlogged — not yet approached', 'Archived'],
    'ungrouped mode heads only the two appended groups')

  // BY STATUS: blocked, in_progress, review, open (attention first when present)
  await chooseGroup(el, 'status')
  assert.deepEqual(headings(el), ['Blocked', 'In progress', 'Open',
    'Backlogged — not yet approached', 'Archived'])
  assert.deepEqual(titles(el), ['Blocked Mid', 'In Progress New', 'In Progress Old',
    'Open New', 'Backlog One', 'Archived One'])

  // BY AGENT: owner, most recently active first, Unassigned named and last
  await chooseGroup(el, 'agent')
  assert.deepEqual(headings(el), ['ana', 'bo', 'Unassigned',
    'Backlogged — not yet approached', 'Archived'])
  assert.deepEqual(titles(el), ['In Progress New', 'In Progress Old', 'Open New',
    'Blocked Mid', 'Backlog One', 'Archived One'])

  // THE INVARIANT: in all three, the last two rows are the two appended groups
  // — ticking a filter can only ever add to the bottom of the list
  for (const mode of ['none', 'status', 'agent']) {
    await chooseGroup(el, mode)
    assert.deepEqual(titles(el).slice(-2), ['Backlog One', 'Archived One'], mode)
  }
})

uiTest('§23b attention outranks every status group, and an unknown status is still reachable', async (mount) => {
  mockWorkItems([
    mkItem({ title: 'Open Plain', status: 'open' }),
    mkItem({ title: 'Flagged Open', status: 'open', effective_attention: true, attention_sources: ['manual'] }),
    mkItem({ title: 'Blocked Plain', status: 'blocked' }),
    mkItem({ title: 'Odd', status: 'invented_later' }),
  ])
  forgetGroupChoice()
  const { el } = await mount(docketModal())
  await flush()
  await chooseGroup(el, 'status')
  assert.deepEqual(headings(el), ['Needs attention', 'Blocked', 'Open', 'Other closed'])
  assert.deepEqual(titles(el), ['Flagged Open', 'Blocked Plain', 'Open Plain', 'Odd'])
})

uiTest('§23c the chosen arrangement persists across a remount', async (mount) => {
  mockWorkItems([mkItem({ title: 'Only', status: 'open' })])
  forgetGroupChoice()
  const { el } = await mount(docketModal())
  await flush()
  assert.equal(groupSelect(el).value, 'none', 'the default with nothing stored')
  await chooseGroup(el, 'agent')
  assert.equal(window.localStorage.getItem('orgtree.docket.group'), 'agent')

  // a fresh panel reads the stored choice rather than resetting to the default
  const again = await mount(docketModal())
  await flush()
  assert.equal(groupSelect(again.el).value, 'agent')
  forgetGroupChoice()
})

uiTest('§24 active successors stay normal while retired actors stay historical', async (mount) => {
  const node = (id: string, tier: string, generation: number) => ({
    id, title: id, tier, model_id: 'm', state: 'live', seat: 1, grant: 1, free: 1,
    scope: { permission_mode: 'normal' }, ui_order: 1, cost_usd: 0,
    occupancy: null, context_window: null, charter: null, generation,
  })
  const tree = mkTree({
    roots: [node('worker-agent', 'sonnet', 1),
      node('rolled-agent', 'opus', 4),
      { ...node('retired-agent', 'haiku', 3), state: 'archived' },
    ] as unknown as TreeNode[],
  })
  // the chip rides the name the row prints, which is the ASSIGNMENT — so
  // these are owners, and the last updater is somebody the tree does not
  // know at all, which would chip as "gone" if the row read the wrong field
  const elsewhere = { node: 'never-existed', generation: 1 }
  mockWorkItems([
    mkItem({ title: 'Current', owner: { node: 'worker-agent', generation: 1 },
      last_updater: elsewhere }),
    // the SAME live node, but the item was assigned to an EARLIER generation:
    // the docket resolves it to the current successor and current model
    mkItem({ title: 'Superseded generation',
      owner: { node: 'rolled-agent', generation: 2 }, last_updater: elsewhere }),
    mkItem({ title: 'Retired', owner: { node: 'retired-agent', generation: 3 },
      last_updater: elsewhere }),
    mkItem({ title: 'Gone', owner: { node: 'never-existed', generation: 1 },
      last_updater: elsewhere }),
  ])
  const { el } = await mount(docketModal({ tree }))
  await flush()
  const [rCur, rSuccessor, rRetired, rGone] = rows(el)

  // POSITIVE CONTROL — without it the assertions below would also pass on a
  // component that simply never renders a chip at all
  const chip = rCur!.querySelector('.docket-updater .tier')
  assert.equal(Boolean(chip), true, 'the current generation DOES get a model chip')
  assert.equal(Boolean(chip?.classList.contains('t-sonnet')), true)
  assert.equal(chip?.textContent?.trim(), 'S')

  assert.equal(rSuccessor!.querySelector('.docket-updater .tier')?.textContent?.trim(), 'O',
    'an earlier generation on a live node gets the current successor model')
  assert.equal(rSuccessor!.querySelector('.docket-actor')?.classList.contains('fit-current'), true)
  assert.equal(rRetired!.querySelector('.docket-updater .tier')?.textContent?.trim(), 'H',
    'a retired node keeps its recorded model badge')
  assert.equal(rRetired!.querySelector('.docket-actor')?.classList.contains('fit-retired'), true)
  assert.equal(Boolean(rGone!.querySelector('.docket-updater .tier')), false)
  assert.equal(rGone!.querySelector('.docket-actor')?.classList.contains('fit-gone'), true)

  // the detail pane obeys the same rule
  await inAct(() => (rCur as HTMLElement).click())
  await flush()
  assert.ok(el.querySelector('.docket-pane-sub .tier')?.classList.contains('t-sonnet'))
  await inAct(() => (rSuccessor as HTMLElement).click())
  await flush()
  assert.equal(el.querySelector('.docket-pane-sub .tier')?.classList.contains('t-opus'), true)
})

uiTest('§25 the backlog is hidden until asked for, counted apart, and never merged into current work', async (mount) => {
  mockWorkItems([
    mkItem({ title: 'Current', status: 'in_progress' }),
  ], [], undefined, [
    mkItem({ title: 'Parked', status: 'backlogged' }),
  ])
  const { el } = await mount(docketModal())
  await flush()
  assert.deepEqual(titles(el), ['Current'], 'the backlog is not shown by default')
  assert.match(el.querySelector('.docket-showbacklog')?.textContent ?? '', /Show backlogged/)
  assert.match(el.querySelector('.docket-showbacklog')?.textContent ?? '', /1/,
    'the count rides the label, so a hidden backlog is still discoverable')

  await inAct(() => showBacklogBox(el).click())
  await flush()
  assert.deepEqual(titles(el), ['Current', 'Parked'], 'appended, never interleaved')
  const parked = rows(el)[1]!
  assert.ok(parked.classList.contains('backlog'), 'it reads as its own state')
  assert.ok(parked.classList.contains('status-backlogged'))
  assert.ok(!parked.classList.contains('active') && !parked.classList.contains('archived'))
  assert.match(parked.querySelector('.docket-status')?.textContent ?? '', /Backlogged/)

  // unticking puts it back out of sight without disturbing the rest
  await inAct(() => showBacklogBox(el).click())
  await flush()
  assert.deepEqual(titles(el), ['Current'])
})

uiTest('§26 an attention-holding backlog row arrives in the MAIN list, not behind the filter', async (mount) => {
  // the backend keeps such a row in `items` so the toolbar badge always opens
  // onto something visible; the UI must therefore not hide it on status alone
  mockWorkItems([
    mkItem({ title: 'Parked but flagged', status: 'backlogged',
      effective_attention: true, attention_sources: ['manual'] }),
  ])
  const { el } = await mount(docketModal())
  await flush()
  assert.deepEqual(titles(el), ['Parked but flagged'], 'visible with the filter OFF')
  const r = rows(el)[0]!
  assert.ok(r.classList.contains('attention'), 'attention wins over the backlog styling')
  assert.match(r.querySelector('.docket-status')?.textContent ?? '', /Needs attention/)
})

uiTest('§27 the name is TEXT in both places, and there is no copy control', async (mount) => {
  // ⚠ THIS TEST EXISTS BECAUSE THE COPY BUTTON WAS REMOVED, TWICE. The name
  // was a padded bordered chip in the row and again in the detail pane; from
  // screenshots the user removed it from the list (13:03) and then from the
  // detail as well (13:04), with "no replacement copy control anywhere". A
  // test that only checked the name is present would pass on its return.
  // ⚠ THERE IS NO LONGER AN UNNAMED ITEM TO TEST. The server cannot serve one:
  // a document still holding the retired opaque key is refused whole (409)
  // rather than served with some rows unnamed, so the old id-fallback half of
  // this check pinned a state the product can no longer reach.
  mockWorkItems([
    mkItem({ slug: 'git-review-workspace', title: 'Named' }),
    mkItem({ slug: 'second-named-item', title: 'Also named' }),
  ])
  // ⚠ onFocusAgent IS PASSED HERE ON PURPOSE, because App.tsx always passes it
  // (App.tsx:1027) and the assertion below is about the agent jump. It used to
  // be omitted, and the panel rendered the jump button anyway — a button whose
  // handler was `onFocusAgent?.(…)`, i.e. a control that did nothing. The
  // shared AgentName renders plain text when there is nowhere to go, so
  // omitting the prop here would now be testing a shape the product never
  // renders. The assertion itself is unchanged.
  const { el } = await mount(docketModal({ onFocusAgent: noop }))
  await flush()
  const [rNamed, rOld] = rows(el)
  assert.equal(rNamed!.querySelector('.l1 .mfrom')?.textContent, 'git-review-workspace')
  assert.equal(rOld!.querySelector('.l1 .mfrom')?.textContent, 'second-named-item')

  // NOTHING IN THE NAME LINE IS PRESSABLE. `.docket-slug` was the removed
  // chip's class; a button in the name line is the shape of the thing the user
  // rejected. (⚠ `assert.ok(x === null)`, never `assert.equal(node, null)` —
  // on failure node serializes the whole jsdom subtree into the diff and the
  // runner dies with "Array buffer allocation failed" instead of telling you
  // which assertion went wrong. That cost a 27-second mystery here.)
  assert.ok(el.querySelector('.docket-slug') === null,
    'the boxed name/copy chip is back in the list')
  assert.ok(rNamed!.querySelector('.l1 button') === null,
    'the row name became a control again')

  // clicking the NAME selects the item, because the name is just the row now
  await inAct(() => (rNamed!.querySelector('.l1 .mfrom') as HTMLElement).click())
  await flush()
  assert.ok(!el.querySelector('.mailer-none'), 'clicking the row name did not open it')

  // the detail pane: full title printed, slug as plain text beside it, and
  // still no copy control
  assert.equal(pane(el)?.querySelector('.docket-pane-head b')?.textContent, 'Named')
  assert.equal(pane(el)?.querySelector('.docket-slug-text')?.textContent,
    'git-review-workspace')
  assert.ok(pane(el)?.querySelector('.docket-slug') === null,
    'the boxed name/copy chip is back in the detail pane')
  // the name itself must be plain text. The sub-line legitimately holds ONE
  // button — the agent jump — so "no buttons here" would be a false alarm;
  // what matters is that the NAME is not one.
  assert.equal(pane(el)?.querySelector('.docket-slug-text')?.tagName, 'SPAN',
    'the detail name is a control again')
  assert.deepEqual(
    [...(pane(el)?.querySelectorAll('.docket-pane-sub button') ?? [])]
      .map((b) => b.className),
    ['cc-name cc-name-jump docket-actor-name'],
    'a control other than the agent jump appeared beside the detail name')

  // and the second row opens to its own name, not to the first one's
  await inAct(() => (rOld as HTMLElement).click())
  await flush()
  assert.equal(pane(el)?.querySelector('.docket-slug-text')?.textContent,
    'second-named-item')
})

uiTest('§28 the detail pane leads with the description, and says so when there is none', async (mount) => {
  mockWorkItems([
    mkItem({ title: 'Described',
      objective: 'agents cite opaque ids the user cannot read; give each item a name' }),
    mkItem({ title: 'Bare', objective: '' }),
  ])
  const { el } = await mount(docketModal())
  await flush()
  await inAct(() => (rows(el)[0] as HTMLElement).click())
  await flush()
  const desc = pane(el)?.querySelector('.docket-desc')
  assert.match(desc?.textContent ?? '', /DESCRIPTION/)
  assert.match(desc?.textContent ?? '', /agents cite opaque ids/)
  // it LEADS: the description comes before the two progress lists
  const order = [...(pane(el)?.querySelectorAll('.docket-desc, .docket-list') ?? [])]
    .map((n) => n.className)
  assert.equal(order[0], 'docket-desc')

  await inAct(() => (rows(el)[1] as HTMLElement).click())
  await flush()
  assert.match(pane(el)?.querySelector('.docket-desc')?.textContent ?? '',
    /predates the rule/, 'an older item without one says so rather than showing blank')
})

uiTest('§29 the panel never re-sorts what the server ordered', async (mount) => {
  // deliberately NOT in recency order, and tied on docket_at: a component that
  // sorted for itself would disagree with the server, and two orderings of the
  // same rows is exactly the shuffle this pins down
  mockWorkItems([
    mkItem({ title: 'First from server', docket_at: '2026-09-05T10:00:00.000Z' }),
    mkItem({ id: 'wzzz', title: 'Second from server', docket_at: '2026-09-05T10:00:00.000Z' }),
    mkItem({ id: 'wmmm', title: 'Third from server', docket_at: '2026-09-05T11:00:00.000Z' }),
  ])
  const { el } = await mount(docketModal())
  await flush()
  assert.deepEqual(titles(el),
    ['First from server', 'Second from server', 'Third from server'])
})

uiTest('§30 a long agent name truncates instead of running under the Dismiss button', async (mount) => {
  mockWorkItems([mkItem({
    title: 'Long updater', effective_attention: true,
    attention_sources: ['manual'],
    manual_attention: { reason: 'look', at: '2026-09-05T09:00:00.000Z', by: { node: 'a', generation: 1 }, set_rev: 1 },
    owner: { node: 'an-extremely-long-agent-identifier-that-will-not-fit', generation: 1 },
  })])
  const { el } = await mount(docketModal())
  await flush()
  const r = rows(el)[0]!
  // THE ACTUAL DEFECT: text-overflow does nothing on a flex container, so the
  // ellipsis has to sit on a NON-flex element inside the wrapper. The structure
  // is what a jsdom test can honestly check; the rendered pixels are measured
  // in the browser capture instead.
  const wrap = r.querySelector('.docket-actor') as HTMLElement
  const name = r.querySelector('.docket-actor-name') as HTMLElement
  assert.ok(wrap && name, 'the name has its own element inside the flex wrapper')
  assert.ok(!name.classList.contains('docket-actor'),
    'the truncating element must not itself be the flex container')
  assert.equal(name.textContent, 'an-extremely-long-agent-identifier-that-will-not-fit')
  assert.ok(r.querySelector('.docket-dismiss'), 'and the Dismiss button is still rendered')
})

uiTest('§31 a row that leaves the archive shows its CURRENT status, not the copy we cached',
  async (mount) => {
    // ⚠ THE FIXTURE MUST HAND OVER A DIFFERENT ARRAY, not mutate the one it
    // already gave out. The panel caches the very array the mock returns, so
    // emptying that array in place empties the cache too — and the stale state
    // this test exists to reproduce never comes into being. (It did not, at
    // first: the check passed against the defective code.)
    mockWorkItems(
      [mkItem({ title: 'Live one' })],
      [mkItem({
        title: 'Was archived', status: 'done', archived: true,
        objective: 'the description it had while it was finished',
      })])
    forgetGroupChoice()
    const { el } = await mount(docketModal())
    await flush()
    await inAct(() => showArchivedBox(el).click())
    await flush()
    await inAct(() => (rows(el)[1] as HTMLElement).click())
    await flush()
    assert.match(pane(el)?.textContent ?? '', /Done/)
    assert.match(pane(el)?.textContent ?? '', /while it was finished/)

    // the server now answers differently: the item has been reopened, so it is
    // live work again with a new status and a rewritten description, and the
    // archive no longer holds it. The panel still has the old copy cached.
    mockWorkItems([
      mkItem({ title: 'Live one' }),
      mkItem({
        title: 'Was archived', status: 'in_progress', archived: false,
        objective: 'the description it has now that it is moving again',
      }),
    ], [])
    // and the user unticks the filter, so the archived group is not even served
    await inAct(() => showArchivedBox(el).click())
    await flush()

    assert.match(pane(el)?.textContent ?? '', /In progress/,
      'the CURRENT row must win over the cached archived copy')
    assert.match(pane(el)?.textContent ?? '', /moving again/)
    assert.doesNotMatch(pane(el)?.textContent ?? '', /while it was finished/)
  })

uiTest('§32 switching org drops the previous org rows and selection', async (mount) => {
  // each org answers with its own item, so "which org is on screen" is visible
  // rather than inferred
  const a = mkItem({ id: 'wA', title: 'Org one item', status: 'done', archived: true })
  const b = mkItem({ id: 'wB', title: 'Org two item', status: 'open' })
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    ((url: string) => {
      const path = String(url)
      const two = path.includes('/orgs/org2/')
      const headers = new Headers()
      return Promise.resolve({
        ok: true, status: 200, headers,
        json: () => Promise.resolve({
          items: two ? [b] : [],
          ...(path.includes('archived=1') ? { archived: two ? [] : [a] } : {}),
          counts: { attention: 0, active: two ? 1 : 0, archived: two ? 0 : 1, backlogged: 0 },
          now: '2026-09-05T10:00:00.000Z',
        }),
      })
    }) as typeof fetch

  forgetGroupChoice()
  const { el, render } = await mount(docketModal({ slug: 'org1' }))
  await flush()
  await inAct(() => showArchivedBox(el).click())
  await flush()
  assert.deepEqual(titles(el), ['Org one item'])
  await inAct(() => (rows(el)[0] as HTMLElement).click())
  await flush()
  assert.match(pane(el)?.textContent ?? '', /Org one item/)

  // the SAME mounted panel is handed a different org
  await render(docketModal({ slug: 'org2' }))
  await flush()
  assert.deepEqual(titles(el), ['Org two item'],
    "the previous org's cached archived row must not survive the switch")
  assert.doesNotMatch(el.textContent ?? '', /Org one item/)
  assert.ok(pane(el)?.querySelector('.mailer-none'),
    'and no detail from the previous org may stay open under the new org URL')
})

uiTest('§32b switching org never auto-opens an item the user did not click', async (mount) => {
  // the sharp case for scoping the SELECTION rather than only the cached rows:
  // when the new org happens to hold the same id, an unscoped selection silently
  // opens a different org's item under the same id — a detail pane the user
  // never asked for, wired to a reply URL they never chose.
  // the same NAME in both orgs — that is the collision this guards against,
  // and the name is the key now
  const one = mkItem({ slug: 'same-name', title: 'Org one item',
    status: 'done', archived: true })
  const two = mkItem({ slug: 'same-name', title: 'Org two item', status: 'open' })
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    ((url: string) => {
      const path = String(url)
      const isTwo = path.includes('/orgs/org2/')
      return Promise.resolve({
        ok: true, status: 200, headers: new Headers(),
        json: () => Promise.resolve({
          items: isTwo ? [two] : [],
          ...(path.includes('archived=1') ? { archived: isTwo ? [] : [one] } : {}),
          counts: { attention: 0, active: isTwo ? 1 : 0, archived: isTwo ? 0 : 1, backlogged: 0 },
          now: '2026-09-05T10:00:00.000Z',
        }),
      })
    }) as typeof fetch

  forgetGroupChoice()
  const { el, render } = await mount(docketModal({ slug: 'org1' }))
  await flush()
  await inAct(() => showArchivedBox(el).click())
  await flush()
  await inAct(() => (rows(el)[0] as HTMLElement).click())
  await flush()
  assert.match(pane(el)?.textContent ?? '', /Org one item/, 'selected in org1')

  await render(docketModal({ slug: 'org2' }))
  await flush()
  // the row is named by its slug, and BOTH orgs use the same one — which is
  // exactly the collision this test exists for
  assert.deepEqual(titles(el), ['same-name'])
  assert.ok(pane(el)?.querySelector('.mailer-none'),
    'the identical NAME must NOT carry the selection across into the new org')
  assert.doesNotMatch(pane(el)?.textContent ?? '', /Org two item/)

  // POSITIVE CONTROL: clicking in the new org still opens the new org's item,
  // so the check above is not passing because selection stopped working
  await inAct(() => (rows(el)[0] as HTMLElement).click())
  await flush()
  assert.match(pane(el)?.textContent ?? '', /Org two item/)
})


uiTest('§33 `review` reads as Agent review in the row, the pane and the group heading',
  async (mount) => {
    // USER RULING 2026-09-05: the status means agents are checking the work.
    // "Under review" read equally as "the user is reviewing it", which is the
    // confusion this removes; asking the user is the attention flag.
    mockWorkItems([
      mkItem({ title: 'Checked by agents', status: 'review' }),
      mkItem({ title: 'Not started', status: 'open' }),
    ])
    forgetGroupChoice()
    const { el } = await mount(docketModal())
    await flush()
    const status = (r: Element) => r.querySelector('.docket-status')
    assert.equal(status(rows(el)[0]!)?.textContent, 'Agent review')
    assert.match(status(rows(el)[0]!)?.getAttribute('title') ?? '', /Review by agents/,
      'the hover help says whose review it is')
    // CONTROL: the row beside it proves the label is read per status rather
    // than being a constant, and that an unambiguous status gets no help text
    assert.equal(status(rows(el)[1]!)?.textContent, 'Open')
    assert.equal(status(rows(el)[1]!)?.getAttribute('title'), null)
    assert.doesNotMatch(el.textContent ?? '', /Under review/, 'the old wording is gone')

    await inAct(() => (rows(el)[0] as HTMLElement).click())
    await flush()
    assert.equal(pane(el)?.querySelector('.docket-status')?.textContent, 'Agent review')

    await chooseGroup(el, 'status')
    assert.ok(headings(el).includes('Agent review'), headings(el).join(' | '))
  })

uiTest('§34 the attention reason keeps every line the user is asked to read',
  async (mount) => {
    // The reason now carries three things at once — requested against
    // delivered, the decision added, and the confirmation wanted (user
    // 2026-09-05) — so it arrives as several lines. jsdom applies no CSS, so
    // this pins the TEXT and the element the pre-wrap rule hangs on; that the
    // lines are VISIBLY separate is measured in docket_layout_probe.py.
    const reason = ['REQUESTED: a CSV export.',
      'DELIVERED: CSV, plus a TSV switch I added.',
      'CONFIRM: keep the TSV switch, or strip it?'].join('\n')
    mockWorkItems([
      mkItem({
        title: 'Extra beyond spec', status: 'in_progress',
        effective_attention: true, attention_sources: ['manual'],
        manual_attention: {
          reason, at: '2026-09-05T09:00:00.000Z',
          by: { node: 'agent1', generation: 1 }, set_rev: 1,
        },
      }),
      mkItem({ title: 'Nothing to confirm', status: 'in_progress' }),
    ])
    forgetGroupChoice()
    const { el } = await mount(docketModal())
    await flush()
    await inAct(() => (rows(el)[0] as HTMLElement).click())
    await flush()
    const body = pane(el)?.querySelector('.docket-attention-box .docket-attention-body')
    assert.ok(body, 'the reason has a body element of its own to style')
    assert.equal(body?.textContent, reason, 'every line arrives, in order, verbatim')
    assert.equal((body?.textContent ?? '').split('\n').length, 3)

    // CONTROL: an item with no flag draws no attention box at all, so the
    // assertions above are about this item's reason and not about a box the
    // pane always renders
    await inAct(() => (rows(el)[1] as HTMLElement).click())
    await flush()
    assert.equal(pane(el)?.querySelector('.docket-attention-box'), null)
  })


uiTest('§35 a row recorded as Waiting arrives as Blocked (the state was removed) and groups there', async (mount) => {
  mockWorkItems([
    mkItem({ title: 'Blocked One', status: 'blocked' }),
    mkItem({ title: 'Moving One', status: 'in_progress' }),
    mkItem({ title: 'Reviewed One', status: 'review' }),
    mkItem({ title: 'Open One', status: 'open' }),
    // THE WIRE SHAPE OF A LEGACY ROW (user 2026-09-07 removed `waiting`): the
    // backend serves it as blocked, says what it was stored as, and carries
    // the recorded reason into blocked_reason
    mkItem({ title: 'Waiting One', status: 'blocked', legacy_status: 'waiting',
      blocked_reason: 'the nightly build finishes; the watchdog mails me',
      waiting_reason: 'the nightly build finishes; the watchdog mails me' }),
  ], [], undefined, [
    mkItem({ title: 'Backlog One', status: 'backlogged' }),
  ])
  forgetGroupChoice()
  const { el } = await mount(docketModal())
  await flush()
  await inAct(() => showBacklogBox(el).click())
  await flush()
  await chooseGroup(el, 'status')

  // there is no Waiting group any more: the legacy row sits in Blocked with
  // the other blocked work, and the group list has no "Waiting on an event"
  assert.deepEqual(headings(el), ['Blocked', 'In progress', 'Agent review',
    'Open', 'Backlogged — not yet approached'])
  assert.deepEqual(titles(el), ['Blocked One', 'Waiting One', 'Moving One',
    'Reviewed One', 'Open One', 'Backlog One'])

  // the row reads as what it is served as — Blocked, with the blocked class —
  // and the pane says it was recorded as waiting, with its reason
  const legacy = rowFor(el, 'Waiting One')
  assert.ok(legacy.querySelector('.docket-status.status-blocked'),
    'the legacy row carries the blocked status class')
  assert.equal(legacy.querySelector('.docket-status')?.textContent, 'Blocked')
  assert.equal(el.querySelector('.docket-status.status-waiting'), null,
    'nothing renders the removed status word')
  await inAct(() => legacy.click())
  await flush()
  const box = [...(pane(el)?.querySelectorAll('.docket-desc') ?? [])]
    .find((d) => /BLOCKED BECAUSE/.test(d.textContent ?? ''))
  assert.match(box?.textContent ?? '', /recorded as waiting before 2026-09-07/)
  assert.match(box?.textContent ?? '', /the watchdog mails me/)
  // CONTROL: an ordinary blocked row's heading does not claim a legacy origin
  await inAct(() => rowFor(el, 'Blocked One').click())
  await flush()
  const plain = [...(pane(el)?.querySelectorAll('.docket-desc') ?? [])]
    .find((d) => /BLOCKED BECAUSE/.test(d.textContent ?? ''))
  assert.ok(plain && !/recorded as waiting/.test(plain.textContent ?? ''))

  // ⚠ AND THE NAME LINE STARTS WITH THE NAME (user 2026-09-06 removed the
  // status dot for the width). Asserted across EVERY row rather than on this
  // one, so a dot left behind on any other status still fails; the first child
  // is checked, not merely the dot's absence, because a replacement element in
  // the same slot would take the same width back.
  for (const r of rows(el)) {
    assert.equal(r.querySelector('.l1 .docket-dot'), null,
      'a status dot is still eating the width the name was given')
    assert.ok((r.querySelector('.l1')?.firstElementChild as HTMLElement)
      ?.classList.contains('docket-rowname'),
      'something sits between the start of the row and its name')
  }
})

uiTest('§36 the pane explains the state the item is IN, never a leftover one', async (mount) => {
  const REASON = 'the nightly build finishes; the build watchdog mails me'
  const BLOCK = 'the vendor has not sent the key; their support can send it'
  const ENDED = 'CANCELLED by the user: the export format left the product'
  mockWorkItems([
    // ⚠ BOTH fields populated on purpose. The backend clears the one that does
    // not belong, so this shape should never reach the pane — which is exactly
    // why the pane must choose by STATUS and not by "whichever field is set".
    // Choosing by populated field passes every test that plants only one.
    // a row an OLDER backend still serves under the removed word: the pane
    // shows what it sent rather than guessing
    mkItem({ title: 'Waiting Both', status: 'waiting',
      waiting_reason: REASON, blocked_reason: BLOCK }),
    mkItem({ title: 'Blocked Both', status: 'blocked',
      waiting_reason: REASON, blocked_reason: BLOCK }),
    mkItem({ title: 'Moving Both', status: 'in_progress',
      waiting_reason: REASON, blocked_reason: BLOCK }),
    mkItem({ title: 'Waiting Silent', status: 'waiting' }),
    // `dropped` is the third state that owes information, and it owes the
    // most: it is the whole record of why the work ended. Same trap, same
    // shape — all three fields planted, so choosing by "whichever is set"
    // cannot pass.
    mkItem({ title: 'Dropped All', status: 'dropped', dropped_reason: ENDED,
      waiting_reason: REASON, blocked_reason: BLOCK }),
    mkItem({ title: 'Dropped Silent', status: 'dropped' }),
  ])
  forgetGroupChoice()
  const { el } = await mount(docketModal())
  await flush()
  // BY TITLE, never by index: the grouping mode is a PERSISTED preference,
  // so an index here silently follows whatever the previous test chose
  const rowFor = (t: string) => rows(el)[titles(el).indexOf(t)] as HTMLElement
  const stateBox = () => [...(pane(el)?.querySelectorAll('.docket-desc') ?? [])]
    .find((d) => /BLOCKED BECAUSE|WAITING FOR|ENDED WITHOUT COMPLETING/
      .test(d.textContent ?? ''))

  await inAct(() => rowFor('Waiting Both').click())
  await flush()
  assert.match(stateBox()?.textContent ?? '', /WAITING FOR/)
  assert.match(stateBox()?.textContent ?? '', /build watchdog mails me/)
  assert.ok(!(stateBox()?.textContent ?? '').includes(BLOCK),
    'the stale blocked reason is not rendered beside a waiting item')

  await inAct(() => rowFor('Blocked Both').click())
  await flush()
  assert.match(stateBox()?.textContent ?? '', /BLOCKED BECAUSE/)
  assert.match(stateBox()?.textContent ?? '', /their support can send it/)
  assert.ok(!(stateBox()?.textContent ?? '').includes(REASON),
    'and the stale waiting reason is not rendered beside a blocked item')

  // CONTROL: a state that owes nothing draws no box at all, so the two
  // assertions above are about the choice and not about a box always present.
  // Compared as a BOOLEAN: handing a DOM node to assert on a failing run makes
  // node:test diff the whole rendered tree, which hangs instead of failing.
  await inAct(() => rowFor('Moving Both').click())
  await flush()
  assert.equal(Boolean(stateBox()), false)

  // an item that entered the state before the rule says so rather than
  // rendering an empty heading
  await inAct(() => rowFor('Waiting Silent').click())
  await flush()
  assert.match(stateBox()?.textContent ?? '', /WAITING FOR/)
  assert.match(stateBox()?.textContent ?? '', /before the rule/)

  // the terminal non-success outcome: the heading says the item ENDED without
  // being completed, and the two reasons for states it is not in stay off it
  await inAct(() => rowFor('Dropped All').click())
  await flush()
  assert.match(stateBox()?.textContent ?? '', /ENDED WITHOUT COMPLETING/)
  assert.match(stateBox()?.textContent ?? '', /the export format left the product/)
  assert.ok(!(stateBox()?.textContent ?? '').includes(BLOCK),
    'a dropped item rendered a leftover blocked reason')
  assert.ok(!(stateBox()?.textContent ?? '').includes(REASON),
    'a dropped item rendered a leftover waiting reason')

  await inAct(() => rowFor('Dropped Silent').click())
  await flush()
  assert.match(stateBox()?.textContent ?? '', /ENDED WITHOUT COMPLETING/)
  assert.match(stateBox()?.textContent ?? '', /before the rule/)
})


// ------------------------------------------------------- the status palette
// jsdom loads no stylesheet, so the rule is read back from the file the app
// ships — the same way agentstray.test.tsx checks the tray's height.
declare const __SRC_DIR__: string
const DOCKET_CSS = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')

/** the palette token a selector paints with, or null if it has no rule */
const paintOf = (selector: string, prop: string): string | null => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(esc + String.raw`\s*\{([^}]*)\}`).exec(DOCKET_CSS)
  if (!m) return null
  return new RegExp(prop + String.raw`:\s*var\((--[\w-]+)\)`).exec(m[1]!)?.[1] ?? null
}

test('§37 Waiting is painted, and not with Open’s colour', () => {
  // ⚠ THIS CHECKS THE DECLARATION, NOT THE PIXELS. Two different tokens are
  // not a promise that anyone can tell the two apart; all it rules out is the
  // state the branch shipped in, where `waiting` had no rule at all and so
  // rendered exactly as `open` did.
  //
  // The dot half of this check went with the dot itself (user 2026-09-06), so
  // the status WORD is now the only painted reading of the state in the row —
  // which is why it is worth keeping this half.
  assert.equal(paintOf('.docket-status.status-waiting', 'color'), '--warn')
  assert.notEqual(paintOf('.docket-status.status-waiting', 'color'),
    paintOf('.docket-status.status-open', 'color'),
    'Waiting and Open declare the same colour again')
})

// ───────────────────────────────────────────────────────── §38 the sort selector
//
// The docket could only be read in one order, and that order answers only one
// of the three questions asked of it. These drive the REAL <select> the way a
// user does and read the resulting row order off the DOM.
//
// ⚠ EVERY FIXTURE HERE PUTS THE THREE CLOCKS IN DIFFERENT ORDERS ON PURPOSE.
// With `at`, `docket_at` and `status_at` agreeing, every mode produces the
// same list and all three checks pass against a selector that does nothing.

const forgetSortChoice = () => window.localStorage.removeItem('orgtree.docket.sort')
const sortSelect = (el: HTMLElement) =>
  el.querySelector('#docket-sort') as HTMLSelectElement
async function chooseSort(el: HTMLElement, value: string) {
  const sel = sortSelect(el)
  await inAct(() => {
    sel.value = value
    sel.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await flush()
}

/** three items whose three clocks DISAGREE, so each mode has its own answer */
const SORT_FIXTURE = [
  mkItem({ slug: 'oldest-made-newest-moved', title: 'oldest-made-newest-moved',
           at: '2026-09-01T00:00:00.000Z',
           docket_at: '2026-09-05T03:00:00.000Z',
           status_at: '2026-09-05T09:00:00.000Z' }),
  mkItem({ slug: 'newest-made-oldest-moved', title: 'newest-made-oldest-moved',
           at: '2026-09-04T00:00:00.000Z',
           docket_at: '2026-09-05T02:00:00.000Z',
           status_at: '2026-09-02T00:00:00.000Z' }),
  mkItem({ slug: 'middle-of-everything', title: 'middle-of-everything',
           at: '2026-09-02T00:00:00.000Z',
           docket_at: '2026-09-05T01:00:00.000Z',
           status_at: '2026-09-03T00:00:00.000Z' }),
]

uiTest('§38 three orders, and Updated is still the default', async (mount) => {
  forgetGroupChoice(); forgetSortChoice()
  // the server hands them back in ITS order (newest docket update first)
  mockWorkItems([SORT_FIXTURE[0]!, SORT_FIXTURE[1]!, SORT_FIXTURE[2]!])
  const { el } = await mount(docketModal())
  await flush()
  assert.equal(sortSelect(el).value, 'updated', 'the default changed')
  assert.deepEqual(titles(el),
    ['oldest-made-newest-moved', 'newest-made-oldest-moved', 'middle-of-everything'],
    "the default must be the SERVER's order, untouched")
  assert.match(el.querySelector('.docket-sort-why')?.textContent ?? '',
    /most recently updated first/)

  await chooseSort(el, 'created')
  assert.deepEqual(titles(el),
    ['newest-made-oldest-moved', 'middle-of-everything', 'oldest-made-newest-moved'],
    'newest CREATED first')
  assert.match(el.querySelector('.docket-sort-why')?.textContent ?? '',
    /most recently created first/, 'the caption still claims the old order')

  await chooseSort(el, 'status')
  assert.deepEqual(titles(el),
    ['oldest-made-newest-moved', 'middle-of-everything', 'newest-made-oldest-moved'],
    'most recent STATUS CHANGE first')
  assert.match(el.querySelector('.docket-sort-why')?.textContent ?? '',
    /most recent status change first/)
})

uiTest('§38f the age beside each row reads the clock the list is sorted by', async (mount) => {
  // user 2026-09-07 06:50: "Newest first" tickets must show time since
  // CREATION, "Last status change" time since the last STATUS update — and a
  // progress note must not refresh a status age. Stamps are laid out relative
  // to the (fake) clock so `ago` yields three DIFFERENT readable ages per row;
  // an age read from the wrong clock is then visible, never a coincidence.
  forgetGroupChoice(); forgetSortChoice()
  const H = 3600_000
  const stamp = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
  const fx = [
    mkItem({ slug: 'alpha-item', title: 'alpha-item',
             at: stamp(30 * H), docket_at: stamp(1 * H), status_at: stamp(10 * H) }),
    mkItem({ slug: 'bravo-item', title: 'bravo-item',
             at: stamp(5 * H), docket_at: stamp(2 * H), status_at: stamp(20 * H) }),
    mkItem({ slug: 'charlie-item', title: 'charlie-item',
             at: stamp(50 * H), docket_at: stamp(3 * H), status_at: stamp(4 * H) }),
  ]
  mockWorkItems(fx)
  const { el } = await mount(docketModal())
  await flush()
  const ageOf = (title: string) => {
    const r = rows(el)[titles(el).indexOf(title)] as HTMLElement
    const m = r.querySelector('.l1 .mtime') as HTMLElement
    return { text: m.textContent, title: m.getAttribute('title') ?? '', aria: m.getAttribute('aria-label') ?? '' }
  }
  const byName = (t: string) => fx.find((i) => i.title === t)!
  const clocks: [string, 'updated' | 'created' | 'status', (i: WorkItem) => string][] = [
    ['updated', 'updated', (i) => String(i.docket_at)],
    ['created', 'created', (i) => String(i.at)],
    ['last status change', 'status', (i) => String(i.status_at)],
  ]
  for (const [word, mode, clock] of clocks) {
    await chooseSort(el, mode)
    for (const t of titles(el)) {
      const a = ageOf(t)
      assert.equal(a.text, ago(clock(byName(t))), `${mode}: age of ${t} reads the ${word} clock`)
      assert.ok(a.title.startsWith(word + ' '), `${mode}: tooltip names the clock (${a.title})`)
      assert.equal(a.aria, a.title, 'the accessible label says the same as the tooltip')
    }
  }
  // the three clocks really give three different ages for every row — the
  // check above cannot pass by coincidence
  for (const i of fx) {
    const ages = new Set([ago(String(i.at)), ago(String(i.docket_at)), ago(String(i.status_at))])
    assert.equal(ages.size, 3, `fixture: three distinct ages for ${i.title}`)
  }
})

uiTest('§38g the agent docket (default updated order) keeps the updated age', async (mount) => {
  forgetGroupChoice(); forgetSortChoice()
  const H = 3600_000
  const stamp = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
  const mine = [mkItem({ slug: 'alpha-item', title: 'alpha-item',
    at: stamp(30 * H), docket_at: stamp(1 * H), status_at: stamp(10 * H) })]
  const { el } = await mount(<AgentDocketView slug="org" nid="boss" mine={mine} facts={new Map()}
    toast={() => {}} onFocusAgent={() => {}} onChanged={() => {}}
    refs={{ world: { nodes: new Map(), items: new Map() } as any, onOpen: () => {} } as any} />)
  await flush()
  const m = el.querySelector('.mailrow.docket-row .l1 .mtime') as HTMLElement
  assert.equal(m.textContent, ago(String(mine[0]!.docket_at)))
  assert.ok((m.getAttribute('title') ?? '').startsWith('updated '))
})

uiTest('§38b a progress-only update does not advance status order', async (mount) => {
  forgetGroupChoice(); forgetSortChoice()
  // `noted` was updated a minute ago but has not changed state in days;
  // `moved` really did transition, earlier today.
  const noted = mkItem({ slug: 'only-a-note', title: 'only-a-note',
                         at: '2026-09-01T00:00:00.000Z',
                         docket_at: '2026-09-05T11:59:00.000Z',
                         status_at: '2026-09-01T00:00:00.000Z' })
  const moved = mkItem({ slug: 'really-moved', title: 'really-moved',
                         at: '2026-09-01T00:00:00.000Z',
                         docket_at: '2026-09-05T08:00:00.000Z',
                         status_at: '2026-09-05T08:00:00.000Z' })
  mockWorkItems([noted, moved])
  const { el } = await mount(docketModal())
  await flush()
  assert.deepEqual(titles(el), ['only-a-note', 'really-moved'],
    'control: by UPDATE the note is on top, which is the whole problem')
  await chooseSort(el, 'status')
  assert.deepEqual(titles(el), ['really-moved', 'only-a-note'],
    'a progress note is not a state change, and must not outrank one')
})

uiTest('§38c ties break deterministically, and repeat across re-renders',
async (mount) => {
  forgetGroupChoice(); forgetSortChoice()
  // ⚠ THE STORED ORDER IS THE OPPOSITE of a working tie-break's answer, so a
  // build with no tie-break is wrong every run rather than one time in six.
  const tied = ['a-tie', 'b-tie', 'c-tie'].map((n) => mkItem({
    slug: n, title: n, at: '2026-09-03T00:00:00.000Z',
    docket_at: '2026-09-03T00:00:00.000Z', status_at: '2026-09-03T00:00:00.000Z',
  }))
  mockWorkItems(tied)
  const { el } = await mount(docketModal())
  await flush()
  await chooseSort(el, 'created')
  const first = titles(el)
  assert.deepEqual(first, ['c-tie', 'b-tie', 'a-tie'],
    'equal stamps must fall back to the readable name, as the server does')
  await chooseSort(el, 'status')
  await chooseSort(el, 'created')
  assert.deepEqual(titles(el), first, 'the same list must come back the same')
})

uiTest('§38d sorting orders SIBLINGS inside their parent, not the whole tree flat',
async (mount) => {
  forgetGroupChoice(); forgetSortChoice()
  const parent = mkItem({ slug: 'the-parent', title: 'the-parent',
                          at: '2026-09-01T00:00:00.000Z',
                          docket_at: '2026-09-05T00:00:00.000Z',
                          status_at: '2026-09-01T00:00:00.000Z' })
  // the OLDER child is served first; by creation the newer one must lead —
  // but both must stay under their parent
  const kid1 = mkItem({ slug: 'child-older', title: 'child-older',
                        parent: 'the-parent', at: '2026-09-02T00:00:00.000Z',
                        docket_at: '2026-09-04T00:00:00.000Z',
                        status_at: '2026-09-02T00:00:00.000Z' })
  const kid2 = mkItem({ slug: 'child-newer', title: 'child-newer',
                        parent: 'the-parent', at: '2026-09-03T00:00:00.000Z',
                        docket_at: '2026-09-03T00:00:00.000Z',
                        status_at: '2026-09-03T00:00:00.000Z' })
  mockWorkItems([parent, kid1, kid2])
  const { el } = await mount(docketModal())
  await flush()
  assert.deepEqual(titles(el), ['the-parent', 'child-older', 'child-newer'],
    'control: the served order nests the older child first')
  await chooseSort(el, 'created')
  assert.deepEqual(titles(el), ['the-parent', 'child-newer', 'child-older'],
    'the children reordered under the parent — and the parent did not move, '
    + 'and neither child was promoted out of the nesting')
  const depths = rows(el).map((r) => r.className.includes('docket-child'))
  assert.deepEqual(depths.slice(1), [true, true],
    'both rows are still CHILDREN — sorting flattened the tree')
})

uiTest('§38e an item from an older backend sorts by CREATION, never by its edit clock',
async (mount) => {
  forgetGroupChoice(); forgetSortChoice()
  // ⚠ THE PAYLOAD WITHOUT THE FIELD. The server derives `status_at` for every
  // item it serves, so this models an older BACKEND, not an older item — and
  // it is the only shape that reaches the client-side fallback at all. Its
  // edit clock is deliberately the NEWEST thing in the fixture, so a fallback
  // to `updated_at` would put it on top; its creation is the OLDEST, so the
  // honest answer puts it last. The two answers cannot be confused.
  const legacy = mkItem({
    slug: 'from-an-older-build', title: 'from-an-older-build',
    at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-05T23:00:00.000Z',
    docket_at: '2026-09-05T23:00:00.000Z',
  })
  delete (legacy as { status_at?: string | null }).status_at
  const recent = mkItem({
    slug: 'moved-yesterday', title: 'moved-yesterday',
    at: '2026-09-02T00:00:00.000Z',
    updated_at: '2026-09-04T00:00:00.000Z',
    docket_at: '2026-09-04T00:00:00.000Z',
    status_at: '2026-09-04T00:00:00.000Z',
  })
  mockWorkItems([legacy, recent])
  const { el } = await mount(docketModal())
  await flush()
  assert.deepEqual(titles(el), ['from-an-older-build', 'moved-yesterday'],
    'control: by UPDATE the legacy row leads, so a fallback to that clock '
    + 'would be invisible here')
  await chooseSort(el, 'status')
  assert.deepEqual(titles(el), ['moved-yesterday', 'from-an-older-build'],
    'a row with no status clock must fall back to its CREATION — falling back '
    + 'to the edit clock would date a state change that never happened')
})

// ───────────────────────────────────── §8 a second click is a second request
//
// ⚠ ASTRA, 2026-09-05: the latches compared the target id and nothing else, so
// once a reference had been followed, following it AGAIN did nothing — for the
// rest of the session — even after the reader had deliberately moved to
// something else in between. The latch has to stay (without it every poll
// re-runs the jump and drags the reader back), so the request carries its own
// identity and the latch compares that.

uiTest('§8 following the SAME reference twice works the second time',
async (mount) => {
  mockWorkItems([
    mkItem({ slug: 'first-item', title: 'first-item' }),
    mkItem({ slug: 'second-item', title: 'second-item' }),
  ])
  const { el, render: re } = await mount(docketModal())
  await flush()
  // the first click on `first-item`
  await re(docketModal({ jumpTo: 'first-item', jumpSeq: 1 }))
  await flush()
  assert.match(pane(el)?.textContent ?? '', /first-item/,
    'positive control: the first jump landed')
  // the reader then chooses something else by hand
  const rows2 = rows(el)
  const other = rows2.find((r) => (r.textContent ?? '').includes('second-item'))!
  await inAct(() => { (other as HTMLElement).click() })
  await flush()
  assert.match(pane(el)?.textContent ?? '', /second-item/,
    'positive control: the manual selection moved the pane')
  // …and clicks the SAME reference again. A new request, not a repeat.
  await re(docketModal({ jumpTo: 'first-item', jumpSeq: 2 }))
  await flush()
  assert.match(pane(el)?.textContent ?? '', /first-item/,
    'the second click on the same reference did nothing')
})

uiTest('§8b CONTROL — an unrelated repoll does NOT re-run the jump',
async (mount) => {
  // ⚠ THE CLOCK IS MOCKED BECAUSE THE REPOLL IS THE WHOLE POINT. A re-render
  // with the same props leaves every dep of the jump effect unchanged, so
  // React skips it and this control passed WHETHER OR NOT THE LATCH EXISTED —
  // it was the dependency array being checked, not the guard. Ticking the
  // 5s poll gives `usePolled` a FRESH payload object, `data` changes identity,
  // and the effect really does re-run. (Found by mutate_docketsort: removing
  // the latch left this check green and took §4/§5 down instead.)
  useFakeClock()
  try {
    mockWorkItems([
      mkItem({ slug: 'first-item', title: 'first-item' }),
      mkItem({ slug: 'second-item', title: 'second-item' }),
    ])
    const { el, render } = await mount(docketModal({ jumpTo: 'first-item', jumpSeq: 1 }))
    await flush()
    assert.match(pane(el)?.textContent ?? '', /first-item/,
      'positive control: the request opened the item it names')
    const other = rows(el).find((r) => (r.textContent ?? '').includes('second-item'))!
    await inAct(() => { (other as HTMLElement).click() })
    await flush()
    assert.match(pane(el)?.textContent ?? '', /second-item/,
      'positive control: the reader moved')
    // the same request, re-delivered by a re-render, with the poll ticking
    // underneath it — the reader must be left exactly where they went
    await render(docketModal({ jumpTo: 'first-item', jumpSeq: 1 }))
    await flush()
    await advance(6000, 16)
    await flush()
    assert.match(pane(el)?.textContent ?? '', /second-item/,
      'an unchanged request re-ran and dragged the reader back')
  } finally { realClock() }
})

uiTest('§39 Dropped reads as an outcome that is not Done', async (mount) => {
  // ⚠ THE WHOLE POINT OF THE STATUS. The word "Dropped" on its own can be
  // read as "finished with", and the docket's own Done sits two rows away, so
  // the row has to be readable as the opposite of a completion without
  // opening anything. Checked on the ROW, which is what the user scans.
  mockWorkItems([
    mkItem({ title: 'Ended Work', status: 'dropped',
      dropped_reason: 'FAILED UNRECOVERABLY: the vendor retired the API' }),
    mkItem({ title: 'Finished Work', status: 'done' }),
  ])
  forgetGroupChoice()
  const { el } = await mount(docketModal())
  await flush()
  const rowFor = (t: string) => rows(el)[titles(el).indexOf(t)] as HTMLElement
  const chip = (t: string) =>
    rowFor(t).querySelector('.docket-status') as HTMLElement | null

  assert.equal(chip('Ended Work')?.textContent?.trim(), 'Dropped')
  assert.equal(chip('Finished Work')?.textContent?.trim(), 'Done')
  // the hover help is where the row says what the word means. Without it the
  // only difference between the two outcomes is one dim colour.
  const help = chip('Ended Work')?.getAttribute('title') ?? ''
  assert.match(help, /WITHOUT being completed/)
  assert.match(help, /never Done/)
  // CONTROL: Done carries no such help, so the assertion above is about
  // `dropped` and not about every chip having a title
  assert.equal(chip('Finished Work')?.getAttribute('title'), null)
})

uiTest('§40 review-state tickets display clearly labelled Reviewer alongside assignee', async (mount) => {
  let focused: string | null = null
  let closed = false
  mockWorkItems([
    mkItem({
      slug: 'review-with-reviewer',
      title: 'Review with Reviewer',
      status: 'review',
      owner: { node: 'worker-agent', generation: 1 },
      reviewer: { node: 'review-lead', generation: 1 },
    }),
    mkItem({
      slug: 'in-progress-with-old-reviewer',
      title: 'In Progress with Old Reviewer',
      status: 'in_progress',
      owner: { node: 'worker-agent', generation: 1 },
      reviewer: { node: 'past-reviewer', generation: 1 },
    }),
    mkItem({
      slug: 'review-without-reviewer',
      title: 'Review without Reviewer',
      status: 'review',
      owner: { node: 'worker-agent', generation: 1 },
      reviewer: null,
    }),
  ])
  forgetGroupChoice()
  const { el } = await mount(docketModal({
    close: () => { closed = true },
    onFocusAgent: (id) => { focused = id },
  }))
  await flush()

  const rowList = rows(el)
  assert.equal(rowList.length, 3)

  const bySlug = (slug: string) => rowList.find((r) => r.querySelector('.docket-rowname')?.textContent === slug)!
  const r1 = bySlug('review-with-reviewer')
  const r2 = bySlug('in-progress-with-old-reviewer')
  const r3 = bySlug('review-without-reviewer')

  // Case 1: status === 'review' with distinct owner and reviewer
  // List row check: shows assignee in .docket-updater and Reviewer in .docket-reviewer
  const r1Updater = r1.querySelector('.docket-updater')
  assert.ok(r1Updater, 'r1 has docket-updater')
  assert.match(r1Updater.textContent ?? '', /worker-agent/, 'assignee shown in list row')
  const r1Reviewer = r1.querySelector('.docket-reviewer')
  assert.ok(r1Reviewer, 'r1 has docket-reviewer')
  assert.match(r1Reviewer.textContent ?? '', /Reviewer:/, 'Reviewer label shown in list row')
  assert.match(r1Reviewer.textContent ?? '', /review-lead/, 'reviewer name shown in list row')

  // Case 2: status !== 'review' with stored reviewer: must NOT display reviewer in list row
  assert.equal(r2.querySelector('.docket-reviewer'), null,
    'non-review item does not display reviewer in list row')

  // Case 3: status === 'review' with absent reviewer: must NOT display reviewer or guess from owner
  assert.equal(r3.querySelector('.docket-reviewer'), null,
    'review item with null reviewer does not display reviewer in list row')

  // Open Case 1 in detail pane
  await inAct(() => (r1 as HTMLElement).click())
  await flush()

  const sub1 = el.querySelector('.docket-pane-sub')!
  assert.ok(sub1, 'docket-pane-sub rendered')
  assert.match(sub1.textContent ?? '', /Assigned to\s+worker-agent/,
    'detail subtitle shows clearly labelled Assigned to')
  assert.match(sub1.textContent ?? '', /Reviewer\s+review-lead/,
    'detail subtitle shows clearly labelled Reviewer')

  // Preserves ownership and reply routing
  const replyBox = el.querySelector('.docket-reply-label')
  assert.match(replyBox?.textContent ?? '', /Reply to\s+worker-agent · assigned to this item/,
    'reply label preserves assignment to worker-agent')

  // Clicking reviewer jump focuses reviewer agent and closes modal
  const reviewerBtn = sub1.querySelectorAll('button.cc-name-jump')[1] as HTMLButtonElement
  assert.ok(reviewerBtn, 'reviewer jump button exists in subtitle')
  assert.equal(reviewerBtn.textContent?.trim(), 'review-lead')
  await inAct(() => reviewerBtn.click())
  assert.ok(closed, 'modal closed on reviewer click')
  assert.equal(focused, 'review-lead', 'focused reviewer desk')

  // Open Case 2 in detail pane (non-review with stored reviewer)
  await inAct(() => (r2 as HTMLElement).click())
  await flush()
  const sub2 = el.querySelector('.docket-pane-sub')!
  assert.match(sub2.textContent ?? '', /Assigned to\s+worker-agent/)
  assert.doesNotMatch(sub2.textContent ?? '', /Reviewer/,
    'non-review item detail does not show Reviewer label')
  assert.doesNotMatch(sub2.textContent ?? '', /past-reviewer/,
    'non-review item detail does not show old stored reviewer')

  // Open Case 3 in detail pane (review with absent reviewer)
  await inAct(() => (r3 as HTMLElement).click())
  await flush()
  const sub3 = el.querySelector('.docket-pane-sub')!
  assert.match(sub3.textContent ?? '', /Assigned to\s+worker-agent/)
  assert.doesNotMatch(sub3.textContent ?? '', /Reviewer/,
    'review item with absent reviewer does not show Reviewer label')
})

uiTest('§41 `deploy_ready` reads as Deploy Ready — active, not Blocked, not Done',
  async (mount) => {
    // Coordinator/user 2026-09-08: completed implementation awaiting
    // deployment was being asserted as `blocked`, which is wrong — nothing
    // outside the item is what it is stuck on. `deploy_ready` names that
    // state without borrowing Blocked or Done.
    mockWorkItems([
      mkItem({ title: 'Ready to ship', status: 'deploy_ready' }),
      mkItem({ title: 'Stuck on something', status: 'blocked',
        blocked_reason: 'waiting on the vendor' }),
      mkItem({ title: 'Live already', status: 'done' }),
    ])
    forgetGroupChoice()
    const { el } = await mount(docketModal())
    await flush()
    const status = (r: Element) => r.querySelector('.docket-status')
    const ready = rowFor(el, 'Ready to ship')
    assert.equal(status(ready)?.textContent, 'Deploy Ready')
    assert.ok(ready.classList.contains('status-deploy_ready'),
      'the row carries its own status class, not Blocked or Done\'s')
    assert.match(status(ready)?.getAttribute('title') ?? '', /awaiting deployment/,
      'the hover help distinguishes it from Blocked and from Done')
    // CONTROL: neighboring statuses keep their own words and classes — this
    // is not a fallback label a missing entry would also produce
    assert.equal(status(rowFor(el, 'Stuck on something'))?.textContent, 'Blocked')
    assert.equal(status(rowFor(el, 'Live already'))?.textContent, 'Done')

    await inAct(() => ready.click())
    await flush()
    assert.equal(pane(el)?.querySelector('.docket-status')?.textContent, 'Deploy Ready')

    await chooseGroup(el, 'status')
    assert.ok(headings(el).includes('Deploy Ready'), headings(el).join(' | '))
    // it groups on its own — not folded into Blocked or Other closed
    assert.deepEqual(titles(el), ['Stuck on something', 'Ready to ship', 'Live already'])
  })

uiTest('agent docket exposes backlog, all three clocks and status groups without losing selection', async mount => {
  forgetGroupChoice(); forgetSortChoice()
  const stamp=(n:number)=>`2026-09-0${n}T00:00:00Z`
  const mine=[
    mkItem({slug:'updated-first', title:'updated-first', status:'open', at:stamp(1), docket_at:stamp(3), status_at:stamp(2)}),
    mkItem({slug:'created-first', title:'created-first', status:'in_progress', at:stamp(3), docket_at:stamp(2), status_at:stamp(1)}),
    mkItem({slug:'status-first', title:'status-first', status:'open', at:stamp(2), docket_at:stamp(1), status_at:stamp(3)}),
    mkItem({slug:'future-work', title:'future-work', status:'backlogged', at:stamp(5)}),
  ]
  const {el}=await mount(<AgentDocketView slug="org" nid="agent1" mine={mine} facts={new Map()}
    toast={()=>{}} refs={{world:{nodes:new Map(),items:new Map()} as any,onOpen:()=>{}} as any}/> )
  await flush()
  assert.deepEqual(titles(el),['updated-first','created-first','status-first'])
  await inAct(()=> (el.querySelector('.mailrow.docket-row') as HTMLElement).click())
  const chosen=el.querySelector('.mailer-read')!.textContent
  const choose=async (selector:string,value:string)=>{
    const select=el.querySelector(selector) as HTMLSelectElement
    await inAct(()=>{select.value=value;select.dispatchEvent(new window.Event('change',{bubbles:true}))})
    await flush()
  }
  await choose('.docket-sort-select','created')
  assert.deepEqual(titles(el),['created-first','status-first','updated-first'])
  await choose('.docket-sort-select','status')
  assert.deepEqual(titles(el),['status-first','updated-first','created-first'])
  await inAct(()=> (el.querySelector('.docket-showbacklog input') as HTMLInputElement).click())
  assert.equal(titles(el).at(-1),'future-work')
  await choose('.docket-group-select','status')
  assert.equal(el.querySelectorAll('.docket-group-head').length,3,'two active statuses and a backlog group')
  assert.equal(el.querySelector('.mailer-read')!.textContent,chosen,'view controls preserve the selected detail')
})
