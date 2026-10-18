import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { QuickChat } from '../src/QuickChatBox'
import { legacyAppBackend } from './appfeed-fixture'
import { linkifyRefs, refClickHandler, unlinkifyRefs } from '../src/canvas/refmd'
import { mailRefTarget, splitTypedRefs } from '../src/canvas/reflinks'
import { agentCopyEntry, ObjectMenuBoundary } from '../src/canvas/contextmenu'
import { AgentName } from '../src/canvas/identity'
import {
  clearMentionHighlight, dismissUserMention, hasUnseenUserMention, HubContactChip,
  resetSeenMentions, setHubchatInstalled, setKnownOrgs, useMentionHighlight,
} from '../src/canvas/agentmentions'
import { AttentionQueue } from '../src/attention/AttentionQueue'
import { buildAttentionRows, countRows, splitMentionBlurb } from '../src/attention/feed'
import { attentionLayout, forgetAttentionMode } from '../src/attention/mode'
import { ToolRefs } from '../src/canvas/toolrefs'
import { md } from '../src/canvas/shared'
import type { RefWorld } from '../src/canvas/reflinks'
import type { TreeNode, TreePayload } from '../src/types'

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

import { ProjectSquare } from '../src/canvas/projectcard'
import { ProjectDesk } from '../src/canvas/projectdesk'
import type { CanvasNode, OpResult } from '../src/canvas/shared'

test('Copy mention menu paths copy @mention on agents and projects while ticket copies stay unchanged',async t=>{
  const saved=Object.getOwnPropertyDescriptor(navigator,'clipboard'),writes:string[]=[],toasts:string[][]=[]
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(s:string)=>{writes.push(s)}}})
  t.after(()=>{if(saved)Object.defineProperty(navigator,'clipboard',saved);else delete(navigator as {clipboard?:unknown}).clipboard})
  const el=document.createElement('button')
  const navCopy=agentCopyEntry(el,'worker-alpha',lines=>toasts.push(lines??[]))
  assert.equal(navCopy.label,'Copy mention')
  navCopy.onSelect?.()
  await flush(3)
  assert.deepEqual(writes,['@worker-alpha'],'navigation marker copy produces @name')
  assert.deepEqual(toasts,[['copied mention']])
  const projNode={id:'worker-project',title:'worker-project',kind:'project',state:'live',tier:'project',model_id:'',
    seat:0,grant:0,free:0,scope:{tools:{},add_dirs:[]},charter:'desc',children:[],lineage:[],turns:[],audiences_held:[],mail_pending:0} as unknown as CanvasNode
  const view=await mountView(
    <ObjectMenuBoundary toast={lines=>toasts.push(lines??[])}>
      <AgentName id="worker-beta" tier="haiku"/>
      <ProjectSquare node={projNode} pos={{x:0,y:0}} lod="norm" dragging={false} isDrop={false}
        op={()=>Promise.resolve({} as OpResult)} slug="org" toast={lines=>toasts.push(lines??[])} zoom={2}
        hire={{}} seats={{}} onHire={()=>{}} onInbox={()=>{}} onNewProject={()=>{}}
        onDragStart={()=>{}} onDragMove={()=>{}} onDragEnd={()=>{}} onDragCancel={()=>{}} />
      <ProjectDesk node={projNode} slug="org" tree={{slug:'org',roots:[]} as unknown as TreePayload}
        map={new Map([[projNode.id,projNode]])} op={()=>Promise.resolve({} as OpResult)}
        toast={lines=>toasts.push(lines??[])} refs={{world,onOpen:()=>{}}} />
    </ObjectMenuBoundary>,h=>h)
  t.after(()=>view.unmount())
  for(const target of [
    view.el.querySelector('.cc-name[data-copy-agent-name="worker-beta"]')!,
    view.el.querySelector('.sq.project[data-copy-agent-name="worker-project"]')!,
    view.el.querySelector('.project-desk .cc-head-left[data-copy-agent-name="worker-project"]')!,
  ]){
    await inAct(async()=>{target.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true}));await flush(4)})
    const items=[...document.querySelectorAll<HTMLButtonElement>('.ctxmenu-item')].map(x=>x.textContent)
    assert.equal(items.includes('Copy agent name'),false,'old Copy agent name label is gone')
    const item=[...document.querySelectorAll<HTMLButtonElement>('.ctxmenu-item')].find(x=>x.textContent==='Copy mention')!
    assert.ok(item,`expected Copy mention in ${JSON.stringify(items)}`)
    await inAct(async()=>{item.click();await flush(3)})
  }
  assert.equal(view.el.querySelector('.project-desk .cc-head-left')?.getAttribute('data-agent-nav'),'worker-project',
    'project desk header carries data-agent-nav for canonical menu parity')
  assert.deepEqual(writes,['@worker-alpha','@worker-beta','@worker-project','@worker-project'])
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

