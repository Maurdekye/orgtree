import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView, inAct, flush } from './harness'
import { DeskDogsProvider, DogChip, WatchdogRow } from '../src/canvas/deskdogs'
import { ToolRefs } from '../src/canvas/toolrefs'
import type { Watchdog } from '../src/types'
import { WatchdogLink } from '../src/canvas/watchdoglink'
import { WatchdogSatellite } from '../src/canvas/watchdogchip'
import { MailListenersView } from '../src/canvas/maillisteners'
import { mailListenerState } from '../src/canvas/listeners'
import type { CanvasNode } from '../src/canvas/shared'
import { HistoryDog } from '../src/canvas/historydog'
import { ObjectNavProvider } from '../src/canvas/objectnav'
import { ObjectNavHost } from '../src/canvas/objectnavhost'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'
import { EventCard } from '../src/events/card'
import type { KnownEvent } from '../src/events/types'

test('watchdog satellite, desk and destination offer the identical canonical object menu', async t => {
  const opened: string[] = []
  const v = await mountView(<ObjectNavProvider>
    <ObjectNavHost org="demo" dogs={[dog]} openDog={id => opened.push(id)} toast={() => {}} />
    <DeskDogsProvider value={{ org: 'demo', dogs: [dog], open: id => opened.push(id) }}>
      <ObjectMenuBoundary>
        <WatchdogSatellite dog={dog} dogs={[dog]} org="demo" onOpen={id => opened.push(id)} />
        <DogChip dog={dog} onOpen={id => opened.push(id)} />
        <WatchdogLink dog={dog} atDestination />
        <WatchdogRow id={dog.id}>watch</WatchdogRow>
      </ObjectMenuBoundary>
    </DeskDogsProvider>
  </ObjectNavProvider>, el => el)
  t.after(() => v.unmount())
  let expected: string[] | undefined
  for (const identity of v.el.querySelectorAll('[data-object-id]')) {
    await inAct(() => identity.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))
    await flush()
    const menu = document.querySelector('.ctxmenu:not(.ctxmenu-submenu)')!
    const entries = [...menu.children].flatMap(child => child.getAttribute('role') === 'separator' ? ['sep']
      : child.classList.contains('ctxmenu-branch') ? [child.querySelector('[role="menuitem"]')!.textContent!.trim()] : [])
    expected ??= entries
    assert.deepEqual(entries, expected)
    assert.ok(entries.includes('Open details'))
    assert.ok(entries.includes('Pause'))
  }
  assert.deepEqual(opened, [], 'opening menus executes no dog action')
})

test('known watchdog hover text is identical on satellite, name, desk, tool, history, row and destination', async t => {
  const clock = Date.now
  const now = 1_800_000_000_000
  Date.now = () => now
  t.after(() => { Date.now = clock })
  for (const state of ['armed', 'paused', 'spent']) {
    const w: Watchdog = { ...dog, kind: 'command', state, spent: state === 'spent', interval_s: 60,
      next_check_at: new Date(now + 60000).toISOString() }
    const v = await mountView(<DeskDogsProvider value={{ org: 'demo', dogs: [w], open: () => {} }}>
      <WatchdogSatellite dog={w} dogs={[w]} org="demo" onOpen={() => {}} />
      <DogChip dog={w} onOpen={() => {}} />
      <ToolRefs refs={[{ kind: 'watchdog', id: 'watch' }]} owner="worker" org="demo" agent={id => id} />
      <HistoryDog dog={{ id: w.id, owner: w.owner, name: w.name, kind: w.kind, once: w.once, gone: w.spent }} />
      <WatchdogLink dog={w} atDestination />
      <WatchdogRow id={w.id}><span>watch</span></WatchdogRow>
    </DeskDogsProvider>, el => el)
    try {
      const expected = v.el.querySelector<HTMLElement>('.watchdog-link')!.title
      const identities = [...v.el.querySelectorAll<HTMLElement>('.wd-chip, .wd-name > span, .watchdog-link, [data-object-id]')]
      assert.ok(identities.length >= 6)
      for (const identity of identities) assert.equal(identity.title, expected, `${state}: ${identity.className}`)
      assert.doesNotMatch(expected, /click for detail/)
      assert.match(expected, /watch/)
      assert.match(expected, /command/)
      assert.match(expected, /fires once/)
      if (state === 'armed') assert.match(expected, /next check in 1:00/)
      else assert.doesNotMatch(expected, /next check/)
    } finally { await v.unmount() }
  }
})

const dog: Watchdog = {id:'worker/watch',owner:'worker',name:'watch',kind:'listener_watch',target:'build',count:2,
  once:true,state:'armed',at:'2026-10-19T00:00:00Z',fired:0,interval_s:30}

