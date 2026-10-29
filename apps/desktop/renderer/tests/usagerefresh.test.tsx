import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { getRegisteredAccountUsage } from '../src/api'
import { UsageModal } from '../src/App'
import { UsageBars } from '../src/canvas/accounts'
import { legacyAppBackend } from './appfeed-fixture'
import type { AccountUsage } from '../src/types'

const observed='2026-10-13T18:00:00Z'
const good=(account:string,percent:number):AccountUsage=>({account,provider:'Claude',label:account,
  available:true,plan:'Max',observed_at:observed,limits:[{kind:'session',group:'session',percent,
    severity:'normal',resets_at:null,is_active:false,model:null}]})
const reply=(body:unknown)=>Promise.resolve(new Response(JSON.stringify(body),{status:200,
  headers:{'Content-Type':'application/json'}}))

test('registered usage defaults to cache; only force=true sets the boolean query on the encoded account URL',async()=>{
  const before=globalThis.fetch,urls:string[]=[]
  globalThis.fetch=async url=>{urls.push(String(url));return reply(good('fixture',17))}
  try{
    await getRegisteredAccountUsage('fixture/name ü')
    await getRegisteredAccountUsage('fixture/name ü',false)
    await getRegisteredAccountUsage('fixture/name ü',true)
    assert.deepEqual(urls,[
      '/api/accounts/fixture%2Fname%20%C3%BC/usage',
      '/api/accounts/fixture%2Fname%20%C3%BC/usage',
      '/api/accounts/fixture%2Fname%20%C3%BC/usage?force=true',
    ])
  }finally{globalThis.fetch=before}
})

test('available last-good bars expose provider failure, and a later successful payload clears it',async()=>{
  const payload={...good('fixture',42),error:'provider did not answer'}
  const view=await mountView(<UsageBars u={payload}/>,el=>el)
  try{
    assert.match(view.el.querySelector('[role="alert"]')?.textContent??'',/refresh failed: provider did not answer/)
    assert.match(view.el.textContent??'',/42%/)
    assert.equal(view.el.querySelectorAll('.usage-track').length,1)
    await view.render(<UsageBars u={good('fixture',43)}/> )
    assert.equal(view.el.querySelector('[role="alert"]'),null)
    assert.match(view.el.textContent??'',/43%/)
  }finally{await view.unmount()}
})

test('unavailable and unsupported payloads retain their existing explanations, without invented bars',async()=>{
  const view=await mountView(<UsageBars u={{...good('fixture',0),available:false,limits:[],error:'signed out'}}/>,el=>el)
  try{
    assert.match(view.el.textContent??'',/signed out/)
    assert.doesNotMatch(view.el.textContent??'',/refresh failed:/)
    assert.equal(view.el.querySelectorAll('.usage-track').length,0)
    await view.render(<UsageBars u={{...good('fixture',0),available:false,unsupported:true,limits:[],error:'unsupported kind'}}/> )
    assert.match(view.el.querySelector('.acct-unsupported')?.textContent??'',/unsupported kind/)
    assert.equal(view.el.querySelector('[role="alert"]'),null)
    assert.equal(view.el.querySelectorAll('.usage-track').length,0)
  }finally{await view.unmount()}
})

