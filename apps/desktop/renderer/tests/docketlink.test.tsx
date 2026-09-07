// docketlink.test.tsx — "open this item in the docket", from the tool chip.
//
// User request 2026-09-05: "when an agent updates a docket item, it should
// have a button next to the item that opens the docket and selects the item,
// like how mails have such a button". Two halves meet here:
//
//   1. the CHIP renders the button, and only when there is an item to open;
//   2. the DOCKET, handed a name, selects and reveals that item — once.
//
// The metadata half (which tool results carry an item at all, and that the
// identity comes from the RESULT rather than the arguments) is pinned in the
// backend by tests/test_docket_open_link.py; this file does not restate it.
//
// Run: cd frontend && node tests/run.mjs docketlink

import { flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Msg } from '../src/canvas/desk'
import { DocketModal } from '../src/canvas/docket'
import type { ChatMessage, TreePayload, WorkItem } from '../src/types'

// ------------------------------------------------------------- the chip

const msg = (tool: Record<string, unknown>): ChatMessage => ({
  role: 'assistant', text: '', at: '2026-09-05T10:00:00.000Z',
  tools: [{ name: 'mcp__orgtree__orgtree_work', id: 't1', ...tool }],
} as unknown as ChatMessage)

async function chip(tool: Record<string, unknown>, onWorkLink?: (w: unknown) => void) {
  const view = await mountView(
    <Msg m={msg(tool)} slug="org" nid="worker"
      onWorkLink={onWorkLink as never} />,
    (el) => el)
  return view.el
}

const openButtons = (el: HTMLElement) =>
  [...el.querySelectorAll('.worklink')] as HTMLButtonElement[]

test('§1 a docket write offers to open the item it wrote', async () => {
  const clicked: unknown[] = []
  const el = await chip({ arg: 'update', work: { slug: 'git-review-workspace' } },
    (w) => clicked.push(w))
  const btns = openButtons(el)
  assert.equal(btns.length, 1, 'no open-in-docket button on a docket write')
  assert.match(btns[0]!.getAttribute('title') ?? '', /git-review-workspace/)
  await inAct(() => btns[0]!.click())
  assert.deepEqual(clicked, [{ slug: 'git-review-workspace' }])
})

test('§2 a chip with no item to open has no button', async () => {
  // THE CONTROL. Without it, a button rendered unconditionally passes §1 and
  // offers a dead link on every read action and every failure — which is
  // exactly what the backend metadata is careful not to produce.
  const el = await chip({ arg: 'list' }, () => {})
  assert.equal(openButtons(el).length, 0)
})

test('§3 without a handler the button is not offered at all', async () => {
  // a button whose click goes nowhere is worse than no button
  const el = await chip({ arg: 'update', work: { slug: 'anything' } })
  assert.equal(openButtons(el).length, 0)
})

// ------------------------------------------------------------ the docket

const mkItem = (o: Partial<WorkItem>): WorkItem => ({
  slug: 'fixture', rev: 1, kind: 'code', title: 'Item', objective: '',
  status: 'in_progress', blocked_reason: null, archived: false,
  archived_at: null, owner: { node: 'agent1', generation: 1 },
  owner_current: true, owner_state: 'live', participants: [],
  created_by: { node: 'agent1', generation: 1 },
  at: '2026-09-05T08:00:00.000Z', updated_at: '2026-09-05T09:00:00.000Z',
  done_so_far: [], working_on_next: [], docket_at: '2026-09-05T09:00:00.000Z',
  last_updater: { node: 'agent1', generation: 1 }, manual_attention: null,
  dismissals: [], questions: [], effective_attention: false,
  attention_sources: [], acceptance: [], dependencies: [], evidence: [],
  delivery: null, accepted: null, superseded_by: null, history: [],
  ...o,
} as unknown as WorkItem)

