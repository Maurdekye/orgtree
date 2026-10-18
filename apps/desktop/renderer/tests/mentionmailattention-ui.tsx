import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {AskBell} from '../src/App'
import {MailList} from '../src/canvas/mail'
import {markReadNow} from '../src/mailread'
import '../src/styles.css'
import type {MailEntry} from '../src/types'
const m:MailEntry={id:'capture-mention',from:'worker',kind:'message',body:'Please review this result, @user.',at:'2026-10-18T14:00:00Z',mailbox_attention:true}
function Fixture(){
 const [read,setRead]=useState(false)
 ;(window as unknown as {readMention:()=>Promise<void>}).readMention=async()=>{await markReadNow('mention-capture',m,async()=>{});setRead(true)}
 return <main style={{padding:24,maxWidth:860}}><h3>Mailbox attention</h3>
 <p>Ordinary mail mentioning @user draws attention until read.</p>
 <AskBell tree={{slug:'mention-capture',user_inbox_count:1,urgent_unread:1}} onOpen={()=>{}} />
 <div style={{marginTop:20,height:230}}><MailList delivered={[{...m,_wait:!read}]} /></div>
 <p className="dim">{read?'Read: mailbox attention cleared.':'Unread: same mailbox signal as urgent mail, without an urgent label.'}</p>
 </main>
}
document.documentElement.dataset.theme='dark'
createRoot(document.getElementById('root')!).render(<Fixture/>)
