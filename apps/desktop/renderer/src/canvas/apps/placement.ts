import type {AppPlacement,CustomPanel} from './types'
import {clampRect,type PinRect} from '../pins'
import type {CanvasBox} from '../pinspace'

/** The engine's smallest panel (wire::dimensions); a window pin never shrinks below it. */
export const PANEL_MIN={width:160,height:120}
/** A window pin's displayed box, in canvas-area pixels like pinned desks and
 *  kept inside the measured area: at render, so a window resize never strands
 *  a panel, and again at commit. */
export const windowRect=(p:Pick<AppPlacement,'x'|'y'|'width'|'height'>,bounds:CanvasBox|null):PinRect=>clampRect({x:p.x,y:p.y,w:p.width,h:p.height},bounds,PANEL_MIN)
/** float is the ordinary centered modal. The pin pins a panel to the window
 * where it is, at its size (user 2026-10-26: "i meant pin it to the window like
 * other pinned panels"); canvas pins were removed ("Remove canvas pinning").
 * `shown` is the panel's measured box in window pixels and `bounds` its org's
 * canvas area; a panel that was never laid out pins in the middle of the area. */
export function appPlacement(panel:CustomPanel,mode:AppPlacement['mode'],shown:DOMRect|null=null,bounds:CanvasBox|null=null):AppPlacement{
  const p={...panel.placement,mode}
  if(mode!=='window'||panel.placement.mode==='window')return p
  const m=shown&&shown.width>0&&shown.height>0?shown:null
  const r=windowRect(m?{x:m.left-(bounds?.x??0),y:m.top-(bounds?.y??0),width:m.width,height:m.height}
    :{x:bounds?(bounds.w-p.width)/2:60,y:bounds?(bounds.h-p.height)/2:60,width:p.width,height:p.height},bounds)
  return {...p,x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.w),height:Math.round(r.h)}
}
