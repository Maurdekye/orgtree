import { mountView, inAct, flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { MailList, QueueChip } from '../src/canvas/mail'
import type { MailRow } from '../src/canvas/shared'
import { fmtFull } from '../src/timefmt'

const mail: MailRow = { id: '1', from: 'hubchat-jumplist-sol', kind: 'question',
  ev: {v:1,variant:'ordinary.question',actor:{kind:'agent',id:'hubchat-jumplist-sol'},object:null,engine_authored:false,body:'Please check this project item.'},
  body: 'Please check this project item.', at: '2026-10-18T12:00:00Z',
  queue: { held_by: 'coordinator-opus', ack: false } }

test('project delivery marker links its recipient without selecting the mail', async t => {
  const focus: unknown[][] = []
  const v = await mountView(<MailList delivered={[mail]} onFocusAgent={(...a) => focus.push(a)}
    hasAgent={() => true} tierOf={() => 'sol'} />, el => el)
  t.after(() => v.unmount())
  const marker = v.el.querySelector('.mailrow .queue-delivery')
  assert.ok(marker, 'compact delivered marker')
  const link = marker.querySelector<HTMLButtonElement>('button[data-agent-nav="coordinator-opus"]')
  assert.ok(link, 'the shared agent link exposes its canonical context menu')
  assert.equal(link.textContent, '@coordinator-opus')
  assert.equal(link.dataset.agentTooltip, 'coordinator-opus', 'shared identity tooltip')
  assert.match(marker.getAttribute('title') ?? '', /delivered to coordinator-opus.*time not recorded/i)
  assert.equal(marker.textContent?.includes('delivered to'), false, 'delivery prose belongs in the tooltip')
  await inAct(() => link.click())
  assert.deepEqual(focus, [['coordinator-opus']], 'navigation gets only the id, never a MouseEvent as zoom')
  assert.equal(v.el.querySelector('.mailrow.on') === null, true, 'link does not toggle selection')
})

test('project delivery marker is shared by the reading pane', async t => {
  const v = await mountView(<MailList delivered={[mail]} onFocusAgent={() => {}}
    hasAgent={() => true} />, el => el)
  t.after(() => v.unmount())
  await inAct(async () => { v.el.querySelector<HTMLElement>('.mailrow')!.click(); await flush(2) })
  assert.ok(v.el.querySelector('.mailer-head .queue-delivery [data-agent-nav="coordinator-opus"]'))
  assert.equal(v.el.querySelector('.mailrow .askkind, .mailrow .event-row-kind')?.textContent, 'Question', 'kind stays visible')
})

test('project queue non-delivery states keep their distinct meaning', async t => {
  for (const [q, text] of [
    [{held_by:'dev1',ack:true}, 'dev1 · awaiting ack'],
    [{held_by:'dev1',acked_at:'2026-10-18T12:00:00Z'}, 'acked by dev1'],
    [{released:{by:'dev1'}}, 'released (dev1)'],
    [{dead_letter:{by:'dev1'}}, 'dead letter'],
    [{purged:{by:'@user'}}, 'purged'],
  ] as const) {
    const v = await mountView(<QueueChip q={q} />, el => el)
    t.after(() => v.unmount())
    assert.equal(v.el.querySelector('.queuekind')?.textContent, text)
    assert.equal(v.el.querySelector('.queue-delivery') === null, true)
  }
})

test('project delivery tooltip uses the claim time when recorded', async t => {
  const at = '2026-10-18T12:03:00Z'
  const v = await mountView(<QueueChip q={{held_by:'dev1',held_at:at,ack:false}} />, el => el)
  t.after(() => v.unmount())
  assert.equal(v.el.querySelector('.queue-delivery')?.getAttribute('title'), `delivered to dev1 at ${fmtFull(at)}`)
  assert.equal(v.el.querySelector('button') === null, true, 'unknown or unavailable identities stay honest plain text')
})
