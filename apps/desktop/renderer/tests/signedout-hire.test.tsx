import { installFetch, FakeServer, mountView, inAct, flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { SpawnChips } from '../src/canvas/cards'
import { QuickChat } from '../src/QuickChatBox'
import { DeskModelButton } from '../src/canvas/deskmodel'
import { hireOf, syncProviderRegistries, type CanvasNode } from '../src/canvas/shared'
import { resetStaffingOptionsForTests } from '../src/canvas/staffingoptions'
import { legacyAppBackend } from './appfeed-fixture'
import type { ProviderInfo, TreePayload } from '../src/types'

const families = [
  ['claude', 'Claude', 'opus'], ['openai', 'Codex', 'sol'],
  ['google', 'Antigravity', 'argon'], ['muse', 'Muse', 'wonder-full'],
  ['openrouter', 'OpenRouter', 'or-synthetic'], ['langserver', 'Language servers', 'ls-synthetic'],
] as const
const providers: ProviderInfo[] = families.map(([id,label,tier]) => ({
  id,label,cli:id,hire_enabled:false,hire_reason:'signed_out',user_enabled:true,
  reason:'Synthetic sign-in remedy',status:{installed:true,connected:false},
  // A signed-out native harness can have no account catalog.
  tiers: id === 'openrouter' || id === 'langserver'
    ? [{tier,provider:id,seat:1,model:tier,letter:'S'}] : [],
}))
const hires = () => Object.fromEntries(['claudeHire','codexHire','antigravityHire','museHire','openrouterHire','langserverHire']
  .map((key,i) => [key,hireOf(providers[i])]))
const noop=()=>{}
function previews(root:ParentNode) {
  for(const [,label,tier] of families){
    const chip=root.querySelector<HTMLButtonElement>('button.t-'+tier)
    assert.ok(!!chip, label+' token exists')
    assert.equal(chip!.disabled,true,label+' cannot hire')
    assert.equal(chip!.classList.contains('codex-preview'),true,label+' uses dashed style')
    assert.match(chip!.title,/isn't signed in\. Sign in to hire agents from it\./)
    assert.match(chip!.title,/Synthetic sign-in remedy/)
  }
}
for(const side of [undefined,'top','left','right'] as const) test(`signed-out families remain visible on ${side??'bottom'} strip despite empty eligibility`,async()=>{
  installFetch(new FakeServer());syncProviderRegistries({providers})
  let clicks=0
  const view=await mountView(<SpawnChips seats={{}} side={side} allowedTiers={[]} {...hires()} onSpawn={()=>clicks++}/>,el=>el)
  try{previews(view.el);for(const chip of view.el.querySelectorAll<HTMLButtonElement>('button'))chip.click();assert.equal(clicks,0)}finally{await view.unmount()}
})

test('off, absent, unknown and signed-in missing catalogs retain their existing rules',async()=>{
  installFetch(new FakeServer());syncProviderRegistries({providers})
  for(const delta of [{user_enabled:false},{status:{installed:false,connected:false}},
    {hire_enabled:true,hire_reason:null,status:{installed:true,connected:true}}] as Partial<ProviderInfo>[]){
    const p={...providers[3]!,...delta}
    const view=await mountView(<SpawnChips seats={{}} museHire={hireOf(p)} onSpawn={noop} allowedTiers={[]}/>,el=>el)
    try{assert.equal(!!view.el.querySelector('button.t-wonder-full'),false)}finally{await view.unmount()}
  }
  const p={...providers[0]!,hire_reason:undefined,reason:'some probe failure'}
  const view=await mountView(<SpawnChips seats={{}} claudeHire={hireOf(p)} onSpawn={noop}/>,el=>el)
  try{assert.equal(view.el.querySelector('button.t-opus')?.getAttribute('title')?.includes('Sign in to hire'),false)}finally{await view.unmount()}
})

for(const surface of ['quick','desk'] as const)test(`${surface} picker retains signed-out previews with no staffing choices`,async()=>{
  localStorage.clear();resetStaffingOptionsForTests();installFetch(new FakeServer())
  const oldFetch=globalThis.fetch
  globalThis.fetch=legacyAppBackend((async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=new URL(String(input),'http://localhost').pathname
    const body=path==='/api/providers'?{providers,checking:false}:path.endsWith('/staffing-options')
      ?{tiers:[],errors:[],loading:false}:null
    return body?new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}}):oldFetch(input,init)
  }) as typeof fetch)
  syncProviderRegistries({providers})
  const node={id:'worker',tier:'sol',state:'live',generation:1,scope:{},children:[]} as CanvasNode
  const view=await mountView(surface==='quick'
    ?<QuickChat slug="signedout" tree={{slug:'signedout',roots:[]} as unknown as TreePayload} op={async()=>({})} toast={noop} onHired={noop}/>
    :<DeskModelButton node={node} slug="signedout" op={async()=>({})} toast={noop}/>,el=>el)
  try{
    await inAct(async()=>{await flush(12)})
    const button=view.el.querySelector<HTMLButtonElement>(surface==='quick'?'.quickchat-model':'.desk-model-button')
    assert.ok(button)
    await inAct(async()=>{button.click();await flush(12)})
    previews(document.body)
    assert.equal(!!document.querySelector('[aria-label="Apply model change"]'),false)
  }finally{await view.unmount();globalThis.fetch=oldFetch;resetStaffingOptionsForTests();localStorage.clear()}
})