test('desk cards use the shared watchdog link and retain their detail action',async t=>{
  const opened:string[]=[]
  const v=await mountView(<DeskDogsProvider value={{org:'demo',dogs:[dog],open:id=>opened.push(id)}}>
    <DogChip dog={dog} onOpen={id=>opened.push(id)}/></DeskDogsProvider>,el=>el)
  t.after(()=>v.unmount())
  const chip=v.el.querySelector<HTMLElement>('.watchdog-link')
  assert.ok(!!chip,'desk watchdog is a shared link')
  assert.ok(chip!.classList.contains('listener-watch'))
  assert.ok(chip!.classList.contains('oneshot'))
  assert.equal(chip!.getAttribute('data-object-org'),'demo')
  await inAct(async()=>chip!.click())
  assert.deepEqual(opened,[dog.id])
})

test('tool watchdog links resolve metadata from the current org and update on changes',async t=>{
  const refs=[{kind:'watchdog' as const,id:'watch'}]
  const show=(w:Watchdog,org='demo')=><DeskDogsProvider value={{org,dogs:[w],open:()=>{}}}>
    <ToolRefs refs={refs} owner="worker" org="demo" agent={id=>id}/></DeskDogsProvider>
  const v=await mountView(show(dog),el=>el);t.after(()=>v.unmount())
  assert.ok(!!v.el.querySelector('.watchdog-link.listener-watch.oneshot'))
  await v.render(show({...dog,kind:'fair_queue',once:false}))
  assert.ok(!!v.el.querySelector('.watchdog-link.fair-queue:not(.oneshot)'))
  await v.render(show(dog,'other'))
  assert.equal(v.el.querySelector('.watchdog-link.listener-watch')===null,true,'foreign registry metadata must not bleed into this org')
})

test('missing watchdog metadata keeps a neutral shared chip without inventing its kind',async t=>{
  const v=await mountView(<DeskDogsProvider value={{org:'demo',dogs:[],open:()=>{throw Error('gone dog opened')}}}>
    <ToolRefs refs={[{kind:'watchdog',id:'gone'}]} owner="worker" org="demo" agent={id=>id}/>
  </DeskDogsProvider>,el=>el);t.after(()=>v.unmount())
  const chip=v.el.querySelector('.watchdog-link')
  assert.ok(!!chip,'gone links use the same component')
  assert.equal(chip!.classList.contains('listener'),false)
  assert.equal(chip!.classList.contains('oneshot'),false)
  assert.match(chip!.textContent??'',/gone/)
  assert.equal(chip!.tagName,'SPAN')
})

test('a handle beyond a partial preview keeps its exact detail and menu route',async t=>{
  const opened:string[]=[]
  const v=await mountView(<DeskDogsProvider value={{org:'demo',dogs:[],counts:{worker:{total:33,kept:33,one_shot:0}},open:id=>opened.push(id)}}>
    <ToolRefs refs={[{kind:'watchdog',id:'later'}]} owner="worker" org="demo" agent={id=>id}/>
  </DeskDogsProvider>,el=>el);t.after(()=>v.unmount())
  const chip=v.el.querySelector<HTMLElement>('.watchdog-link')!
  assert.equal(chip.tagName,'BUTTON')
  assert.equal(chip.dataset.objectId,'worker/later')
  assert.equal(chip.dataset.objectOrg,'demo')
  assert.equal(chip.classList.contains('listener-watch'),false,'unknown metadata stays neutral')
  await inAct(async()=>chip.click())
  assert.deepEqual(opened,['worker/later'])
})

test('each kind and lifetime uses the same icon and perimeter classes in links and cards',async t=>{
  const kinds:Watchdog['kind'][]=['command','event','mqtt','websocket','slot','fair_queue','project_listener','listener_watch']
  for(const kind of kinds)for(const once of [false,true]){
    const w={...dog,kind,once}
    const v=await mountView(<><WatchdogSatellite dog={w} dogs={[w]} org="demo" onOpen={()=>{}}/>
      <WatchdogLink dog={w} onOpen={()=>{}}/></>,el=>el)
    try{
      const [card,link]=[v.el.querySelector('.wd-chip')!,v.el.querySelector('.watchdog-link')!]
      assert.equal(link.querySelector('.wd-glyph')!.textContent,card.querySelector('.wd-glyph')!.textContent)
      for(const cls of ['slot','fair-queue','listener','listener-watch','websocket','oneshot'])assert.equal(link.classList.contains(cls),card.classList.contains(cls),kind+' '+cls)
      assert.match(link.getAttribute('title')??'',once?/fires once/:/continuous/)
    }finally{await v.unmount()}
  }
})

