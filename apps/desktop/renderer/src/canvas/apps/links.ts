// An app or a panel as a LINK. The Apps menu rows and @app:/@panel: mention chips
// (USER 2026-10-27 m449dc0a35cbe) share this hover text and this menu: one link,
// one behaviour (user 2026-10-21). Settings and Delete use the same native
// settings/confirmation routes as the Apps list gears (user 2026-10-27).
import {mentionCopyEntry} from '../contextmenu'
import type {MenuEntry} from '../contextmenu'
import {refToken} from '../reflinks'
import type {ToastFn} from '../../types'
import {changeApps,isRunning} from './store'
import type {CustomPanel} from './types'

type PanelRun=Pick<CustomPanel,'open'|'running'>
/** Visible => running; a hidden panel may still run (user 2026-10-26). */
export function panelRunState(p:PanelRun):{cls:string;word:string}{
  return isRunning(p)?(p.open?{cls:'open',word:'Running · visible'}:{cls:'running',word:'Running · hidden'}):{cls:'',word:'Off'}
}
/** An app link's hover text: the panel a click opens, or the one it creates. */
export const appLinkTitle=(name:string,recent:string|null|undefined):string=>recent?`Open ${recent}`:`Create a panel for ${name}`
/** A panel link's hover text is its run state; its label is on the link. */
export const panelLinkTitle=(p:PanelRun):string=>panelRunState(p).word
export type AppSettingsRequest={slug:string;kind:'app'|'panel';id:string;owner:Document;confirmDelete:boolean}
/** Display request only. AppsWorkspace reads the current target and opens the
 * existing settings or delete confirmation in the pressed link's document. */
export function manageAppLink(slug:string,kind:'app'|'panel',id:string,anchor:Element,confirmDelete=false):void{
  window.dispatchEvent(new window.CustomEvent<AppSettingsRequest>('custom-app-settings',{detail:{slug,kind,id,owner:anchor.ownerDocument,confirmDelete}}))
}
function managementMenu(slug:string,kind:'app'|'panel',id:string,anchor:Element):MenuEntry[]{
  return [{label:'Settings',onSelect:()=>manageAppLink(slug,kind,id,anchor)},'sep',
    {label:'Delete…',danger:true,onSelect:()=>manageAppLink(slug,kind,id,anchor,true)}]
}
/** Both link menus offer Copy mention, `@app:org/slug` and `@panel:org/slug`
 * (USER 2026-10-27), above Settings; `toast` confirms it where the surface has one. */
export const appLinkMenu=(slug:string,id:string,anchor:Element,toast?:ToastFn):MenuEntry[]=>[
  {label:'New panel',description:'Creates a powered-off panel without opening it',onSelect:()=>void changeApps(slug,{action:'panel_open',app:id,closed:true}).catch(error=>window.dispatchEvent(new window.CustomEvent('custom-app-error',{detail:{slug,error:String(error)}})))},
  'sep',mentionCopyEntry(anchor,refToken({kind:'app',org:slug,id}),toast),'sep',...managementMenu(slug,'app',id,anchor)
]
/** A panel link's menu. Start running never shows a window; Power off stops and
 * hides it. Power changes send no revision: a running panel's saves keep bumping it. */
export function panelLinkMenu(slug:string,p:PanelRun&{id:string},anchor:Element,toast?:ToastFn):MenuEntry[]{
  const power=(action:'panel_start'|'panel_stop')=>void changeApps(slug,{action,panel:p.id}).catch(error=>window.dispatchEvent(new window.CustomEvent('custom-app-error',{detail:{slug,error:String(error)}})))
  return [...(isRunning(p)?[{label:'Power off',onSelect:()=>power('panel_stop'),description:'Stops this panel and closes its window'}]:[{label:'Start running',onSelect:()=>power('panel_start'),description:'Runs this panel hidden, without opening its window'}]),'sep',mentionCopyEntry(anchor,refToken({kind:'panel',org:slug,id:p.id}),toast),'sep',...managementMenu(slug,'panel',p.id,anchor)]
}