test('actual native and registered Refresh show HTTP200 retained-bar errors without restamping, then recover',async()=>{
  const id='fixture-refresh-account',before=globalThis.fetch,urls:string[]=[]
  let failed=false
  const payload=(account:string,percent:number)=>({...good(account,percent),...(failed?{error:'fixture provider failed'}:{})})
  globalThis.fetch=legacyAppBackend((async input=>{
    const url=new URL(String(input),'http://localhost'),path=url.pathname
    urls.push(path+url.search)
    if(path==='/api/providers')return reply({providers:[{id:'claude',hire_enabled:true,status:{installed:true}}]})
    if(path==='/api/accounts')return reply({accounts:[{id,provider:'claude',harness:'claude-code',label:'Fixture login',
      mode:'subscription',enabled:true,ambient:false,credential:{kind:'managed',path:'D:/synthetic/profile'},
      identity:{email:'fixture@example.test'},auth:'authenticated',tint_ordinal:1,bound:[]}]})
    if(path==='/api/usage')return reply(payload('primary',17))
    if(path===`/api/accounts/${id}/usage`)return reply(payload(id,42))
    if(path==='/api/langservers')return reply({servers:[]})
    if(path.includes('/keys/usage'))return reply({keys:[]})
    return reply({available:false,limits:[],accounts:[],keys:[]})
  }) as typeof fetch)
  let view:Awaited<ReturnType<typeof mountView>>|undefined
  try{
    view=await mountView(<UsageModal close={()=>{}} toast={()=>{}}/>,el=>el)
    await inAct(async()=>{await flush(12)})
    const registered=view.el.querySelector<HTMLElement>(`[data-account="${id}"]`)!
    const native=[...view.el.querySelectorAll<HTMLElement>('.usage-acct')]
      .find(card=>!!card.querySelector('[aria-label="refresh Claude usage"]'))!
    assert.ok(native);assert.ok(registered)
    const stamps=[native,registered].map(card=>card.querySelector('.usage-updated')?.getAttribute('title'))
    assert.ok(stamps.every(Boolean),'both dated readings reached actual cards')
    failed=true
    for(const card of [native,registered])await inAct(async()=>{
      card.querySelector<HTMLButtonElement>('.usage-refresh-button')!.click();await flush(12)
    })
    for(const [i,card] of [native,registered].entries()){
      assert.match(card.querySelector('[role="alert"]')?.textContent??'',/refresh failed: fixture provider failed/)
      assert.equal(card.querySelectorAll('.usage-track').length,1)
      assert.equal(card.querySelector('.usage-updated')?.getAttribute('title'),stamps[i])
      assert.equal(card.querySelector('.usage-refresh-button')?.getAttribute('aria-busy'),'false')
    }
    assert.ok(urls.includes(`/api/accounts/${id}/usage?force=true`),'registered Refresh forced its own account')
    assert.ok(urls.includes('/api/usage?force=true'),'native force path remains intact')
    failed=false
    for(const card of [native,registered])await inAct(async()=>{
      card.querySelector<HTMLButtonElement>('.usage-refresh-button')!.click();await flush(12)
    })
    assert.equal(native.querySelector('[role="alert"]'),null)
    assert.equal(registered.querySelector('[role="alert"]'),null)
    assert.match(native.textContent??'',/17%/);assert.match(registered.textContent??'',/42%/)
  }finally{await view?.unmount();globalThis.fetch=before}
})

