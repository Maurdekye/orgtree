import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { MailList } from '../src/canvas/mail'
import { MailTagPicker } from '../src/canvas/mailtagpicker'
import { applyTheme } from '../src/themes'

const choices=['alpha','build','progress','review','a longer release announcement tag']
function Fixture(){
  const [selected,setSelected]=useState(['alpha','build'])
  const [browse,setBrowse]=useState(['alpha','build'])
  return <main className="settings" style={{width:960,height:600,maxWidth:'none',position:'static',transform:'none',margin:0,boxSizing:'border-box'}}>
    <h3>Inbox tag picker · synthetic mail</h3>
    <div style={{display:'grid',gridTemplateColumns:'340px 480px',gap:40}}>
      <section id="inbox-sample" style={{height:430,display:'flex',flexDirection:'column'}}>
        <h4>Selected inbox filters</h4>
        <style>{'#inbox-sample .mailer-list{width:100%;max-width:none;min-width:0;flex:1 1 auto} #inbox-sample .mailer-read{display:none}'}</style>
        <MailList delivered={[{id:'sample',from:'coordinator',kind:'message',at:'2026-10-18T10:57:00Z',body:'A synthetic tagged update',tags:['alpha','build']} ]}
          tagFilter={{selected,choices,onChange:setSelected}}/>
      </section>
      <section id="browse-sample"><h4>Tag choices</h4><MailTagPicker selected={browse} choices={choices} onChange={setBrowse}/></section>
    </div>
  </main>
}
window.fetch=async()=>new Response(JSON.stringify({}),{headers:{'Content-Type':'application/json'}})
applyTheme('orgtree')
createRoot(document.getElementById('root')!).render(<Fixture/>)
