import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {TemplatePicker} from '../src/shell/templatepicker'
import {SaveTemplateModal} from '../src/canvas/templates'
import type {TemplatePlan,TemplatePlanRow,TemplateSummary} from '../src/api'
import template from '../../../../engine/docs/templates/heavy-dev-shop.json'
import '../src/styles.css'

// Isolated display fixture; no org, database, bridge, providers or network.
const rows:TemplatePlanRow[]=[]
const costs:Record<string,number>={opus:4,sonnet:2,astra:10,sol:2,argon:2}
type Slot={name:string;tier:string;spare?:number;charter?:{preset?:string;text?:string};reports?:Slot[]}
const walk=(slots:Slot[],depth=0,parent:string|null=null):number=>slots.reduce((total,s)=>{
  const row:TemplatePlanRow={slot:s.name,name:s.name,parent,depth,tier:s.tier,requested_tier:s.tier,note:null,account:s.tier==='project'?null:'primary',provider:['opus','sonnet'].includes(s.tier)?'claude':s.tier==='argon'?'google':s.tier==='project'?null:'openai',seat:costs[s.tier]??0,grant:0,charter:s.tier==='project'?'none':s.charter?.preset?'preset: '+s.charter.preset:'text',team_charter:null,kickoff:depth===0,blocked:false,dirs_dropped:[]}
  rows.push(row)
  const below=walk(s.reports??[],depth+1,s.name)
  row.grant=s.tier==='project'?0:(s.spare??0)+below
  return total+(s.tier==='project'?below:row.seat+row.grant)
},0)
walk(template.agents)
const plan:TemplatePlan={id:template.id,name:template.name,agents:rows,blocked:[],ok:true,org_md:false,top_grant:80,standing_notes:7,offered:Object.entries(costs).map(([tier,seat])=>({tier,seat,provider:tier==='argon'?'google':['opus','sonnet'].includes(tier)?'claude':'openai'}))}
const summary:TemplateSummary={id:template.id,name:template.name,description:template.description,source:'folder',path:'/templates/heavy-dev-shop.json',agents:rows.map(r=>({name:r.name,tier:r.tier!,depth:r.depth,parent:r.parent})),problems:[]}
window.fetch=(async(url:RequestInfo|URL)=>new Response(JSON.stringify(String(url).includes('/resolve')?plan:{templates:[summary],dir:'/templates'}),{status:200,headers:{'Content-Type':'application/json'}})) as typeof fetch
function Surface(){
 const [choice,setChoice]=useState({id:template.id,overrides:{},removed:[] as string[],kickoff:false})
 return <main className="settings" style={{margin:24,width:760}}><h1>Heavy dev shop</h1><TemplatePicker choice={choice} onChange={setChoice} plan={plan} onPlan={()=>{}} orgName="Example" dirs={[]}/><SaveTemplateModal slug="fixture" orgName="Example" close={()=>{}}/></main>
}
const style=document.createElement('style')
style.textContent='.overlay{position:absolute!important;inset:auto!important;left:825px!important;top:24px!important;display:block!important;background:transparent!important}.overlay .save-template{width:680px!important;max-height:none!important}body{min-width:1550px;min-height:1050px;background:var(--bg)}'
document.head.appendChild(style)
createRoot(document.getElementById('root')!).render(<Surface/> )
