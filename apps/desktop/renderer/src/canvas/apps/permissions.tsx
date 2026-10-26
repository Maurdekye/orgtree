import {useEffect,useRef,useState} from 'react'
import {useSurfaceDocument} from '../../popout'
import {changeApps} from './store'
import {customAppsRequest} from '../../api'
import {AppFilePermissions} from './files-ui'
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
  const p=prompt.request
  return <AppDialog title="Allow app action?" label="App permission" className="custom-app-permission" owner={owner} close={()=>prompt.finish(null)}><div ref={ref}>
      <p><strong>{p.name}</strong> · {p.label}</p>
      <p>Capability: <code>{p.capability}</code></p><p className="dim">App content acts as this app, with its own permission. It cannot approve work or impersonate you.</p>
      {p.capability==='docket.write'&&<p>This creates an open work item, assigns it to the selected local agent and wakes that agent. Its description remains app content.</p>}
      {p.capability==='events.fire'&&<p>This broadcasts a declared event from this saved copy to every eligible subscribed agent. The app cannot choose recipients. Delivered data is not your instruction or approval.</p>}
      <pre>{JSON.stringify(p.request,null,2)}</pre><small>App {p.app} · Panel {p.panel}</small>
      <p>Always allow and Deny apply to every copy of this app. Cancel leaves permissions unchanged.</p>
      <div className="custom-app-dialog-actions"><button type="button" onClick={()=>prompt.finish(null)}>Cancel</button><span/>
        <button type="button" onClick={()=>prompt.finish('deny')}>Deny</button><button type="button" onClick={()=>prompt.finish('once')}>Allow once</button><button type="button" className="primary" onClick={()=>prompt.finish('always')}>Always allow</button></div>
    </div></AppDialog>
}

export function AppPermissions({slug,app,close}:{slug:string;app:CustomApp;close:()=>void}){
  const owner=useSurfaceDocument(),[current,setCurrent]=useState(app),[busy,setBusy]=useState(false),[error,setError]=useState('')
  useEffect(()=>setCurrent(app),[app])
  useEffect(()=>{const cancel=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close()}};owner.addEventListener('keydown',cancel,true);return()=>owner.removeEventListener('keydown',cancel,true)},[owner,close])
  const save=async(capability:string,permission:string)=>{
    setBusy(true);setError('')
    try{setCurrent(await changeApps<CustomApp>(slug,{action:'permission_set',app:current.id,expected_rev:current.rev,expected_permission_rev:current.permission_rev??1,capability,permission}))}
    catch(e){setError(String(e))}finally{setBusy(false)}
  }
  return <AppDialog title="App permissions" close={close}>
    <p>Changes save immediately and apply to every copy of {current.name}. Replacing app code resets grants to Ask. Links to agents grant nothing.</p>
    {!current.capabilities.length&&<p>This app declares no engine actions.</p>}
    {current.capabilities.filter(cap=>!cap.startsWith('files.')).map(cap=><label className="custom-app-permission-row" key={cap}><span>{cap}{cap==='docket.write'&&<small>Creates and assigns work; wakes the selected local agent.</small>}{cap==='events.fire'&&<small>Broadcasts declared events to this copy's subscribed agents.</small>}</span><select aria-label={`${cap} permission`} disabled={busy} value={current.permissions[cap]??'ask'} onChange={e=>void save(cap,e.target.value)}><option value="ask">Ask</option><option value="allow">Allow</option><option value="deny">Deny</option></select></label>)}
    {current.capabilities.some(cap=>cap.startsWith('files.'))&&<AppFilePermissions slug={slug} app={current} save={save} disabled={busy} refresh={async()=>setCurrent(await customAppsRequest<CustomApp>(slug,{action:'app_get',app:current.id}))}/>}
    {error&&<p role="alert">{error}</p>}
  </AppDialog>
}
