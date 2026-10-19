import { createRoot } from 'react-dom/client'
import { CurrentOrg } from '../src/popout'
import { BulkCompactConfirm } from '../src/canvas/bulkcompact'
import { applyTheme } from '../src/themes'
import { agent, summaryTargets, supportReply, targetId } from './bulkcompact-summary-fixture'
applyTheme('orgtree')
const targets=[...summaryTargets(),...Array.from({length:4},(_,i)=>agent('empty-'+(i+6),{occupancy:0}))]
window.fetch=async url=>new Response(JSON.stringify(supportReply(targetId(url))),{headers:{'Content-Type':'application/json'}})
createRoot(document.getElementById('root')!).render(<CurrentOrg.Provider value="fixture">
 <div style={{padding:24,color:'var(--ink)'}}>Synthetic subtree - busy and no-context exclusions apply to both modes</div>
 <BulkCompactConfirm title="Compact subtree of build-slot?" scope="subtree of build-slot"
 targets={targets} op={async()=>({})} toast={()=>{}} close={()=>{}}/>
</CurrentOrg.Provider>)
