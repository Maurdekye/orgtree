import type { CSSProperties } from 'react'
import type { Watchdog } from '../types'
import { objectNavProps } from './objectnav'
import { ordinal, slotPlace } from './slots'
import { WatchdogCountdownTitle } from './watchdogcountdown'

export const watchdogKindClass=(w:Watchdog)=>w.kind==='slot'?'slot':w.kind==='fair_queue'?'fair-queue':w.kind==='project_listener'||w.kind==='listener_watch'?'listener':''

/** The canvas satellite, shared with the isolated visual fixture. */
export function WatchdogSatellite({ dog:w, dogs, org, style, onOpen }: {
  dog:Watchdog; dogs:Watchdog[]; org:string; style?:CSSProperties; onOpen:(id:string)=>void
}) {
  const title=`${w.once?'one-shot dog':'watchdog'} "${w.name}" (${w.kind}) — ${w.spent?'departing after its spark':w.state}; click for detail`
  const place=w.kind==='slot'?slotPlace(w,dogs):null
  return <button {...(!w.spent?objectNavProps('watchdog',w.id,org):{})}
    className={'wd-chip '+w.state+(w.kind==='slot'?' slot':'')
      +(w.kind==='project_listener'||w.kind==='listener_watch'?' listener':'')
      +(w.kind==='fair_queue'?' fair-queue':'')+(w.once?' oneshot':'')+(w.spent?' spent':'')}
    style={style} title={title} onPointerDown={e=>e.stopPropagation()}
    onClick={e=>{e.stopPropagation();onOpen(w.id)}}>
    <span className="wd-glyph">{place?'⏳':w.state==='armed'?'◉':w.state==='paused'?'◫':w.spent?'↗':'✕'}</span>
    {w.once&&!place&&<span className="wd-once" aria-label="one-shot dog">1×</span>}
    <span className="wd-name"><WatchdogCountdownTitle dog={w} title={title}>{place?`${w.target.replace(/^@/,'')} ${ordinal(place)}`:w.name}</WatchdogCountdownTitle></span>
  </button>
}