test('@user renders as a link that opens the user Inbox and preserves @user text on copy',()=>{
  const host=document.createElement('div')
  host.innerHTML=md('Heads up @user — build finished, see `@user` in code.').__html
  linkifyRefs(host,world)
  const userChip=host.querySelector<HTMLButtonElement>('button.ref-chip.ref-mail[data-ref-token="@user"]')!
  assert.ok(userChip,'@user must render as an active mail ref chip')
  assert.equal(userChip.textContent,'@user')
  assert.equal(userChip.title,"open the user's inbox")
  const opened:Array<{id:string;to:string}>=[]
  host.addEventListener('click',refClickHandler(()=>world,r=>{opened.push(mailRefTarget(r.ref))}))
  userChip.click()
  assert.deepEqual(opened,[{id:'@user',to:'user_inbox'}])
  unlinkifyRefs(host)
  assert.ok(host.textContent?.includes('Heads up @user — build finished'))
})

test('@user attention row shows centered cut-out blurb and clicking it removes it, switches the attention desk, and highlights the mention',async t=>{
  resetSeenMentions()
  forgetAttentionMode()
  const seenPosts:Array<{url:string;body:string}>=[]
  const oldFetch=globalThis.fetch
  globalThis.fetch=legacyAppBackend((async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input)
    if(url.endsWith('/mention-seen')){
      seenPosts.push({url,body:String(init?.body??'')})
      return {ok:true,status:200,headers:new Headers(),json:async()=>({ok:true})}
    }
    if(url.includes('/work-items')){
      return {ok:true,status:200,headers:new Headers(),json:async()=>({items:[],archived:[],backlogged:[]})}
    }
    if(url.includes('/inbox')){
      return {ok:true,status:200,headers:new Headers(),json:async()=>({pending:[],archive:[]})}
    }
    return {ok:true,status:200,headers:new Headers(),json:async()=>({})}
  }) as typeof fetch)
  t.after(()=>{
    globalThis.fetch=oldFetch
    resetSeenMentions()
    forgetAttentionMode()
  })

  const cut=splitMentionBlurb('…finished the verification pass; @user please check the summary card…')
  assert.equal(cut.before,'…finished the verification pass; ')
  assert.equal(cut.token,'@user')
  assert.equal(cut.after,' please check the summary card…')

  const mentionNode={
    id:'worker-alpha',
    state:'live',
    tier:'haiku',
    children:[],
    user_mention:{
      id:'1:0',
      turn_id:1,
      seq:0,
      event_id:'ev-mention-1',
      blurb:'All checks passed — @user ready for your inspection.',
      at:'2026-10-18T01:00:00Z',
    },
  } as unknown as TreeNode
  assert.equal(hasUnseenUserMention(mentionNode,'org'),true,'node has unseen @user mention before dismissal')

  const built=buildAttentionRows({nodes:[mentionNode],slug:'org'})
  assert.equal(built.length,1)
  assert.equal(built[0]!.kind,'mention')
  assert.equal(countRows(built).mention,1)

  const tree={slug:'org',roots:[mentionNode],asks:[]} as unknown as TreePayload
  const focusedAgents:string[]=[]
  function Probe(){
    const hl=useMentionHighlight('org','worker-alpha')
    return (
      <div>
        <AttentionQueue slug="org" tree={tree} toast={()=>{}}
          onFocusAgent={id=>focusedAgents.push(id)}
          treeStatus={{loading:false,stale:false,unavailable:false}} />
        <div data-probe-highlight={hl?`${hl.mentionId}:${hl.eventId??''}`:''} />
      </div>
    )
  }
  const view=await mountView(<Probe />,h=>h)
  t.after(()=>view.unmount())
  await flush(6)

  const rowEl=view.el.querySelector<HTMLElement>('[data-attn-kind="mention"] .attn-mention-row')
  assert.ok(rowEl,'mention row renders in AttentionQueue')
  assert.equal(rowEl.querySelector('.attn-mention-before')?.textContent,'All checks passed — ')
  assert.equal(rowEl.querySelector('.attn-mention-token')?.textContent,'@user')
  assert.equal(rowEl.querySelector('.attn-mention-after')?.textContent,' ready for your inspection.')

  await inAct(async()=>{
    rowEl.click()
    await flush(5)
  })
  assert.equal(view.el.querySelector('[data-attn-kind="mention"]')===null,true,'clicking mention row removes it immediately')
  assert.equal(hasUnseenUserMention(mentionNode,'org'),false,'glow state clears immediately when mention is seen')
  assert.deepEqual(focusedAgents,['worker-alpha'],'clicking mention row focuses the mentioning agent')
  assert.equal(attentionLayout('org').agent,'worker-alpha','clicking mention row switches the attention desk to that agent')
  assert.equal(view.el.querySelector('[data-probe-highlight]')?.getAttribute('data-probe-highlight'),'1:0:ev-mention-1')
  assert.equal(seenPosts.length,1)
  assert.ok(seenPosts[0]!.url.endsWith('/api/orgs/org/nodes/worker-alpha/mention-seen'))
  clearMentionHighlight('org','worker-alpha')
})

