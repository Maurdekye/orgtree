import type {AppPlacement,CustomPanel} from './types'
import {clampRect,type PinRect} from '../pins'
import type {CanvasBox} from '../pinspace'

/** The engine's smallest panel (wire::dimensions); a window pin never shrinks below it. */
export const PANEL_MIN={width:160,height:120}
/** A window pin's displayed box, in canvas-area pixels like pinned desks and
 *  kept inside the measured area: at render, so a window resize never strands
 *  a panel, and again at commit. */
export const windowRect=(p:Pick<AppPlacement,'x'|'y'|'width'|'height'>,bounds:CanvasBox|null):PinRect=>clampRect({x:p.x,y:p.y,w:p.width,h:p.height},bounds,PANEL_MIN)
/** The eight resize handles an app panel shows, named as the pinned desks' (modalpin.tsx EDGES). */
export const PANEL_EDGES=['n','s','e','w','ne','nw','se','sw'] as const
export type PanelEdge=typeof PANEL_EDGES[number]
/** One resize gesture's result: the dragged side follows the pointer, the opposite side stays put, and the minimum pins the
 *  opposite side (shrinking past it from the west/north never walks the panel). A CENTERED float panel grows both ways, so
 *  its dragged edge moves at twice the pointer's pace to stay under it; its x/y are unused and untouched. */
export function resizePlacement<T extends Pick<AppPlacement,'x'|'y'|'width'|'height'>>(p:T,edge:PanelEdge,dx:number,dy:number,centered:boolean):T{
  const k=centered?2:1,clamp=(v:number,min:number)=>Math.max(min,Math.min(4096,v))
  let {x,y,width,height}=p
  if(edge.includes('e'))width=p.width+k*dx
  if(edge.includes('w'))width=p.width-k*dx
  if(edge.includes('s'))height=p.height+k*dy
  if(edge.includes('n'))height=p.height-k*dy
  width=Math.round(clamp(width,PANEL_MIN.width));height=Math.round(clamp(height,PANEL_MIN.height))
  if(!centered){
    if(edge.includes('w'))x=p.x+p.width-width
    if(edge.includes('n'))y=p.y+p.height-height
  }
  return {...p,x,y,width,height}
}
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
