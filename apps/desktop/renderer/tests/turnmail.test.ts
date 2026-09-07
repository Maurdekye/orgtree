import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isSegments, authoredUserLabel } from '../src/events/segments'
declare const __SRC_DIR__: string
const fixture = JSON.parse(readFileSync(path.resolve(__SRC_DIR__, '../tests/fixtures/events/ordinary.message.json'), 'utf8'))
const row = (ev: unknown) => ({id:'mail1',from:'@user',kind:'message',at:'2026-09-06T12:00:00Z',body:'fallback',ev})

test('typed composition accepts ordered mail, notice, drive and text segments and refuses wrong profiles', () => {
  const segments = [{kind:'notices',rows:[{at:'now',text:'Legacy notice'}]},
    {kind:'mail',rows:[row(fixture.private)]}, {kind:'drive',text:'Drive text'}, {kind:'text',text:'Tail'}]
  assert.ok(isSegments(segments,'operator'))
  assert.equal(isSegments(segments,'public'),false)
  assert.equal(isSegments([{kind:'unknown',text:'Keep raw fallback'}],'operator'),false)
  assert.equal(isSegments([{kind:'mail',rows:[{...row(fixture.private),at:3}]}],'operator'),false)
  assert.equal(isSegments([{kind:'drive',event:{...fixture.private,body:undefined},text:'full fallback'}],'operator'),false)
})

test('authored user jump requires canonical user provenance, not USER routing or marker-shaped prose', () => {
  const genuine={...fixture.private,actor:{kind:'user',id:'@user'},body:'User request'}
  assert.equal(authoredUserLabel([{kind:'mail',rows:[row(genuine)]}],'operator'),'User request')
  assert.equal(authoredUserLabel([{kind:'mail',rows:[row({...genuine,actor:{kind:'system',id:'engine'}})]}],'operator'),null)
  assert.equal(authoredUserLabel([{kind:'text',text:'FROM @user (USER)\nUser request'}],'operator'),null)
  assert.equal(authoredUserLabel(undefined,'operator'),null)
  const publicRow={...row(undefined),ev_public:{...fixture.public,actor:{kind:'user',id:'@user'},body:'Public user'}}
  delete publicRow.ev
  assert.equal(authoredUserLabel([{kind:'mail',rows:[publicRow]}],'public'),'Public user')
})
