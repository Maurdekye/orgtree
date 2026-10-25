import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import { refreshConvo, resetConvos } from '../src/convo'
import type { CanvasNode } from '../src/canvas/shared'

const node = { id: 'worker', generation: 2, kind: 'agent', state: 'live', tier: 'sol',
  children: [], seat: 2, grant: 0, scope: { tools: {}, add_dirs: [] } } as CanvasNode
function hidden(element: HTMLElement): boolean {
  for (let p: HTMLElement | null = element; p; p = p.parentElement) {
    if (p.hidden || (p.tagName === 'DETAILS' && !(p as HTMLDetailsElement).open)) return true
  }
  return false
}

for (const placement of ['desk', 'floating', 'pinned', 'popout'] as const) {
  test(`${placement}: one queue separator collapses Backend restarted and ordinary mail together`, async t => {
    resetConvos(); localStorage.clear()
    const slug = `all-queued-${placement}`, server = new FakeServer()
    Object.assign(server.postMail('Backend restarted', 'restart'), { from: '@system', notice: true,
      kind: 'status', event_id: 'restart-event', ev: { v: 1, variant: 'runtime.restart_notice',
        actor: { kind: 'system', id: '@system' }, object: null, engine_authored: true,
        body: 'Backend restarted', data: { version: 'synthetic' } } })
    Object.assign(server.postMail('Ordinary queued notice', 'notice'), { from: 'coordinator', notice: true,
      event_id: 'notice-event' })
    installFetch(server)
    const view = await mountView(<DeskChat node={node} map={new Map([[node.id, node]])}
      slug={slug} op={async () => ({})} toast={() => {}} bare={placement !== 'desk'}
      borrow={placement === 'floating'} />, el => el)
    t.after(async () => { await view.unmount(); resetConvos() })
    await inAct(async () => { await refreshConvo(slug, node.id, { force: true }); await flush(5) })
    const labels = [...view.el.querySelectorAll<HTMLElement>('.pending-divider, .pending-run-label')]
    console.log({ placement, busy: server.busy, currentTurn: server.pending_mail.filter(m => m.delivering || m.stage === 'turn' || m.via === 'turn').length,
      queued: server.pending_mail.length, labels: labels.map(label => label.textContent) })
    assert.equal(labels.length, 1, 'all queued mail has one separator label')
    assert.match(labels[0].textContent!, /2 queued \/ undelivered/)
    const control = labels[0].closest<HTMLElement>('summary, button')
    assert.ok(control, 'the sole separator is the toggle')
    const cards = [...view.el.querySelectorAll<HTMLElement>('.pendrow')]
    assert.equal(cards.length, 2)
    assert.ok(cards.every(card => !hidden(card)), 'both system and ordinary queued cards begin visible')
    const state = JSON.stringify(server.pending_mail)
    await inAct(async () => { control.click(); await flush(5) })
    assert.ok(cards.every(hidden), 'the same toggle hides every queued card')
    assert.equal(JSON.stringify(server.pending_mail), state, 'collapse never delivers or mutates mail')
    await inAct(async () => { control.click(); await flush(5) })
    assert.ok(cards.every(card => !hidden(card)))
    const reopenedCards = [...view.el.querySelectorAll('.pendrow')]
    assert.equal(reopenedCards.length, cards.length, 'no cards are added or removed by toggling')
    reopenedCards.forEach((card, index) => {
      assert.equal(card === cards[index], true, `card ${index} remains mounted`)
    })
  })
}

for (const carrier of ['native', 'legacy'] as const) {
  test(`${carrier}: current-turn mail and live reply stay visible when undelivered mail collapses`, async t => {
    resetConvos(); localStorage.clear()
    const slug = `active-queued-${carrier}`, server = new FakeServer()
    server.busy = true
    Object.assign(server.postMail('Current turn message', 'now'), { delivering: true,
      ...(carrier === 'native' ? { stage: 'turn' } : { via: 'turn' }) })
    server.liveRow('text', 'Live response')
    server.postMail('Waiting for next turn', 'later')
    installFetch(server)
    const view = await mountView(<DeskChat bare node={node} map={new Map([[node.id, node]])}
      slug={slug} op={async () => ({})} toast={() => {}} />, el => el)
    t.after(async () => { await view.unmount(); resetConvos() })
    await inAct(async () => { await refreshConvo(slug, node.id, { force: true }); await flush(5) })
    const [now, later] = [...view.el.querySelectorAll<HTMLElement>('.pendrow')]
    const live = view.el.querySelector<HTMLElement>('.msg.live')!
    assert.match(now.textContent!, /Current turn message/)
    assert.equal(now.closest('details') === null, true, 'current-turn mail is a normal visible message')
    assert.ok(now.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING)
    assert.ok(live.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING)
    const labels = [...view.el.querySelectorAll<HTMLElement>('.pending-divider, .pending-run-label')]
    assert.equal(labels.length, 1)
    assert.match(labels[0].textContent!, /1 queued \/ undelivered/)
    const control = labels[0].closest<HTMLElement>('summary, button')!
    await inAct(async () => { control.click(); await flush(5) })
    assert.ok(hidden(later))
    assert.ok(!hidden(now) && !hidden(live), 'current-turn mail and reply never collapse')
  })
}

test('idle chat ignores stale current-turn flags and an older busy tree snapshot', async t => {
  resetConvos(); localStorage.clear()
  const slug = 'idle-stale-queued', server = new FakeServer()
  Object.assign(server.postMail('Stale current marker', 'stale'), { delivering: true, via: 'turn', stage: 'turn' })
  server.postMail('Still waiting', 'later')
  installFetch(server)
  const staleNode = { ...node, busy: true }
  const view = await mountView(<DeskChat bare node={staleNode} map={new Map([[node.id, staleNode]])}
    slug={slug} op={async () => ({})} toast={() => {}} />, el => el)
  t.after(async () => { await view.unmount(); resetConvos() })
  await inAct(async () => { await refreshConvo(slug, node.id, { force: true }); await flush(5) })
  const labels = [...view.el.querySelectorAll<HTMLElement>('.pending-divider, .pending-run-label')]
  console.log({ case: 'idle-stale', busy: server.busy, treeBusy: staleNode.busy, labels: labels.map(label => label.textContent) })
  assert.equal(labels.length, 1)
  assert.match(labels[0].textContent!, /2 queued \/ undelivered/)
  const cards = [...view.el.querySelectorAll<HTMLElement>('.pendrow')]
  const state = JSON.stringify(server.pending_mail)
  await inAct(async () => { labels[0].closest<HTMLElement>('summary, button')!.click(); await flush(5) })
  assert.ok(cards.every(hidden))
  assert.equal(JSON.stringify(server.pending_mail), state)
})