test('every OpenRouter key has independent Refresh; only the clicked key forces and failures retain its bars',async()=>{
  const before=globalThis.fetch,seen:string[]=[]
  const readings:Record<string,AccountUsage&{name:string}>={
    'openrouter-1':{...good('openrouter-1',11),provider:'OpenRouter',name:'Personal'},
    'openrouter-2':{...good('openrouter-2',22),provider:'OpenRouter',name:'Team budget'},
    'openrouter-3':{...good('openrouter-3',63),provider:'OpenRouter',name:'Other budget'},
  }
  let settle:((value:Response)=>void)|undefined
  globalThis.fetch=legacyAppBackend((async input=>{
    const url=new URL(String(input),'http://localhost'),path=url.pathname
    seen.push(path+url.search)
    if(path==='/api/providers')return reply({providers:[{id:'openrouter',hire_enabled:true,status:{installed:true}}]})
    if(path==='/api/accounts')return reply({accounts:[]})
    if(path==='/api/openrouter/keys/usage')return reply(readings)
    if(path==='/api/accounts/openrouter-2/usage')return new Promise<Response>(resolve=>{settle=resolve})
    if(path==='/api/langservers')return reply({servers:[]})
    return reply({available:false,limits:[]})
  }) as typeof fetch)
  let view:Awaited<ReturnType<typeof mountView>>|undefined
  try{
    view=await mountView(<UsageModal close={()=>{}} toast={()=>{}}/>,el=>el)
    await inAct(async()=>{await flush(12)})
    const cards=[...view.el.querySelectorAll<HTMLElement>('.usage-acct')]
    const two=cards.find(card=>card.textContent?.includes('Team budget (openrouter-2)'))!
    const three=cards.find(card=>card.textContent?.includes('Other budget (openrouter-3)'))!
    assert.ok(two);assert.ok(three)
    const button=two.querySelector<HTMLButtonElement>('[aria-label="refresh openrouter-2 usage"]')
    const other=three.querySelector<HTMLButtonElement>('[aria-label="refresh openrouter-3 usage"]')
    assert.ok(button,'secondary key gets the shared Refresh control')
    assert.ok(other,'every added key gets its own Refresh control')
    // every key alike (user 2026-10-14): the first key's card is one more key card
    assert.ok(view.el.querySelector('[aria-label="refresh openrouter-1 usage"]'),'the first key has its own Refresh too')
    assert.equal(view.el.querySelector('[aria-label="refresh OpenRouter usage"]'),null,'no separate lane card')
    assert.equal(seen.some(url=>url.startsWith('/api/accounts/openrouter-')),false,'ordinary key reads remain cache-only')
    const stamp=two.querySelector('.usage-updated')?.getAttribute('title')
    assert.ok(stamp)
    await inAct(async()=>{button.click();await flush(4)})
    assert.equal(button.getAttribute('aria-busy'),'true')
    assert.equal(other.getAttribute('aria-busy'),'false')
    await inAct(async()=>{button.click();await flush(4)})
    assert.deepEqual(seen.filter(url=>url.includes('force=')),['/api/accounts/openrouter-2/usage?force=true'],
      'pending duplicate cannot force another call or any sibling key')
    assert.ok(settle,'the key-specific synthetic request reached the endpoint')
    await inAct(async()=>{settle!(await reply({...readings['openrouter-2'],error:'key provider failed'}));await flush(12)})
    assert.match(two.querySelector('[role="alert"]')?.textContent??'',/refresh failed: key provider failed/)
    assert.match(two.textContent??'',/22%/)
    assert.equal(two.querySelector('.usage-updated')?.getAttribute('title'),stamp)
    assert.match(three.textContent??'',/63%/)
    assert.equal(three.querySelector('[role="alert"]'),null)
    await inAct(async()=>{button.click();await flush(4)})
    await inAct(async()=>{settle!(await reply({...readings['openrouter-2'],limits:good('openrouter-2',23).limits}));await flush(12)})
    assert.equal(two.querySelector('[role="alert"]'),null)
    assert.match(two.textContent??'',/23%/)
    await inAct(async()=>{button.click();await flush(4)})
    await inAct(async()=>{settle!(new Response(JSON.stringify({detail:'key endpoint down'}),{status:500,
      headers:{'Content-Type':'application/json'}}));await flush(12)})
    assert.match(two.querySelector('[role="alert"]')?.textContent??'',/refresh failed: .*key endpoint down/)
    assert.match(two.textContent??'',/23%/)
    assert.equal(other.getAttribute('aria-busy'),'false')
  }finally{await view?.unmount();globalThis.fetch=before}
})


import { AccountUsagePanel } from '../src/accountusage'

