import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {pinModal,unpinModal,commitModalRect,readModalPins,forgetModalPins,forgetModalOpenCache,rememberModalOpen,modalPinKey,isModalPinned,MODAL_PINS_KEY} from '../src/canvas/modalpin'

test('org modal geometry and pin state remain independent across reloads',()=>{
  localStorage.clear();forgetModalPins();forgetModalOpenCache()
  const a={x:10,y:20,w:500,h:400}, b={x:80,y:90,w:600,h:420}
  pinModal('inbox',a,'a');pinModal('inbox',b,'b')
  commitModalRect('inbox',{...a,x:25},'a');forgetModalPins()
  assert.equal(readModalPins()[modalPinKey('inbox','a')].rect.x,25)
  assert.deepEqual(readModalPins()[modalPinKey('inbox','b')].rect,b)
  assert.equal(isModalPinned('inbox','c'),false)
  unpinModal('inbox','a');forgetModalPins()
  assert.equal(isModalPinned('inbox','a'),false);assert.equal(isModalPinned('inbox','b'),true)
})

test('legacy pin adoption is limited to its recorded org and does not resurrect an unpin',()=>{
  localStorage.clear();forgetModalPins();forgetModalOpenCache()
  rememberModalOpen('docket','old')
  localStorage.setItem(MODAL_PINS_KEY,JSON.stringify({docket:{rect:{x:10,y:20,w:500,h:400},z:0}}))
  forgetModalPins()
  assert.equal(isModalPinned('docket','old'),true)
  assert.equal(isModalPinned('docket','new'),false)
  unpinModal('docket','old');forgetModalPins()
  assert.equal(isModalPinned('docket','old'),false)
})
