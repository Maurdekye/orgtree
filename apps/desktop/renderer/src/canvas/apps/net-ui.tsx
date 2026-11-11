import {useEffect,useState} from 'react'
import {customAppsRequest} from '../../api'
import {AppDialog} from './dialog'
import {fmtFull,fmtShort} from '../../timefmt'
import {SetGroup,SetRow} from '../settingskit'
import {LOG_PAGE,LogList} from './loglist'
import type {LogCursor} from './loglist'
import {useApps} from './store'
import type {CustomApp,PermissionHistoryEntry,PermissionHistoryPage,SiteClass,SiteLogin,SiteRow} from './types'

/** host[:port] with a bracketed IPv6 literal, as the engine's net.rs reads it. */
function hostPort(site:string):[string,number]|null{
  const v6=/^\[([^\]]+)\](?::(\d+))?$/.exec(site)
  if(v6)return [v6[1]!.toLowerCase(),v6[2]?Number(v6[2]):443]
  const at=site.lastIndexOf(':')
  if(at>0&&!site.slice(0,at).includes(':')&&/^\d+$/.test(site.slice(at+1)))return [site.slice(0,at).toLowerCase(),Number(site.slice(at+1))]
  return site?[site.toLowerCase(),443]:null
}
/** Whether a declared site covers a concrete site row (engine site_matches). */
export function siteCovers(declared:string,row:string){
  if(declared==='*')return true
  const want=hostPort(row),have=hostPort(declared)
  if(!want||!have||want[1]!==have[1])return false
  if(have[0].startsWith('*.')){const suffix=have[0].slice(1);return want[0].length>suffix.length&&want[0].endsWith(suffix)}
  return want[0]===have[0]
}

/** Add or replace one site's saved login (spec 4.3): a bearer token or one header. The value is a password field that
 * lives only in this dialog; the engine seals it and never returns it, so nothing here can show it again. */
function LoginDialog({slug,app,site,close,saved}:{slug:string;app:CustomApp;site:string;close:()=>void;saved:(login:SiteLogin)=>void}){
  const [kind,setKind]=useState<'bearer'|'header'>('bearer'),[name,setName]=useState(''),[value,setValue]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const save=async()=>{
    setBusy(true);setError('')
    try{saved(await customAppsRequest<SiteLogin>(slug,{action:'site_login_set',app:app.id,site,kind,...(kind==='header'?{name}:{}),value}));close()}
    catch(e){setError(String(e));setBusy(false)}
  }
  return <AppDialog title="Saved login" label="Saved login" className="custom-app-permission" close={close}>
    <p>Orgtree adds this to every request <strong>{app.name}</strong> makes to <strong>{site}</strong>. The app, its agents and its exports never see it, and Orgtree never shows it again.</p>
    <select aria-label="Login kind" value={kind} onChange={e=>setKind(e.target.value as 'bearer'|'header')}><option value="bearer">Bearer token</option><option value="header">Header</option></select>
    {kind==='header'&&<input aria-label="Header name" autoComplete="off" value={name} placeholder="Header name, e.g. X-Api-Key" onChange={e=>setName(e.target.value)}/>}
    <input type="password" aria-label="Login value" autoComplete="new-password" value={value} placeholder={kind==='bearer'?'Token':'Header value'} onChange={e=>setValue(e.target.value)}/>
    {error&&<p role="alert">{error}</p>}
    <div className="custom-app-dialog-actions"><button type="button" onClick={close}>Cancel</button><span/><button type="button" className="primary" disabled={busy||!value||(kind==='header'&&!name)} onClick={()=>void save()}>Save</button></div>
  </AppDialog>
}

/** Internet access (USER 2026-10-26 m95c57abc95fb; design m232e1d1ccb57): off until
 * the user allows it; one row per declared site, Deny wins; Any site only by its
 * own Allow. Hosts answered at a prompt under a *.domain or * declaration keep
 * their own rows, which the user can change or remove. */
