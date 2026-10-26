// Assigned synthetic renderer scene: production Apps surfaces and real API.
import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {CurrentOrg} from '../src/popout'
import {AppsButton,AppsWorkspace} from '../src/canvas/apps/ui'
import {AppPermissions} from '../src/canvas/apps/permissions'
import {customAppsRequest} from '../src/api'
import {changeApps} from '../src/canvas/apps/store'
import type {CustomApp,CustomPanel} from '../src/canvas/apps/types'
const args=new URLSearchParams(location.search),slug=location.pathname.split('/')[2],app=args.get('app')!,panel=args.get('panel')!
function Scene(){
  const [permissions,setPermissions]=useState<CustomApp|null>(null)
  return <CurrentOrg.Provider value={slug}><div style={{display:'flex',alignItems:'center',gap:12,padding:12}}><AppsButton slug={slug}/><strong>Synthetic caption file proof</strong>
    <button id="proof-reopen" onClick={()=>void changeApps<CustomPanel>(slug,{action:'panel_open',panel})}>Reopen saved panel</button>
    <button id="proof-permissions" onClick={()=>void customAppsRequest<CustomApp>(slug,{action:'app_get',app}).then(setPermissions)}>Files permissions</button></div>
    <AppsWorkspace slug={slug}/>{permissions&&<AppPermissions slug={slug} app={permissions} close={()=>setPermissions(null)}/>}</CurrentOrg.Provider>
}
createRoot(document.getElementById('root')!).render(<Scene/>);
