import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { isEvent } from '../src/events/decode'
import { eventSummary, projectEvent } from '../src/events/project'
import { humanValue } from '../src/events/value'
import type { HumanValue } from '../src/events/value'
import { FAMILIES, MANIFEST } from '../src/generated/events'
declare const __SRC_DIR__: string
const directory = path.resolve(__SRC_DIR__, '../tests/fixtures/events')
const fixtures = readdirSync(directory).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(path.join(directory, f), 'utf8')))
test('every canonical leaf places all and only its human fields', () => {
  const covered = new Set<string>()
  for (const f of fixtures) {
    assert.ok(isEvent(f.private))
    for (const event of [f.private]) {
      const view = projectEvent(event); covered.add(view.family)
      assert.equal(view.family, f.family)
      assert.ok(view.title.length > 0)
      const expected = Object.entries(MANIFEST.leaves[event.variant].fields)
        .filter(([key, field]) => !['v','variant','actor','object','engine_authored'].includes(key)
          && ['both','human_only'].includes(field.disposition) && Object.hasOwn(event,key)).map(([key]) => key).sort()
      assert.deepEqual(view.fields.map(field=>field.key).sort(), expected, event.variant)
      for (const field of view.fields) assert.ok(field.label && ['header','body','context'].includes(field.placement))
    }
  }
  assert.deepEqual([...covered].sort(), [...FAMILIES].sort())
})


test('all generated human field types have a recursive value presentation', () => {
  let values=0, nestedEvents=0
  function check(value:HumanValue) {
    values++
    assert.notEqual(value.kind,'unavailable','known schema fields must render')
    if(value.kind==='list') value.items.forEach(check)
    if(value.kind==='record') value.fields.forEach(f=>check(f.value))
    if(value.kind==='event') { nestedEvents++; for(const f of projectEvent(value.event).fields)
      check(humanValue(f.value,f.type,'operator')) }
  }
  for(const f of fixtures) {
    const event=f.private
    assert.ok(isEvent(event))
    for(const field of projectEvent(event).fields) check(humanValue(field.value,field.type,'operator'))
  }
  assert.ok(values>100,'positive control: fields were actually visited')
  assert.ok(nestedEvents>=1,'nested events were visited')
  assert.equal(humanValue({hidden:'never'},'N:NotDeclared','operator').kind,'unavailable','unknown record cannot dump its fields')
})


test('nested answer summaries and bodyless decisions give usable preview labels',()=>{
  for(const f of fixtures) assert.ok(eventSummary(f.private).trim(),f.variant)
  const f=fixtures.find(f=>f.variant==='answer.batch')
  const event={...f.private,actor:{kind:'user',id:'user'},sections:[{kind:'ask',ask_id:'request1',questions:[{label:null,question:'Which option?',answer:'Chosen answer C'}]}]}
  assert.ok(isEvent(event))
  assert.match(eventSummary(event),/Chosen answer C/)
})
