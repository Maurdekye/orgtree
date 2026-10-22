import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { DeskModelButton } from '../src/canvas/deskmodel'
import { syncProviderRegistries } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
syncProviderRegistries({providers:[{id:'openai',tiers:[{tier:'sol'},{tier:'astra'},{tier:'luna'}]},
  {id:'claude',tiers:[{tier:'opus'}]}]})
const node={id:'worker',tier:'opus',state:'live',generation:1,children:[],seat:5,grant:0,free:0,
  account:'claude/primary',scope:{tools:{},add_dirs:[]}} as CanvasNode
const operations:Record<string,unknown>[]=[]
;(window as any).__modelSwitchOps=operations
function Fixture(){const[message,setMessage]=useState('No model switch submitted')
  return <main style={{padding:36}}>
    <h2>Model switch with a limited default OpenAI login</h2>
    <p>Synthetic staffing snapshot: native OpenAI login spent; openai-1 eligible.</p>
    <div style={{display:'flex',gap:14,alignItems:'center',marginTop:35}}>
      <DeskModelButton node={node} slug="model-fixture" op={async b=>{operations.push(b);return{queued:false}}}
        toast={lines=>setMessage(lines.join(' '))}/><strong>worker</strong><span>Current model: opus</span>
    </div>
    <p data-result>{message}</p>
    <p style={{marginTop:330}}>Eligible Codex choices remain visible. Their tooltips name account openai-1.</p>
  </main>
}
document.body.style.cssText='margin:0;background:var(--bg);color:var(--ink);font:14px sans-serif'
createRoot(document.getElementById('root')!).render(<Fixture/> )
