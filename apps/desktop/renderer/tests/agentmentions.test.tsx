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

test('@user attention row shows one word-boundary excerpt and clicking it removes it, switches the attention desk, and highlights the mention',async t=>{
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
  // one excerpt, not the two centred cut-out halves it replaced (user 2026-10-18 14:39Z)
  assert.equal(rowEl.querySelector('.l2 .mail-preview-text')?.textContent,'All checks passed — @user ready for your inspection.')
  assert.equal(rowEl.querySelector('.attn-mention-token')?.textContent,'@user')

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

import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import { agentTooltipInfo } from '../src/canvas/OrgCanvas'
import { AgentLink, NodeLink, ProjectLink, createNodeLinkEl, nodeMenuAction, ticketOwnerAction } from '../src/canvas/identity'
import { userMentionClass } from '../src/canvas/desk'

test('inline single- and multi-backtick code spans and fenced blocks never parse or mangle @<name> or mentions',()=>{
  const raw='Write `@<name>` or `` `@worker-alpha` `` or `@user` or `@net:alice.77ded7`, then real @worker-alpha and @worker-project.\n\n```ts\nconst s = "@worker-alpha @<name> @user"\n```'
  const host=document.createElement('div')
  host.innerHTML=md(raw).__html
  linkifyRefs(host,world)

  const codes=[...host.querySelectorAll('code')].map(c=>c.textContent)
  assert.ok(codes.includes('@<name>'),'`@<name>` in code span must stay intact without angle-escaping mangling')
  assert.ok(codes.includes('`@worker-alpha`'),'multi-backtick code span must stay intact')
  for(const codeEl of host.querySelectorAll('code, pre')){
    assert.equal(codeEl.querySelector('.ref-chip')===null,true,'no ref-chip may be created inside code or pre')
    assert.equal(codeEl.querySelector('[data-agent-nav]')===null,true,'no agent nav chip inside code or pre')
  }
  const chips=[...host.querySelectorAll<HTMLElement>('.ref-chip[data-agent-nav]')]
  assert.deepEqual(chips.map(c=>c.getAttribute('data-agent-nav')),['worker-alpha','worker-project'])

  const runs=splitTypedRefs('In code: `@<name>` and `` `@worker-alpha` `` and `@agent:org/worker-beta`, outside: @worker-alpha',world)
  assert.deepEqual(runs.filter(r=>r.ref).map(r=>r.ref!.ref.id),['worker-alpha'],'splitTypedRefs skips inline backtick code spans')

  assert.equal(userMentionClass('assistant','Use `@user` in your reply'),'',
    '@user inside inline code span does not trigger mention-highlight')
  assert.equal(userMentionClass('assistant','```md\n@user\n```'),'',
    '@user inside fenced code block does not trigger mention-highlight')
  assert.equal(userMentionClass('assistant','See `@user` and then @user here'),' mention-highlight',
    'real @user outside code spans still triggers mention-highlight')
})

test('agent and project mentions share the rich tooltip and shared NodeLink base across DOM and React',async t=>{
  const alphaNode={
    id:'worker-alpha',state:'live',tier:'sol',model_id:'gpt-5.4',effort_effective:'high',
    children:[],seat:1,grant:0,free:0,scope:{tools:{},add_dirs:[]},
  } as unknown as CanvasNode
  const projNode={
    id:'worker-project',state:'live',kind:'project',tier:'project',charter:'Build slot coordination\nMore details',
    children:[],seat:0,grant:0,free:0,configured_scope:{slots_capacity:2},scope:{slots:2,tools:{},add_dirs:[]},
  } as unknown as CanvasNode
  const map=new Map<string,CanvasNode>([[alphaNode.id,alphaNode],[projNode.id,projNode]])
  const providers=[{id:'openai',tiers:[{tier:'sol',display_name:'GPT-5.4'}]}] as never

  const alphaTip=agentTooltipInfo(alphaNode,providers,null,'high')
  const projTip=agentTooltipInfo(projNode,providers,null,'high')
  assert.equal(alphaTip?.title,'GPT-5.4 · high')
  assert.equal(projTip?.title,'Project · 2 slots · Build slot coordination')

  function Host(){
    useProvideAgentNav(()=>[],id=>agentTooltipInfo(map.get(id),providers,null,'high'))
    return (
      <div>
        <AgentLink id="worker-alpha" tier="sol" label="@worker-alpha" onFocus={()=>{}} />
        <ProjectLink id="worker-project" label="@worker-project" onFocus={()=>{}} />
        <div className="md-host" />
      </div>
    )
  }
  const view=await mountView(<AgentNavProvider><Host /></AgentNavProvider>,h=>h)
  t.after(()=>view.unmount())
  await flush(2)

  const mdHost=view.el.querySelector<HTMLElement>('.md-host')!
  mdHost.innerHTML=md('Ping @worker-alpha and @worker-project').__html
  linkifyRefs(mdHost,{
    org:'org',
    agents:new Map([['worker-alpha','worker-alpha'],['worker-project','worker-project']]),
    tierOf:id=>map.get(id)?.kind==='project'?'project':map.get(id)?.tier,
  })

  for(const el of view.el.querySelectorAll<HTMLElement>('[data-agent-tooltip="worker-alpha"]')){
    await inAct(()=>{el.dispatchEvent(new window.MouseEvent('pointerover',{bubbles:true}))})
    assert.equal(el.title,'GPT-5.4 · high','agent mention and AgentLink show rich model tooltip on hover')
  }
  for(const el of view.el.querySelectorAll<HTMLElement>('[data-agent-tooltip="worker-project"]')){
    await inAct(()=>{el.dispatchEvent(new window.MouseEvent('pointerover',{bubbles:true}))})
    assert.equal(el.title,'Project · 2 slots · Build slot coordination','project mention and ProjectLink show rich project tooltip on hover')
    const svg=el.querySelector('.project-mark svg')
    assert.ok(svg,'project link renders folder SVG')
    assert.equal(svg.getAttribute('fill'),'currentColor','project folder SVG uses currentColor for org theme tint')
  }

  const domNode=createNodeLinkEl(document,{id:'worker-alpha',tier:'sol',label:'@worker-alpha',className:'ref-chip ref-agent',live:true})
  assert.equal(domNode.getAttribute('data-agent-tooltip'),'worker-alpha')
  assert.equal(domNode.getAttribute('data-agent-nav'),'worker-alpha')
  assert.equal(domNode.getAttribute('data-copy-agent-name'),'worker-alpha')
  assert.equal(nodeMenuAction,ticketOwnerAction.length>=0?nodeMenuAction:nodeMenuAction)
  const menuEntry=nodeMenuAction('Owner…',domNode,'worker-alpha',[{label:'Focus on canvas',onSelect:()=>{}}])
  assert.equal(menuEntry?.agentTooltipId,'worker-alpha')
})

test('@ suggestion list supports Up/Down highlight + scrollIntoView, Enter/Tab completion, and Escape close',async t=>{
  const old=globalThis.fetch
  globalThis.fetch=legacyAppBackend((async()=>({ok:true,status:200,headers:new Headers(),json:async()=>({providers:[]})})) as typeof fetch)
  t.after(()=>{globalThis.fetch=old})
  const node=(id:string,state='live',kind='agent')=>({id,state,kind,tier:kind==='project'?'project':'haiku',children:[]})
  const tree={slug:'org',roots:[node('worker-alpha'),node('worker-beta'),node('worker-project','live','project')]} as unknown as TreePayload
  let sent=0
  const scrolled:Element[]=[]
  const origScroll=window.HTMLElement.prototype.scrollIntoView
  window.HTMLElement.prototype.scrollIntoView=function(){scrolled.push(this)}
  t.after(()=>{window.HTMLElement.prototype.scrollIntoView=origScroll})

  const view=await mountView(<QuickChat slug="org" tree={tree} op={async()=>{sent++;return {} as never}} toast={()=>{}} onHired={()=>{}}/>,h=>h)
  t.after(()=>view.unmount())
  const box=view.el.querySelector<HTMLInputElement>('.quickchat-input')!

  await type(box,'Hi @worker-')
  let items=[...document.querySelectorAll<HTMLElement>('.agent-mention-item')]
  assert.equal(items.length,3)
  assert.equal(items[0]!.getAttribute('aria-selected'),'true')

  const downEv=new window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true})
  await inAct(async()=>{box.dispatchEvent(downEv);await flush(3)})
  assert.equal(downEv.defaultPrevented,true,'ArrowDown prevents default cursor movement')
  items=[...document.querySelectorAll<HTMLElement>('.agent-mention-item')]
  assert.equal(items[1]!.getAttribute('aria-selected'),'true','ArrowDown moves highlight to second item')
  assert.ok(scrolled.includes(items[1]!), 'ArrowDown scrolls active suggestion into view')

  const upEv=new window.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true})
  await inAct(async()=>{box.dispatchEvent(upEv);await flush(3)})
  assert.equal(upEv.defaultPrevented,true,'ArrowUp prevents default cursor movement')
  items=[...document.querySelectorAll<HTMLElement>('.agent-mention-item')]
  assert.equal(items[0]!.getAttribute('aria-selected'),'true','ArrowUp moves highlight back to first item')

  const escEv=new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})
  await inAct(async()=>{box.dispatchEvent(escEv);await flush(3)})
  assert.equal(escEv.defaultPrevented,true,'Escape prevents default')
  assert.equal(document.querySelector('.agent-mentions')===null,true,'Escape closes suggestion list')

  await type(box,'Hi @worker-b')
  assert.ok(document.querySelector('.agent-mentions'),'typing further reopens suggestion list')
  const enterEv=new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})
  await inAct(async()=>{box.dispatchEvent(enterEv);await flush(3)})
  assert.equal(enterEv.defaultPrevented,true,'Enter completes highlighted suggestion instead of submitting')
  assert.equal(box.value,'Hi @worker-beta ')
  assert.equal(sent,0,'Enter while suggestion list is open does not submit composer')
})

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { AgentGalleryView } from '../src/canvas/gallery'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { refreshConvo, resetConvos } from '../src/convo'
import { FakeServer, installFetch } from './harness'
import { installGalleryFixture } from './galleryrows-fixture'

