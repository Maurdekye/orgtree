import {mountView,inAct,flush,FakeServer,installFetch} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {ProjectDesk} from '../src/canvas/projectdesk'
import {NodeConfig} from '../src/canvas/modals'
import {ProjectDraftNode,projectDraftSteps} from '../src/canvas/newproject'
import type {CanvasNode,OpRequest} from '../src/canvas/shared'
import type {TreePayload} from '../src/types'
const node={id:'website',title:'website',kind:'project',tier:'project',state:'live',parent:'user',charter:'A standing charter.',
  configured_scope:{slots_capacity:1},scope:{tools:{},add_dirs:[]},children:[{id:'dev',tier:'sol',state:'live',children:[]}],
  lineage:[],turns:[],audiences_held:[],mail_pending:0,seat:0,grant:0,free:0} as unknown as CanvasNode
const tree={slug:'org',roots:[node],slot_leases:[{project:'website',agent:'dev',slot:1,lease:'lease',since:'2026-10-18T17:00:00Z'}],watchdogs:[]} as unknown as TreePayload
const noop=()=>{}
function serve(t:{after:(fn:()=>void)=>void}) {const old=globalThis.fetch;installFetch(new FakeServer());t.after(()=>{globalThis.fetch=old})}

test('project wire field remains description',()=>{
  assert.deepEqual(projectDraftSteps({parent:'user'} as never,'website','Saved summary'),[
    {op:'create_project',name:'website',parent:'user',description:'Saved summary'},
  ])
})

test('project Summary tab and plain slots label preserve their internal routes',async t=>{
  serve(t)
  const v=await mountView(<ProjectDesk node={node} tree={tree} map={new Map([[node.id,node]])} slug="org"
    refs={{world:{org:'org'},onOpen:noop} as never} op={async()=>({})} toast={noop}/>,el=>el)
  t.after(()=>v.unmount())
  assert.equal(v.el.querySelector('[data-tab="desk"]')?.textContent,'Summary')
  assert.equal(v.el.querySelector('[data-tab="slots"]')?.textContent,'slots')
  assert.equal(v.el.querySelector('[data-tab="slots"] .tab-count')===null,true)
  assert.equal(v.el.querySelector('[data-action="dissolve"]')?.textContent,'dissolve')
})

test('project Summary editor keeps set_description wire operation',async t=>{
  serve(t);const ops:OpRequest[]=[];const notices:string[][]=[]
  const v=await mountView(<ProjectDesk node={node} tree={tree} map={new Map([[node.id,node]])} slug="org"
    refs={{world:{org:'org'},onOpen:noop} as never} op={async op=>{ops.push(op);return {}}} toast={s=>notices.push(s)}/>,el=>el)
  t.after(()=>v.unmount())
  const editor=v.el.querySelector<HTMLElement>('[aria-label="Summary of project website"]')
  assert.ok(editor)
  await inAct(()=>editor.click())
  const box=v.el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Summary of project website"]')!
  await inAct(()=>{Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(box,'Updated summary');box.dispatchEvent(new Event('input',{bubbles:true}))})
  await inAct(async()=>{box.blur();box.dispatchEvent(new window.FocusEvent('focusout',{bubbles:true}));await flush(2)})
  assert.deepEqual(ops,[{op:'set_description',node:'website',description:'Updated summary'}])
  assert.match(notices.flat().join(' '),/Summary of website saved/)
})

test('project settings and draft call the description setting Summary',async t=>{
  serve(t)
  const v=await mountView(<NodeConfig node={node} tree={tree} map={new Map([[node.id,node]])} slug="org" op={async()=>({})} toast={noop} close={noop}/>,el=>el)
  t.after(()=>v.unmount())
  assert.ok(v.el.querySelector('textarea[aria-label="Project Summary"]'))
  assert.equal([...v.el.querySelectorAll('button')].some(b=>b.textContent==='dissolve'),true)
  const draft=await mountView(<ProjectDraftNode pos={{x:0,y:0}} onConfirm={noop} onCancel={noop}/>,el=>el)
  t.after(()=>draft.unmount())
  assert.match(draft.el.querySelector('textarea')?.placeholder??'',/^Summary \(optional\)/)
})
