import { FakeServer, flush, installFetch, mountView, inAct } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import { resetConvos, addPending } from '../src/convo'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

test('pending user, agent and notice cards retain their transcript styling and attachments', async t => {
  const server = new FakeServer(); installFetch(server)
  const rows = ['@user', 'peer', '@system'].map((from, i) => ({
    id: `mail-${i}`, from, kind: i === 2 ? 'notice' : 'message',
    body: `**Message ${i}**`, at: '2026-09-10T12:00:00Z',
    attachments: [{name:'file.txt',path:'outbox/file.txt'}],
  }))
  server.pending_mail.push(...rows)
  server.messages.push({role:'user',text:'',seq:1,segments:[{kind:'mail',rows}]})
  const node = {id:'worker',state:'live',tier:'haiku',children:[],seat:1,grant:0,free:0,
    scope:{tools:{},add_dirs:[]},model_id:'haiku'} as CanvasNode
  const view = await mountView(<DeskChat node={node} map={new Map([[node.id,node]])}
    op={() => Promise.resolve({} as OpResult)} slug='pending-style' toast={() => {}} pub={false} bare />, el => el)
  t.after(async () => {await view.unmount();resetConvos()})
  await inAct(async () => {await flush()})
  const pending = [...view.el.querySelectorAll('.pendrow .turn-mail')]
  const delivered = [...view.el.querySelectorAll('.typed-input .turn-mail')]
  assert.equal(pending.length,3);assert.equal(delivered.length,3)
  for(let i=0;i<3;i++) {
    assert.equal(pending[i].className,delivered[i].className)
    // React's accessibility IDs are unique per mounted instance.
    const canonical = (el: Element) => el.innerHTML.replace(/:r[0-9a-z]+:/g, ':react-id:')
    assert.equal(canonical(pending[i]),canonical(delivered[i]))
    assert.ok(pending[i].querySelector('header.turn-mail-head'))
    assert.ok(pending[i].querySelector('.attach-row a[download="file.txt"]'))
  }
  assert.equal(view.el.querySelectorAll('.pendrow button[title="retract (undelivered)"]').length,3)
  assert.ok(pending[2].classList.contains('passive'))
  await inAct(async () => {addPending('pending-style','worker','Local send');await flush()})
  const ghost = view.el.querySelector('.pendghost .turn-mail')
  assert.ok(ghost?.querySelector('header.turn-mail-head'))
  assert.match(ghost?.textContent ?? '', /Local send/)
  assert.ok(view.el.querySelector('.pendghost .ghost-acts button'))
})
