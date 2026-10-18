import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { MailList } from '../src/canvas/mail'
const rows=[{id:'one',from:'writer',kind:'message',at:'2026-10-18T11:00:00Z',body:'The selected build is ready to inspect.',tags:['alpha','build']},
  {id:'two',from:'writer',kind:'message',at:'2026-10-18T10:00:00Z',body:'Earlier build notes.',tags:['alpha','build']}]
function Fixture(){
  const [tags,setTags]=useState(['alpha','build'])
  return <main className="settings" style={{position:'static',transform:'none',width:900,maxWidth:'none',margin:20,padding:20}}>
    <h3>Inbox · filtered mail</h3><p className="dim">Unread mail outside this filter stays visible in the compact entry.</p>
    <div style={{height:400,display:'flex'}}><MailList delivered={rows} selectOldestUnread
      selectionRequest={{key:'fixture',id:'one'}} hiddenUnread={{count:802,onOpen:()=>setTags([])}}
      tagFilter={{selected:tags,choices:['alpha','build','review'],onChange:setTags}}/></div>
  </main>
}
document.documentElement.dataset.theme='dark'
createRoot(document.getElementById('root')!).render(<Fixture/>)
