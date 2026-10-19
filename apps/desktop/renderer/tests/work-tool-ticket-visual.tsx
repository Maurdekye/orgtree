import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ToolChip } from '../src/canvas/desk'
import type { ToolChip as Tool } from '../src/types'
import { AgentDirectoryProvider } from '../src/canvas/identity'
import { AgentNavProvider } from '../src/canvas/agentnav'
import { ObjectNavProvider } from '../src/canvas/objectnav'
import { ObjectNavHost } from '../src/canvas/objectnavhost'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'
import '../src/styles.css'

declare const __WORK_TOOL_CHIPS__: Tool[]
const item = { slug: 'restore-ticket-cards', title: 'Restore ticket cards', status: 'in_progress', archived: false }
window.fetch = (async (url: string | URL | Request) => new Response(JSON.stringify(
  String(url).includes('work-item-references') ? { references: [item] } : { item }
), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch
const opened: string[] = []
Object.assign(window, { openedTickets: opened })
flushSync(() => createRoot(document.getElementById('root')!).render(
  <AgentNavProvider><AgentDirectoryProvider value={{ resolve: id => id === 'worker' ? { tier: 'sol' } : undefined }}>
    <ObjectNavProvider><ObjectNavHost org="fixture" dogs={[]} openDog={() => {}}
      openTicket={slug => opened.push(slug)} toast={() => {}} />
      <main style={{ padding: 24, maxWidth: 920 }}>
        <h2>Docket tool calls</h2>
        <p>Create takes its ticket identity from the timed result. Update keeps its input slug.</p>
        <ObjectMenuBoundary>{__WORK_TOOL_CHIPS__.map(t =>
          <div key={t.id} style={{ marginBlock: 20 }}><ToolChip t={t} slug="fixture" nid="owner"
            onWorkLink={work => opened.push(work.slug)} /></div>
        )}</ObjectMenuBoundary>
      </main>
    </ObjectNavProvider>
  </AgentDirectoryProvider></AgentNavProvider>,
))
