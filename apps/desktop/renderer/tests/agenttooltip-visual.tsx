import { createRoot } from 'react-dom/client'
import {
  AgentNavProvider, agentNavProps, useProvideAgentNav,
} from '../src/canvas/agentnav'
import type { AgentTooltipInfo } from '../src/canvas/agentnav'

const id = 'coordinator-opus'
const info: AgentTooltipInfo = { title: 'ChatGPT Sol 6.1 · high · openai-1' }

function RegisterTooltip() {
  useProvideAgentNav(() => [], target => target === id ? info : null)
  return null
}

createRoot(document.getElementById('root')!).render(
  <AgentNavProvider>
    <RegisterTooltip />
    <main style={{ padding: 36 }}>
      <h1>Agent directory</h1>
      <button id="agent-link" type="button" {...agentNavProps(id)}>
        {id}
      </button>
      <p>Hover or focus the linked agent to inspect its native title.</p>
    </main>
  </AgentNavProvider>,
)