const tree = () => ({
  slug: 'org1', name: 'Org 1', epoch: 1, rev: 1, roots: [],
  work_items_summary: { attention: 0, active: 0 },
  user_inbox_count: 0, user_inbox_urgent_count: 0, asks: [], asks_open: 0,
} as unknown as TreePayload)

function serve(items: WorkItem[], backlogged: WorkItem[] = []) {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    ((url: string) => {
      const path = String(url)
      const ok = (p: unknown) => Promise.resolve({
        ok: true, status: 200, headers: new Headers(),
        json: () => Promise.resolve(p),
      })
      if (path.includes('/work-items')) {
        return ok({
          items,
          ...(path.includes('archived=1') ? { archived: [] } : {}),
          ...(path.includes('backlogged=1') ? { backlogged } : {}),
          counts: { attention: 0, active: items.length, archived: 0,
            backlogged: backlogged.length },
          now: '2026-09-05T10:00:00.000Z',
        })
      }
      return ok({})
    }) as unknown as typeof fetch
}

function uiTest(name: string, body: (mount: (v: React.ReactElement)
  => Promise<HTMLElement>) => Promise<void>) {
  test(name, async (t: TestContext) => {
    useFakeClock()
    let open: { unmount: () => Promise<void> } | null = null
    t.after(async () => { try { await open?.unmount() } finally { realClock() } })
    window.localStorage.removeItem('orgtree.docket.group')
    await body(async (v) => {
      const view = await mountView(v, (host) => host)
      open = view
      return view.el
    })
  })
}

const pane = (el: HTMLElement) => el.querySelector('.mailer-read')
const names = (el: HTMLElement) =>
  [...el.querySelectorAll('.mailrow.docket-row .l1 .mfrom')]
    .map((n) => n.textContent ?? '')

uiTest('§4 opening AT an item selects it, even one hidden behind a filter',
  async (mount) => {
    // ⚠ THE ITEM IS NOT LOADED YET WHEN THE PANEL MOUNTS. The link fires
    // before the first poll answers, so a jump that acts immediately silently
    // does nothing and the button looks broken. This is the case that matters.
    const hidden = mkItem({ slug: 'nested-docket-items', title: 'Nested items',
      status: 'backlogged' })
    serve([mkItem({ slug: 'something-else', title: 'Something else' })], [hidden])
    let handled = 0
    const el = await mount(
      <DocketModal slug="org1" toast={() => {}} close={() => {}} tree={tree()}
        jumpTo="nested-docket-items" onJumpHandled={() => { handled++ }} />)
    await flush()

    assert.match(pane(el)?.textContent ?? '', /Nested items/,
      'the named item was not opened')
    assert.ok(names(el).includes('nested-docket-items'),
      'the hidden group was not revealed, so the row is not there to select')
    assert.equal(handled, 1, 'the jump must be consumed exactly once')
  })

uiTest('§5 a name this org does not have is discarded, not held forever',
  async (mount) => {
    // it may be an item this viewer may not read, or one that is simply gone.
    // Holding the jump would drag the user back to it on every later render.
    serve([mkItem({ slug: 'something-else', title: 'Something else' })])
    let handled = 0
    const el = await mount(
      <DocketModal slug="org1" toast={() => {}} close={() => {}} tree={tree()}
        jumpTo="not-in-this-org" onJumpHandled={() => { handled++ }} />)
    await flush()
    assert.ok(el.querySelector('.mailer-none'), 'something was opened anyway')
    assert.equal(handled, 1, 'an unresolvable jump was never consumed')
  })

uiTest('§6 with no jump the panel opens on nothing at all', async (mount) => {
  // the control for §4: without it, a panel that auto-selected its first row
  // would pass §4 while ignoring `jumpTo` entirely
  serve([mkItem({ slug: 'something-else', title: 'Something else' })])
  const el = await mount(
    <DocketModal slug="org1" toast={() => {}} close={() => {}} tree={tree()} />)
  await flush()
  assert.ok(el.querySelector('.mailer-none'))
})
