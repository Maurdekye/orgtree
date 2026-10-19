import { createRoot } from 'react-dom/client'
import { ComposerFocusFixture, seedComposer } from './composerfocus-fixture'
import '../src/styles.css'
import '../src/shell.css'

globalThis.fetch=async url=>new Response(JSON.stringify({messages:[],pending:[],delivered:[],items:[],docs:[],references:{},
  after:'0:0',has_more:false,total:0,responding:String(url).includes('-busy')}),{status:200,headers:{'Content-Type':'application/json'}})
seedComposer()
document.body.style.cssText='margin:0;padding:20px;background:#202020;color:#ddd;font:13px sans-serif;box-sizing:border-box'
createRoot(document.getElementById('root')!).render(<main>{[false,true].map(busy=><section key={String(busy)} data-composer={busy?'busy':'idle'}>
  <h3>{busy?'Responding — interrupt control':'Idle — send control'}</h3>
  <div className="desk-body" style={{height:250,display:'flex',flexDirection:'column',marginBottom:20}}>
    <ComposerFocusFixture surface="agent" busy={busy}/>
  </div>
</section>)}</main>)
