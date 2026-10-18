import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { QuickChat } from '../src/QuickChatBox'
import { legacyAppBackend } from './appfeed-fixture'
import { linkifyRefs, refClickHandler, unlinkifyRefs } from '../src/canvas/refmd'
import { splitTypedRefs } from '../src/canvas/reflinks'
import { agentCopyEntry, ObjectMenuBoundary } from '../src/canvas/contextmenu'
import { AgentName } from '../src/canvas/identity'
import { HubContactChip, setHubchatInstalled, setKnownOrgs } from '../src/canvas/agentmentions'
import { ToolRefs } from '../src/canvas/toolrefs'
import { md } from '../src/canvas/shared'
import type { RefWorld } from '../src/canvas/reflinks'
import type { TreePayload } from '../src/types'

const world: RefWorld = {
  org:'org',
  agents:new Map([['worker-alpha','worker-alpha'],['worker-beta','worker-beta'],['worker-project','worker-project']]),
  tierOf:(id)=>id==='worker-project'?'project':'haiku',
}
const type = async (box:HTMLInputElement,value:string) => inAct(async()=>{
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(box,value)
  box.dispatchEvent(new window.Event('input',{bubbles:true}))
  box.setSelectionRange(value.length,value.length)
  box.dispatchEvent(new window.Event('select',{bubbles:true}))
  await flush(5)
})

test('agent and project mentions link in sanitized Markdown, preserve text, and use existing navigation',()=>{
  const host=document.createElement('div')
  host.innerHTML=md('Ask @worker-alpha and @worker-project; @unknown and worker-beta stay plain. `@worker-beta`\n\n```txt\n@worker-alpha\n```\n\n[email](mailto:a@worker-alpha.test) and a@worker-alpha.test').__html
  linkifyRefs(host,world)
  const chip=host.querySelector<HTMLButtonElement>('[data-agent-nav="worker-alpha"]')
  const projChip=host.querySelector<HTMLButtonElement>('[data-agent-nav="worker-project"]')
  assert.ok(chip,'known @name must use canonical agent link')
  assert.ok(projChip,'known @project must use canonical project link')
  assert.equal(projChip.querySelector('.project-mark')!==null,true,'project link chip shows folder icon')
  assert.equal(host.querySelectorAll('[data-agent-nav]').length,2)
  assert.equal(host.querySelector('code')?.textContent,'@worker-beta')
  assert.ok(host.textContent?.includes('@unknown'))
  const opened:string[]=[]
  host.addEventListener('click',refClickHandler(()=>world,r=>{opened.push(r.ref.id)}))
  chip.click()
  projChip.click()
  assert.deepEqual(opened,['worker-alpha','worker-project'])
  unlinkifyRefs(host)
  assert.ok(host.textContent?.includes('Ask @worker-alpha and @worker-project;'))
})

test('agent mentions update when the org index changes without decorating unknown names',()=>{
  const host=document.createElement('div');host.innerHTML=md('@worker-alpha @worker-beta @unknown').__html
  linkifyRefs(host,{...world,agents:new Map([['worker-alpha','worker-alpha']])})
  assert.equal(host.querySelectorAll('[data-agent-nav]').length,1,'first known mention links')
  linkifyRefs(host,world)
  assert.equal(host.querySelectorAll('[data-agent-nav]').length,2,'newly known mention links on same HTML')
  linkifyRefs(host,{...world,agents:new Map()})
  assert.equal(host.querySelectorAll('[data-agent-nav]').length,0)
  assert.equal(host.textContent?.trim(),'@worker-alpha @worker-beta @unknown')
})

test('plain message rendering shares @name identity and lossless boundaries with Markdown',()=>{
  const text='(@worker-alpha), @worker-project @worker-beta-x @unknown a@worker-alpha.test @agent:org/worker-beta'
  const runs=splitTypedRefs(text,world)
  assert.equal(runs.map(r=>r.text).join(''),text)
  assert.deepEqual(runs.filter(r=>r.ref).map(r=>r.ref!.ref.id),['worker-alpha','worker-project','worker-beta'])
})

