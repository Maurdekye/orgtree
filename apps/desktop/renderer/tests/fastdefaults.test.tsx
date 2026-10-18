import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { SettingsPanel } from '../src/App'
import { syncProviderRegistries } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

test('fast defaults save explicit per-tier values and survive settings tab changes', async () => {
  syncProviderRegistries({ providers: [{ id: 'openai', tiers: [
    { tier: 'sol', fast_mode: true }, { tier: 'luna', fast_mode: true },
    { tier: 'astra', fast_mode: false },
  ] }] })
  installFetch(new FakeServer())
  const original=globalThis.fetch, posted: Record<string,unknown>[]=[]
  globalThis.fetch=(async (url,init) => {
    if (init?.method === 'POST' && String(url).endsWith('/settings')) {
      posted.push(JSON.parse(String(init.body)))
      return new Response('{}',{status:200})
    }
    return original(url,init)
  }) as typeof fetch
  const tree={slug:'org',name:'Org',tiers:{sol:2,luna:1,astra:4},dirs:[],agents:[],
    default_fast_mode:{sol:true},default_tools:{mcp:[]}} as unknown as TreePayload
  const v=await mountView(<SettingsPanel tree={tree} toast={()=>{}} close={()=>{}}
    initialTab="hiredefaults" />,el=>el)
  try {
    await inAct(async()=>{await flush(3)})
    const sol=v.el.querySelector<HTMLInputElement>('[aria-label="New Sol hires start in fast mode"]')
    const luna=v.el.querySelector<HTMLInputElement>('[aria-label="New Luna hires start in fast mode"]')
    assert.ok(!!sol && !!luna,'supported tiers have separate controls')
    assert.equal(sol!.checked,true); assert.equal(luna!.checked,false,'absent defaults are OFF')
    assert.ok(!v.el.querySelector('[aria-label="New Astra hires start in fast mode"]'))
    await inAct(async()=>{sol!.click();await flush(2)})
    await inAct(async()=>{luna!.click();await flush(2)})
    const basic=[...v.el.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b=>b.textContent==='Basic')!
    await inAct(async()=>{basic.click();await flush(2)})
    const hire=[...v.el.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b=>b.textContent==='Hire defaults')!
    await inAct(async()=>{hire.click();await flush(2)})
    assert.equal(v.el.querySelector<HTMLInputElement>('[aria-label="New Sol hires start in fast mode"]')!.checked,false)
    assert.equal(v.el.querySelector<HTMLInputElement>('[aria-label="New Luna hires start in fast mode"]')!.checked,true)
    const save=[...v.el.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()==='save')!
    await inAct(async()=>{save.click();await flush(5)})
    assert.deepEqual(posted.at(-1)?.default_fast_mode,{sol:false,luna:true})
  } finally {await v.unmount();globalThis.fetch=original}
})
