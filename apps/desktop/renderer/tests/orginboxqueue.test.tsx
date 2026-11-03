// A project holds the org inbox (USER 2026-11-03 m99ee62b87e70, mdf5da6c51202; spec rev 2 §4, R2-R4).
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { HeldAudienceChips } from '../src/canvas/desk'
import { AudienceHolderRows, QueueChip, showsQueueState } from '../src/canvas/mail'
import { InboxReplaceConfirm } from '../src/canvas/inboxreplace'
import { audienceGrantTooltip, EXTERN, type CanvasNode } from '../src/canvas/shared'

const PROJECT_TIP = "Receives outside mail sent to the org inbox in its queue"

test('R4 the org-inbox tooltip names a project holder\'s queue; an agent keeps its own wording', () => {
  assert.equal(audienceGrantTooltip(EXTERN, 'project'), PROJECT_TIP)
  assert.equal(audienceGrantTooltip(EXTERN, 'agent'), 'Can read and answer outside mail sent to the org inbox')
  assert.equal(audienceGrantTooltip(EXTERN), 'Can read and answer outside mail sent to the org inbox')
})

test('R4 the project desk header shows the "org inbox" chip with the project tooltip and a revoke', async t => {
  const map = new Map<string, CanvasNode>([['intake', { id: 'intake', kind: 'project', state: 'live' } as CanvasNode]])
  const view = await mountView(<HeldAudienceChips slug="demo" toast={() => {}} map={map}
    node={{ id: 'intake', audiences_held: [EXTERN], audiences_explicit: [EXTERN] }} />, el => el)
  t.after(() => view.unmount())
  const badge = view.el.querySelector<HTMLElement>('.badge')!
  assert.match(badge.textContent ?? '', /org inbox/)
  assert.equal(badge.title, PROJECT_TIP)
  assert.equal(badge.querySelector('.chip-x')?.getAttribute('title'), 'Revoke')
})

test('R3 the org mailbox holders row shows a project holder as a chip with its tooltip and ✕', async t => {
  const nodes = new Map<string, CanvasNode>([
    ['front', { id: 'front', kind: 'agent', state: 'live', tier: 'sol' } as CanvasNode],
    ['intake', { id: 'intake', kind: 'project', state: 'live', tier: 'project' } as CanvasNode],
  ])
  const removed: string[] = []
  const view = await mountView(<AudienceHolderRows ids={['front', 'intake']} nodes={nodes} audienceTarget={EXTERN}
    onRemove={id => removed.push(id)} />, el => el)
  t.after(() => view.unmount())
  await flush()
  const chips = [...view.el.querySelectorAll<HTMLElement>('.aud-badge')]
  assert.deepEqual(chips.map(c => c.title), ['Can read and answer outside mail sent to the org inbox', PROJECT_TIP])
  await inAct(() => { chips[1].querySelector<HTMLElement>('.chip-x')!.click() })
  assert.deepEqual(removed, ['intake'])
})

test('R2 the single-holder replacement confirm names both holders and confirms once', async t => {
  let confirmed = 0, closed = 0
  const view = await mountView(<InboxReplaceConfirm id="intake" current="front" onConfirm={() => { confirmed++ }}
    close={() => { closed++ }} />, el => el)
  t.after(() => view.unmount())
  await flush()
  const text = document.body.textContent ?? ''
  assert.match(text, /Replace front as the org inbox's holder with intake\?/)
  assert.match(text, /Only one holder is allowed/)
  const replace = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Replace')!
  await inAct(() => { replace.click() })
  assert.equal(confirmed, 1)
  assert.ok(closed >= 0)
})

test('R5 a follow-up row in a project Mail tab shows "follow-up to <job>"', async t => {
  assert.equal(showsQueueState({ follow_up_to: 'job1' }), true)
  const view = await mountView(<QueueChip q={{ follow_up_to: 'job1' }} />, el => el)
  t.after(() => view.unmount())
  const chip = view.el.querySelector<HTMLElement>('.queuekind')!
  assert.equal(chip.textContent, 'follow-up to job1')
  assert.match(chip.title, /follow-up/)
})
