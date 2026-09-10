import { createRoot } from 'react-dom/client'
import { AccountsPanel } from '../src/canvas/accounts'
const rows = ['claude', 'openai', 'google'].flatMap(provider => [{
  id: provider+'-1', provider, label: provider === 'claude' ? 'Personal Claude' : provider === 'openai' ? 'Work Codex' : 'Imported Antigravity',
  credential: {kind:'managed',path:'C:/fixture/profile'}, identity:{email:'example@example.test'},tint_ordinal:1,
  standing:{auth:provider==='google'?'unobserved':'authenticated'},bound:[],
}])
window.fetch = (async (url: string) => new Response(JSON.stringify(String(url).endsWith('/providers') ? {providers:
  ['claude','openai','google'].map((id,i)=>({id,label:['Claude','Codex','Antigravity'][i],cli:['Claude Code','Codex CLI','Antigravity'][i],status:{installed:true,connected:true},hire_enabled:true,tiers:[]}))
} : String(url).endsWith('/accounts') ? {accounts:rows} : {}), {status:200,headers:{'Content-Type':'application/json'}})) as typeof fetch
;(window as any).orgtreeDesktop = {getPreferences:async()=>({}),onEvent:()=>()=>{},getProviderLoginStatus:async()=>({phase:'idle'})}
createRoot(document.getElementById('root')!).render(<AccountsPanel toast={()=>{}} close={()=>{}} />)