test('Claude rate-limited (429) and network-failed usage fetches keep rendering last-good bars with original observed age until the next success replaces them',async()=>{
  const id='claude-secondary',before=globalThis.fetch
  const obs1='2026-10-13T18:00:00Z',obs2='2026-10-13T18:10:00Z'
  const futureReset=new Date(Date.now()+3600_000).toISOString()
  const claudeGood=(account:string,sessionPct:number,weeklyPct:number,observed_at=obs1):AccountUsage=>({
    account,provider:'Claude',label:account,available:true,plan:'Max',observed_at,
    limits:[
      {kind:'session',group:'session',percent:sessionPct,severity:'normal',resets_at:futureReset,is_active:false,model:null},
      {kind:'weekly_all',group:'weekly',percent:weeklyPct,severity:'normal',resets_at:futureReset,is_active:false,model:null},
    ],
  })
  let phase:'good1'|'rate_limited'|'net_failed'|'good2'='good1'
  globalThis.fetch=legacyAppBackend((async input=>{
    const url=new URL(String(input),'http://localhost'),path=url.pathname
    if(path==='/api/providers')return reply({providers:[{id:'claude',hire_enabled:true,status:{installed:true}}]})
    if(path==='/api/accounts')return reply({accounts:[{id,provider:'claude',harness:'claude-code',label:'Claude Secondary',
      mode:'subscription',enabled:true,ambient:false,credential:{kind:'managed',path:'D:/synthetic/claude-2'},
      identity:{email:'secondary@example.test'},auth:'authenticated',tint_ordinal:1,bound:[]}]})
    if(path==='/api/usage'){
      if(phase==='good1')return reply(claudeGood('primary',38,61,obs1))
      if(phase==='rate_limited')return reply({
        ...claudeGood('primary',38,61,obs1),
        available:false,
        error:'usage updates paused; next retry in 120 s',
      })
      if(phase==='net_failed')return reply({
        account:'primary',provider:'Claude',label:'primary',available:false,
        limits:[],error:'Claude usage is not available right now',detail:'request timed out',
      })
      return reply(claudeGood('primary',44,65,obs2))
    }
    if(path===`/api/accounts/${id}/usage`){
      if(phase==='good1')return reply(claudeGood(id,24,53,obs1))
      if(phase==='rate_limited')return reply({
        ...claudeGood(id,24,53,obs1),
        available:false,
        error:'usage updates paused; next retry in 180 s',
      })
      if(phase==='net_failed')return reply({
        account:id,provider:'Claude',label:id,available:false,
        limits:[],error:'HTTP 429 rate limited',
      })
      return reply(claudeGood(id,31,58,obs2))
    }
    if(path==='/api/langservers')return reply({servers:[]})
    if(path.includes('/keys/usage'))return reply({keys:[]})
    return reply({available:false,limits:[],accounts:[],keys:[]})
  }) as typeof fetch)
  let view:Awaited<ReturnType<typeof mountView>>|undefined
  try{
    view=await mountView(<UsageModal close={()=>{}} toast={()=>{}}/>,el=>el)
    await inAct(async()=>{await flush(12)})
    const registered=view.el.querySelector<HTMLElement>(`[data-account="${id}"]`)!
    const native=[...view.el.querySelectorAll<HTMLElement>('.usage-acct')]
      .find(card=>!!card.querySelector('[aria-label="refresh Claude usage"]'))!
    assert.ok(native);assert.ok(registered)
    const stamps1=[native,registered].map(card=>card.querySelector('.usage-updated')?.getAttribute('title'))
    assert.ok(stamps1.every(Boolean))
    assert.equal(native.querySelectorAll('.usage-track').length,2)
    assert.equal(registered.querySelectorAll('.usage-track').length,2)
    assert.match(native.textContent??'',/38%/);assert.match(native.textContent??'',/61%/)
    assert.match(registered.textContent??'',/24%/);assert.match(registered.textContent??'',/53%/)

    // Rate-limited (429 cooldown with available:false): bars and original observed_at stay visible.
    phase='rate_limited'
    for(const card of [native,registered])await inAct(async()=>{
      card.querySelector<HTMLButtonElement>('.usage-refresh-button')!.click();await flush(12)
    })
    assert.equal(native.querySelectorAll('.usage-track').length,2,'native Claude card keeps both bars on 429')
    assert.equal(registered.querySelectorAll('.usage-track').length,2,'registered Claude card keeps both bars on 429')
    assert.match(native.textContent??'',/38%/);assert.match(native.textContent??'',/61%/)
    assert.match(registered.textContent??'',/24%/);assert.match(registered.textContent??'',/53%/)
    assert.equal(native.querySelector('.usage-updated')?.getAttribute('title'),stamps1[0])
    assert.equal(registered.querySelector('.usage-updated')?.getAttribute('title'),stamps1[1])
    assert.match(native.querySelector('[role="alert"]')?.textContent??'',/usage updates paused; next retry in 120 s/)
    assert.match(registered.querySelector('[role="alert"]')?.textContent??'',/usage updates paused; next retry in 180 s/)

    // Network/timeout failure returning available:false with empty limits: renderer still retains last-good bars.
    phase='net_failed'
    for(const card of [native,registered])await inAct(async()=>{
      card.querySelector<HTMLButtonElement>('.usage-refresh-button')!.click();await flush(12)
    })
    assert.equal(native.querySelectorAll('.usage-track').length,2)
    assert.equal(registered.querySelectorAll('.usage-track').length,2)
    assert.match(native.textContent??'',/38%/);assert.match(native.textContent??'',/61%/)
    assert.match(registered.textContent??'',/24%/);assert.match(registered.textContent??'',/53%/)
    assert.equal(native.querySelector('.usage-updated')?.getAttribute('title'),stamps1[0])
    assert.equal(registered.querySelector('.usage-updated')?.getAttribute('title'),stamps1[1])

    // Next successful reading replaces the retained bars and clears the alert.
    phase='good2'
    for(const card of [native,registered])await inAct(async()=>{
      card.querySelector<HTMLButtonElement>('.usage-refresh-button')!.click();await flush(12)
    })
    assert.equal(native.querySelector('[role="alert"]'),null)
    assert.equal(registered.querySelector('[role="alert"]'),null)
    assert.match(native.textContent??'',/44%/);assert.match(native.textContent??'',/65%/)
    assert.match(registered.textContent??'',/31%/);assert.match(registered.textContent??'',/58%/)
    assert.notEqual(native.querySelector('.usage-updated')?.getAttribute('title'),stamps1[0])
  }finally{await view?.unmount();globalThis.fetch=before}
})

