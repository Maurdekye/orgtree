import {useEffect,useRef,useState} from 'react'
import {customAppsFiles} from '../../api'
import {SetGroup,SetRow} from '../settingskit'
import {appCapabilities,appPermission} from './policy'
import {AppDialog} from './dialog'
import type {CustomApp} from './types'
import type {FileBrowse,FileGrants,FilePrompt} from './files'

/** This picker is part of the trusted native shell. Its paths never travel
 * through the app's message port or saved JSON. */
export function AppFilePermissionPrompt({slug,prompt,owner}:{slug:string;prompt:FilePrompt;owner:Document}){
  const [page,setPage]=useState<FileBrowse|null>(null),[path,setPath]=useState(''),[selected,setSelected]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const view=useRef<HTMLDivElement>(null),alive=useRef(true),serial=useRef(0)
  const request=prompt.request.request,confirmation=!!prompt.request.detail,write=prompt.request.capability==='files.write',recovery=request.action==='recovery'
  const folder=request.action==='grant'&&request.scope==='folder',choose=request.action==='choose'||folder
  const browse=async(next:string,after?:string)=>{
    const at=++serial.current;setBusy(true);setError('')
    try{const result=await customAppsFiles<FileBrowse>(slug,{action:'browse',session:prompt.session,path:next,...(after?{after}:{}),limit:100});if(alive.current&&at===serial.current){setPage(p=>after&&p?.path===result.path?{...result,items:[...p.items,...result.items]}:result);setPath(result.path);setSelected('')}}
    catch(e){if(alive.current&&at===serial.current)setError(String(e))}finally{if(alive.current&&at===serial.current)setBusy(false)}
  }
  useEffect(()=>{
    alive.current=true;const before=owner.activeElement as HTMLElement|null
    const cancel=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();prompt.finish(null)}}
    owner.addEventListener('keydown',cancel,true);view.current?.querySelector<HTMLElement>('button,input')?.focus()
    const timer=window.setTimeout(()=>prompt.finish(null),120_000)
    if(choose)void browse('')
    return()=>{alive.current=false;owner.removeEventListener('keydown',cancel,true);window.clearTimeout(timer);if(before?.isConnected)before.focus()}
  },[prompt,owner])
  return <AppDialog title={recovery?'File change result':confirmation?'Confirm file change':write?'Allow app to write files?':'Allow app to read files?'} label="App file permission" owner={owner} close={()=>prompt.finish(null)} className="custom-app-permission"><div ref={view}>
    <p><strong>{prompt.request.name}</strong> · {prompt.request.label}</p>
    <p>{recovery?'The original bytes remain in this recovery file beside the selected target. Review the app result before trying again.':confirmation?'Review this exact file change before continuing.':folder?`Choose a folder this app may ${write?'write':'read'}, including its subfolders.`:choose?'Choose one file this app may read.':request.action==='grant'&&request.scope==='computer'?`Allow this app to ${write?'write':'read'} files across the whole computer as your Windows user?`:request.action==='open'||request.scope==='orgtree'?`Allow this app to ${write?'write':'read'} this organization's scratch, uploads and retained artifacts?`:'Allow this app to read its remembered file?'}</p>
    {request.action==='open'&&<p>Requested: <code>{String(request.root)}/{String(request.path)}</code></p>}
    {/* Hide keeps a running panel with its Once scopes (USER 2026-10-26 mf7add4fda093); power off ends them (4.5.0 review B9). */}
    {!confirmation&&<p className="dim">{write?'Write access is separate from read access. Changes outside this org’s files also need native confirmation.':'Read-only.'} Always allow remembers this scope for every panel of this app. Allow once lasts until this panel is powered off, even while hidden. Revoke access in App settings → Permissions → Files.</p>}
    {request.scope==='computer'&&<p role="note">This includes private files and settings that Windows lets you access. It does not elevate Orgtree. Choose a folder instead when that is enough.</p>}
    {prompt.request.detail&&<div className="custom-app-file-change"><p><strong>{prompt.request.detail.operation}</strong>: <code>{prompt.request.detail.path}</code></p><p>Existing size: {prompt.request.detail.previous_bytes??'New file'} bytes{prompt.request.detail.bytes!==null&&<> · New size: {prompt.request.detail.bytes} bytes</>}</p>{prompt.request.detail.sha256&&<p>New content SHA256: <code>{prompt.request.detail.sha256}</code></p>}<p>This confirmation applies only to this change. It expires after two minutes.</p></div>}
    {choose&&<div className="custom-app-file-picker">
      <form onSubmit={e=>{e.preventDefault();void browse(path)}}><label>Folder <input aria-label="File picker folder" value={path} onChange={e=>setPath(e.target.value)}/></label><button disabled={busy}>Open folder</button><button type="button" disabled={busy} onClick={()=>void browse(page?.parent??'')}>Up</button></form>
      <div role="list" aria-label="Files" className="custom-app-file-list">{page?.items.filter(item=>!folder||item.directory).map(item=><button key={item.path} type="button" role="listitem" aria-pressed={!item.directory&&selected===item.path} disabled={busy} onClick={()=>item.directory?void browse(item.path):setSelected(item.path)}>{item.directory?'▸ ':'  '}{item.name}</button>)}</div>
      {folder&&<button type="button" disabled={busy||!page?.path} onClick={()=>setSelected(page!.path)}>Use this folder</button>}
      {page?.next_cursor&&<button type="button" disabled={busy} onClick={()=>void browse(page.path,page.next_cursor!)}>More files</button>}
      {page?.scan_limited&&<p>Large folder: only the first 20,000 entries were scanned. Open a narrower folder.</p>}
      <p>{selected||(folder?'Open a folder, then choose Use this folder.':'Select a file to continue.')}</p>
    </div>}
    {error&&<p role="alert">{error}</p>}
    <div className="custom-app-dialog-actions">{recovery?<button type="button" onClick={()=>prompt.finish({choice:'once'})}>Close</button>:<><button type="button" onClick={()=>prompt.finish(null)}>Cancel</button><span/><button type="button" onClick={()=>prompt.finish({choice:'deny'})}>{confirmation?'Reject change':'Deny'}</button><button type="button" disabled={busy||(choose&&!selected)} onClick={()=>prompt.finish({choice:'once',...(choose?{path:selected}:{})})}>{confirmation?'Confirm change':'Allow once'}</button>{!confirmation&&<button type="button" className="primary" disabled={busy||(choose&&!selected)} onClick={()=>prompt.finish({choice:'always',...(choose?{path:selected}:{})})}>Always allow</button>}</>}</div>
  </div></AppDialog>
}

