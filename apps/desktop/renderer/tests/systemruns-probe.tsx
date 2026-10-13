import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { Msg } from '../src/canvas/desk'
import { SystemRuns, transcriptEntries } from '../src/events/systemruns'
import { applyTheme } from '../src/themes'
import type { ChatMessage } from '../src/types'
import restart from './fixtures/events/runtime.restart_notice.json'

const notice = (id: string): ChatMessage => ({ role: 'user', event_id: id, text: '', segments: [{ kind: 'mail', rows: [{
  id, from: '@system', kind: 'status', notice: true, body: `System notice ${id}. Full content and [reference](https://example.invalid) retained.`, at: '2026-10-13T12:00:00Z',
}] }] })
function Fixture() {
  const [extra, setExtra] = useState(false)
  const messages: ChatMessage[] = [
    { role: 'user', text: 'Please review the latest change.', event_id: 'human' },
    { role: 'user', text: '', event_id: 'restart', segments: [{ kind: 'notices', rows: [{ at: '2026-10-13T12:00:00Z', text: '', ev: restart.private }] }] },
    notice('one'), notice('two'), ...(extra ? [notice('three')] : []),
    { role: 'user', event_id: 'peer', text: '', segments: [{ kind: 'mail', rows: [{ id: 'peer', from: 'reviewer', kind: 'status', notice: true,
      body: 'This agent notice stays visible and breaks the run.', at: '2026-10-13T12:00:00Z' }] }] },
    { role: 'assistant', event_id: 'assistant', text: 'Here is my response. The notices remain available above.' },
    notice('single'),
  ]
  Object.assign(window, { systemFixture: { append: () => setExtra(true) } })
  return <main style={{ width: 720, maxWidth: '95vw', padding: 24, margin: 'auto' }}>
    <h2>Agent transcript</h2>
    <div className="msgs" style={{ maxHeight: 650, overflow: 'auto' }}>
      <SystemRuns entries={transcriptEntries(messages)} render={({ message, key }) =>
        <div data-probe-row={key}><Msg systemPart m={message} slug="fixture" nid="worker" /></div>} />
    </div>
  </main>
}
applyTheme('orgtree')
createRoot(document.getElementById('root')!).render(<Fixture />)
