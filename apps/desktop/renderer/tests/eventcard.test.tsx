import './harness'
import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { EventCard } from '../src/events/card'
import { FAMILIES } from '../src/generated/events'
declare const __SRC_DIR__: string
const directory = path.resolve(__SRC_DIR__, '../tests/fixtures/events')
const fixtures = readdirSync(directory).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(path.join(directory, f), 'utf8')))

test('operator and visitor render every canonical family with a type heading', async t => {
  for (const profile of ['operator', 'public'] as const) {
    const view = await mountView(<div>{fixtures.map(f => <EventCard key={f.variant} org="fixture" profile={profile}
      row={profile === 'operator' ? { ev: f.private, body: f.body } : { ev_public: f.public, body: f.body }} />)}</div>, h => h)
    t.after(() => view.unmount())
    assert.equal(view.el.querySelectorAll(':scope > div > [data-event-variant]').length, fixtures.length)
    assert.equal(view.el.querySelectorAll('.event-unsupported').length, 0)
    for (const family of FAMILIES) {
      const cards = view.el.querySelectorAll('.event-card.event-' + family)
      assert.ok(cards.length > 0, profile + ' ' + family)
      assert.ok(cards[0]!.querySelector('.event-head strong')!.textContent)
    }
  }
})

test('public reply renders allowed unique content and activates its qualified object link', async t => {
  const fixture = fixtures.find(f => f.variant === 'reply.document')
  const ev_public = { ...fixture.public, body: 'Allowed unique reply C', object: {
    kind: 'document', id: 'plan', title: 'Recorded plan title', node: 'agent' } }
  const opened: string[] = []
  const view = await mountView(<EventCard org="fixture" profile="public" row={{ ev_public, body: 'Full original body' }}
    world={{ org: 'fixture' }} onOpen={r => opened.push(r.ref.org + '/' + r.ref.id)} />, h => h)
  t.after(() => view.unmount())
  assert.equal(view.el.querySelector('.event-head strong')!.textContent, 'Presentation reply')
  assert.match(view.el.querySelector('.event-body')!.textContent!, /Allowed unique reply C/)
  assert.equal(view.el.querySelector('.event-card')!.classList.contains('event-linked_reply'), true)
  const link = view.el.querySelector('button.ref-chip') as HTMLButtonElement
  assert.ok(link, 'permitted object action exists')
  link.click(); assert.deepEqual(opened, ['fixture/plan'])
  assert.doesNotMatch(view.el.textContent!, /Full original body/)
})

test('public engine message shows system actor while user message shows User', async t => {
  const engine = fixtures.find(f => f.variant === 'runtime.ui_crash_report')
  const user = fixtures.find(f => f.variant === 'ordinary.message')
  const view = await mountView(<div>
    <EventCard org="fixture" profile="public" row={{ from: 'user', ev_public: engine.public }} />
    <EventCard org="fixture" profile="public" row={{ from: 'user', ev_public: { ...user.public, actor: { kind: 'user', id: 'user' } } }} />
  </div>, h => h)
  t.after(() => view.unmount())
  assert.equal(view.el.querySelector('[data-actor-kind="system"]')!.textContent, 'System')
  assert.equal(view.el.querySelector('[data-actor-kind="user"]')!.textContent, 'User')
  assert.doesNotMatch(view.el.textContent!, /report.stack|report.url/)
})


test('digest members keep typed family and permitted values without dumping canonical metadata', async t => {
  const digest=fixtures.find(f=>f.variant==='context.notice_digest')
  const lifecycle=fixtures.find(f=>f.variant==='lifecycle.retired')
  const model=fixtures.find(f=>f.variant==='context.org_charter')
  for(const profile of ['operator','public'] as const) {
    const key=profile==='operator'?'private':'public'
    const member={...lifecycle[key],freed:31.25}
    const ev={...digest[key],groups:[{variant:member.variant,object_kind:'node',members:[{at:'2026-09-06T01:02:03Z',event:member}]}]}
    const view=await mountView(<EventCard org="fixture" profile={profile} row={profile==='operator'?{ev}:{ev_public:ev}}/>,h=>h)
    t.after(()=>view.unmount())
    assert.equal(view.el.querySelectorAll('.event-lifecycle').length,1,'member uses its actual family')
    assert.match(view.el.textContent!,/31.25/,'unique retained value is readable')
    assert.match(view.el.textContent!,/2026-09-06T01:02:03Z/,'each occurrence keeps its time')
    assert.equal(view.el.querySelectorAll('[data-event-field="engine_authored"],[data-event-field="org"]').length,0)
    if(profile==='operator') {
      const hidden={...model.private,text:'MODEL_ONLY_SENTINEL'}
      const wrapped={...digest.private,groups:[{variant:hidden.variant,object_kind:'org',members:[{at:'now',event:hidden}]}]}
      const hiddenView=await mountView(<EventCard org="fixture" profile="operator" row={{ev:wrapped}}/>,h=>h)
      t.after(()=>hiddenView.unmount())
      assert.equal(hiddenView.el.querySelectorAll('[data-event-variant="context.org_charter"]').length,1)
      assert.doesNotMatch(hiddenView.el.textContent!,/MODEL_ONLY_SENTINEL/)
    }
  }
})


test('compact object headings retain permitted build and reference facts in context', async t => {
  const build=fixtures.find(f=>f.variant==='runtime.restart_notice')
  const node=fixtures.find(f=>f.variant==='lifecycle.retired')
  for(const profile of ['operator','public'] as const) {
    const key=profile==='operator'?'private':'public'
    const ev={...build[key],object:{...build[key].object,commit:'full-commit-C',short:'short-C',dirty:true,pid:424242}}
    const view=await mountView(<EventCard org="fixture" profile={profile} row={profile==='operator'?{ev}:{ev_public:ev}}/>,h=>h)
    t.after(()=>view.unmount())
    assert.match(view.el.querySelector('.event-head')!.textContent!,/short-C/)
    const context=view.el.querySelector('.event-context')!
    assert.match(context.textContent!,/full-commit-C/)
    assert.match(context.textContent!,/424242/)
    assert.equal(context.querySelector('[data-event-field="dirty"] dd')!.textContent,'Yes')
    const event={...node[key],object:{...node[key].object,generation:41}}
    const reference=await mountView(<EventCard org="fixture" profile={profile} row={profile==='operator'?{ev:event}:{ev_public:event}}/>,h=>h)
    t.after(()=>reference.unmount())
    assert.match(reference.el.querySelector('.event-object-details')!.textContent!,/41/)
    assert.equal(reference.el.querySelectorAll('.event-object-details [data-event-field="org"]').length,0)
  }
})


test('explicit received-mail fallback keeps the preview without classifying its prose',async t=>{
  const body='[DOCKET ASSIGNMENT] This is authored text, not typed metadata.'
  for(const profile of ['operator','public'] as const) for(const unsupported of [false,true]) {
    const row={body,...(unsupported?{ev_error:{code:'unknown'}}:{})}
    const view=await mountView(<EventCard org="fixture" profile={profile} row={row} preview/>,h=>h)
    t.after(()=>view.unmount())
    assert.equal(view.el.querySelectorAll('.event-fallback .turn-mail-preview').length,1)
    assert.ok(view.el.textContent!.includes(body))
    assert.equal(view.el.querySelectorAll('.event-assignment').length,0)
    assert.equal(view.el.querySelectorAll('.event-unsupported').length,unsupported?1:0)
  }
})
