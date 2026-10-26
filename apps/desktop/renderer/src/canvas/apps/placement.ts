import type {AppPlacement,CustomPanel} from './types'
export const appCanvases=new Map<string,{center:(w:number,h:number)=>{x:number;y:number};focus:(p:{x:number;y:number})=>void}>()
/** float is the ordinary centered modal; persisted coordinates belong to pins. */
export function appPlacement(slug:string,panel:CustomPanel,mode:AppPlacement['mode'],owner:Document):AppPlacement{
  const p={...panel.placement,mode,anchor:mode==='canvas'?panel.placement.anchor:null}
  if(mode==='canvas'&&panel.placement.mode!=='canvas')Object.assign(p,appCanvases.get(slug)?.center(p.width,p.height)??{x:100,y:100})
  if(mode==='screen'&&panel.placement.mode!=='screen'){
    const node=[...owner.querySelectorAll<HTMLElement>('[data-custom-panel]')].find(e=>e.dataset.customPanel===panel.id),r=node?.getBoundingClientRect(),win=owner.defaultView
    Object.assign(p,r&&r.width&&r.height?{x:r.x,y:r.y,width:Math.round(Math.max(160,Math.min(4096,r.width))),height:Math.round(Math.max(120,Math.min(4096,r.height)))}:{x:Math.max(8,((win?.innerWidth??800)-p.width)/2),y:Math.max(8,((win?.innerHeight??600)-p.height)/2)})
  }
  return p
}
