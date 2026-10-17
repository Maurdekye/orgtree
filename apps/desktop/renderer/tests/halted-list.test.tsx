import {inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {AgentWorkstate,TrayStatus,TurnStatusBanner,pulseAgeClock} from '../src/canvas/desk'
import {AgentTray} from '../src/canvas/agenttray'
import type {CanvasNode} from '../src/canvas/shared'
const NOW=Date.parse('2026-10-14T12:00:00Z')
const at=(seconds:number)=>new Date(NOW-seconds*1000).toISOString()
const halt={phase:'halted' as const,requested_at:at(7200),at:at(3600),by:'user'}
const frozen={until:'2026-10-14T16:00:00Z',until_ts:NOW/1000+14400,detected_at:at(300),error:'usage limit'}
const node=(extra:Record<string,unknown>={}):CanvasNode=>({id:'fixture',tier:'haiku',state:'live',
  children:[],lineage:[],turns:[],halt:null,frozen:null,busy:false,waiting:false,occupancy:null,context_window:null,
  last_status:null,prev_status:null,...extra} as unknown as CanvasNode)

test('halted row uses existing stop icon and completed halt timestamp',async t=>{
  t.mock.method(Date,'now',()=>NOW)
  const v=await mountView(<TrayStatus node={node({halt})}/>,el=>el);t.after(()=>v.unmount())
  assert.ok(v.el.querySelector('.tray-halted'))
  assert.equal(v.el.querySelector('.tray-status-label.halted')?.textContent,'Halted')
  assert.equal(v.el.querySelector('.tray-status-time')?.textContent?.trim(),'60m')
  assert.match(v.el.querySelector('.tray-status-time')!.getAttribute('title')!,/Halted since/)
})

test('legacy halt falls back to requested time; halting uses request time; missing time stays unknown',async t=>{
  t.mock.method(Date,'now',()=>NOW)
  const v=await mountView(<TrayStatus node={node({halt:{...halt,at:undefined}})}/>,el=>el);t.after(()=>v.unmount())
  assert.equal(v.el.querySelector('.tray-status-time')?.textContent?.trim(),'2h')
  await v.render(<TrayStatus node={node({halt:{...halt,phase:'halting'}})}/>)
  assert.equal(v.el.querySelector('.tray-status-label')?.textContent,'Halting…')
  assert.equal(v.el.querySelector('.tray-status-time')?.textContent?.trim(),'2h')
  await v.render(<TrayStatus node={node({halt:{phase:'halted',by:'user'}})}/>)
  assert.equal(v.el.querySelector('.tray-status-time')?.textContent?.trim(),'—')
})

test('halt clock ticks without replacing node props',async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now)
  const v=await mountView(<TrayStatus node={node({halt:{...halt,at:at(10)}})}/>,el=>el);t.after(()=>v.unmount())
  assert.equal(v.el.querySelector('.tray-status-time')?.textContent?.trim(),'10s')
  now+=15000;await inAct(()=>pulseAgeClock())
  assert.equal(v.el.querySelector('.tray-status-time')?.textContent?.trim(),'25s')
})

test('desk header and zoom card show live halted duration from halt time, not last turn',async t=>{
  let now=NOW;t.mock.method(Date,'now',()=>now)
  const turn={at:at(7200),killed:true,cost:0,denials:0}
  const v=await mountView(<><TurnStatusBanner state="idle" turn={turn} halted haltedAt={halt.at}/>
    <AgentWorkstate node={node({halt})} turn={turn}/></>,el=>el);t.after(()=>v.unmount())
  assert.equal(v.el.querySelector('.turn-status-label')?.textContent,'Halted')
  assert.ok(v.el.querySelector('.turn-status-banner')?.classList.contains('halted'))
  assert.equal(v.el.querySelector('.turn-status-time')?.textContent,'60m')
  assert.equal(v.el.querySelector('.turn-status-banner')?.getAttribute('aria-label'),'Halted for 60m')
  assert.equal(v.el.querySelector('.sq-halt-status > span')?.textContent,'Halted')
  assert.equal(v.el.querySelector('.sq-halt-status .sq-idle-time')?.textContent,'60m')
  now+=60000;await inAct(()=>pulseAgeClock())
  assert.equal(v.el.querySelector('.turn-status-time')?.textContent,'61m')
  assert.equal(v.el.querySelector('.sq-halt-status .sq-idle-time')?.textContent,'61m')
})

test('explicit halt still wins usage freeze; usage-only keeps frozen presentation',async t=>{
  const v=await mountView(<TrayStatus node={node({halt,frozen,busy:true})}/>,el=>el);t.after(()=>v.unmount())
  assert.ok(v.el.querySelector('.tray-halted'))
  assert.equal(v.el.querySelector('.usage-freeze-status'),null)
  await v.render(<TrayStatus node={node({frozen,busy:true})}/>)
  assert.ok(v.el.querySelector('.usage-freeze-status'))
  assert.match(v.el.textContent!,/Frozen/)
  assert.equal(v.el.querySelector('.tray-halted'),null)
})

test('shared AgentTray keeps last/previous status and age, reserving a summary slot for every row',async t=>{
  t.mock.method(Date,'now',()=>NOW)
  const last={status:'idle',summary:'Retained last status',at:at(7200)}
  const previous={status:'done',summary:'Retained previous status',at:at(3600)}
  const nodes=[node({id:'halt-last',halt,last_status:last}),node({id:'halt-prev',halt,prev_status:previous}),
    node({id:'halt-empty',halt}),node({id:'idle-empty'})]
  const picked:string[]=[]
  const v=await mountView(<AgentTray map={new Map(nodes.map(n=>[n.id,n]))} rows={nodes.map(n=>({node:n,depth:0}))}
    query="" onQuery={()=>{}} archived={false} onArchived={()=>{}} onPick={id=>picked.push(id)}/>,el=>el)
  t.after(()=>v.unmount())
  const rows=[...v.el.querySelectorAll('.tray-row')]
  assert.equal(v.el.querySelectorAll('.tray-sum').length,4)
  assert.match(rows[0].querySelector('.tray-sum')!.textContent!,/idle: Retained last status.*2h ago/)
  assert.match(rows[1].querySelector('.tray-sum.stale')!.textContent!,/done: Retained previous status.*60m ago/)
  for(const row of rows.slice(2)){
    assert.equal(row.querySelector('.tray-sum-text')?.getAttribute('aria-hidden'),'true')
    assert.equal(row.querySelector('.tray-sum-at'),null)
  }
  await inAct(()=>rows[0].querySelector<HTMLButtonElement>('.tray-main')!.click())
  assert.deepEqual(picked,['halt-last'],'same single activation handler')
})
