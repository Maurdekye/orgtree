import {createRoot} from 'react-dom/client'
import {SpawnChips} from '../src/canvas/cards'
import {hireOf,syncProviderRegistries} from '../src/canvas/shared'
import type {ProviderInfo} from '../src/types'
const rows=[['claude','Claude','opus'],['openai','Codex','sol'],['google','Antigravity','argon'],
 ['muse','Muse','wonder-full'],['openrouter','OpenRouter','or-synthetic'],['langserver','Language servers','ls-synthetic']]
const providers:ProviderInfo[]=rows.map(([id,label,tier])=>({id:id!,label:label!,cli:id!,hire_enabled:false,hire_reason:'signed_out',user_enabled:true,
 reason:'Open App settings to sign in.',status:{installed:true,connected:false},tiers:id==='openrouter'||id==='langserver'
 ?[{tier:tier!,provider:id!,model:tier!,seat:1,letter:'S'}]:[]}))
// Isolated display fixture. No provider, account or live-engine request.
window.fetch=async()=>new Response('{}')
localStorage.clear();syncProviderRegistries({providers})
const keys=['claudeHire','codexHire','antigravityHire','museHire','openrouterHire','langserverHire']
const hires=Object.fromEntries(keys.map((key,i)=>[key,hireOf(providers[i])]))
createRoot(document.getElementById('root')!).render(<main style={{padding:28,fontFamily:'sans-serif'}}>
 <h2>Signed-out harnesses</h2><p>Every token stays visible and disabled. Hover for the sign-in remedy.</p>
 <div className="sample-strip"><SpawnChips seats={{}} {...hires} allowedTiers={[]} onSpawn={()=>{throw Error('Disabled token was activated')}}/></div>
 <h3>Hover text</h3><div id="hover-reason" style={{maxWidth:820,padding:16,border:'1px solid #888',borderRadius:8}}/>
 <p>Provider switches and model eligibility still decide which tokens can hire.</p>
</main>)
