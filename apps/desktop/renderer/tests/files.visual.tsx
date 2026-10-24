import { createRoot } from 'react-dom/client'
import { AgentFilesView } from '../src/canvas/files'
import { DeskTabs } from '../src/canvas/deskshell'
import { bumpLive, flushLive } from '../src/livebus'
import '../src/styles.css'

let newest = 80
Object.assign(window, { appendFixtureFile: () => { ++newest; bumpLive(); flushLive() } })
window.fetch = (async url => {
  const older = String(url).includes('before=')
  const files = Array.from({length:20}, (_, index) => {
    const id = (older ? 60 : newest) - index
    const name = `delivery-${id}.${id % 4 === 0 ? 'png' : id % 3 === 0 ? 'log' : 'zip'}`
    return {delivery_id:String(id),name,path:'/offline/'+name,bytes:id*2048,
      note:'Original retained delivery snapshot',at:new Date(Date.UTC(2026,9,24,12,id)).toISOString()}
  })
  return new Response(JSON.stringify({node:'builder',next_cursor:older ? null : '61',files}),{headers:{'Content-Type':'application/json'}})
}) as typeof fetch
createRoot(document.getElementById('root')!).render(<div className="desk" style={{width:720,height:540,margin:24,display:'flex',flexDirection:'column'}}>
  <h2 style={{padding:'0 14px'}}>builder</h2>
  <DeskTabs shown="files" tabs={['chat','mail','docket','presented','files'].map(id=>({id,label:id}))} onShow={()=>{}} />
  <AgentFilesView slug="fixture" nid="builder" />
</div>)
