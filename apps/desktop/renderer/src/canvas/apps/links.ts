// An app or a panel as a LINK. The Apps menu rows and @app:/@panel: mention chips
// (USER 2026-10-27 m449dc0a35cbe) share this hover text and this menu: one link,
// one behaviour (user 2026-10-21). The app row has no menu, so neither has an app chip.
import type {MenuEntry} from '../contextmenu'
import {changeApps,isRunning} from './store'
import type {CustomPanel} from './types'

type PanelRun=Pick<CustomPanel,'open'|'running'>
/** Visible => running; a hidden panel may still run (user 2026-10-26). */
export function panelRunState(p:PanelRun):{cls:string;word:string}{
  return isRunning(p)?(p.open?{cls:'open',word:'Running · visible'}:{cls:'running',word:'Running · hidden'}):{cls:'',word:'Off'}
}
/** An app link's hover text: the copy a click opens, or the one it creates. */
export const appLinkTitle=(name:string,recent:string|null|undefined):string=>recent?`Open ${recent}`:`Create a panel for ${name}`
/** A panel link's hover text is its run state; its label is on the link. */
export const panelLinkTitle=(p:PanelRun):string=>panelRunState(p).word
/** A panel link's menu. Start running never shows a window; Power off stops and
 * hides it. Power changes send no revision: a running panel's saves keep bumping it. */
export function panelLinkMenu(slug:string,p:PanelRun&{id:string}):MenuEntry[]{
  const power=(action:'panel_start'|'panel_stop')=>void changeApps(slug,{action,panel:p.id}).catch(error=>window.dispatchEvent(new window.CustomEvent('custom-app-error',{detail:{slug,error:String(error)}})))
  return isRunning(p)?[{label:'Power off',onSelect:()=>power('panel_stop'),description:'Stops this panel and closes its window'}]:[{label:'Start running',onSelect:()=>power('panel_start'),description:'Runs this panel hidden, without opening its window'}]
}