export function AppNetPermissions({app,save,disabled,slug}:{app:CustomApp;save:(capability:string,permission:string,site?:string)=>Promise<void>;disabled:boolean;slug?:string}){
  const sites=app.sites??[],rows=app.site_permissions??{},capability=app.permissions['net.fetch']??'ask'
  const [classes,setClasses]=useState<Record<string,SiteClass>>({}),[confirm,setConfirm]=useState<string|null>(null)
  const [logins,setLogins]=useState<Record<string,SiteLogin>>({}),[loginFor,setLoginFor]=useState<string|null>(null)
  // Where each exact declared site resolves now (spec 3.6), read when the tab opens and after a save; an
  // engine that cannot answer leaves the row as it was.
  const exact=sites.filter(site=>site!=='*'&&!site.startsWith('*.')).join('\n')
  useEffect(()=>{
    if(!slug)return;let live=true
    for(const site of exact?exact.split('\n'):[])customAppsRequest<SiteClass>(slug,{action:'net_classify',app:app.id,site}).then(got=>{if(live&&got)setClasses(old=>({...old,[site]:got}))},()=>{})
    return()=>{live=false}
  },[slug,app.id,app.rev,app.permission_rev,exact])
  // Which sites have a saved login (spec 4.3): the engine answers site, kind and time only.
  useEffect(()=>{
    if(!slug)return;let live=true
    customAppsRequest<{logins:SiteLogin[]}>(slug,{action:'site_logins',app:app.id}).then(got=>{if(live&&got?.logins)setLogins(Object.fromEntries(got.logins.map(l=>[l.site,l])))},()=>{})
    return()=>{live=false}
  },[slug,app.id,app.rev])
  const valueOf=(row:string|SiteRow|undefined)=>typeof row==='string'?row:row?.value
  const value=(site:string)=>valueOf(rows[site])??(capability==='allow'&&site!=='*'?'allow':'ask')
  const answered=Object.keys(rows).filter(site=>!sites.includes(site)).sort()
  const label=(site:string)=>site==='*'?'Any site':site
  const isPrivate=(site:string)=>classes[site]?.class==='private'||value(site)==='allow-private'
  const choose=(site:string,next:string)=>{if(next==='allow-private')setConfirm(site);else void save('net.fetch',next,site)}
  const choice=(site:string)=><select aria-label={`${label(site)} internet permission`} disabled={disabled} value={value(site)} onChange={e=>choose(site,e.target.value)}><option value="ask">Ask</option>{isPrivate(site)?<option value="allow-private">Allow private network</option>:<option value="allow">Allow</option>}<option value="deny">Deny</option></select>
  // Under a private row: the addresses it is pinned to, the network kind, and a moved name.
  const detail=(site:string)=>{const c=classes[site];if(!c||(c.class!=='private'&&value(site)!=='allow-private'))return null
    return <div className="custom-app-private-site">
      <small>{c.tailscale?'Tailscale range':'Private network · Unencrypted (http)'}{c.pinned.length?` · pinned to ${c.pinned.join(', ')}`:` · resolves to ${c.addresses.join(', ')}`}</small>
      {c.allowed&&c.moved&&<p role="alert">{site} now resolves to {c.addresses.join(', ')}, not the address you allowed. <button type="button" disabled={disabled} onClick={()=>void save('net.fetch','allow-private',site)}>Use the new address</button></p>}
    </div>}
  // The saved-login line under an exact site the user has allowed (spec 4.1, 4.3).
  const loginLine=(site:string)=>{
    if(!slug||site==='*'||site.startsWith('*.')||!['allow','allow-private'].includes(value(site)))return null
    const login=logins[site]
    return <div className="custom-app-saved-login">{login
      ?<><small>Saved login: {login.kind==='bearer'?'Bearer token':'Header'}, saved {new Date(login.set_at).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}</small>
        <button type="button" disabled={disabled} onClick={()=>setLoginFor(site)}>Replace</button>
        <button type="button" disabled={disabled} aria-label={`Remove saved login for ${site}`} onClick={()=>void customAppsRequest(slug,{action:'site_login_remove',app:app.id,site}).then(()=>setLogins(old=>{const next={...old};delete next[site];return next}),()=>{})}>Remove</button></>
      :<button type="button" disabled={disabled} onClick={()=>setLoginFor(site)}>Add a saved login</button>}</div>
  }
  const asked=confirm?classes[confirm]:undefined
  return <SetGroup title="Internet access" note="Orgtree makes each request for the app, without your cookies or sign-ins, and never to this computer. Public sites use HTTPS. A computer on your own private network (Tailscale or a local address) needs its own Allow private network here. A site you allow can receive anything the app can read, including org data and files.">
    <SetRow label="Internet access" hint={capability==='deny'?'Deny blocks every site.':capability==='allow'?'Every listed site is allowed except Any site, unless its own row says Ask or Deny.':'Each site asks first. Deny on any row wins.'}>
      <select aria-label="Internet access permission" disabled={disabled} value={capability} onChange={e=>void save('net.fetch',e.target.value)}><option value="ask">Ask</option><option value="allow">Allow listed sites</option><option value="deny">Deny</option></select>
    </SetRow>
    {!sites.length&&<p>This app declares no sites, so it cannot connect anywhere.</p>}
    {sites.map(site=><SetRow key={site} label={label(site)} hint={site==='*'?<strong>Lets the app connect to any website. Allow it only for an app you trust with everything it can read.</strong>:site.startsWith('*.')?`Any subdomain of ${site.slice(2)}`:undefined}>{choice(site)}{detail(site)}{loginLine(site)}</SetRow>)}
    {answered.map(site=><SetRow key={site} label={site} hint={sites.some(declared=>siteCovers(declared,site))?'Answered at a prompt.':'Answered at a prompt; the app no longer declares it.'}>
      {choice(site)}<button type="button" disabled={disabled} aria-label={`Remove ${site}`} onClick={()=>void save('net.fetch','default',site)}>Remove</button>
    </SetRow>)}
    {loginFor&&slug&&<LoginDialog slug={slug} app={app} site={loginFor} close={()=>setLoginFor(null)} saved={login=>setLogins(old=>({...old,[login.site]:login}))}/>}
    {confirm&&<AppDialog title="Allow private network?" label="Allow private network" className="custom-app-permission" close={()=>setConfirm(null)}>
      <p>Allow <strong>{app.name}</strong> to reach <strong>{confirm}</strong> ({asked?asked.addresses.join(', '):'its address'}) on your private network? It can send anything it can read to that computer, and read anything that computer answers. Only allow a computer you control.</p>
      <div className="custom-app-dialog-actions"><button type="button" onClick={()=>setConfirm(null)}>Cancel</button><span/><button type="button" className="primary" onClick={()=>{const site=confirm;setConfirm(null);void save('net.fetch','allow-private',site)}}>Allow</button></div>
    </AppDialog>}
  </SetGroup>
}

