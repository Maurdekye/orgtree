// Synthetic user inbox for mail-filter-bar-visual: the filter bar, tagged rows
// and the reading pane's chips, driven through window.__filterBar. Fixture
// data only; nothing here talks to an engine.
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { MailList } from '../src/canvas/mail'
import { applyTheme } from '../src/themes'
import type { MailRow } from '../src/canvas/shared'

const choices=['alpha','build','release','review','engine','docs','a longer release announcement tag']
const rows:MailRow[]=[
  {id:'m1',from:'coordinator-opus',kind:'message',at:'2026-10-18T10:27:00Z',tags:['build','alpha'],
    body:'Orgtree 4.4.0-alpha.7 is built: [Orgtree Setup 4.4.0-alpha.7.exe](C:/orgtree-artifacts/Orgtree%20Setup%204.4.0-alpha.7.exe)'},
  {id:'m2',from:'coordinator-opus',kind:'message',at:'2026-10-18T09:59:00Z',tags:['alpha','release'],
    body:'The alpha.7 smoke passed on the synthetic rig; installer and hashes are in the artifacts index.'},
  {id:'m3',from:'skilltree-opus',kind:'message',at:'2026-10-18T09:40:00Z',tags:['docs','review'],
    body:'Glossary pages for the build slot are ready for review.'},
  {id:'m4',from:'taskbar-orgs-sol',kind:'message',at:'2026-10-18T09:12:00Z',tags:['alpha','build','review','engine'],
    body:'The inbox tag popover now stays anchored while the list scrolls.'},
  {id:'m5',from:'rig-sol-b',kind:'message',at:'2026-10-18T08:55:00Z',body:'Combined round finished with no new failures.'},
  {id:'m6',from:'usage-header-sonnet',kind:'message',at:'2026-10-18T08:30:00Z',tags:['alpha'],
    body:'Usage header spacing is fixed in both themes.'},
]
interface Mode { tags:string[]; node:boolean }
declare global { interface Window { __filterBar?:{ set:(m:Partial<Mode>)=>void } } }

function Fixture(){
  const [mode,setMode]=useState<Mode>({tags:['alpha'],node:false})
  useEffect(()=>{window.__filterBar={set:m=>setMode(old=>({...old,...m}))}},[])
  return <main className="settings wide" id="probe" style={{width:940,maxWidth:'none',height:620,position:'static',transform:'none',margin:0,boxSizing:'border-box'}}>
    <h3>Your inbox</h3>
    <div className="mailpane" style={{height:500}} data-mode={mode.node?'node':'user'} data-tags={mode.tags.join(',')}>
      {mode.node
        ? <MailList key="node" delivered={rows}/>
        : <MailList key="user" hideMailReplyKind pending={rows.slice(0,1)} delivered={rows.slice(1)} waitLabel="unread" selectOldestUnread
            tagFilter={{selected:mode.tags,choices,onChange:tags=>setMode(old=>({...old,tags}))}}/>}
    </div>
  </main>
}
window.fetch=async()=>new Response(JSON.stringify({}),{headers:{'Content-Type':'application/json'}})
applyTheme('orgtree')
createRoot(document.getElementById('root')!).render(<Fixture/>)
