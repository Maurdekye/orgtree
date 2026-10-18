import { createRoot } from 'react-dom/client'
import { DeskChat } from '../src/canvas/desk'
import { NearCard, agent, seedFastMode } from './fastmode-near-fixture'
import { applyTheme } from '../src/themes'
applyTheme('orgtree'); seedFastMode()
document.documentElement.style.overflow='hidden'; document.body.style.overflow='hidden'
window.fetch=async url=>{
 const path=new URL(String(url),location.href).pathname
 const body=path.endsWith('/chat')?{busy:true,responding:true,queued:0,messages:[],live:[],pending_mail:[],mail_pending:0}
 :path.endsWith('/documents')?{documents:[],total:0,next_offset:null}
 :path.endsWith('/work-items')?{items:[],counts:{attention:0,active:0,archived:0,backlogged:0}}
 :path.endsWith('/history')?{items:[]}:{ok:true}
 return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json','X-Orgtree-Instance':'synthetic-fast-layout'}})
}
const desk=agent(true,{id:'composer',busy:true,responding:true,fast_mode_current:false,effort_effective:'high'})
const rows=[
 ['Running standard / queued on',agent(true,{id:'queued-on',busy:true,fast_mode_current:false})],
 ['Running fast / queued off',agent(false,{id:'queued-off',busy:true,fast_mode_current:true})],
 ['Running fast / unchanged',agent(true,{id:'matching',busy:true,fast_mode_current:true})],
 ['Unknown serving speed',agent(true,{id:'unknown',busy:true,fast_mode_current:null})],
] as const
createRoot(document.getElementById('root')!).render(<main style={{padding:20,color:'var(--ink)'}}>
 <h2 style={{margin:'0 0 12px'}}>Fast toggle on the top row</h2>
 <section data-desk style={{height:340,display:'flex',position:'relative',border:'1px solid var(--line)',borderRadius:8}}>
  <DeskChat node={desk} map={new Map([[desk.id,desk]])} slug="fixture" bare op={async()=>({})} toast={()=>{}}/>
 </section>
 <section data-near style={{display:'flex',gap:12,marginTop:24}}>
 {rows.map(([label,node])=><section key={node.id} data-fixture={node.id} style={{position:'relative',flex:1,height:220}}>
  <h3 style={{fontSize:12,margin:0}}>{label}</h3>
  <div style={{position:'relative',marginTop:14,transform:'scale(1.4)',transformOrigin:'top left'}}><NearCard node={node}/></div>
 </section>)}
 </section>
</main>)
