import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { CurrentOrg } from '../src/popout'
import { PinFrame, forgetModalPins, modalPinKey, pinModal, readModalPins } from '../src/canvas/modalpin'
import { usePinSurface, readPinSurfaces } from '../src/canvas/pinspace'
import { ModalOverlapSettings, MODAL_OVERLAP_KEY } from '../src/canvas/pinoverlap'

function DeskPeer() {
  usePinSurface('org','worker',{x:400,y:0,w:400,h:400},false)
  return null
}
test('org pin uses canvas coordinates, snaps to a desk peer, and joins its stacking band', async () => {
  localStorage.clear(); forgetModalPins()
  const canvas = document.createElement('div'); canvas.dataset.pinOrg='org'; canvas.style.border='0'
  canvas.getBoundingClientRect=()=>({x:30,y:80,left:30,top:80,right:1030,bottom:780,width:1000,height:700,toJSON(){}})
  document.body.appendChild(canvas)
  pinModal('docket',{x:0,y:0,w:390,h:400},'org')
  const v=await mountView(<CurrentOrg.Provider value="org"><DeskPeer/><PinFrame kind="docket" title="Work" panel="settings test-pin" close={()=>{}}><input defaultValue="draft"/></PinFrame></CurrentOrg.Provider>,el=>el)
  const proto=window.HTMLElement.prototype
  const capture=proto.setPointerCapture, release=proto.releasePointerCapture
  proto.setPointerCapture=()=>{}; proto.releasePointerCapture=()=>{}
  try {
    await inAct(async()=>{await flush()})
    const panel=document.querySelector<HTMLElement>('.test-pin')!
    const overlay=panel.parentElement!
    assert.equal(overlay.style.left,'30px'); assert.equal(overlay.style.top,'80px')
    assert.equal(overlay.style.width,'1000px'); assert.equal(overlay.style.height,'700px')
    assert.ok(Number.isInteger(Number(overlay.style.zIndex)))
    assert.ok(overlay.closest('.pin-layer'), 'integer ranks stay inside the shared stacking context')
    assert.equal(readPinSurfaces().filter(p=>p.org==='org').length,2)
    const input=panel.querySelector('input')!
    const bar=panel.querySelector('.modalpin-bar')!
    const pointer=async(type:string,x:number)=>inAct(()=>bar.dispatchEvent(new window.PointerEvent(type,{bubbles:true,button:0,pointerId:1,clientX:x,clientY:100})))
    await pointer('pointerdown',40); await pointer('pointermove',45)
    assert.ok(overlay.querySelector('.pin-snap-preview'), 'drag near peer shows the shared snap preview')
    await pointer('pointerup',45)
    assert.equal(readModalPins()[modalPinKey('docket','org')]!.rect.x,10, 'right edge lands exactly on the peer left edge')
    assert.equal(panel.querySelector('input'),input,'draft node remains mounted through the move')
    assert.equal(input.value,'draft')
  } finally {await v.unmount(); canvas.remove(); proto.setPointerCapture=capture; proto.releasePointerCapture=release; forgetModalPins()}
})
test('global dialogs have no pin or popout controls and overlap fading defaults off', async () => {
  localStorage.clear(); forgetModalPins()
  const v=await mountView(<CurrentOrg.Provider value="org"><ModalOverlapSettings/>{['app-settings','advanced-org','defaults'].map(kind=><PinFrame key={kind} kind={kind} title={kind} panel="global-fixture" close={()=>{}}>content</PinFrame>)}</CurrentOrg.Provider>,el=>el)
  try {
    assert.equal(v.el.querySelectorAll('.global-fixture').length,3,'all global dialogs rendered')
    assert.equal(v.el.querySelectorAll('.modalpin-btn').length,0)
    assert.equal(v.el.querySelectorAll('.popout-btn').length,0)
    const toggle=v.el.querySelector<HTMLInputElement>('input[type=checkbox]')!
    assert.equal(toggle.checked,false)
    await inAct(()=>toggle.click())
    assert.equal(toggle.checked,true)
    assert.equal(JSON.parse(localStorage.getItem(MODAL_OVERLAP_KEY)!).enabled,true)
  } finally {await v.unmount()}
})
