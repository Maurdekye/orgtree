import { createRoot } from 'react-dom/client'
import { Agent, Project, documentRow } from './deskreaders.fixture'
import { RecordFeed } from '../src/recordfeed'
import { OrgRecordContext } from '../src/recordsession'
import { liveRevision } from '../src/livebus'

let presented=false,work=false,rev=1
const reads:{node:string;at:number}[]=[]
const cursor={org_uuid:'readers-id',incarnation:'one',rev:1}
const feed=new RecordFeed({snapshot:async()=>{throw Error('unexpected snapshot')},
  catchup:async()=>{throw Error('unexpected catchup')},project:records=>records,
  publish:()=>{},error:error=>{throw error}})
feed.receive({type:'record_snapshot',cursor,records:[]})
globalThis.fetch=(async url=>{
  const u=new URL(String(url),'http://fixture'),p=u.pathname
  let data:unknown={ok:true}
  if(p.endsWith('/reader-availability')){
    reads.push({node:p.split('/').at(-2)!,at:performance.now()})
    data={work:{own:work,team:work},presented:{own:false,team:presented}}
  }else if(p.endsWith('/chat'))data={busy:false,queued:0,responding:false,last_error:null,messages:[],live:[],draft_epoch:'fixture:0',mail_pending:0,pending_mail:[]}
  else if(p.endsWith('/inbox'))data={pending:[],delivered:[],sent:[]}
  else if(p.endsWith('/transfers'))data={transfers:[],next_cursor:null}
  else if(p.endsWith('/helpers'))data={count:0,items:[]}
  else if(p.endsWith('/history'))data={items:[]}
  else if(p.endsWith('/documents'))data={documents:[documentRow],total:1,offset:0,next_offset:null,opening_id:'proposal'}
  return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}})
}) as typeof fetch
Object.assign(window,{deskReaderFixture:{
  arrive:(kind:'presented'|'work')=>{
    if(kind==='presented')presented=true;else work=true
    const at=performance.now(),from=rev++
    feed.receive({type:'record_changes',...cursor,from,to:rev,upserts:[],tombstones:[]})
    return at
  },
  state:()=>({reads:[...reads],liveRevision:liveRevision(),rev})
}})
createRoot(document.getElementById('root')!).render(<OrgRecordContext.Provider value={{slug:'readers',session:feed}}>
  <main style={{display:'flex',gap:16,padding:16,height:'100vh',boxSizing:'border-box'}}>
    <section style={{display:'flex',flexDirection:'column',flex:1,minWidth:0}}><h2>Agent · first arrivals</h2><div data-reader="agent" style={{display:'flex',flex:1,minHeight:0}}><Agent/></div></section>
    <section style={{display:'flex',flexDirection:'column',flex:1,minWidth:0}}><h2>Project · first arrivals</h2><div data-reader="project" style={{display:'flex',flex:1,minHeight:0}}><Project/></div></section>
  </main>
</OrgRecordContext.Provider>)
