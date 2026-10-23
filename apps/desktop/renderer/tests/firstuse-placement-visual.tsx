import { createRoot } from 'react-dom/client'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { CurrentOrg } from '../src/popout'
import { beginFirstUse } from '../src/canvas/firstuse'
import { setStartView, saveView, EYE_ANCHOR_X, NODE_W } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'
import '../src/styles.css'
import '../src/shell.css'

const slug = 'first-use-layout'
localStorage.clear()
setStartView('remember')
saveView(slug, { x: innerWidth / 2 - (EYE_ANCHOR_X + NODE_W / 2), y: 230, z: 1 })
window.WebSocket = class { onmessage = null; onclose = null; onerror = null; close() {} } as unknown as typeof WebSocket
const providers = ['claude', 'openai', 'google'].map(id => ({ id, name: id, user_enabled:true,
  hire_enabled:true, reason:null, status:{installed:true}, tiers:[] }))
window.fetch = async (input) => {
  const url = String(input)
  const body = url.includes('/providers') ? { providers, checking:false }
    : url.includes('/accounts') ? { accounts:[], providers:[] }
      : url.includes('/transfers') ? { transfers:[], next_cursor:null }
        : url.includes('/work-items') ? { items:[], archived:[], backlogged:[], counts:{attention:0,active:0} }
          : url.includes('/inbox') ? { pending:[],delivered:[],sent:[] }
            : { ok:true }
  return new Response(JSON.stringify(body), { headers:{'content-type':'application/json','X-Orgtree-Instance':'first-use-layout'} })
}
const tree = { slug,name:'A new organization',roots:[],dirs:[],tiers:{haiku:1,sonnet:2,opus:4,sol:2,astra:4},
  default_top_grant:12,max_top_grant:100,cascade_hire:true,default_visibility:'team',default_tools:{},
  audiences:[],audience_requests:[],credit_requests:[],user_inbox_count:0 } as unknown as TreePayload
beginFirstUse(slug)
createRoot(document.getElementById('root')!).render(<CurrentOrg.Provider value={slug}>
  <div className="app"><main className="solo"><div className="canvas-stage">
    <OrgCanvas tree={tree} slug={slug} op={async()=>({})} toast={()=>{}} mailEvt={null}/>
  </div></main></div>
</CurrentOrg.Provider>)
