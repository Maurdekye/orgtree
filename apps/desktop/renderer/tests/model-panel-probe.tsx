// Actual Providers panel; its existing synthetic fixture augmented with models.
import './provider-compact-probe'
const original=window.fetch
const reply=(body:unknown)=>Promise.resolve(new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}}))
const model={id:'fixture/mimo-v2.6-pro',name:'Mimo fixture',label:'mimo-v2.6-pro',vendor:'fixture',letter:'M',color:'#e49b8d',context:65536,prompt:1,completion:1,tools:true}
let selected=true
const seen:unknown[]=[]
Object.assign(window,{modelPanelFixture:{seen}})
window.fetch=async (url,init)=>{
  const path=new URL(String(url),location.href).pathname
  const method=init?.method??'GET'
  if(path==='/api/openrouter/models')return reply({items:[{...model,selected}],offset:0,limit:25,total:1})
  if(path==='/api/openrouter/favorites'){
    const body=JSON.parse(String(init?.body));seen.push({path,method,body});selected=body.selected
    return window.fetch('/api/openrouter')
  }
  if(path==='/api/langservers/probe')return reply({reachable:true,version:'fixture',listed:1,
    models:[{id:'qwen3.8-27b-iq3xxs',context:65536}]})
  const response=await original(url,init)
  if(path==='/api/openrouter'){
    const body=await response.json()
    body.tiers=selected?[{...model,model:model.id,tier:'or-fixture',seat:1}]:[];body.favorites=body.tiers.length
    return reply(body)
  }
  if(path==='/api/langservers'){
    const body=await response.json()
    for(const server of body.servers)server.models={'qwen3.8-27b-iq3xxs':{offered:true,context:65536}}
    return reply(body)
  }
  return response
}