declare const __SRC_DIR__: string

test('agent and project mentions are white with no underline at rest, underlined in agent accent on hover/focus, inbox headers keep 4px badge-to-name spacing without settings button padding, and project presentations show presenter model badge',async t=>{
  const css=readFileSync(path.join(__SRC_DIR__,'styles.css'),'utf8')
  const styleEl=document.createElement('style')
  styleEl.textContent=css
  document.head.appendChild(styleEl)
  t.after(()=>styleEl.remove())

  installGalleryFixture()
  const v=await mountView(
    <div className="settings wide">
      <div className="desk-body prov-claude">
        <AgentLink id="worker-alpha" tier="sol" label="@worker-alpha" onFocus={()=>{}} />
        <ProjectLink id="worker-project" label="@worker-project" onFocus={()=>{}} />
        <AgentLink id="worker-here" tier="haiku" label="@worker-here" atDestination onFocus={()=>{}} />
      </div>
      <div className="mailer-head event-head">
        <span className="event-family">·</span>
        <strong>Message</strong>
        <span className="event-actor">
          <AgentName id="coordinator-opus" tier="opus" onFocus={()=>{}} />
        </span>
      </div>
      <AgentGalleryView slug="synthetic" nid="test-project"
        node={{id:'test-project',kind:'project'} as never}
        toast={()=>{}} onFocusAgent={()=>{}} initialDocument="project" />
    </div>,
    h=>h,
  )
  t.after(()=>v.unmount())
  await flush(5)

  const agentChip=v.el.querySelector<HTMLButtonElement>('button.ref-chip.ref-agent[data-agent-nav="worker-alpha"]')!
  const projChip=v.el.querySelector<HTMLButtonElement>('button.ref-chip.ref-agent[data-agent-nav="worker-project"]')!
  const hereChip=v.el.querySelector<HTMLElement>('span.ref-chip.ref-agent.ref-here')!
  assert.ok(agentChip&&projChip&&hereChip,'agent, project, and atDestination mention chips render')

  // 1. Resting state: white (--ink-strong), no underline
  assert.equal(window.getComputedStyle(agentChip).color,'var(--ink-strong)','agent mention is white at rest')
  assert.equal(window.getComputedStyle(agentChip).textDecoration,'none','agent mention has no underline at rest')
  assert.equal(window.getComputedStyle(projChip).color,'var(--ink-strong)','project mention text is white at rest')
  assert.equal(window.getComputedStyle(projChip).textDecoration,'none','project mention has no underline at rest')
  assert.equal(window.getComputedStyle(hereChip).color,'var(--ink-strong)','atDestination mention is white at rest')
  assert.equal(window.getComputedStyle(hereChip).textDecoration,'none','atDestination mention has no underline at rest')
  const projMark=projChip.querySelector<HTMLElement>('.project-mark')!
  assert.match(window.getComputedStyle(projMark).color,/--org-accent/,'project folder icon keeps org theme colour')

  // 2. Focus/hover state: switches to --agent-accent-text with underline
  // (mutate a data attribute after focus() so jsdom invalidates document._styleCache)
  agentChip.focus(); agentChip.setAttribute('data-focused','1')
  assert.match(window.getComputedStyle(agentChip).color,/--agent-accent-text/,'focused agent mention takes agent accent color')
  assert.equal(window.getComputedStyle(agentChip).textDecoration,'underline','focused agent mention is underlined')
  projChip.focus(); projChip.setAttribute('data-focused','1')
  assert.match(window.getComputedStyle(projChip).color,/--agent-accent-text/,'focused project mention takes agent accent color')
  assert.equal(window.getComputedStyle(projChip).textDecoration,'underline','focused project mention is underlined')
  projChip.blur()

  // 3. Agent inbox header inside .settings: no 15px button padding on .cc-name, and 4px badge-to-name gap
  const headerActor=v.el.querySelector<HTMLElement>('.mailer-head .event-actor')!
  const headerName=headerActor.querySelector<HTMLButtonElement>('button.cc-name')!
  assert.equal(window.getComputedStyle(headerActor).gap,'4px','sender header uses 4px badge-to-name gap')
  assert.equal(window.getComputedStyle(headerName).padding,'0px','sender header button.cc-name resets .settings button padding')

  // 4. Project presentation PresentedBy footer renders model badge beside presenting agent link,
  // and global Presentations list rows render 16x16 model badges via the shared AgentName/.event-actor component
  const presentedBy=v.el.querySelector<HTMLElement>('.doc-pane-head .doc-presented-by')!
  assert.ok(presentedBy,'project presentation renders PresentedBy line')
  const presenterBadge=presentedBy.querySelector<HTMLElement>('.tier.t-sol')
  assert.ok(presenterBadge,'PresentedBy renders presenting agent model badge')
  assert.equal(presenterBadge.textContent,'S')
  assert.equal(window.getComputedStyle(presenterBadge).width,'16px','PresentedBy model badge is 16px wide')
  const presenterBtn=presentedBy.querySelector<HTMLButtonElement>('button.cc-name')!
  assert.equal(presenterBtn.textContent,'test-proj-worker-c')
  assert.equal(window.getComputedStyle(presenterBtn).padding,'0px','PresentedBy agent link has no extra button padding')

  const rowActor=v.el.querySelector<HTMLElement>('.doc-gallery-row .l2 .event-actor')!
  const rowBadge=rowActor.querySelector<HTMLElement>('.tier')!
  const rowOwner=rowActor.querySelector<HTMLElement>('span.cc-name.doc-row-owner')!
  assert.ok(rowActor&&rowBadge&&rowOwner,'global presentations list row renders shared AgentName inside .event-actor')
  assert.equal(window.getComputedStyle(rowActor).gap,'4px','global presentations list row uses 4px badge-to-name gap')
  assert.equal(window.getComputedStyle(rowBadge).width,'16px','global presentations list row model badge is 16px wide')
  assert.equal(window.getComputedStyle(rowBadge).height,'16px','global presentations list row model badge is 16px tall')
})