test('retained reading whose window reset time is in the past renders reset; awaiting reading instead of presenting the old percentage as current',async()=>{
  const pastReset=new Date(Date.now()-15*60_000).toISOString()
  const futureReset=new Date(Date.now()+2*86400_000).toISOString()
  const retainedClaude:AccountUsage={
    account:'primary',provider:'Claude',label:'primary',
    available:false,plan:'Max',observed_at:observed,
    error:'usage updates paused; next retry in 120 s',
    limits:[
      {kind:'session',group:'session',percent:84,severity:'warning',resets_at:pastReset,is_active:false,model:null},
      {kind:'weekly_all',group:'weekly',percent:52,severity:'normal',resets_at:futureReset,is_active:false,model:null},
    ],
  }
  const view=await mountView(<UsageBars u={retainedClaude}/>,el=>el)
  try{
    const rows=view.el.querySelectorAll('.usage-row')
    assert.equal(rows.length,2,'both windows remain listed on the card')
    const sessionRow=rows[0]!,weeklyRow=rows[1]!
    assert.match(sessionRow.querySelector('.u-reset')?.textContent??'',/reset; awaiting reading/)
    assert.equal(sessionRow.querySelector('.usage-track'),null,'passed-reset window must not render old bar as current')
    assert.equal(sessionRow.querySelector('.u-pct'),null,'passed-reset window must not render old 84% badge as current')
    assert.doesNotMatch(sessionRow.textContent??'',/84%/)
    assert.ok(weeklyRow.querySelector('.usage-track'),'unexpired weekly window keeps its bar')
    assert.match(weeklyRow.textContent??'',/52%/)
  }finally{await view.unmount()}
})