test('at the watchdog destination the chip keeps its menu without reopening the panel',async t=>{
  const v=await mountView(<WatchdogLink dog={dog} org="demo" atDestination onOpen={()=>{throw Error('destination reopened')}}/>,el=>el)
  t.after(()=>v.unmount())
  const chip=v.el.querySelector<HTMLElement>('.watchdog-link')!
  assert.equal(chip.tagName,'SPAN')
  assert.equal(chip.getAttribute('data-object-id'),dog.id)
  await inAct(async()=>chip.click())
})

test('mail listener mode is conveyed by the chip and tooltip without a trailing mode word',async t=>{
  const w={...dog,kind:'fair_queue' as const}
  const v=await mountView(<MailListenersView node={{id:'build',state:'live'} as CanvasNode}
    state={mailListenerState('build',[w])} map={new Map()} rows={[]} ack={false}/>,el=>el)
  t.after(()=>v.unmount())
  const cell=v.el.querySelector('.listener-dog-cell')!
  assert.ok(!!cell.querySelector('.watchdog-link.oneshot'))
  assert.equal(cell.querySelector('.dim')===null,true,'no duplicate mode word beside the chip')
  assert.match(cell.querySelector('.watchdog-link')!.getAttribute('title')??'',/fires once/)
})

// websocket watchdogs (docs/rust-engine/websocket-watchdogs.md): their own violet
// outline class and a two-way glyph while armed (coordinator 2026-10-19 21:14Z)
test('a websocket dog has its own outline class and a two-way glyph in links and cards',async t=>{
  const w:Watchdog={...dog,kind:'websocket',once:false,target:'wss://ha.local/api/websocket'}
  for(const [state,glyph] of [['armed','⇄'],['paused','◫']] as const){
    const v=await mountView(<><WatchdogSatellite dog={{...w,state}} dogs={[w]} org="demo" onOpen={()=>{}}/>
      <WatchdogLink dog={{...w,state}} onOpen={()=>{}}/></>,el=>el)
    try{
      for(const chip of [v.el.querySelector('.wd-chip')!,v.el.querySelector('.watchdog-link')!]){
        assert.ok(chip.classList.contains('websocket'),chip.className)
        assert.ok(!chip.classList.contains('listener'),chip.className)
        assert.equal(chip.querySelector('.wd-glyph')!.textContent,glyph)
      }
    }finally{await v.unmount()}
  }
})


