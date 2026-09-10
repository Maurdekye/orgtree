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
    // React's accessibility IDs are unique per mounted instance. The pending
    // chrome (delivery receipt / retract ✕, riding the metadata strip since
    // 2026-09-10) is the ONE declared difference — set aside before the
    // byte-for-byte comparison, which must then hold exactly.
    const canonical = (el: Element) => {
      const clone = el.cloneNode(true) as Element
      for (const c of clone.querySelectorAll('.pend-tag, .pend-x, .ghost-acts')) c.remove()
      return clone.innerHTML.replace(/:r[0-9a-z]+:/g, ':react-id:')
    }
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

test('a typed-ev pending row still draws the transcript\'s plain card (user capture 2026-09-10)', async t => {
  // The user's before/after images: the SAME message wore the dark typed
  // event dress while pending (its box row carries `ev`) and the plain mail
  // card once settled (the transcript row carries none). The pending row
  // must present the branch it SETTLES INTO.
  const server = new FakeServer(); installFetch(server)
  const body = 'this is not the same.'
  const row = { id:'mt', from:'@user', kind:'message', body, at:'2026-09-10T13:19:58Z' }
  const ev = { v:1, variant:'ordinary.message', actor:{kind:'user', id:'@user'},
    object:null, engine_authored:false, body }
  server.pending_mail.push({ ...row, ev } as never)
  server.messages.push({ role:'user', text:'', seq:1, segments:[{kind:'mail', rows:[row]}] } as never)
  // the POTENCY CONTROL: the same ev on a settled row must produce the typed
  // dress — if it stopped changing anything, the parity below proves nothing
  server.messages.push({ role:'user', text:'', seq:2,
    segments:[{kind:'mail', rows:[{ ...row, id:'mc', ev }]}] } as never)
  const node = {id:'worker',state:'live',tier:'haiku',children:[],seat:1,grant:0,free:0,
    scope:{tools:{},add_dirs:[]},model_id:'haiku'} as CanvasNode
  const view = await mountView(<DeskChat node={node} map={new Map([[node.id,node]])}
    op={() => Promise.resolve({} as OpResult)} slug='pending-typed' toast={() => {}} pub={false} bare />, el => el)
  t.after(async () => {await view.unmount();resetConvos()})
  await inAct(async () => {await flush()})
  const pend = view.el.querySelector('.pendrow .turn-mail[data-mail-id="mt"]')
  const done = view.el.querySelector('.typed-input .turn-mail[data-mail-id="mt"]')
  const control = view.el.querySelector('.typed-input .turn-mail[data-mail-id="mc"]')
  assert.ok(pend && done && control, 'all three cards rendered')
  assert.ok(control!.classList.contains('event-card'),
    'CONTROL: a typed ev really does dress a card — otherwise this test is vacuous')
  assert.ok(!pend!.classList.contains('event-card'),
    'the pending copy does NOT wear the typed dress its transcript row will not have')
  assert.equal(pend!.className, done!.className)
  const canonical = (el: Element) => {
    const clone = el.cloneNode(true) as Element
    for (const c of clone.querySelectorAll('.pend-tag, .pend-x, .ghost-acts')) c.remove()
    return clone.innerHTML.replace(/:r[0-9a-z]+:/g, ':react-id:').replace(/data-mail-id="m[tc]"/g, '')
  }
  assert.equal(canonical(pend!), canonical(done!))
})
