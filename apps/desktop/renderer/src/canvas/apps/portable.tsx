import {useState} from 'react'
import {customAppsRequest} from '../../api'
import {changeApps,loadAppsMenu} from './store'
import {SetRow} from '../settingskit'
import type {AppDefinition,AppState,CustomApp} from './types'

// Provisional v1 format and bounds, pending the single morning question list.
export const APP_BUNDLE_MAX=16*1024*1024
export interface AppBundle {format:'orgtree-app';version:1;definition:AppDefinition;panels?:{label:string;state:AppState}[]}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
function keys(value:Record<string,unknown>,allowed:string[]){if(Object.keys(value).some(k=>!allowed.includes(k)))throw Error('Unexpected app bundle field. Permissions, identities and placement cannot be imported.')}
function text(v:unknown,n:number){return typeof v==='string'&&v.trim().length>0&&[...v].length<=n&&!/[\x00-\x1f\x7f]/.test(v)}
export function parseAppBundle(raw:string):AppBundle {
  if(new TextEncoder().encode(raw).length>APP_BUNDLE_MAX)throw Error('App bundle exceeds 16 MiB.')
  const value:unknown=JSON.parse(raw)
  if(!object(value)||value.format!=='orgtree-app'||value.version!==1||!object(value.definition))throw Error('Expected an orgtree-app version 1 bundle.')
  keys(value,['format','version','definition','panels']);const def=value.definition
  keys(def,['name','description','html','initial_state','capabilities','events','width','height'])
  if(!text(def.name,120)||typeof def.html!=='string'||!def.html.trim()||new TextEncoder().encode(def.html).length>4*1024*1024)throw Error('App needs a name and HTML up to 4 MiB.')
  if(def.description!==undefined&&(typeof def.description!=='string'||[...def.description].length>1000||/[\x00-\x1f\x7f]/.test(def.description)))throw Error('Invalid app description.')
  if(def.capabilities!==undefined&&(!Array.isArray(def.capabilities)||def.capabilities.length>6||new Set(def.capabilities).size!==def.capabilities.length||def.capabilities.some(c=>!['org.read','mail.send','docket.write','events.fire','files.read','files.write'].includes(c))))throw Error('Unknown or duplicate app capability.')
  if(def.events!==undefined){
    if(!Array.isArray(def.events)||def.events.length>64)throw Error('At most 64 declared app events.')
    const seen=new Set<string>()
    for(const event of def.events){
      if(!object(event))throw Error('Invalid app event declaration.')
      keys(event,['name','description'])
      const name=event.name
      if(typeof name!=='string'||!text(name,80)||name.trim()!==name||/[\u0080-\u009f]/.test(name)||seen.has(name))throw Error('Event names must be unique without surrounding whitespace or controls.')
      seen.add(name)
      if(event.description!==undefined&&(typeof event.description!=='string'||[...event.description].length>1000||/[\x00-\x1f\x7f-\x9f]/.test(event.description)))throw Error('Invalid app event description.')
    }
  }
  const state=(v:unknown)=>{if(!object(v)||new TextEncoder().encode(JSON.stringify(v)).length>2*1024*1024)throw Error('App state must be a JSON object up to 2 MiB.')}
  if(def.initial_state!==undefined)state(def.initial_state)
  if(value.panels!==undefined){if(!Array.isArray(value.panels)||value.panels.length>16)throw Error('An app bundle can include at most 16 saved panels.');for(const p of value.panels){if(!object(p)||!text(p.label,120))throw Error('Invalid saved panel label.');keys(p,['label','state']);state(p.state)}}
  // Never sanitize away authority fields: the engine independently validates the
  // complete original bundle and imports fresh IDs with no execution grants.
  return value as unknown as AppBundle
}
export function saveAppJson(owner:Document,name:string,value:unknown,portable=false){
  const raw=portable?JSON.stringify(value):JSON.stringify(value,null,2)
  if(portable&&new TextEncoder().encode(raw).length>APP_BUNDLE_MAX)throw Error('App bundle exceeds 16 MiB.')
  const url=window.URL.createObjectURL(new Blob([raw],{type:'application/json'})),a=owner.createElement('a')
  a.href=url;a.download=name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');owner.body.appendChild(a)
  try{a.click()}finally{a.remove();window.setTimeout(()=>window.URL.revokeObjectURL(url),30_000)}
}
export function AppImport({slug,bundle,close}:{slug:string;bundle:AppBundle;close:()=>void}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  const importApp=async()=>{setBusy(true);setError('');try{await changeApps(slug,{action:'app_import',bundle});await loadAppsMenu(slug);close()}catch(e){setError(String(e))}finally{setBusy(false)}}
  return <><p><b>{bundle.definition.name}</b></p><p>{bundle.definition.description}</p>
    <p>Apps imported from outside this org have full access to it and its state. Be careful importing apps from untrustworthy sources. Saved copies stay closed until you open them. Importing does not run the app.</p>
    <p>Requested capabilities: {bundle.definition.capabilities?.join(', ')||'None'}</p>
    <p>{bundle.panels?.length??0} saved copies. IDs and permissions from another org are not retained.</p>
    {!!bundle.panels?.length&&<ul className="custom-app-import-copies">{bundle.panels.map((p,i)=><li key={i}>{p.label}</li>)}</ul>}
    {error&&<p role="alert">{error}</p>}
    <div className="custom-app-dialog-actions"><button type="button" disabled={busy} onClick={close}>Cancel</button><button type="button" className="primary" disabled={busy} onClick={()=>void importApp()}>Import app</button></div></>
}
export function AppExport({slug,app,owner}:{slug:string;app:CustomApp;owner:Document}){
  const [include,setInclude]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const exportApp=async()=>{setBusy(true);setError('');try{const out=await customAppsRequest<{bundle:AppBundle}>(slug,{action:'app_export',app:app.id,expected_rev:app.rev,include_panels:include});saveAppJson(owner,app.name+'.orgtree-app',out.bundle,true)}catch(e){setError(String(e))}finally{setBusy(false)}}
  return <SetRow label="Export app" hint={<>Exports never include execution permissions. Maximum 16 MiB and 16 saved copies; leave data unchecked for a definition-only export.{error&&<span role="alert"> {error}</span>}</>}>
    <label className="custom-app-include"><input type="checkbox" aria-label="Include saved panel data" checked={include} disabled={busy} onChange={e=>setInclude(e.target.checked)}/>Include saved panel data</label>
    <button type="button" disabled={busy} onClick={()=>void exportApp()}>Export app</button></SetRow>
}