const verbs:Record<PermissionHistoryEntry['permission'],string>={ask:'set to Ask',allow:'allowed',deny:'denied',default:'returned to default',once:'allowed once','allow-private':'allowed on the private network',repin:'address re-pinned','login-saved':'saved login added','login-replaced':'saved login replaced','login-removed':'saved login removed'}
/** One line per entry: what changed, how, by whom. */
export function describePermission(entry:PermissionHistoryEntry){
  const target=entry.capability==='net.fetch'?(entry.site?(entry.site==='*'?'Any site':entry.site):'Internet access'):entry.capability
  const verb=entry.via==='code'?'Allow cleared by a code change':verbs[entry.permission]??entry.permission
  return `${target}: ${verb}${entry.via==='prompt'?' at a prompt':''}`
}

const who=(actor:string)=>actor==='user'?'You':actor
const choices:Record<PermissionHistoryEntry['permission'],string>={ask:'Ask',allow:'Allow',deny:'Deny',default:'Default',once:'Allow once','allow-private':'Allow private network',repin:'Re-pin address','login-saved':'Saved login added','login-replaced':'Saved login replaced','login-removed':'Saved login removed'}
const ways:Record<PermissionHistoryEntry['via'],string>={change:'Changed in Permissions',prompt:'Answered at a prompt',code:'Reset by a code change'}
/** A Permission history row on one line: when, what changed and how, and who. */
function permissionSummary(entry:PermissionHistoryEntry){
  return <><time dateTime={entry.at}>{fmtShort(entry.at)}</time>{' '}<span>{describePermission(entry)}</span>{' '}<span className="dim">{who(entry.actor)}</span></>
}

/** App settings' Permission history tab, the last one (user 2026-10-27 m838e66af753b:
 * "ssme for permission history, and put tgat on i6s own tab"): every stored
 * permission change, prompt answer and code-change reset, as the same live list as
 * a panel's History. It follows Apps changes; a panel's own fires change nothing here.
 * It opens on the list, with no intro line (user 2026-10-28 m420ce21a63f4: "and this
 * one"); an empty history keeps its one line. */
export function AppPermissionHistory({slug,app}:{slug:string;app:CustomApp}){
  const panels=useApps(slug).panels
  const read=(cursor:LogCursor)=>customAppsRequest<PermissionHistoryPage>(slug,{action:'permission_history',app:app.id,limit:LOG_PAGE,...cursor}).then(page=>({items:page.entries??[],next_cursor:page.next_cursor??null}))
  // An expanded row: the exact time, who, and what was set where.
  const details=(entry:PermissionHistoryEntry)=>{const panel=entry.panel&&(panels.find(p=>p.id===entry.panel)?.label??entry.panel)
    return <dl>
      <dt>Time</dt><dd>{fmtFull(entry.at)}</dd><dt>By</dt><dd>{who(entry.actor)}</dd><dt>Capability</dt><dd>{entry.capability}</dd>
      {entry.site&&<><dt>Site</dt><dd>{entry.site==='*'?'Any site':entry.site}</dd></>}
      {entry.detail&&<><dt>Addresses</dt><dd>{entry.detail}</dd></>}
      <dt>Permission</dt><dd>{choices[entry.permission]??entry.permission}</dd><dt>How</dt><dd>{ways[entry.via]??entry.via}</dd>
      {panel&&<><dt>Panel</dt><dd>{panel}</dd></>}
    </dl>}
  return <div className="set-group custom-app-log-group">
    <LogList slug={slug} label="Permission history" read={read} follows={change=>!change.panel&&!change.listeners} summary={permissionSummary} details={details} empty="No permission changes yet."/>
  </div>
}