test('AccountUsagePanel keeps rendering last-good bars across rate-limited or failed refreshes until the next success replaces them',async()=>{
  const before=globalThis.fetch
  const futureReset=new Date(Date.now()+3600_000).toISOString()
  let step=0
  globalThis.fetch=(async()=>{
    step++
    if(step===1)return reply({
      account:'claude-2',provider:'Claude',label:'claude-2',available:true,plan:'Max',observed_at:observed,
      limits:[
        {kind:'session',group:'session',percent:29,severity:'normal',resets_at:futureReset,is_active:false,model:null},
        {kind:'weekly_all',group:'weekly',percent:74,severity:'normal',resets_at:futureReset,is_active:false,model:null},
      ],
    })
    if(step===2)return reply({
      account:'claude-2',provider:'Claude',label:'claude-2',available:false,plan:'Max',observed_at:observed,
      error:'usage updates paused; next retry in 120 s',
      limits:[
        {kind:'session',group:'session',percent:29,severity:'normal',resets_at:futureReset,is_active:false,model:null},
        {kind:'weekly_all',group:'weekly',percent:74,severity:'normal',resets_at:futureReset,is_active:false,model:null},
      ],
    })
    if(step===3)return reply({
      account:'claude-2',provider:'Claude',label:'claude-2',available:false,plan:'Max',
      error:'network timeout',limits:[],
    })
    if(step===4)return new Response(JSON.stringify({detail:'gateway timeout'}),{status:502,headers:{'Content-Type':'application/json'}})
    return reply({
      account:'claude-2',provider:'Claude',label:'claude-2',available:true,plan:'Max',observed_at:'2026-10-13T18:15:00Z',
      limits:[
        {kind:'session',group:'session',percent:33,severity:'normal',resets_at:futureReset,is_active:false,model:null},
        {kind:'weekly_all',group:'weekly',percent:76,severity:'warning',resets_at:futureReset,is_active:false,model:null},
      ],
    })
  }) as typeof fetch
  let view:Awaited<ReturnType<typeof mountView>>|undefined
  try{
    view=await mountView(<AccountUsagePanel accountId="claude-2"/>,el=>el)
    await inAct(async()=>{await flush(10)})
    assert.equal(view.el.querySelectorAll('.usage-track').length,2)
    assert.match(view.el.textContent??'',/29%/);assert.match(view.el.textContent??'',/74%/)

    for(const expectedAlert of [/usage updates paused/,/refresh failed: network timeout/,/refresh failed: .*gateway timeout/]){
      await inAct(async()=>{
        view!.el.querySelector<HTMLButtonElement>('.account-usage button')!.click()
        await flush(10)
      })
      assert.equal(view.el.querySelectorAll('.usage-track').length,2,'retained bars remain visible across failed refreshes')
      assert.match(view.el.textContent??'',/29%/);assert.match(view.el.textContent??'',/74%/)
      assert.match(view.el.querySelector('[role="alert"]')?.textContent??'',expectedAlert)
    }

    await inAct(async()=>{
      view!.el.querySelector<HTMLButtonElement>('.account-usage button')!.click()
      await flush(10)
    })
    assert.equal(view.el.querySelector('[role="alert"]'),null)
    assert.match(view.el.textContent??'',/33%/);assert.match(view.el.textContent??'',/76%/)
  }finally{await view?.unmount();globalThis.fetch=before}
})

