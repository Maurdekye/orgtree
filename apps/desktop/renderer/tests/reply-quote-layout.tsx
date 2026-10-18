import { createRoot } from 'react-dom/client'
import { MailReplyPreview } from '../src/canvas/mailreply'
import { ReplyPreview,ReplySourceProvider } from '../src/canvas/replypreview'
import { applyTheme } from '../src/themes'

const org='synthetic',title='Project slots: UI/UX mockups and a deliberately long presentation title that should truncate inside a narrow reply'
const world={org,handles:new Set<'doc'|'mail'|'item'>(['doc','mail','item']),docs:new Map([['doc-one',title],['doc-two','Build notes']])}
const doc=(id:string)=>({id,kind:'document',from:'writer',at:'',gist:'Retained presentation excerpt with useful context.'})
window.fetch=async()=>new Response('{}',{headers:{'Content-Type':'application/json'}})
applyTheme('orgtree')
createRoot(document.getElementById('root')!).render(<main className="settings" style={{width:960,height:600,maxWidth:'none',position:'static',transform:'none',margin:0,boxSizing:'border-box'}}>
  <h3>Reply targets · synthetic quotes</h3>
  <div style={{display:'grid',gridTemplateColumns:'430px 430px',gap:24}}>
    <section><h4>Multiple presentation replies</h4><MailReplyPreview row={{replies:[doc('doc-one'),doc('doc-two')]}} org={org} world={world} onOpen={()=>{}}/></section>
    <section><h4>Message and unavailable target</h4>
      <ReplySourceProvider value={()=><p>A quoted message can retain its <a href="https://example.invalid">own link</a>.</p>}>
        <ReplyPreview reply={{org,agent:'writer',generation:1,eventId:'message',quote:'Message excerpt'}} available onLocate={()=>{}}/>
      </ReplySourceProvider>
      <MailReplyPreview row={{reply_to:doc('gone')}} org={org} world={world} onOpen={()=>{}}/>
    </section>
  </div>
</main>)
