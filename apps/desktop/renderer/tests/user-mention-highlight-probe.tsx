import { createRoot } from 'react-dom/client'
import { Msg } from '../src/canvas/desk'
import { applyTheme } from '../src/themes'
import { clearMentionHighlight, dismissUserMention, hasUnseenUserMention } from '../src/canvas/agentmentions'
import type { ChatMessage } from '../src/types'

applyTheme('orgtree')
const light = new URLSearchParams(location.search).get('theme') === 'light'
document.documentElement.classList.toggle('contrast-light', light)
window.fetch = async () => new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } })
const node = { id: 'worker', user_mention: { id: 'turn:row', event_id: 'reply-row' } }
const text = 'The update is ready, @user. Please review the summary when convenient.\n\nThe transcript keeps this whole reply highlighted after its attention is dismissed.'
const stored = JSON.parse(JSON.stringify({ role: 'assistant', text, tools: [] })) as ChatMessage
async function start() {
  await dismissUserMention('fixture', 'worker', 'turn:row', 'reply-row', { highlight: true })
  clearMentionHighlight('fixture', 'worker')
  const unseen = hasUnseenUserMention(node as never, 'fixture')
  createRoot(document.getElementById('root')!).render(<main style={{ padding: 18, color: 'var(--ink)', background: 'var(--bg)', minHeight: 480, boxSizing: 'border-box' }}>
    <h3 style={{ margin: '0 0 14px' }}>{light ? 'Light theme' : 'Dark theme'}</h3>
    <div style={{ fontSize: 12, color: 'var(--dim)', marginBottom: 18 }} data-attention={unseen ? 'unseen' : 'dismissed'}>Attention dismissed</div>
    <section className="msgs" style={{ gap: 14, overflow: 'visible', padding: 0 }}>
      <Msg m={stored} slug="fixture" nid="worker" />
      <Msg m={{ role: 'assistant', text: 'An ordinary reply remains unhighlighted.', tools: [] } as ChatMessage} slug="fixture" nid="worker" />
    </section>
  </main>)
}
void start()
