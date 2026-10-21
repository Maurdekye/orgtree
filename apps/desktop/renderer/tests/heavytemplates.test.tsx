import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {TemplatePicker,layoutPick} from '../src/shell/templatepicker'
import {SaveTemplateModal,DEFAULT_INCLUDE} from '../src/canvas/templates'
import type {TemplatePlan} from '../src/api'

const plan:TemplatePlan={id:'heavy',name:'Heavy dev shop',org_md:false,ok:true,blocked:[],top_grant:6,standing_notes:2,offered:[{tier:'sol',provider:'openai',seat:2}],agents:[
  {slot:'lead',name:'lead',parent:null,depth:0,tier:'sol',requested_tier:'sol',note:null,account:'primary',provider:'openai',seat:2,grant:6,charter:'text',team_charter:null,kickoff:true,blocked:false,dirs_dropped:[]},
  {slot:'build-slot',name:'build-slot',parent:'lead',depth:1,tier:'project',requested_tier:'project',note:null,account:null,provider:null,seat:0,grant:0,charter:'none',team_charter:null,kickoff:false,blocked:false,dirs_dropped:[]},
]}
const choice={id:'heavy',overrides:{},removed:[],kickoff:false}
const response=(value:unknown)=>({ok:true,status:200,headers:new Headers(),json:async()=>value})
test('project preview is free and has no model picker; expectation pins its kind',async()=>{
  globalThis.fetch=(async()=>response({templates:[],loading:false})) as typeof fetch
  const view=await mountView(<TemplatePicker choice={choice} onChange={()=>{}} plan={plan} onPlan={()=>{}} orgName="Fixture" dirs={[]}/>,e=>e)
  try {
    await inAct(async()=>{await flush(2)})
    const project=view.el.querySelector('input[aria-label="name of build-slot"]')!.closest('tr')!
    assert.equal(project.querySelector('select'),null)
    assert.match(project.textContent??'',/project.*free/)
    assert.match(view.el.textContent??'',/1 agent \+ 1 project/)
    assert.match(view.el.textContent??'',/copies 2 AGENTS.md files/)
    assert.match(view.el.textContent??'',/Send the top-level agent/)
    assert.equal(layoutPick(choice,plan)!.expect!['build-slot'],'project')
  }finally{await view.unmount()}
})
test('scratch note capture is an explicit unchecked save choice and names copying and limits',async()=>{
  assert.equal(DEFAULT_INCLUDE.standing_notes,false)
  const seen:{body?:Record<string,unknown>}={}
  globalThis.fetch=(async(_url:unknown,init?:RequestInit)=>{seen.body=JSON.parse(String(init?.body));return response({id:'x',file:'x.json',path:'/fixture/x.json',content:'{}',agents:1,problems:[]})}) as typeof fetch
  const view=await mountView(<SaveTemplateModal slug="fixture" orgName="Fixture" close={()=>{}}/>,e=>e)
  try {
    const label=[...view.el.querySelectorAll('label')].find(l=>l.textContent?.includes('Scratch AGENTS.md'))!
    const checkbox=label.querySelector<HTMLInputElement>('input')!
    assert.equal(checkbox.checked,false)
    assert.match(label.textContent??'',/copies shared, team\/project and personal notes into this template file/)
    assert.match(label.textContent??'',/16,000.*128,000/)
    await inAct(async()=>{checkbox.click();await flush(2)})
    const save=[...view.el.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='Save template')!
    await inAct(async()=>{save.click();await flush(3)})
    assert.equal((seen.body?.['include'] as {standing_notes:boolean}).standing_notes,true)
  }finally{await view.unmount()}
})
