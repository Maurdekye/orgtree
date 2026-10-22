import { createRoot } from 'react-dom/client'
import { SessionZeroBadge } from '../src/canvas/nextturn'
import { DndBadge } from '../src/canvas/dnd'
import type { SessionPlacement } from '../src/types'

const placement: SessionPlacement = { session: 'session0', reason: 'helper-unreachable', at: '2026-10-22T08:00:00Z' }
const reasons: SessionPlacement['reason'][] = ['signed-out','helper-unreachable','preference','background-work',null]
document.body.style.cssText='margin:0;background:var(--bg);color:var(--ink);font:14px sans-serif'
createRoot(document.getElementById('root')!).render(<main style={{padding:28}}>
  <h2 style={{marginTop:0}}>Session 0 state badge</h2>
  <h3>Desk header state badges</h3>
  <div className="cc-head-meta"><DndBadge active /><SessionZeroBadge node={{session_placement:placement}} /></div>
  <h3>Zoom-card state badges</h3>
  <div className="sq-badges"><DndBadge active /><SessionZeroBadge node={{session_placement:placement}} /></div>
  <h3>Placement explanations</h3>
  <p>Native tooltip text is shown beside each badge for inspection.</p>
  {reasons.map(reason=><div key={reason??'legacy'} data-reason={reason??'legacy'} style={{display:'flex',gap:18,marginBottom:14,alignItems:'start'}}>
    <SessionZeroBadge node={{session_placement:{...placement,reason,at:null}}} />
    <output style={{fontSize:13}} />
  </div>)}
  <h3>Hidden when signed in or placement is unknown</h3>
  <div data-hidden><SessionZeroBadge node={{session_placement:null}} /><SessionZeroBadge
    node={{session_placement:{session:'signed-in',reason:null,at:null}}} />No Session 0 badge</div>
</main>)
