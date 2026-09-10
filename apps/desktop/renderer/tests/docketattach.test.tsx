// docketattach.test.tsx — ticket attachments (user feature 2026-09-10):
// files and images attached TO a work item, rendered in the docket pane.
// Images reuse the chat's AttachThumb (thumbnail + download), other files
// the attach-chip download link; adding posts the raw file to the item's
// attachments route and refetches, removal DELETEs by record id.
import './harness'
import { flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { DocketModal } from '../src/canvas/docket'
import type { TreePayload, WorkItem } from '../src/types'

interface Call { method: string; url: string }

const mkItem = (o: Partial<WorkItem>): WorkItem => ({
  slug: 'attach-me', rev: 1, kind: 'code', title: 'Attach me',
  objective: 'Test objective', status: 'in_progress', blocked_reason: null,
  archived: false, archived_at: null,
  owner: { node: 'agent1', generation: 1 }, owner_current: true,
  owner_state: 'live', reviewer: null, participants: [],
  created_by: { node: 'agent1', generation: 1 },
  at: '2026-09-05T08:00:00.000Z', updated_at: '2026-09-05T09:00:00.000Z',
  done_so_far: ['step'], working_on_next: ['next'],
  docket_at: '2026-09-05T09:00:00.000Z',
  last_updater: { node: 'agent1', generation: 1 },
  manual_attention: null, dismissals: [], questions: [],
  effective_attention: false, attention_sources: [], acceptance: [],
  dependencies: [], evidence: [], delivery: null, accepted: null,
  superseded_by: null, history: [],
  ...o,
})

const TREE: TreePayload = {
  slug: 'org1', name: 'Org 1', epoch: 1, rev: 1, roots: [],
  work_items_summary: { attention: 0, active: 1 },
  user_inbox_count: 0, user_inbox_urgent_count: 0, asks: [],
} as unknown as TreePayload

function mock(items: WorkItem[]): Call[] {
  const calls: Call[] = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    ((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const path = String(url)
      calls.push({ method, url: path })
      const headers = new Headers()
      const ok = (payload: unknown) => Promise.resolve(
        { ok: true, status: 200, headers, json: () => Promise.resolve(payload) })
      if (method === 'POST' && /\/attachments\?/.test(path)) {
        const name = new URL(path, 'http://localhost').searchParams.get('name') ?? 'file'
        return ok({ attachment: { id: 'a-new', at: '2026-09-10T17:00:00Z',
          by: 'user', name, bytes: 3 } })
      }
      if (method === 'DELETE' && /\/attachments\//.test(path)) {
        return ok({ removed: path.split('/').pop() })
      }
      if (method === 'GET' && path.includes('/work-items')) {
        return ok({ items, counts: { attention: 0, active: items.length,
          archived: 0, backlogged: 0 }, now: '2026-09-05T10:00:00.000Z' })
      }
      return ok({})
    }) as typeof fetch
  return calls
}

function rig(name: string, body: (k: {
  mount: () => Promise<HTMLElement>, calls: () => Call[],
  setCalls: (c: Call[]) => void }) => Promise<void>) {
  test(name, async (t: TestContext) => {
    useFakeClock()
    let open: { unmount: () => Promise<void> } | null = null
    let calls: Call[] = []
    t.after(async () => { try { await open?.unmount() } finally { realClock() } })
    await body({
      mount: async () => {
        const view = await mountView(
          <DocketModal slug="org1" toast={() => {}} close={() => {}}
            jumpTo={null} tree={TREE} />, (host) => host)
        open = view
        await inAct(async () => { await flush(4) })
        return view.el
      },
      calls: () => calls,
      setCalls: (c) => { calls = c },
    })
  })
}

const ITEM = mkItem({ attachments: [
  { id: 'a1', at: '2026-09-10T16:00:00Z', by: 'user', name: 'shot.png', bytes: 1234 },
  { id: 'a2', at: '2026-09-10T16:01:00Z', by: { node: 'agent1', generation: 1 },
    name: 'log.txt', bytes: 99 },
] })

rig('the pane lists attachments: images as thumbnails, files as download chips', async ({ mount, setCalls }) => {
  setCalls(mock([ITEM]))
  const el = await mount()
  await inAct(() => { (el.querySelector('.mailrow.docket-row') as HTMLElement).click() })
  await inAct(async () => { await flush(2) })
  assert.match(el.textContent ?? '', /ATTACHMENTS/)
  const thumb = el.querySelector<HTMLImageElement>('.docket-attachments img.attach-thumb')
  assert.ok(thumb, 'the image attachment renders as a thumbnail')
  assert.match(thumb!.src, /\/work-items\/attach-me\/attachments\/a1$/)
  const chip = el.querySelector<HTMLAnchorElement>('.docket-attachments a.attach-chip')
  assert.ok(chip, 'the non-image attachment renders as a download chip')
  assert.match(chip!.href, /\/work-items\/attach-me\/attachments\/a2$/)
  assert.equal(chip!.getAttribute('download'), 'log.txt')
  assert.match(chip!.textContent ?? '', /log\.txt/)
  assert.match(chip!.textContent ?? '', /99 B/)
  // the add control exists and is wired to a real file input
  assert.ok(el.querySelector('.docket-attach-add'))
  assert.ok(el.querySelector('input[aria-label="attach files to this item"]'))
})

rig('an item without attachments still offers the add control, with no empty chrome', async ({ mount, setCalls }) => {
  setCalls(mock([mkItem({})]))
  const el = await mount()
  await inAct(() => { (el.querySelector('.mailrow.docket-row') as HTMLElement).click() })
  await inAct(async () => { await flush(2) })
  assert.match(el.textContent ?? '', /ATTACHMENTS/)
  assert.equal(el.querySelector('.docket-attachments .attach-row'), null,
    'no empty attachment row is rendered')
  assert.ok(el.querySelector('.docket-attach-add'))
})

rig('picking a file posts it to the item and refetches the list', async ({ mount, setCalls, calls }) => {
  const captured = mock([ITEM])
  setCalls(captured)
  const el = await mount()
  await inAct(() => { (el.querySelector('.mailrow.docket-row') as HTMLElement).click() })
  await inAct(async () => { await flush(2) })
  const before = captured.filter((c) => c.method === 'GET' && c.url.includes('/work-items')).length
  const input = el.querySelector<HTMLInputElement>(
    'input[aria-label="attach files to this item"]')!
  const file = new File([new Uint8Array([1, 2, 3])], 'new shot.png',
    { type: 'image/png' })
  Object.defineProperty(input, 'files', { value: [file] })
  await inAct(() => {
    input.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await inAct(async () => { await flush(4) })
  const posts = captured.filter((c) => c.method === 'POST' && c.url.includes('/attachments'))
  assert.equal(posts.length, 1, 'one upload request per picked file')
  assert.match(posts[0]!.url, /\/work-items\/attach-me\/attachments\?name=new%20shot\.png$/)
  const after = captured.filter((c) => c.method === 'GET' && c.url.includes('/work-items')).length
  assert.ok(after > before, 'the list is refetched so the pane shows the new attachment')
})

rig('the remove control deletes by record id', async ({ mount, setCalls }) => {
  const captured = mock([ITEM])
  setCalls(captured)
  const el = await mount()
  await inAct(() => { (el.querySelector('.mailrow.docket-row') as HTMLElement).click() })
  await inAct(async () => { await flush(2) })
  const chipX = el.querySelector<HTMLButtonElement>(
    '.docket-attachments a.attach-chip .chip-x')
  assert.ok(chipX, 'the chip carries its remove control')
  assert.match(chipX!.title, /permanent/)
  await inAct(() => { chipX!.click() })
  await inAct(async () => { await flush(3) })
  const dels = captured.filter((c) => c.method === 'DELETE')
  assert.equal(dels.length, 1)
  assert.match(dels[0]!.url, /\/work-items\/attach-me\/attachments\/a2$/)
})
