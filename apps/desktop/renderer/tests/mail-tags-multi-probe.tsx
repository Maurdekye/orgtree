import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { MailList,MailRowView } from '../src/canvas/mail'
import { decodeEventRow } from '../src/events/decode'
import { projectEvent } from '../src/events/project'
import { applyTheme } from '../src/themes'
import type { MailRow } from '../src/canvas/shared'
import replyFixture from './fixtures/events/reply.mail.json'
import docFixture from './fixtures/events/reply.document.json'
const tags=['a lengthy build announcement tag','release','alpha build','review','progress','renderer','engine','ready']
const row:MailRow={id:'preview',from:'coordinator',kind:'message',at:'2026-10-17T19:50:00Z',body:docFixture.body,tags,ev:docFixture.private}
const decoded=decodeEventRow(row,'operator'),view=decoded.kind==='known'?projectEvent(decoded.event):null
const reply:MailRow={id:'reply',from:'coordinator',kind:'message',at:'2026-10-17T19:52:00Z',body:replyFixture.body,tags,ev:replyFixture.private}
function Fixture(){
  const [selected,setSelected]=useState(['release','alpha build'])
  return <main className="settings" style={{width:960,maxWidth:'none',height:640,position:'static',transform:'none',margin:0,boxSizing:'border-box'}}>
    <style>{'#tag-filter-layout .mailer-list{width:100%;max-width:none;min-width:0;flex:1 1 auto}'}</style>
    <h3>Mail tags - synthetic layout</h3>
    <div style={{display:'grid',gridTemplateColumns:'330px 550px',gap:16}}>
      <section id="narrow-row" style={{width:330,minWidth:0}}>
        <h4>Tagged row</h4><MailRowView m={row} view={view} selected={false} party="coordinator" onClick={()=>{}}/>
        <h4>Same header without tags</h4><div id="baseline-row"><MailRowView m={{...row,tags:[]}} view={view} selected={false} party="coordinator" onClick={()=>{}}/></div>
        <h4>Tag filter</h4><div id="tag-filter-layout"><MailList delivered={[]} tagFilter={{selected,choices:tags,onChange:setSelected}}/></div>
      </section>
      <section id="read-pane" style={{height:510,minHeight:0,display:'flex',flexDirection:'column'}}>
        <h4>User-inbox reply</h4><MailList pending={[reply]} hideMailReplyKind selectOldestUnread/>
      </section>
    </div>
  </main>
}
window.fetch=async()=>new Response(JSON.stringify({}),{headers:{'Content-Type':'application/json'}})
applyTheme('orgtree')
createRoot(document.getElementById('root')!).render(<Fixture/>)
