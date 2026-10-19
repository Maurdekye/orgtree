import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { MailList } from '../src/canvas/mail'
import { useInboxTagSelection } from '../src/inboxselection'
import { applyTheme } from '../src/themes'
import type { InboxPayload } from '../src/types'

const box: InboxPayload = { pending: [], sent: [], delivered: [
  { id: 'old', from: 'lead', kind: 'message', at: '2026-10-19T10:00:00Z', body: 'Currently open message: an alpha update.', tags: ['alpha'] },
  { id: 'clicked', from: 'lead', kind: 'message', at: '2026-10-19T10:01:00Z', body: 'Clicked tagged message: review the renderer change.', tags: ['alpha', 'Review'] },
  { id: 'newest', from: 'lead', kind: 'message', at: '2026-10-19T10:02:00Z', body: 'Another matching message: a separate review.', tags: ['Review'] },
] }
const lookup = async () => null
function Fixture() {
  const [tags, setTags] = useState<string[]>([])
  const mode = new URLSearchParams(location.search).get('mode') ?? 'user'
  const selection = useInboxTagSelection(`capture-${mode}`, box, tags, mode === 'user', lookup)
  return <main className="settings" style={{ position: 'static', transform: 'none', width: 940, height: 600, maxWidth: 'none', display: 'flex', flexDirection: 'column', margin: 16 }}>
    <h3>{mode} inbox — tag click selection</h3>
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <MailList delivered={box.delivered} selectOldestUnread={mode === 'user'} projectMail={mode === 'project'}
        selectionRequest={mode === 'user' ? selection.request : undefined} onOpenMail={selection.remember}
        tagFilter={{ selected: tags, choices: ['alpha', 'Review'], onChange: setTags }}/>
    </div>
  </main>
}
window.fetch = async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })
applyTheme('orgtree')
createRoot(document.getElementById('root')!).render(<Fixture/> )
