import { createRoot } from 'react-dom/client'
import { AgentFilesView } from '../src/canvas/files'
import { DeskTabs } from '../src/canvas/deskshell'
import '../src/styles.css'

window.fetch = (async () => new Response(JSON.stringify({node:'builder',next_cursor:'17',files:[
  {delivery_id:'release',name:'orgtree-desktop.zip',path:'/offline/orgtree-desktop.zip',bytes:125829120,note:'Desktop package and checksums for review.',at:'2026-10-23T08:12:00Z'},
  {delivery_id:'report',name:'focused-checks.log',path:'/offline/focused-checks.log',bytes:9236,note:'Focused checks completed successfully.',at:'2026-10-23T07:40:00Z'},
  {delivery_id:'older',name:'export.csv',path:'/offline/export.csv',bytes:2048,note:null,at:'2026-10-22T19:15:00Z'},
]}),{headers:{'Content-Type':'application/json'}})) as typeof fetch
createRoot(document.getElementById('root')!).render(<div className="desk" style={{width:720,height:540,margin:24,display:'flex',flexDirection:'column'}}>
  <h2 style={{padding:'0 14px'}}>builder</h2>
  <DeskTabs shown="files" tabs={['chat','mail','docket','presented','files'].map(id=>({id,label:id}))} onShow={()=>{}} />
  <AgentFilesView slug="fixture" nid="builder" />
</div>)
