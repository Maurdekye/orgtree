import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { CacheForecastWarning, ComposerFocusRegion } from '../src/canvas/desk'
import type { CacheForecast } from '../src/types'

const forecast: CacheForecast = { generation:'synthetic', state:'known_incompatible', readiness:'not_ready',
  readiness_cause:'prefix_changed', reason:'Synthetic changed prefix', source:'synthetic fixture', lane:'subscription',
  changed_inputs:['system prompt'], precompact_action:'not_applicable' }
function Fixture() {
  const [focused,setFocused]=useState(false),[opened,setOpened]=useState(0)
  return <main style={{padding:32,maxWidth:940}}>
    <h2>Composer cache warning</h2>
    <p>Pointer press and native keyboard Tab/Enter retain the link until activation.</p>
    <ComposerFocusRegion onFocusChange={setFocused}>
      <div className="cc-composer"><textarea aria-label="Message" defaultValue="Review this change" />
        <button type="button" className="cc-send">Send</button></div>
      <CacheForecastWarning forecast={forecast} midTurn composerFocused={focused}
        cheapCompactOn cheapCompactOcc={0.25} contextRatio={0.6} onTurnOff={()=>setOpened(n=>n+1)} />
    </ComposerFocusRegion>
    <p><output data-opened={opened}>Settings action invoked: {opened}</output></p>
    <button type="button" data-outside>Move focus outside the composer</button>
  </main>
}
document.body.style.cssText='margin:0;background:var(--bg);color:var(--ink);font:14px sans-serif'
createRoot(document.getElementById('root')!).render(<Fixture />)
