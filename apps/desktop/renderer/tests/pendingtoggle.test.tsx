import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import { refreshConvo, resetConvos } from '../src/convo'
import type { CanvasNode } from '../src/canvas/shared'

const node = { id: 'worker', generation: 2, kind: 'agent', state: 'live', tier: 'sol',
  children: [], seat: 2, grant: 0, scope: { tools: {}, add_dirs: [] } } as CanvasNode
const desk = (slug: string, generation = 2) => <DeskChat node={{ ...node, generation }}
  map={new Map([[node.id, node]])} slug={slug} op={async () => ({})} toast={() => {}} bare />
const refresh = (slug: string) => inAct(async () => {
  await refreshConvo(slug, node.id, { force: true }); await flush(5)
})
const runIn = (el: HTMLElement) => el.querySelector<HTMLDetailsElement>('.pending-run')!
const toggle = (run: HTMLDetailsElement) => inAct(async () => {
  run.querySelector('summary')!.click(); await new Promise(resolve => setTimeout(resolve, 5))
})
const add = (server: FakeServer, count: number) => {
  for (let i = 0; i < count; i++) server.postMail(`Queued message ${server.pending_mail.length + 1}`)
}

for (const placement of ['desk', 'floating', 'pinned', 'popout'] as const) {
  test(`${placement}: the queued separator itself is the only disclosure row`, async t => {
    resetConvos(); localStorage.clear()
    const slug = `pending-separator-${placement}`, server = new FakeServer(); add(server, 1); installFetch(server)
    // These placements share DeskChat; detached hosts use its bare body and
    // a floating desk borrows the conversation rather than taking ownership.
    const view = await mountView(<DeskChat node={node} map={new Map([[node.id, node]])}
      slug={slug} op={async () => ({})} toast={() => {}} bare={placement !== 'desk'}
      borrow={placement === 'floating'} />, el => el)
    t.after(async () => { await view.unmount(); resetConvos() })
    await refresh(slug)
    const run = runIn(view.el), summary = run.querySelector('summary')!
    const divider = view.el.querySelector('.pending-divider')!
    assert.equal(summary.contains(divider), true, 'the separator is inside the native toggle')
    assert.equal(view.el.querySelectorAll('.pending-divider').length, 1)
    assert.equal((view.el.textContent!.match(/1 queued \/ undelivered/g) ?? []).length, 1, 'the count is not repeated')
    assert.doesNotMatch(summary.textContent!, /— (Show|Hide)/)
    const card = run.querySelector('.pendrow')
    await toggle(run); assert.equal(run.open, false)
    await toggle(run); assert.equal(run.open, true)
    assert.equal(run.querySelector('.pendrow'), card, 'cards survive both toggles')
  })
}

test('one queued message always offers a visible toggle and keeps a manual collapse across updates', async t => {
  resetConvos(); localStorage.clear()
  const slug = 'pending-toggle-one', server = new FakeServer(); add(server, 1); installFetch(server)
  const view = await mountView(desk(slug), el => el)
  t.after(async () => { await view.unmount(); resetConvos() })
  await refresh(slug)
  const run = runIn(view.el), summary = run.querySelector('summary')!
  assert.equal(summary.hidden, false)
  assert.equal(run.open, true)
  assert.match(summary.textContent!, /1 queued \/ undelivered/)
  assert.match(summary.getAttribute('aria-label')!, /^Hide 1 queued/)
  await toggle(run)
  assert.equal(run.open, false)
  await refresh(slug)
  assert.equal(runIn(view.el).open, false)
  add(server, 5); await refresh(slug)
  assert.equal(run.open, false)
  server.pending_mail.splice(0, 5); await refresh(slug)
  assert.equal(run.open, false, 'manual Hide still wins below six')
  assert.equal(run.querySelectorAll('.pendrow').length, 1, 'the hidden card stays mounted')
})

test('manual Show below six survives threshold crossing and resets after the desk closes or generation changes', async t => {
  resetConvos(); localStorage.clear()
  const slug = 'pending-toggle-reset', server = new FakeServer(); add(server, 1); installFetch(server)
  const view = await mountView(desk(slug), el => el)
  t.after(async () => { await view.unmount(); resetConvos() })
  await refresh(slug)
  assert.equal(runIn(view.el).querySelector('summary')!.hidden, false)
  await toggle(runIn(view.el)); await toggle(runIn(view.el))
  add(server, 5); await refresh(slug)
  assert.equal(runIn(view.el).open, true, 'manual Show wins at six')
  await view.render(desk(slug, 3)); await refresh(slug)
  assert.equal(runIn(view.el).open, false, 'a new generation gets the automatic default')
  await toggle(runIn(view.el))
  await view.render(<></>); await view.render(desk(slug, 3)); await refresh(slug)
  assert.equal(runIn(view.el).open, false, 'closing/reopening resets a manual Show')
})

test('delivery removes the group without hiding delivered messages and a later queue starts from its default', async t => {
  resetConvos(); localStorage.clear()
  const slug = 'pending-toggle-delivery', server = new FakeServer(); add(server, 1); installFetch(server)
  const view = await mountView(desk(slug), el => el)
  t.after(async () => { await view.unmount(); resetConvos() })
  await refresh(slug)
  assert.equal(runIn(view.el).querySelector('summary')!.hidden, false)
  await toggle(runIn(view.el))
  server.drain(); server.echo(); await refresh(slug)
  assert.equal(!!view.el.querySelector('.pending-run'), false)
  assert.match(view.el.querySelector('.msgs')!.textContent!, /Queued message 1/)
  add(server, 1); await refresh(slug)
  assert.equal(runIn(view.el).open, true, 'emptying the queue discarded the old Hide')
})
