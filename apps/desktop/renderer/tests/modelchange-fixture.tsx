import { createRoot } from 'react-dom/client'
import { ToolChip } from '../src/canvas/desk'
import { AgentDirectoryProvider } from '../src/canvas/identity'
import type { ToolChip as ToolData } from '../src/types'
import '../src/styles.css'

const cases=[
  {label:'Old known · current model unchanged',from:'haiku',current:'sol'},
  {label:'Old known · model changed again',from:'haiku',current:'astra'},
  {label:'Old unknown · current model unchanged',from:null,current:'sol'},
  {label:'Old unknown · model changed again',from:null,current:'astra'},
]
createRoot(document.getElementById('root')!).render(<main style={{padding:24,maxWidth:920}}>
  <h2>Model changes in tool chips</h2>
  <p className="dim">Synthetic recorded switch: haiku → sol. The agent link shows its current model.</p>
  {cases.map((c,i)=>{
    const tool={id:'model-'+i,name:'mcp__orgtree__orgtree_switch_model',arg:'worker sol',result:'{"node":"worker","tier":"sol"}',
      refs:[{kind:'agent',id:'worker',model_change:{from:c.from,to:'sol'}}]} as ToolData
    return <section key={i} data-modelcase={i} style={{padding:'16px 12px',margin:'12px 0',border:'1px solid #555',borderRadius:8}}>
      <h3 style={{margin:'0 0 12px',fontSize:14}}>{c.label}</h3>
      <AgentDirectoryProvider value={{resolve:()=>({tier:c.current}),onFocus:()=>{document.body.dataset.focused='worker'}}}>
        <ToolChip t={tool} slug="synthetic-model-cards" nid="boss"/>
      </AgentDirectoryProvider>
    </section>
  })}
</main>)
