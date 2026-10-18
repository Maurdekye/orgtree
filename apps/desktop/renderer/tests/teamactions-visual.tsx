import { createRoot } from 'react-dom/client'
import { TeamActionsFixture } from './teamactions-fixture'
window.fetch=(()=>Promise.resolve(new Response(JSON.stringify({items:[],references:{},revisions:{},next_cursor:null,
  pending:[],delivered:[],sent:[]}),{headers:{'content-type':'application/json'}}))) as typeof fetch
localStorage.clear()
createRoot(document.getElementById('root')!).render(<div style={{padding:16,display:'grid',gridTemplateColumns:'600px 300px',gap:16}}>
  {[false,true].flatMap(isProject=>[false,true].map(narrow=><section key={`${isProject}-${narrow}`} data-case={`${isProject?'project':'agent'}-${narrow?'narrow':'normal'}`}>
    <div style={{fontSize:12,color:'var(--dim)',marginBottom:4}}>{isProject?'Project':'Agent'} · {narrow?'narrow (300px)':'normal (600px)'}</div>
    <div style={{height:300,minHeight:0,border:'1px solid var(--line)'}}><TeamActionsFixture isProject={isProject}/></div>
  </section>))}
</div>)