function ProvideNav({children}:{children:import('react').ReactNode}) {
  useProvideAgentNav(id=>[
    {label:'View Agent',onSelect:()=>{}},
    {label:`Copy "${id}"`,onSelect:()=>{}},
  ])
  return children
}

test('right-clicking an agent mention inside a transcript message or transcript mail card opens the agent menu without highlighting the containing message or card',async t=>{
  localStorage.clear(); resetConvos()
  const mkCNode=(id:string,tier='sol'):CanvasNode=>({
    id,generation:1,state:'live',tier,children:[],seat:1,grant:0,free:0,scope:{tools:{},add_dirs:[]},
  } as unknown as CanvasNode)
  const alphaNode=mkCNode('worker-alpha','sol')
  const betaNode=mkCNode('worker-beta','haiku')
  const leadNode=mkCNode('lead','opus')
  const server=new FakeServer()
  server.messages=[
    {role:'assistant',text:'Ping @worker-beta for review.',seq:0,event_id:'reply-1'},
  ]
  server.pending_mail=[
    {id:'m1',event_id:'mail-1',from:'lead',body:'Hello @worker-beta',at:'2026-10-18T14:00:00Z'},
  ]
  installFetch(server)
  const nodeMap=new Map<string,CanvasNode>([
    [alphaNode.id,alphaNode],
    [betaNode.id,betaNode],
    [leadNode.id,leadNode],
  ])
  const v=await mountView(
    <AgentNavProvider>
      <ProvideNav>
        <DeskChat node={alphaNode} map={nodeMap} slug="org" op={async()=>({})} toast={()=>{}} bare
          onJump={()=>{}} />
      </ProvideNav>
    </AgentNavProvider>,
    h=>h,
  )
  t.after(async()=>{await v.unmount();resetConvos()})
  await inAct(async()=>{await refreshConvo('org','worker-alpha');await flush(5)})

  // 1. Transcript message body mention right-click & non-primary mousedown
  const msg=v.el.querySelector<HTMLElement>('[data-transcript-row][data-reply-event="reply-1"]')!
  const msgMention=msg.querySelector<HTMLElement>('[data-agent-nav="worker-beta"]')!
  assert.ok(msg&&msgMention,'transcript message and inner @worker-beta mention exist')

  let bubbleDown=false
  msg.addEventListener('mousedown',()=>{bubbleDown=true},{once:true})
  await inAct(async()=>{
    msgMention.dispatchEvent(new window.MouseEvent('mousedown',{bubbles:true,cancelable:true,button:2}))
    msgMention.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:80,clientY:80}))
    await flush(3)
  })
  assert.equal(bubbleDown,false,'right-button mousedown on agent mention does not bubble to containing message')
  assert.equal(msg.classList.contains('ctx-target'),false,'containing transcript message is not highlighted with .ctx-target when inner mention is right-clicked')
  const menuItems=[...document.querySelectorAll('.ctxmenu [role="menuitem"]')].map(n=>n.textContent)
  assert.ok(menuItems.includes('View Agent'),'agent context menu opened on mention right-click')

  await inAct(async()=>{
    document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))
    await flush(2)
  })

  // 2. Transcript mail card (.turn-mail) header agent link right-click
  const mailRow=v.el.querySelector<HTMLElement>('[data-reply-event="mail-1"]')!
  const mailCard=v.el.querySelector<HTMLElement>('.turn-mail')!
  const mailActor=mailCard.querySelector<HTMLElement>('[data-agent-nav="lead"]')!
  assert.ok(mailRow&&mailCard&&mailActor,'transcript mail card and sender agent link exist')
  await inAct(async()=>{
    mailActor.dispatchEvent(new window.MouseEvent('mousedown',{bubbles:true,cancelable:true,button:2}))
    mailActor.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:90,clientY:90}))
    await flush(3)
  })
  assert.equal(mailRow.classList.contains('ctx-target'),false,'containing transcript mail row is not highlighted with .ctx-target when sender mention is right-clicked')
  assert.equal(mailCard.classList.contains('ctx-target'),false,'containing transcript mail card is not highlighted with .ctx-target when sender mention is right-clicked')
})


