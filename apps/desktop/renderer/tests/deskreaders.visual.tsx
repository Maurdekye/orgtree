import { createRoot } from 'react-dom/client'
import { Agent, Project, lead, documentRow, workRow } from './deskreaders.fixture'
import { rememberDesk } from '../src/canvas/desktabs'
const empty={...lead,id:'empty',title:'empty',children:[]}
rememberDesk('readers','lead','tab','presented')
rememberDesk('readers','pool','tab','presented')
globalThis.fetch=(async(url)=>{
  const u=new URL(String(url),'http://fixture'),p=u.pathname
  let data:unknown={ok:true}
  if(p.endsWith('/reader-availability')) {
    const own=false,team=!p.includes('/empty/')
    data={work:{own,team},presented:{own,team}}
  } else if(p.endsWith('/documents')) data={documents:u.searchParams.has('team')?[documentRow]:[],total:u.searchParams.has('team')?1:0,offset:0,next_offset:null,opening_id:u.searchParams.has('team')?'proposal':null}
  else if(p.endsWith('/documents/proposal'))data={...documentRow,body:'# Team proposal\n\nThis presentation belongs to a report.\n\nThe desk opens in **Team** scope because its own list is empty.'}
  else if(p.endsWith('/work-items-page'))data={format:'orgtree.work-page/v1',group:'items',rows:[],total:0,totals:{items:0,archived:0,backlogged:0},matched:{items:0,archived:0,backlogged:0},counts:{active:0,attention:0,archived:0,backlogged:0},revision:'r1',at:'2026-10-23T14:00:00Z',next_offset:null}
  else if(p.endsWith('/chat'))data={busy:false,queued:0,responding:false,last_error:null,messages:[],live:[],draft_epoch:'fixture:0',mail_pending:0,pending_mail:[]}
  else if(p.endsWith('/inbox'))data={pending:[],delivered:[],sent:[]}
  else if(p.endsWith('/transfers'))data={transfers:[],next_cursor:null}
  else if(p.endsWith('/history'))data={items:[]}
  return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}})
}) as typeof fetch
document.body.style.background='var(--bg)'
createRoot(document.getElementById('root')!).render(<main style={{display:'flex',gap:16,padding:16,height:'100vh',boxSizing:'border-box'}}>
  <section style={{width:430,display:'flex',flexDirection:'column'}}><h2>Empty node · tabs hidden</h2><div data-fixture="empty" style={{display:'flex',flex:1,minHeight:0}}><Agent node={empty}/></div></section>
  <section style={{width:540,display:'flex',flexDirection:'column'}}><h2>Agent · team presentations</h2><div data-fixture="agent" style={{display:'flex',flex:1,minHeight:0}}><Agent/></div></section>
  <section style={{width:540,display:'flex',flexDirection:'column'}}><h2>Project · same Team checkbox</h2><div data-fixture="project" style={{display:'flex',flex:1,minHeight:0}}><Project/></div></section>
</main>)
