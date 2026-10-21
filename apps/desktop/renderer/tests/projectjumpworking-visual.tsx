import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { NavChip } from '../src/canvas/desk'
import { workingTree } from './projectjumpworking-fixture'
import { agent, project } from './projectbunch-fixture'
import type { CanvasNode } from '../src/canvas/shared'

function Fixture() {
  const [busy, setBusy] = useState(true)
  Object.assign(window, { projectJumpFixture: { setBusy } })
  return <div style={{ padding: 32, color: 'var(--ink)', font: '14px sans-serif' }}>
    <p>Project jump chips · descendant turn activity</p>
    <div className="desk-nav">
      <NavChip n={workingTree(busy)} dir="down" onJump={() => {}} />
      <NavChip n={{ ...agent('shader-worker'), busy }} dir="down" onJump={() => {}} />
      <NavChip n={project('idle-project') as CanvasNode} dir="down" onJump={() => {}} />
    </div>
    <p>Superior navigation uses the same project chip</p>
    <div className="desk-nav"><NavChip n={workingTree(busy)} dir="up" onJump={() => {}} /></div>
  </div>
}
document.body.style.cssText = 'margin:0;background:var(--bg)'
createRoot(document.getElementById('root')!).render(<Fixture />)
