import { createRoot } from 'react-dom/client'
import { CurrentOrg } from '../src/popout'
import { BulkCompactConfirm } from '../src/canvas/bulkcompact'
import { applyTheme } from '../src/themes'
import { summaryTargets, supportReply, targetId } from './bulkcompact-summary-fixture'
applyTheme('orgtree')
window.fetch=async url=>new Response(JSON.stringify(supportReply(targetId(url))),{headers:{'Content-Type':'application/json'}})
createRoot(document.getElementById('root')!).render(<CurrentOrg.Provider value="fixture">
 <div style={{padding:24,color:'var(--ink)'}}>Synthetic subtree - 24 agents</div>
 <BulkCompactConfirm title="Compact subtree of build-slot?" scope="subtree of build-slot"
 targets={summaryTargets()} op={async()=>({})} toast={()=>{}} close={()=>{}}/>
</CurrentOrg.Provider>)
