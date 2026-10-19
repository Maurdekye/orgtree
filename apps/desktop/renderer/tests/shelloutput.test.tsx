import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolChip } from '../src/canvas/desk'
import { TurnActiveContext, RunningTurnContext } from '../src/canvas/toolclock'
import { ShellOutputContext, acceptShellOutput } from '../src/shelloutput'
import type { ShellOutputFrame } from '../src/shelloutput'
import { ingestStream, ingestPulse, resetConvos, useConvo } from '../src/convo'
import type { Convo } from '../src/convo'
const stamp='2026-10-19T17:00:00Z', call={id:'cmd',name:'powershell',started_at:stamp,arg:'synthetic command'}
const frame:ShellOutputFrame={turn_started_at:stamp,revision:1,tools:[{id:'cmd',text:'ONE\n',truncated:false}]}
const render=(f=frame,t=call,active=true)=><TurnActiveContext.Provider value={active}><RunningTurnContext.Provider value={stamp}><ShellOutputContext.Provider value={f}><ToolChip t={t} slug="synthetic" nid="author" /></ShellOutputContext.Provider></RunningTurnContext.Provider></TurnActiveContext.Provider>
const text=(el:Element)=>el.textContent??''
async function expand(el:HTMLElement){await inAct(()=>{(el.querySelector('.tline') as HTMLElement).click()})}
test('expanded running shell shows incremental output before any final result',async t=>{
 const v=await mountView(render(),text);t.after(()=>v.unmount());await expand(v.el)
 assert.equal(v.el.querySelector('.tool-live-output pre')?.textContent,'ONE\n')
 await v.render(render({...frame,revision:2,tools:[{id:'cmd',text:'ONE\nTWO\n',truncated:true}]}))
 assert.equal(v.el.querySelector('.tool-live-output pre')?.textContent,'ONE\nTWO\n');assert.match(v.last(),/earlier output omitted/i)
})
test('collapsed shell never renders live bytes',async t=>{const v=await mountView(render(),text);t.after(()=>v.unmount());assert.equal(v.el.querySelector('.tool-live-output')===null,true);assert.doesNotMatch(v.last(),/ONE/);})
test('final result replaces live preview without changing final bytes',async t=>{
 const v=await mountView(render(),text);t.after(()=>v.unmount());await expand(v.el)
 await v.render(render(frame,{...call,result:'FINAL',ended_at:stamp} as typeof call))
 assert.equal(v.el.querySelector('.tool-live-output')===null,true);assert.match(v.last(),/FINAL/);assert.doesNotMatch(v.last(),/ONE/)
})
test('old turns, inactive turns and non-shell tools never show live output',async t=>{
 const v=await mountView(render({...frame,turn_started_at:'2026-10-18T17:00:00Z'}),text);t.after(()=>v.unmount());await expand(v.el)
 assert.equal(v.el.querySelector('.tool-live-output')===null,true)
 await v.render(render(frame,call,false));assert.equal(v.el.querySelector('.tool-live-output')===null,true)
 await v.render(render(frame,{...call,name:'Read'}));assert.equal(v.el.querySelector('.tool-live-output')===null,true)
})
test('snapshot acceptance rejects stale revisions and scopes to the active turn',()=>{
 assert.equal(acceptShellOutput(null,frame,stamp)?.tools[0].text,'ONE\n')
 const latest={...frame,revision:3};assert.equal(acceptShellOutput(latest,frame,stamp),latest)
 assert.equal(acceptShellOutput(latest,{...frame,turn_started_at:'2026-10-18T17:00:00Z'},stamp),latest)
 assert.equal(acceptShellOutput(null,{...frame,tools:[{id:'cmd',text:'x'.repeat(32769),truncated:false}]},stamp),null)
})
test('shared live output updates do not fetch or mutate transcript rows and retire on turn end',async t=>{
 useFakeClock();const server=new FakeServer();server.busy=true;installFetch(server)
 let current:Convo|undefined
 function Probe(){const c=useConvo('synthetic','streamer');current=c;return null}
 const view=await mountView(<Probe/>,text)
 t.after(async()=>{await view.unmount();resetConvos();realClock()});await flush();await advance(100)
 const before=JSON.stringify(current?.chat?.messages),requests=server.requests.length
 await inAct(()=>ingestStream('synthetic',{node:'streamer',kind:'shell_output',text:'',t:Date.now(),shell_output:frame}))
 assert.equal(current?.shellOutput?.tools[0].text,'ONE\n')
 assert.equal(JSON.stringify(current?.chat?.messages),before);await advance(250);assert.equal(server.requests.length,requests)
 await inAct(()=>ingestPulse('synthetic',{node:'streamer',event:'turn_done',t:Date.now()}));assert.equal(current?.shellOutput,null)
})
