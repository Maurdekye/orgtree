import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { DogChip } from '../src/canvas/deskdogs'
import { WatchdogLink } from '../src/canvas/watchdoglink'
import { WatchdogSatellite } from '../src/canvas/watchdogchip'
import type { Watchdog } from '../src/types'

const now = Date.parse('2026-10-21T12:00:00Z')
let clock = now
Date.now = () => clock
const dogs: Watchdog[] = [68, 10_980, 97_200].map((seconds, i) => ({
  id: `synthetic/clock-${i}`, owner: 'synthetic', name: `clock-${i}`, kind: 'command',
  state: 'armed', interval_s: seconds, once: false, fired: 0, target: 'synthetic fixture',
  at: new Date(now).toISOString(), next_check_at: new Date(now + seconds * 1000).toISOString(),
}))
Object.assign(window, { advanceTooltipClock: () => { clock += 1000 } })
function Fixture() {
  const [title, setTitle] = useState('Hover a watchdog identity')
  Object.assign(window, { inspectTooltip: () => setTitle(document.querySelector<HTMLElement>('.desk-sample .watchdog-link')!.title) })
  return <main style={{ padding: 28 }}>
    <h2>Watchdog countdowns</h2>
    <p>Chip timers keep ticking. Native hover text stays fixed until the pointer leaves.</p>
    <div style={{ display: 'grid', gridTemplateColumns: '160px 230px 230px', gap: 24, alignItems: 'center' }}>
      <b>Canvas</b><b>Desk</b><b>Transcript</b>
      {dogs.map(w => <section key={w.id} style={{ display: 'contents' }}>
        <div style={{ position: 'relative', height: 30 }}><WatchdogSatellite dog={w} dogs={dogs} org="fixture"
          style={{ width: 130, height: 28 }} onOpen={() => {}} /></div>
        <div className="desk-sample"><DogChip dog={w} onOpen={() => {}} /></div>
        <WatchdogLink dog={w} org="fixture" onOpen={() => {}} countdown />
      </section>)}
    </div>
    <div style={{ marginTop: 40, border: '1px solid var(--line-soft)', padding: 18 }}>
      <b>Native title inspection</b><pre style={{ whiteSpace: 'pre-wrap' }}>{title}</pre>
    </div>
  </main>
}
document.body.style.cssText = 'margin:0;background:var(--bg);color:var(--ink);font:14px sans-serif'
createRoot(document.getElementById('root')!).render(<Fixture />)
