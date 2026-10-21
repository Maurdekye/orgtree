import type { ReactNode } from 'react'
import type { Watchdog } from '../types'
import { objectNavProps } from './objectnav'
import { watchdogGlyph, watchdogKindClass } from './watchdogchip'
import { useWatchdogTitle } from './watchdogtitle'
import { WatchdogCountdown } from './watchdogcountdown'
import { useDogRoute } from './watchdogroute'

export interface WatchdogLinkProps {
  dog?: Watchdog
  id?: string
  owner?: string
  name?: string
  org?: string
  onOpen?: (id: string) => void
  className?: string
  children?: ReactNode
  countdown?: boolean
  /** Keep a recorded identity and copy menu after its watchdog is removed. */
  stale?: boolean
  atDestination?: boolean
}

/** One watchdog identity chip. Missing metadata stays neutral; orgs never share IDs. */
export function WatchdogLink({dog:given,id,owner,name,org,onOpen,className='',children,countdown=false,stale=false,atDestination=false}:WatchdogLinkProps) {
  const route=useDogRoute()
  const handle=id?.includes('/')||!owner?id:`${owner}/${id}`
  const sameOrg=!org||!route?.org||org===route.org
  const dog=given??(sameOrg?route?.dogs.find(w=>w.id===handle):undefined)
  const key=dog?.id??handle??''
  const label=name??dog?.name??id??''
  const gone=stale||!!dog?.spent||dog?.state==='spent'
  const title=useWatchdogTitle(dog,key,gone)
  // A bounded tree preview cannot establish that another handle is gone.
  // Keep its exact detail/menu route without guessing kind or lifetime.
  const partialOwner=key.includes('/')&&(route?.counts?.[key.split('/')[0]!]?.total??0)>8
  const open=gone||atDestination?undefined:onOpen??(sameOrg&&(dog||partialOwner)?route?.open:undefined)
  const Tag=open?'button':'span'
  const state=dog?.state??(gone?'spent':'unknown')
  return <Tag {...(open?{type:'button' as const}:{})}
    {...(open||stale||(dog&&!gone)?objectNavProps('watchdog',key,org??route?.org):{})}
    {...(stale?{'data-object-stale':'true','data-object-name':label}: {})}
    className={`desk-nav-chip desk-dog-chip watchdog-link ${state} ${dog?watchdogKindClass(dog):''}${dog?.once?' oneshot':''}${gone?' gone':''}${dog?.disabled&&!gone?' disabled':''} ${className}`}
    title={title}
    aria-label={`watchdog ${label}, ${gone?'no longer exists':state}`}
    aria-disabled={gone?'true':undefined}
    onMouseDown={e=>{if(e.button!==0)e.stopPropagation()}}
    onPointerDown={e=>e.stopPropagation()}
    onClick={e=>{e.stopPropagation();open?.(key)}}>
    <span className="wd-glyph" aria-hidden="true">{dog?watchdogGlyph(dog):gone?'✕':'◉'}</span>
    {dog?.once&&<span className="wd-once" aria-label="one-shot dog">1×</span>}
    <span className="watchdog-link-name">{children??label}</span>
    {countdown&&dog&&<WatchdogCountdown dog={dog} compact/>}
  </Tag>
}
