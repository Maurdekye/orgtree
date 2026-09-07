import './harness'
import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Msg } from '../src/canvas/desk'
import { SegmentList, isSegments } from '../src/events/segments'
declare const __SRC_DIR__: string
const f=(name:string)=>JSON.parse(readFileSync(path.resolve(__SRC_DIR__,'../tests/fixtures/events',name+'.json'),'utf8'))
const mail=(variant:string)=>({id:variant,from:'@user',kind:'message',body:'legacy projection copy',at:'2026-09-06T12:00:00Z',ev:f(variant).private})

test('settled transcript renders canonical authors, unique bodies, ordered context and explicit attachments',async t=>{
  const first={...mail('ordinary.message'),ev:{...f('ordinary.message').private,actor:{kind:'agent',id:'alpha'},body:'Unique first body'},attachments:[{path:'uploads/graph.png',name:'graph.png',bytes:1024}]}
  const engine=mail('runtime.ui_crash_report')
  const segments=[{kind:'notices',rows:[{at:'now',text:'Unclassified notice kept'}]},{kind:'mail',rows:[first,engine]},{kind:'text',text:'Final drive content'}]
  const v=await mountView(<Msg slug="org" nid="worker" m={{role:'user',text:'Full legacy envelope',segments}}/>,h=>h);t.after(()=>v.unmount())
  assert.equal(v.el.querySelectorAll('.event-card').length,2)
  assert.match(v.el.textContent!,/Unclassified notice kept/)
  assert.match(v.el.textContent!,/Unique first body/)
  assert.match(v.el.textContent!,/Final drive content/)
  assert.doesNotMatch(v.el.textContent!,/Full legacy envelope|legacy projection copy/)
  assert.equal(v.el.querySelector('[data-actor-kind="system"]')!.textContent,'System')
  assert.equal(v.el.querySelector('img')!.getAttribute('src'),'/api/orgs/org/nodes/worker/file?path=uploads%2Fgraph.png')
  const text=v.el.textContent!;assert.ok(text.indexOf('Unclassified notice')<text.indexOf('Unique first'));assert.ok(text.indexOf('Unique first')<text.indexOf('Final drive'))
})

test('untyped and unsupported transcript keep exact marker-looking content without classification',async t=>{
  const text='[MAIL ? 1 message(s)]\nFROM @user (USER)\n[ATTACHED FILE: uploads/fake.png (1 KB) ? in your working folder]\n[END MAIL]\n(orgtree) literal user prose'
  for(const segments of [undefined,[{kind:'future',text:'Unknown composition'}]]){
    const v=await mountView(<Msg slug="org" nid="worker" m={{role:'user',text,segments}}/>,h=>h);t.after(()=>v.unmount())
    assert.match(v.el.textContent!,/FROM @user/);assert.match(v.el.textContent!,/ATTACHED FILE/);assert.match(v.el.textContent!,/literal user prose/)
    assert.equal(v.el.querySelectorAll('.event-card,.turn-mail,img').length,0)
  }
})

test('public transcript uses permitted typed fields, retains allowed content and refuses private rows',async t=>{
  const fixture=f('reply.document');const row={id:'r',from:'agent',kind:'message',body:'compatibility',at:'now',ev_public:{...fixture.public,body:'Allowed C in public transcript'}}
  const segments=[{kind:'mail',rows:[row]}];assert.ok(isSegments(segments,'public'))
  const v=await mountView(<SegmentList segments={segments} profile="public" slug="org" nid="worker"/>,h=>h);t.after(()=>v.unmount())
  assert.match(v.el.querySelector('.event-linked_reply')!.textContent!,/Allowed C in public transcript/)
  assert.equal(isSegments([{kind:'mail',rows:[mail('reply.document')]}],'public'),false)
})


