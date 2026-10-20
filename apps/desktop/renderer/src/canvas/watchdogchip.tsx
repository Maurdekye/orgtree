import type { CSSProperties } from 'react'
import type { Watchdog } from '../types'
import { objectNavProps } from './objectnav'
import { ordinal, slotPlace } from './slots'
import { WatchdogCountdownTitle } from './watchdogcountdown'
import { isDeadLetterListener } from './listeners'

// a dead-letter listener (an event dog on project.dead_letter) wears the dead-letter
// sepia-maroon wherever it is drawn (user 2026-10-20 06:41Z)
export const watchdogKindClass=(w:Watchdog)=>w.kind==='slot'?'slot':w.kind==='fair_queue'?'fair-queue':w.kind==='listener_watch'?'listener listener-watch':w.kind==='project_listener'?'listener':w.kind==='websocket'?'websocket':isDeadLetterListener(w)?'dead-letter':''

export const watchdogGlyph=(w:Watchdog)=>w.spent||w.state==='spent'?'↗':w.disabled?'⊘':w.state==='paused'?'◫':w.state!=='armed'?'✕':w.kind==='slot'&&!w.lease?'⏳':w.kind==='event'?'⚡':w.kind==='websocket'?'⇄':'◉'

/** A dog's state as its chip's tooltip words it: a dog its project's
 *  event-listeners switch-off disabled says so, and why. */
export const watchdogStateWords=(w:Watchdog)=>w.disabled?`disabled: ${w.disabled}`:w.state

/** The canvas satellite, shared with the isolated visual fixture. */
export function WatchdogSatellite({ dog:w, dogs, org, style, onOpen }: {
  dog:Watchdog; dogs:Watchdog[]; org:string; style?:CSSProperties; onOpen:(id:string)=>void
}) {
  const title=`${w.once?'one-shot dog':'watchdog'} "${w.name}" (${w.kind}) — ${w.spent?'departing after its spark':watchdogStateWords(w)}; click for detail`
  const place=w.kind==='slot'?slotPlace(w,dogs):null
  return <button {...(!w.spent?objectNavProps('watchdog',w.id,org):{})}
    className={'wd-chip '+w.state+' '+watchdogKindClass(w)+(w.once?' oneshot':'')+(w.spent?' spent':'')+(w.disabled?' disabled':'')}
    style={style} title={title} onPointerDown={e=>e.stopPropagation()}
    onClick={e=>{e.stopPropagation();onOpen(w.id)}}>
    <span className="wd-glyph">{watchdogGlyph(w)}</span>
    {w.once&&!place&&<span className="wd-once" aria-label="one-shot dog">1×</span>}
    <span className="wd-name"><WatchdogCountdownTitle dog={w} title={title}>{place?`${w.target.replace(/^@/,'')} ${ordinal(place)}`:w.name}</WatchdogCountdownTitle></span>
  </button>
}