test('Quick chat offers live agent and project mentions only after @ and Tab completes without sending',async t=>{
  const old=globalThis.fetch
  globalThis.fetch=legacyAppBackend((async()=>({ok:true,status:200,headers:new Headers(),json:async()=>({providers:[]})})) as typeof fetch)
  t.after(()=>{globalThis.fetch=old})
  const node=(id:string,state='live',kind='agent')=>({id,state,kind,tier:kind==='project'?'project':'haiku',children:[]})
  const tree={slug:'org',roots:[node('worker-alpha'),node('worker-beta'),node('worker-old','archived'),node('worker-project','live','project')]} as unknown as TreePayload
  let sent=0
  const view=await mountView(<QuickChat slug="org" tree={tree} op={async()=>{sent++;return {} as never}} toast={()=>{}} onHired={()=>{}}/>,h=>h)
  t.after(()=>view.unmount())
  const box=view.el.querySelector<HTMLInputElement>('.quickchat-input')!
  await type(box,'work')
  assert.equal(document.querySelector('.agent-mentions')===null,true,'bare names never open hints')
  await type(box,'Please ask @worker-')
  const list=document.querySelector('.agent-mentions')
  assert.ok(list,'@ prefix must open agent mentions')
  assert.ok(list.textContent?.includes('@worker-alpha'))
  assert.ok(list.textContent?.includes('@worker-project'))
  assert.equal(list.querySelector('.project-mark')!==null,true,'project hint shows folder icon')
  assert.ok(!list.textContent?.includes('@worker-old'))
  await inAct(async()=>{box.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));await flush(4)})
  assert.equal(box.value,'Please ask @worker-alpha ')
  assert.equal(sent,0)
})

test('both Copy agent name menu paths copy a mention while ticket copies stay unchanged',async t=>{
  const saved=Object.getOwnPropertyDescriptor(navigator,'clipboard'),writes:string[]=[]
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(s:string)=>{writes.push(s)}}})
  t.after(()=>{if(saved)Object.defineProperty(navigator,'clipboard',saved);else delete(navigator as {clipboard?:unknown}).clipboard})
  const el=document.createElement('button')
  agentCopyEntry(el,'worker-alpha').onSelect?.()
  await flush(3)
  assert.deepEqual(writes,['@worker-alpha'],'navigation marker copy produces @name')
  const view=await mountView(<ObjectMenuBoundary><AgentName id="worker-beta" tier="haiku"/></ObjectMenuBoundary>,h=>h)
  t.after(()=>view.unmount())
  await inAct(async()=>{view.el.querySelector('[data-copy-agent-name]')!.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));await flush(4)})
  const item=[...document.querySelectorAll<HTMLButtonElement>('.ctxmenu-item')].find(x=>x.textContent==='Copy agent name')!
  assert.ok(item)
  await inAct(async()=>{item.click();await flush(3)})
  assert.deepEqual(writes,['@worker-alpha','@worker-beta'])
})

test('@net: and @org: hub contacts render as links in Markdown, plain text, and tool chips with local org vs Hubchat routing',async t=>{
  setKnownOrgs(['local-org'])
  setHubchatInstalled(false)
  const openedUrls:string[]=[]
  const oldOpen=window.open
  window.open=((url?:string|URL)=>{openedUrls.push(String(url));return null}) as typeof window.open
  t.after(()=>{window.open=oldOpen;setKnownOrgs([]);setHubchatInstalled(false)})

  const host=document.createElement('div')
  host.innerHTML=md('Ping @org:local-org and @net:alice.77ded7 and @org:remote-org.').__html
  linkifyRefs(host,world)
  const localBtn=host.querySelector<HTMLButtonElement>('[data-hub-address="@org:local-org"]')!
  const netBtn=host.querySelector<HTMLButtonElement>('[data-hub-address="@net:alice.77ded7"]')!
  const remoteBtn=host.querySelector<HTMLButtonElement>('[data-hub-address="@org:remote-org"]')!
  assert.ok(localBtn&&netBtn&&remoteBtn,'all @net: and @org: tokens linkify')
  assert.equal(localBtn.getAttribute('aria-disabled'),null,'installed @org: is active even without Hubchat')
  assert.equal(netBtn.getAttribute('aria-disabled'),'true','@net: is inert when Hubchat is not installed')
  assert.equal(netBtn.title,"Hubchat isn't installed")
  assert.equal(remoteBtn.title,"Hubchat isn't installed")

  await inAct(async()=>{
    setHubchatInstalled(true)
    await flush(3)
  })
  linkifyRefs(host,world)
  const activeNetBtn=host.querySelector<HTMLButtonElement>('[data-hub-address="@net:alice.77ded7"]')!
  assert.equal(activeNetBtn.getAttribute('aria-disabled'),null)
  activeNetBtn.click()
  assert.deepEqual(openedUrls,['hubchat://chat?to=%40net%3Aalice.77ded7'])

  const view=await mountView(
    <div>
      <HubContactChip address="@net:bob.123456" />
      <ToolRefs refs={[{kind:'hub' as never,id:'@org:remote-org'}]} />
    </div>,
    h=>h,
  )
  t.after(()=>view.unmount())
  const toolChip=view.el.querySelector<HTMLButtonElement>('[data-hub-address="@org:remote-org"]')!
  assert.ok(toolChip,'ToolRefs renders hub contact chip')
  await inAct(async()=>{toolChip.click();await flush(2)})
  assert.deepEqual(openedUrls,['hubchat://chat?to=%40net%3Aalice.77ded7','hubchat://chat?to=%40org%3Aremote-org'])
})

