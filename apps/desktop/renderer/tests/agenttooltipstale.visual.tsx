// agenttooltipstale.visual.tsx — the fixture for agenttooltipstale.capture.cjs (user 2026-11-13 m34935c22a71e: the
// node's model tag showed over every part of an agent's canvas desk).
//
// The REAL tooltip host (`registerAgentNativeTooltipDocument`) and the real attribute helper (`agentTooltipProps`).
// The card is a stand-in that does the one thing the canvas card does here (cards.tsx): it carries the tooltip
// attribute while it is a node and drops it when it becomes the desk. Inside the desk: the agent's name (an anchor of
// its own, as the desk header's is), a plain paragraph, and a button with its own tooltip. Browser-only.
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { agentTooltipProps, registerAgentNativeTooltipDocument } from '../src/canvas/agentnav'
import '../src/styles.css'

const TAG = 'scout · Anthropic · Claude Opus 5.5 · effort high'

function App() {
  const [focused, setFocused] = useState(false)
  useEffect(() => registerAgentNativeTooltipDocument(document, (id) => (id === 'scout' ? { title: TAG } : null)), [])
  return <div style={{ position: 'fixed', inset: 0, background: 'var(--bg)', color: 'var(--ink)', padding: 24 }}>
    <button type="button" id="back" onClick={() => setFocused(false)}>back to the node</button>
    <div id="card" {...agentTooltipProps(focused ? undefined : 'scout')}
      onClick={() => setFocused(true)}
      style={{ marginTop: 16, border: '1px solid var(--line)', borderRadius: 6, background: 'var(--panel)',
        width: focused ? 640 : 180, height: focused ? 380 : 70, padding: 12, boxSizing: 'border-box' }}>
      {!focused && <span id="node-name">scout</span>}
      {focused && <>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span id="desk-name" {...agentTooltipProps('scout')} style={{ fontWeight: 700 }}>scout</span>
          <button type="button" id="own" title="settings for scout">settings</button>
        </div>
        <p id="plain" style={{ marginTop: 40 }}>A plain part of the desk, with no tooltip of its own.</p>
      </>}
    </div>
  </div>
}

createRoot(document.getElementById('root')!).render(<App />)