test('Codex, Antigravity and OpenRouter cards retain last-good readings across failed fetches until replaced by a fresh reading',async()=>{
  const before=globalThis.fetch
  const futureReset=new Date(Date.now()+3600_000).toISOString()
  let failed=false,recovered=false
  const codexReading=():AccountUsage=>failed?{
    account:'codex',provider:'Codex',label:'codex@example.test',available:false,
    limits:[],error:'Codex HTTPS 429 rate limited',
  }:{
    account:'codex',provider:'Codex',label:'codex@example.test',available:true,plan:'Pro',
    observed_at:recovered?'2026-10-13T18:10:00Z':observed,
    limits:[{kind:'weekly_all',group:'codex',percent:recovered?25:19,severity:'normal',resets_at:futureReset,is_active:false,model:null,label:'7 days'}],
  }
  const agyReading=():AccountUsage=>failed?{
    account:'antigravity',provider:'Antigravity',label:'agy@example.test',available:false,
    limits:[],error:'Antigravity usage check timed out',
  }:{
    account:'antigravity',provider:'Antigravity',label:'agy@example.test',available:true,tier:'Google AI Pro',
    observed_at:recovered?'2026-10-13T18:10:00Z':observed,
    limits:[{kind:'session',group:'gemini-5h',percent:recovered?48:41,severity:'normal',resets_at:futureReset,is_active:false,model:'Gemini Models',label:'Gemini Models · Five Hour'}],
  }
  const orReading=():AccountUsage&{name:string}=>failed?{
    account:'openrouter-1',name:'Primary OR',provider:'OpenRouter',label:'Primary OR',available:false,
    limits:[],error:'OpenRouter usage check failed (429)',
  }:{
    account:'openrouter-1',name:'Primary OR',provider:'OpenRouter',label:'Primary OR',available:true,
    observed_at:recovered?'2026-10-13T18:10:00Z':observed,
    limits:[{kind:'usage',group:'credits',percent:recovered?60:55,severity:'normal',resets_at:null,is_active:false,model:null,label:'$5.50 of $10.00 spend cap'}],
  }
  globalThis.fetch=legacyAppBackend((async input=>{
    const url=new URL(String(input),'http://localhost'),path=url.pathname
    if(path==='/api/providers')return reply({providers:['openai','google','openrouter'].map(id=>({id,hire_enabled:true,status:{installed:true}}))})
    if(path==='/api/accounts')return reply({accounts:[]})
    if(path==='/api/codex/usage')return reply(codexReading())
    if(path==='/api/antigravity/usage')return reply(agyReading())
    if(path==='/api/openrouter/keys/usage')return reply({'openrouter-1':orReading()})
    if(path==='/api/accounts/openrouter-1/usage')return reply(orReading())
    if(path==='/api/langservers')return reply({servers:[]})
    return reply({available:false,limits:[]})
  }) as typeof fetch)
  let view:Awaited<ReturnType<typeof mountView>>|undefined
  try{
    view=await mountView(<UsageModal close={()=>{}} toast={()=>{}}/>,el=>el)
    await inAct(async()=>{await flush(12)})
    assert.equal(view.el.querySelectorAll('.usage-track').length,3)
    assert.match(view.el.textContent??'',/19%/)
    assert.match(view.el.textContent??'',/41%/)
    assert.match(view.el.textContent??'',/55%/)

    failed=true
    for(const label of ['refresh Codex usage','refresh Antigravity usage','refresh openrouter-1 usage']){
      await inAct(async()=>{
        view!.el.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click()
        await flush(12)
      })
    }
    assert.equal(view.el.querySelectorAll('.usage-track').length,3,'all three provider cards keep their last-good bars on failure')
    assert.match(view.el.textContent??'',/19%/)
    assert.match(view.el.textContent??'',/41%/)
    assert.match(view.el.textContent??'',/55%/)

    failed=false;recovered=true
    for(const label of ['refresh Codex usage','refresh Antigravity usage','refresh openrouter-1 usage']){
      await inAct(async()=>{
        view!.el.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click()
        await flush(12)
      })
    }
    assert.equal(view.el.querySelectorAll('[role="alert"]').length,0)
    assert.match(view.el.textContent??'',/25%/)
    assert.match(view.el.textContent??'',/48%/)
    assert.match(view.el.textContent??'',/60%/)
  }finally{await view?.unmount();globalThis.fetch=before}
})
