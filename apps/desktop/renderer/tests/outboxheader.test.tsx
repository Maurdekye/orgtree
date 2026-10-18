import { mountView, inAct, flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgInboxModal } from '../src/canvas/mail'
import type { OrgInboxEntry } from '../src/types'
import type { CanvasNode } from '../src/canvas/shared'

const row: OrgInboxEntry = { id:'sent-1',dir:'out',peer:'@net:peer.fixture',by:'coordinator-opus',
  body:'Retained org outbox body',at:'2026-10-18T12:00:00Z',state:'read' }
async function open(t: {after:(fn:()=>void)=>void}, by = row.by) {
  const saved=globalThis.fetch
  const entry={...row,by}
  globalThis.fetch=(async input => new Response(JSON.stringify(String(input).endsWith('/org_inbox')
    ? {entries:[entry],total:1,unread:0} : {transfers:[]}))) as typeof fetch
  t.after(()=>{globalThis.fetch=saved})
  const focus:unknown[][]=[]
  const v=await mountView(<OrgInboxModal slug="fixture" inbox={{entries:[entry],total:1,unread:0,visible:true,holders:[]}}
    map={new Map([['coordinator-opus',{id:'coordinator-opus',tier:'opus',state:'live'} as CanvasNode]])}
    onFocusAgent={(...args)=>focus.push(args)} toast={()=>{}} close={()=>{}} jumpTo="sent-1" />,el=>el)
  t.after(()=>v.unmount())
  await inAct(async()=>{await flush(5)})
  return {...v,focus}
}

test('org outbox uses one shared inline agent link beside org and recipient',async t=>{
  const v=await open(t)
  const identity=v.el.querySelector('.mailer-head .org-mail-attribution')
  assert.ok(identity,'compound attribution is one wrapping group')
  const link=identity.querySelector<HTMLButtonElement>('button.ref-agent[data-agent-nav="coordinator-opus"]')
  assert.ok(link,'use the shared AgentLink base')
  assert.ok(link.querySelector('.tier'),'badge stays inside the link')
  assert.equal(link.textContent,'O@coordinator-opus','no gap after the @ sigil')
  assert.equal(link.dataset.agentTooltip,'coordinator-opus')
  assert.ok(identity.querySelector('[data-hub-address="@net:peer.fixture"]'))
  assert.match(identity.textContent??'',/as @fixture.*→.*@net:peer.fixture.*✓✓/)
  await inAct(()=>link.click())
  assert.deepEqual(v.focus,[['coordinator-opus']],'the shared link forwards only the id to camera focus')
})

test('org outbox keeps reply and time in a single trailing metadata group',async t=>{
  const v=await open(t)
  const meta=v.el.querySelector('.mailer-head .mail-head-meta')
  assert.ok(meta,'metadata can align right and wrap as one unit')
  assert.match(meta.textContent??'',/reply.*2026-10-18/)
  assert.match(v.el.querySelector('.mailer-body')?.textContent??'',/Retained org outbox body/)
})

test('org outbox preserves unresolved attribution as inert recorded text',async t=>{
  const v=await open(t,'unknown-former-agent')
  assert.match(v.el.querySelector('.mailer-head')?.textContent??'',/@unknown-former-agent/)
  assert.equal(v.el.querySelector('.mailer-head [data-agent-nav="unknown-former-agent"]')===null,true)
})
