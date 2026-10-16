import { createRoot } from 'react-dom/client'
import {
  AgentNavProvider, agentNavProps, useProvideAgentNav,
} from '../src/canvas/agentnav'
import type { AgentTooltipInfo } from '../src/canvas/agentnav'

const info: AgentTooltipInfo = {
  name: 'coordinator-opus',
  provider: 'Codex',
  model: 'GPT-6',
  effort: 'xhigh',
  account: 'openai/primary',
}

function RegisterTooltip() {
  useProvideAgentNav(() => [], id => id === info.name ? info : null)
  return null
}

createRoot(document.getElementById('root')!).render(
  <AgentNavProvider>
    <RegisterTooltip />
    <main style={{ padding: 36 }}>
      <h1>Agent directory</h1>
      <button id="agent-link" type="button" {...agentNavProps(info.name)}>
        {info.name}
      </button>
      <p>Hover the linked agent to see its current identity.</p>
    </main>
  </AgentNavProvider>,
)