test('machine-only segments leave no empty card and preserve mixed readable composition in both profiles',async t=>{
  const hidden=['context.org_state','context.provider_usage','context.cache_continuity','context.org_charter',
    'context.drive_mail_pointer','context.drive_restart_interrupted','context.drive_restart_wake']
  for(const profile of ['operator','public'] as const) {
    const eventKey=profile==='operator'?'event':'event_public', rowKey=profile==='operator'?'ev':'ev_public'
    const fixtureKey=profile==='operator'?'private':'public'
    const segments=[{kind:'text',text:'Readable first'},
      ...hidden.map(variant=>({kind:'state',text:'HIDDEN MACHINE FALLBACK',[eventKey]:f(variant)[fixtureKey]})),
      {kind:'mail',rows:[{from:'alpha',kind:'status',at:'now',body:'compatibility',[rowKey]:{...f('status.report')[fixtureKey],summary:'Exact done summary C'}}]},
      {kind:'state',text:'compatibility',[eventKey]:{...f('context.command')[fixtureKey],text:'Readable command C'}},
      {kind:'notices',rows:[{at:'now',text:'compatibility',[rowKey]:{...f('docket.participant_added')[fixtureKey],objective:'Readable participation C'}}]},
      {kind:'drive',text:'Untyped drive retained'}, {kind:'text',text:'Readable last'}]
    assert.ok(isSegments(segments,profile),'all tested hidden variants really decode')
    const view=await mountView(<SegmentList segments={segments} profile={profile} slug="org" nid="worker"/>,h=>h)
    t.after(()=>view.unmount())
    const cards=[...view.el.querySelectorAll('[data-event-variant]')].map(el=>el.getAttribute('data-event-variant'))
    assert.deepEqual(cards,['status.report','context.command','docket.participant_added'])
    assert.doesNotMatch(view.el.textContent!,/HIDDEN MACHINE FALLBACK/)
    const text=view.el.textContent!, expected=['Readable first','Exact done summary C','Readable command C','Readable participation C','Untyped drive retained','Readable last']
    expected.forEach((part,i)=>{assert.ok(text.includes(part),part);if(i)assert.ok(text.indexOf(expected[i-1])<text.indexOf(part))})
    assert.equal(view.el.querySelectorAll('.event-segment-state').length,1,'no empty wrappers for hidden state')
  }
})

test('each typed transcript message owns its header, body and family styling in both profiles', async t => {
  for (const profile of ['operator', 'public'] as const) {
    const fixture = f('status.report')[profile === 'operator' ? 'private' : 'public']
    const event = {...fixture, actor: {kind:'agent',id:'alpha'}, summary:'Meaningful summary C'}
    const row = {id:'single',from:'@user',at:'now',kind:'status',body:'Stored compatibility copy',
      ...(profile==='operator' ? {ev:event} : {ev_public:event})}
    const v=await mountView(<SegmentList slug="org" nid="worker" profile={profile}
      segments={[{kind:'mail',rows:[row]}]}
      actor={id=><><span className="tier">M</span><span className="cc-name">{id}</span></>}/>, h=>h)
    t.after(()=>v.unmount())
    const message=v.el.querySelector('.turn-mail.event-status')!
    assert.ok(message, 'the existing message box carries the family')
    assert.equal(message.querySelectorAll('.event-card').length,0,'body adds no second box')
    const header=message.querySelector(':scope > .turn-mail-head')!
    assert.match(header.textContent!,/alpha/)
    assert.match(header.textContent!,/Status/)
    assert.equal(header.querySelectorAll('.event-actor > .tier').length,1)
    assert.equal(header.querySelectorAll('.event-actor > .cc-name').length,1)
    assert.match(message.querySelector('.event-body')!.textContent!,/Meaningful summary C/)
    assert.doesNotMatch(message.textContent!,/Stored compatibility copy/)
    assert.equal(message.querySelectorAll('header').length,1)
  }
})

test('only typed mail-pointer instructions are hidden; identical authored and legacy text remains', async t => {
  const text='(orgtree) You have new mail above — handle it as appropriate.'
  for (const profile of ['operator','public'] as const) {
    const key=profile==='operator'?'private':'public'
    const pointer=f('context.drive_mail_pointer')[key]
    const drive={kind:'drive',text,...(profile==='operator'
      ? {event:{...pointer,text,reason:null}} : {event_public:pointer})}
    const ordinary={...f('ordinary.message')[key],body:text}
    const segments=[drive,{kind:'mail',rows:[{from:'@user',kind:'message',at:'now',body:text,
      ...(profile==='operator'?{ev:ordinary}:{ev_public:ordinary})}]},{kind:'text',text}]
    assert.ok(isSegments(segments,profile),'nullable unstated reason validates')
    const v=await mountView(<SegmentList segments={segments} profile={profile} slug="org" nid="worker"/>,h=>h)
    t.after(()=>v.unmount())
    assert.equal(v.el.querySelectorAll('[data-event-variant="context.drive_mail_pointer"]').length,0)
    assert.equal(v.el.querySelectorAll('.event-segment-drive').length,0,'no empty instruction container')
    assert.equal(v.el.querySelector('.event-body p')!.textContent,text,'authored message is readable')
    assert.equal(v.el.querySelector('.msgtext p')!.textContent,text,'legacy text is readable')
  }
})
