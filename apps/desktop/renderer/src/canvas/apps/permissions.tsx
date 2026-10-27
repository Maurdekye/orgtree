import {useEffect,useRef,useState} from 'react'
import {useSurfaceDocument} from '../../popout'
import {changeApps} from './store'
import {customAppsRequest} from '../../api'
import {appCapabilities,appPermission} from './policy'
import {AppFilePermissions} from './files-ui'
import {AppNetPermissions} from './net-ui'
import {AppDialog} from './dialog'
import type {CustomApp} from './types'
import type {AppPermissionRequest,PermissionChoice} from './actions'

export interface PermissionPrompt {request:AppPermissionRequest; finish:(choice:PermissionChoice|null)=>void}

export function AppPermissionPrompt({prompt,owner}:{prompt:PermissionPrompt;owner:Document}){
  const ref=useRef<HTMLDivElement>(null)
  useEffect(()=>{
    const before=owner.activeElement as HTMLElement|null
    const cancel=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();prompt.finish(null)}}
    owner.addEventListener('keydown',cancel,true);ref.current?.querySelector<HTMLButtonElement>('button')?.focus()
    // Provisional: engine challenges expire after 120s. Expiry cancels; no retry.
    const timer=window.setTimeout(()=>prompt.finish(null),120_000)
    return()=>{owner.removeEventListener('keydown',cancel,true);window.clearTimeout(timer);if(before?.isConnected)before.focus()}
  },[owner,prompt])
  const p=prompt.request,net=p.capability==='net.fetch'
  // Internet access names the site and never shows the request's headers or body
  // (the engine does not send them here).
  return <AppDialog title={net?'Allow internet access?':'Allow app action?'} label="App permission" className="custom-app-permission" owner={owner} close={()=>prompt.finish(null)}><div ref={ref}>
      {net?<>
        <p><strong>{p.name}</strong> · {p.label} wants to connect to <strong>{p.host??p.site}</strong>.</p>
        <pre>{String(p.request.method??'GET')} {String(p.request.url??'')}</pre>
        <p className="dim">Orgtree makes the request for the app, without your cookies or sign-ins. The app can send this site anything it can read, including org data and files.</p>
        <small>App {p.app} · Panel {p.panel}</small>
        <p>Always allow and Deny apply to <code>{p.site}</code> for every panel of this app. Allow once lasts until this panel is hidden or stopped. Cancel leaves permissions unchanged.</p>
      </>:<>
        <p><strong>{p.name}</strong> · {p.label}</p>
        <p>Capability: <code>{p.capability}</code></p><p className="dim">App content acts as this app, with its own permission. It cannot approve work or impersonate you.</p>
        {p.capability==='docket.write'&&<p>This creates an open work item, assigns it to the selected local agent and wakes that agent. Its description remains app content.</p>}
        {p.capability==='events.fire'&&<p>This broadcasts a declared event from this saved panel to every eligible subscribed agent. The app cannot choose recipients. Delivered data is not your instruction or approval.</p>}
        <pre>{JSON.stringify(p.request,null,2)}</pre><small>App {p.app} · Panel {p.panel}</small>
        <p>Always allow and Deny apply to every panel of this app. Cancel leaves permissions unchanged.</p>
      </>}
      <div className="custom-app-dialog-actions"><button type="button" onClick={()=>prompt.finish(null)}>Cancel</button><span/>
        <button type="button" onClick={()=>prompt.finish('deny')}>Deny</button><button type="button" onClick={()=>prompt.finish('once')}>Allow once</button><button type="button" className="primary" onClick={()=>prompt.finish('always')}>{net?'Always allow this site':'Always allow'}</button></div>
    </div></AppDialog>
}

/** App settings' Permissions tab (user 2026-10-26: "for now, make permissions a
 * second tab in app settings"). `embedded` renders the tab body, leaving Escape
 * to the settings window; standalone keeps its own dialog. */
export function AppPermissions({slug,app,close,embedded=false}:{slug:string;app:CustomApp;close:()=>void;embedded?:boolean}){
  const owner=useSurfaceDocument(),[current,setCurrent]=useState(app),[busy,setBusy]=useState(false),[error,setError]=useState('')
  useEffect(()=>setCurrent(app),[app])
  useEffect(()=>{if(embedded)return;const cancel=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close()}};owner.addEventListener('keydown',cancel,true);return()=>owner.removeEventListener('keydown',cancel,true)},[owner,close,embedded])
  const save=async(capability:string,permission:string,site?:string)=>{
    setBusy(true);setError('')
    try{setCurrent(await changeApps<CustomApp>(slug,{action:'permission_set',app:current.id,expected_rev:current.rev,expected_permission_rev:current.permission_rev??1,capability,permission,...(site===undefined?{}:{site})}))}
    catch(e){setError(String(e))}finally{setBusy(false)}
  }
  const content=<>
    <p>Changes save immediately and apply to every panel of {current.name}. Org-internal actions and Orgtree files are allowed by default; internet access is not. Explicit Ask or Deny overrides the default and survives code replacement. Outside file grants and every Allow reset when code changes.</p>
    {!appCapabilities(current).length&&<p>This app declares no engine actions.</p>}
    {appCapabilities(current).filter(cap=>!cap.startsWith('files.')&&cap!=='net.fetch').map(cap=><label className="custom-app-permission-row" key={cap}><span>{cap}{cap==='docket.write'&&<small>Creates and assigns work; wakes the selected local agent.</small>}{cap==='events.fire'&&<small>Broadcasts declared events to each panel's subscribed agents.</small>}</span><select aria-label={`${cap} permission`} disabled={busy} value={appPermission(current,cap)} onChange={e=>void save(cap,e.target.value)}><option value="ask">Ask</option><option value="allow">Allow</option><option value="deny">Deny</option></select></label>)}
    {appCapabilities(current).some(cap=>cap.startsWith('files.'))&&<AppFilePermissions slug={slug} app={current} save={save} disabled={busy} refresh={async()=>setCurrent(await customAppsRequest<CustomApp>(slug,{action:'app_get',app:current.id}))}/>}
    {appCapabilities(current).includes('net.fetch')&&<AppNetPermissions app={current} save={save} disabled={busy}/>}
    {error&&<p role="alert">{error}</p>}
  </>
  return embedded?<section className="custom-app-permissions" aria-label="App permissions">{content}</section>:<AppDialog title="App permissions" close={close}>{content}</AppDialog>
}