test('tool-call row and Monitor event card render the identical live and gone watchdog chip, tooltip and menu', async t => {
  const clock = Date.now
  const now = 1_800_000_000_000
  Date.now = () => now
  t.after(() => { Date.now = clock })
  const liveDog: Watchdog = {
    id: 'worker/marchpup-full-sdk', owner: 'worker', name: 'marchpup-full-sdk', kind: 'command',
    target: 'echo build ok', once: true, state: 'armed', spent: false,
    at: '2026-10-29T00:00:00Z', fired: 0, interval_s: 60,
    next_check_at: new Date(now + 60000).toISOString(),
  }
  const spentDog: Watchdog = {
    ...liveDog, id: 'worker/spent-sdk', name: 'spent-sdk', state: 'spent', spent: true, fired: 1,
    next_check_at: undefined,
  }
  const fireEvent = (id: string, name: string): KnownEvent => ({
    v: 1, variant: 'monitor.watchdog_fired', engine_authored: true,
    actor: { kind: 'watchdog', id },
    object: { kind: 'watchdog', org: 'demo', id, owner: 'worker', name },
    prefix: 'WATCHDOG', lines: ['Marchpup SDK build finished'], once: true, count: 1,
  })
  const opened: string[] = []
  const dogs = [liveDog, spentDog]
  const v = await mountView(<ObjectNavProvider>
    <ObjectNavHost org="demo" dogs={dogs} openDog={id => opened.push(id)} toast={() => {}} />
    <DeskDogsProvider value={{ org: 'demo', dogs, open: id => opened.push(id) }}>
      <ObjectMenuBoundary>
        <div className="tool-live"><ToolRefs refs={[{ kind: 'watchdog', id: 'marchpup-full-sdk' }]} owner="worker" org="demo" agent={id => id} /></div>
        <div className="card-live"><EventCard org="demo" profile="operator" row={{ ev: fireEvent(liveDog.id, liveDog.name), body: 'Marchpup SDK build finished' }} preview /></div>
        <div className="tool-gone"><ToolRefs refs={[{ kind: 'watchdog', id: 'removed-sdk' }]} owner="worker" org="demo" agent={id => id} /></div>
        <div className="card-gone"><EventCard org="demo" profile="operator" row={{ ev: fireEvent('worker/removed-sdk', 'removed-sdk'), body: 'Marchpup SDK build finished' }} preview /></div>
        <div className="tool-spent"><ToolRefs refs={[{ kind: 'watchdog', id: 'spent-sdk' }]} owner="worker" org="demo" agent={id => id} /></div>
        <div className="card-spent"><EventCard org="demo" profile="operator" row={{ ev: fireEvent(spentDog.id, spentDog.name), body: 'Marchpup SDK build finished' }} preview /></div>
      </ObjectMenuBoundary>
    </DeskDogsProvider>
  </ObjectNavProvider>, el => el)
  t.after(() => v.unmount())

  const menuLabels = async (el: Element) => {
    await inAct(() => el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 10, clientY: 10 })))
    await flush()
    return [...document.querySelectorAll('.ctxmenu:not(.ctxmenu-submenu) [role="menuitem"]')].map(item => item.textContent?.trim())
  }

  for (const [kind, name] of [['gone', 'removed-sdk'], ['spent', 'spent-sdk']] as const) {
    const toolChip = v.el.querySelector<HTMLElement>(`.tool-${kind} .watchdog-link`)!
    const cardChip = v.el.querySelector<HTMLElement>(`.card-${kind} .watchdog-link`)!
    assert.equal(toolChip.tagName, 'SPAN', `${kind} tool chip is non-interactive`)
    assert.equal(cardChip.tagName, 'SPAN', `${kind} card chip is non-interactive`)
    assert.equal(toolChip.classList.contains('gone'), true, `${kind} tool chip carries .gone`)
    assert.equal(cardChip.classList.contains('gone'), true, `${kind} card chip carries .gone`)
    assert.equal(toolChip.classList.contains('spent'), true, `${kind} tool chip carries .spent`)
    assert.equal(cardChip.classList.contains('spent'), true, `${kind} card chip carries .spent`)
    assert.equal(toolChip.getAttribute('aria-disabled'), 'true')
    assert.equal(cardChip.getAttribute('aria-disabled'), 'true')
    assert.equal(toolChip.querySelector('.wd-glyph')!.textContent, '✕')
    assert.equal(cardChip.querySelector('.wd-glyph')!.textContent, '✕')
    assert.equal(toolChip.querySelector('.watchdog-link-name')!.textContent, name)
    assert.equal(cardChip.querySelector('.watchdog-link-name')!.textContent, name)
    assert.equal(toolChip.textContent, `✕${name} (no longer exists)`)
    assert.equal(cardChip.textContent, toolChip.textContent)
    assert.equal(toolChip.title, cardChip.title)
    assert.match(toolChip.title, /no longer exists/i)
    assert.deepEqual(await menuLabels(toolChip), ['Watchdog no longer exists', 'Copy watchdog name', 'Copy watchdog id'])
    assert.deepEqual(await menuLabels(cardChip), ['Watchdog no longer exists', 'Copy watchdog name', 'Copy watchdog id'])
    await inAct(async () => { toolChip.click(); cardChip.click() })
    assert.deepEqual(opened, [], `${kind} chips never open a detail modal`)
  }

  const toolLive = v.el.querySelector<HTMLElement>('.tool-live .watchdog-link')!
  const cardLive = v.el.querySelector<HTMLElement>('.card-live .watchdog-link')!
  assert.equal(toolLive.tagName, 'BUTTON')
  assert.equal(cardLive.tagName, 'BUTTON')
  assert.equal(toolLive.classList.contains('armed'), true)
  assert.equal(cardLive.classList.contains('armed'), true)
  assert.equal(toolLive.classList.contains('gone'), false)
  assert.equal(cardLive.classList.contains('gone'), false)
  assert.equal(toolLive.querySelector('.wd-glyph')!.textContent, cardLive.querySelector('.wd-glyph')!.textContent)
  assert.equal(toolLive.querySelector('.watchdog-link-name')!.textContent, 'marchpup-full-sdk')
  assert.equal(cardLive.querySelector('.watchdog-link-name')!.textContent, 'marchpup-full-sdk')
  assert.equal(toolLive.textContent, cardLive.textContent)
  assert.equal(toolLive.title, cardLive.title)
  assert.deepEqual(await menuLabels(toolLive), await menuLabels(cardLive))
  await inAct(async () => { toolLive.click(); cardLive.click() })
  assert.deepEqual(opened, [liveDog.id, liveDog.id])
})
