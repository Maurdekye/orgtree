import { mountView, inAct } from './harness'
import { useState } from 'react'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentWorkstate } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { UrgentAgentOptions, type UrgentAgentMail } from '../src/canvas/dnd'
import { MailList } from '../src/canvas/mail'
import { useNodeMetadata, replaceNodeMetadata, clearNodeMetadata } from '../src/nodemetadata'
import type { TreeNode } from '../src/types'
import { sendMessage } from '../src/api'

const node = (dnd: boolean) => ({ id:'focused-agent',tier:'sol',state:'live',busy:true,
  phase:'thinking',dnd,last_status:{status:'working',summary:'Focused work'} } as unknown as CanvasNode)

test('do not disturb is visible alongside the running agent state', async t => {
  const v=await mountView(<AgentWorkstate node={node(true)} />,el=>el)
  t.after(()=>v.unmount())
  assert.equal(v.el.querySelector('.dnd-badge')?.textContent,'DND','focused turn needs DND badge')
})

test('ordinary running state does not show DND', async t => {
  const v=await mountView(<AgentWorkstate node={node(false)} />,el=>el)
  t.after(()=>v.unmount())
  assert.equal(v.el.querySelector('.dnd-badge')===null,true)
})

test('urgent options appear and disappear live with target DND', async t => {
  const slug='dnd-live'
  const base={...node(false),generation:1,children:[]} as unknown as TreeNode
  function LiveOptions() {
    const current=useNodeMetadata(slug,base)
    const [value,onChange]=useState<UrgentAgentMail | undefined>()
    return <UrgentAgentOptions active={current.dnd} value={value} onChange={onChange} />
  }
  replaceNodeMetadata(slug,[base])
  const v=await mountView(<LiveOptions />,el=>el)
  t.after(async()=>{await v.unmount();clearNodeMetadata(slug)})
  assert.equal(v.el.querySelector('input')===null,true)
  await inAct(()=>replaceNodeMetadata(slug,[{...base,dnd:true}]))
  const checkbox=v.el.querySelector<HTMLInputElement>('input[type="checkbox"]')
  assert.ok(checkbox)
  await inAct(()=>checkbox.click())
  assert.ok(v.el.querySelector('input[aria-label="Urgent reason"]'))
  await inAct(()=>replaceNodeMetadata(slug,[{...base,dnd:false}]))
  assert.equal(v.el.querySelector('input')===null,true)
  await inAct(()=>replaceNodeMetadata(slug,[{...base,dnd:true}]))
  assert.equal(v.el.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,false,'old urgency must not rearm')
})

test('sender sees held and explicit-read states instead of delivered', async t => {
  const item={id:'held',from:'sender',to:'focused-agent',kind:'message',body:'Please check this.',at:'2026-10-18T13:00:00Z',dnd_held:true}
  const v=await mountView(<MailList delivered={[item]} outgoing />,el=>el)
  t.after(()=>v.unmount())
  assert.equal(v.el.querySelector('.dnd-mail-state')?.textContent,'held (do not disturb)')
  await v.render(<MailList delivered={[{...item,dnd_held:false,dnd_read:true}]} outgoing />)
  assert.equal(v.el.querySelector('.dnd-mail-state')?.textContent,'read')
})

test('agent composer API sends the existing urgent pair together', async t => {
  const original=globalThis.fetch
  let sent: Record<string,unknown>={}
  globalThis.fetch=(async(_url,init)=>{
    sent=JSON.parse(String(init?.body))
    return {ok:true,json:async()=>({accepted:true})} as Response
  }) as typeof fetch
  t.after(()=>{globalThis.fetch=original})
  await sendMessage('dnd','focused-agent','Now',undefined,undefined,undefined,false,undefined,undefined,
    {urgent:true,urgent_reason:'Deadline before turn end'})
  assert.equal(sent.urgent,true)
  assert.equal(sent.urgent_reason,'Deadline before turn end')
})