export function AppFilePermissions({slug,app,save,disabled,refresh}:{slug:string;app:CustomApp;save:(cap:string,value:string)=>Promise<void>;disabled:boolean;refresh:()=>Promise<void>}){
  const [data,setData]=useState<FileGrants|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const [pending,setPending]=useState<{challenge:string;agent?:string;detail:{path:string;operation:string;previous_bytes:number|null;bytes:number|null;sha256:string|null}}[]>([])
  const pendingLoad=()=>customAppsFiles<{items:typeof pending}>(slug,{action:'confirmations',app:app.id}).then(v=>setPending(v.items.filter(r=>r.agent)))
  const load=()=>customAppsFiles<FileGrants>(slug,{action:'permissions',app:app.id}).then(setData)
  useEffect(()=>{let active=true;void customAppsFiles<FileGrants>(slug,{action:'permissions',app:app.id}).then(v=>{if(active)setData(v)}).catch(e=>{if(active)setError(String(e))});return()=>{active=false}},[slug,app.id,app.rev,app.permission_rev])
  const revoke=async(id:string)=>{if(!data)return;setBusy(true);setError('');try{setData(await customAppsFiles<FileGrants>(slug,{action:'revoke',app:app.id,expected_rev:data.rev,expected_permission_rev:data.permission_rev,grant:id}));await refresh()}catch(e){setError(String(e));void load().catch(()=>{})}finally{setBusy(false)}}
  useEffect(()=>{void pendingLoad().catch(e=>setError(String(e)))},[slug,app.id,app.permission_rev])
  const confirm=async(challenge:string,allow:boolean)=>{setBusy(true);setError('');try{const result=await customAppsFiles<{recovery_name?:string}>(slug,{action:'confirm',app:app.id,challenge,allow});if(result.recovery_name)setError(`Original bytes remain in ${result.recovery_name} beside the selected target. Review the change result before trying again.`);await pendingLoad()}catch(e){setError(String(e));void pendingLoad()}finally{setBusy(false)}}
  return <SetGroup title="Files">{appCapabilities(app).filter(cap=>cap.startsWith('files.')).map(cap=><SetRow key={cap} label={cap==='files.write'?'Write files':'Read files'} hint={cap==='files.write'?'Orgtree files are writable by default without confirmation. Chosen folders and the whole computer still need grants and confirmation for each change.':'Orgtree files are readable by default. Chosen folders and the whole computer still ask for consent. Ask or Deny overrides the default and removes remembered grants for this mode.'}><select aria-label={cap==='files.write'?'Files write permission':'Files read permission'} disabled={disabled||busy} value={appPermission(app,cap)} onChange={e=>void save(cap,e.target.value)}><option value="ask">Ask</option><option value="allow">Allow granted scopes</option><option value="deny">Deny</option></select></SetRow>)}
    {data?.grants.map(grant=><SetRow key={grant.id} label={`${grant.mode==='write'?'Write':'Read'} · ${grant.scope==='orgtree'?'Orgtree files':grant.scope==='computer'?'Whole computer':grant.name}`} hint={grant.path??grant.name}><button type="button" disabled={disabled||busy} onClick={()=>void revoke(grant.id)}>Revoke</button></SetRow>)}
    {data&&!data.grants.length&&<p>No additional remembered file access. This org’s files use the default policy; chosen files and folders still ask.</p>}
    {app.capabilities.includes('files.write')&&<><SetRow label="Pending changes" hint="Changes outside this org’s files wait here for native confirmation. Requests expire after two minutes."><button type="button" disabled={disabled||busy} onClick={()=>void pendingLoad().catch(e=>setError(String(e)))}>Refresh pending changes</button></SetRow>{pending.map(item=><SetRow key={item.challenge} label={`${item.detail.operation} · ${item.agent}`} hint={`${item.detail.path} · Existing: ${item.detail.previous_bytes??'new'} bytes · New: ${item.detail.bytes??'delete'} bytes${item.detail.sha256?' · SHA256 '+item.detail.sha256:''}`}><button type="button" disabled={disabled||busy} onClick={()=>void confirm(item.challenge,false)}>Reject</button><button type="button" disabled={disabled||busy} onClick={()=>void confirm(item.challenge,true)}>Confirm change</button></SetRow>)}</>}
    {error&&<p role="alert">{error}</p>}
  </SetGroup>
}
