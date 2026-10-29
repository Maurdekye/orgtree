import type { ReactNode } from 'react'
import type { Watchdog } from '../types'
import { objectNavProps } from './objectnav'
import { watchdogGlyph, watchdogKindClass } from './watchdogchip'
import { useWatchdogTooltip } from './watchdogtitle'
import { WatchdogCountdown } from './watchdogcountdown'
import { useDogRoute, WATCHDOG_CARD_LIMIT } from './watchdogroute'

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
  // A bounded tree preview cannot establish that another handle is gone.
  // Keep its exact detail/menu route without guessing kind or lifetime.
  const ownerId=owner||dog?.owner||(key.includes('/')?key.split('/')[0]!:'')
  const partialOwner=Boolean(ownerId)&&(route?.counts?.[ownerId]?.total??0)>WATCHDOG_CARD_LIMIT
  const missingFromRoute=!given&&!onOpen&&Boolean(route)&&sameOrg&&Boolean(key)&&!dog&&!partialOwner
  const gone=stale||!!dog?.spent||dog?.state==='spent'||missingFromRoute
  const isStale=stale||gone
  const tooltip=useWatchdogTooltip(dog,key,gone)
  const open=gone||atDestination?undefined:onOpen??(sameOrg&&(dog||partialOwner)?route?.open:undefined)
  const Tag=open?'button':'span'
  const state=gone?'spent':dog?.state??'unknown'
  return <Tag {...(open?{type:'button' as const}:{})}
    {...(open||isStale||(dog&&!gone)?objectNavProps('watchdog',key,org??route?.org):{})}
    {...(isStale?{'data-object-stale':'true','data-object-name':label}:{})}
    className={`desk-nav-chip desk-dog-chip watchdog-link ${state} ${dog?watchdogKindClass(dog):''}${dog?.once?' oneshot':''}${gone?' gone':''}${dog?.disabled&&!gone?' disabled':''} ${className}`}
    {...tooltip}
    aria-label={`watchdog ${label}, ${gone?'no longer exists':state}`}
    aria-disabled={gone?'true':undefined}
    onMouseDown={e=>{if(e.button!==0)e.stopPropagation()}}
    onPointerDown={e=>e.stopPropagation()}
    onClick={e=>{e.stopPropagation();open?.(key)}}>
    <span className="wd-glyph" aria-hidden="true">{gone?'✕':dog?watchdogGlyph(dog):'◉'}</span>
    {dog?.once&&!gone&&<span className="wd-once" aria-label="one-shot dog">1×</span>}
    <span className="watchdog-link-name">{children??label}</span>
    {gone&&!children&&<span className="watchdog-link-gone dim"> (no longer exists)</span>}
    {countdown&&dog&&!gone&&<WatchdogCountdown dog={dog} compact/>}
  </Tag>
}
