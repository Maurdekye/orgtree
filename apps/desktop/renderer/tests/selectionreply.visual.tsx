import { createRoot } from 'react-dom/client'
import { CurrentOrg } from '../src/popout'
import { SelectionDrafts, SelectionReplyPreview } from '../src/canvas/selectionpreview'
import { MailReplyBox } from '../src/canvas/mail'
import type { SelectionDraft } from '../src/replySelection'

const selector={part:'mail.body',projection:'source-v1' as const,unit:'unicode-scalar' as const,expected_sha256:'a'.repeat(64),start:14,end:55}
const draft:SelectionDraft={target:{kind:'mail',org:'demo',id:'mail-1'},selection:selector,
  snapshot:{version:1,selector,revision:1,excerpt:'Keep the captured excerpt after an edit.',prefix:'Please revise: ',suffix:' The original context stays available.',state:'exact'}}
window.fetch=async()=>new Response(JSON.stringify({text:'changed source',projection:'source-v1',unit:'unicode-scalar',sha256:'b'.repeat(64),offset:0,next_offset:null,total_scalars:14,revision:2,location:{state:'changed'}}),{status:200})
createRoot(document.getElementById('root')!).render(<CurrentOrg.Provider value="demo">
  <main style={{padding:28,maxWidth:850,margin:'auto'}}>
    <h2>Reply to selection</h2><p className="dim">Mail to writer · exact source excerpt and nearby context</p>
    <section style={{padding:16,border:'1px solid var(--line)',borderRadius:10}}>
      <SelectionDrafts selections={[draft]} onRemove={()=>{}} onClear={()=>{}} />
      <MailReplyBox slug="demo" target="writer" placeholder="Explain what you want changed…" onSend={()=>{}} />
    </section>
    <h3>A reply whose source changed</h3>
    <SelectionReplyPreview target={draft.target} snapshot={draft.snapshot} />
  </main>
</CurrentOrg.Provider>)
