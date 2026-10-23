// Isolated EffortBar capture: real renderer control, no engine or live data.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EffortBar } from '../src/canvas/effortbar'
import '../src/styles.css'

function Fixture() {
  const [effort, setEffort] = useState('high')
  const [commits, setCommits] = useState(0)
  return <main style={{ padding: 48, width: 600 }}>
    <h1>Thinking effort</h1>
    <p>Drag from high to medium, then release without moving the pointer.</p>
    <section style={{ marginTop: 32, padding: 24, border: '1px solid var(--line)', borderRadius: 12 }}>
      <EffortBar value={effort} level={effort} onSet={(next) => {
        setEffort(next); setCommits((n) => n + 1)
      }} />
      <p>Saved effort: <strong data-saved-effort>{effort}</strong></p>
      <p>Commits: <span data-commits>{commits}</span></p>
    </section>
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
