import type {AppPlacement,CustomPanel} from './types'
export const appCanvases=new Map<string,{center:(w:number,h:number)=>{x:number;y:number};focus:(p:{x:number;y:number})=>void}>()
/** float is the ordinary centered modal; persisted coordinates belong to canvas
 * pins. Screen pins were removed (user 2026-10-26: "only canvas pin"). */
export function appPlacement(slug:string,panel:CustomPanel,mode:AppPlacement['mode']):AppPlacement{
  const p={...panel.placement,mode,anchor:mode==='canvas'?panel.placement.anchor:null}
  if(mode==='canvas'&&panel.placement.mode!=='canvas')Object.assign(p,appCanvases.get(slug)?.center(p.width,p.height)??{x:100,y:100})
  return p
}
