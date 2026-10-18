// projectqueue.test.tsx — a project's MAIL QUEUE on the desktop (Orgtree
// 4.4.0; docket `project-mail-queue-settings-round-robin-default-o`, user
// 2026-10-18 08:01Z-08:13Z).
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 a project mail's queue chip: handed to an agent, awaiting its ack,
//      acked, released back to the queue, an ack record, a dead letter, purged;
//   §2 project settings: "Mail queue" (round-robin by default, or ack mode),
//      "Never hand an agent its own mail", and in ack mode the ack timeout
//      and max attempts; saving sends ONE set_mail_queue with what changed;
//   §3 the ack timeout and max attempts show as inactive while the Runtime
//      20-minute checkup is off;
//   §4 the project desk's inbox tab purges waiting mail after a confirmation.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs projectqueue

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { QueueChip } from '../src/canvas/mail'
import { NodeConfig } from '../src/canvas/modals'
import { ProjectDesk } from '../src/canvas/projectdesk'
import type { CanvasNode, OpRequest, OpResult } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const noop = () => {}
const refs = { world: { org: 'org' }, onOpen: noop } as never
const tree = { slug: 'org', roots: [] } as unknown as TreePayload

function project(scope: Record<string, unknown> = {}, extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: 'website', title: 'website', tier: 'project', kind: 'project', state: 'live', model_id: '',
    seat: 0, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, configured_scope: { tools: {}, add_dirs: [], ...scope },
    parent: 'boss', charter: 'The site.',
    children: [{ id: 'dev1', title: 'dev1', tier: 'haiku', state: 'live', busy: false, children: [] }],
    lineage: [], turns: [], audiences_held: [], mail_pending: 0,
    last_status: null, occupancy: 0, context_window: 0, busy: false, activity: null,
    ...extra,
  } as unknown as CanvasNode
}

/** the harness server, with the Runtime settings answered as `checkups` says */
function serve(t: TestContext, checkups = true) {
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  const inner = globalThis.fetch
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(url), 'http://x').pathname === '/api/app-settings/runtime')
      return Promise.resolve(new Response(JSON.stringify({ working_checkups_enabled: checkups }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }))
    return inner(url, init)
  }) as typeof fetch
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
}

const row = (label: string) => [...document.querySelectorAll<HTMLElement>('.set-row, .set-block')]
  .find((r) => r.textContent?.includes(label))
const choose = (sel: HTMLSelectElement, value: string) => {
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(sel, value)
  sel.dispatchEvent(new Event('change', { bubbles: true }))
}

/* ─── §1 the queue chip ─────────────────────────────────────────────────── */

test('§1 a project mail says where it is in the queue', async (t) => {
  const cases: [Parameters<typeof QueueChip>[0]['q'], string][] = [
    [{ held_by: 'dev1', ack: false }, 'delivered to dev1'],   // user 08:31:49Z
    [{ held_by: 'dev1', ack: true }, 'dev1 · awaiting ack'],
    [{ held_by: 'dev1', ack: true, acked_at: '2026-10-18T08:20:00Z', ack_mail: 'm9' }, 'acked by dev1'],
    [{ released: { by: 'dev1', why: 'was halted' } }, 'released (dev1)'],
    [{ ack_of: 'm1' }, 'ack of m1'],
    [{ dead_letter: { by: 'dev1', why: 'did not ack it after 3 reminders', attempts: 3 } }, 'dead letter'],
    [{ purged: { by: '@user' } }, 'purged'],
  ]
  for (const [q, want] of cases) {
    const view = await mountView(<QueueChip q={q} />, (el) => el)
    t.after(() => view.unmount())
    assert.equal(view.el.querySelector('.queuekind')?.textContent, want, JSON.stringify(q))
  }
  const awaiting = await mountView(<QueueChip q={{ held_by: 'dev1', ack: true }} />, (el) => el)
  t.after(() => awaiting.unmount())
  assert.ok(awaiting.el.querySelector('.queuekind.awaiting'), 'an owed ack is marked')
})

/* ─── §2-3 project settings ─────────────────────────────────────────────── */

async function settings(t: TestContext, nd: CanvasNode, checkups = true) {
  serve(t, checkups)
  const ops: OpRequest[] = []
  const view = await mountView(<NodeConfig node={nd} map={new Map([[nd.id, nd]])} tree={tree} slug="org"
    op={async (b) => { ops.push(b); return {} as OpResult }} toast={noop} close={noop} />, (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(6) })
  return ops
}
const save = async () => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'save')!
  await inAct(async () => { b.click(); await flush(4) })
}

test('§2 the Mail queue setting: round-robin by default; ack mode with its timeout and attempts; one set_mail_queue on save', async (t) => {
  const ops = await settings(t, project())
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Mail queue"]')
  assert.ok(select, 'a Mail queue select')
  assert.equal(select!.value, 'round_robin', 'round-robin by default')
  assert.ok(row('Never hand an agent its own mail'), 'the exclude-sender switch')
  assert.equal(row('Ack timeout') === undefined, true, 'no ack settings in round-robin')
  await inAct(() => { choose(select!, 'ack') })
  assert.ok(row('Ack timeout'), 'ack mode shows the timeout')
  const attempts = document.querySelector<HTMLInputElement>('input[aria-label="Max attempts"]')
  assert.equal(attempts?.value, '3', 'three attempts by default')
  assert.equal(row('Ack timeout')!.querySelector<HTMLInputElement>('input')!.checked, true, 'the timeout is on by default')
  await save()
  assert.deepEqual(ops, [{ op: 'set_mail_queue', node: 'website', mode: 'ack' }])
})

test('§3 the ack timeout and max attempts are inactive while the 20-minute checkup is off', async (t) => {
  await settings(t, project({ mail_queue: 'ack' }), false)
  const timeout = row('Ack timeout')!
  assert.equal(timeout.querySelector<HTMLInputElement>('input')!.disabled, true, 'the timeout is inactive')
  assert.match(timeout.textContent ?? '', /Inactive/, 'and says why')
  assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="Max attempts"]')!.disabled, true, 'so are attempts')
})

/* ─── §4 purge ───────────────────────────────────────────────────────────── */

test('§4 the inbox tab purges waiting mail after a confirmation', async (t) => {
  serve(t)
  const ops: OpRequest[] = []
  const nd = project({}, { mail_pending: 2 })
  const view = await mountView(<ProjectDesk node={nd} slug="org" tree={tree} map={new Map([[nd.id, nd]])}
    op={(b) => { ops.push(b); return Promise.resolve({ purged: 2 } as unknown as OpResult) }}
    toast={noop} refs={refs} />, (el) => el)
  t.after(() => view.unmount())
  await flush(2)
  await inAct(() => { view.el.querySelector<HTMLButtonElement>('.cc-tabs button[data-tab="inbox"]')!.click() })
  await flush(2)
  const purge = view.el.querySelector<HTMLButtonElement>('button[data-action="purge-queue"]')
  assert.ok(purge, 'a purge button while mail waits')
  await inAct(() => { purge!.click() })
  assert.equal(ops.length, 0, 'nothing before the confirmation')
  assert.match(document.body.textContent ?? '', /2 waiting mails will be retracted/)
  const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent === 'purge')!
  await inAct(async () => { confirm.click(); await flush(2) })
  assert.deepEqual(ops, [{ op: 'purge_mail_queue', node: 'website' }])
})
