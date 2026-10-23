import { createRoot } from 'react-dom/client'
import { AccountsPanel } from '../src/canvas/accounts'
import { applyTheme } from '../src/themes'
import '../src/styles.css'
import '../src/shell.css'
const idle = {phase:'idle',ok:null,timedOut:false,output:'',ageMs:0}
;(window as any).orgtreeDesktop = {onEvent:()=>()=>{},getProviderLoginStatus:async()=>idle,
  startProviderLogin:async()=>idle}
window.fetch = async url => new Response(JSON.stringify(String(url).startsWith('/api/providers')
  ? {providers:[{id:'openai',label:'Codex',cli:'Codex',status:{installed:true,connected:false,version:'fixture'},
      tiers:[{tier:'sol',name:'Sol',letter:'S',model:'Codex',seat:2}],hire_enabled:false,
      reason:'Sign in to use Codex.'}],subscription_inference:{openai:true}}
  : String(url).includes('/accounts') ? {accounts:[]} : {}),{headers:{'Content-Type':'application/json'}})
applyTheme('codex'); document.documentElement.dataset.theme='dark'
document.body.style.cssText='margin:0;background:#202020;color:#ddd'
createRoot(document.getElementById('root')!).render(<AccountsPanel toast={()=>{}} close={()=>{}} />)
