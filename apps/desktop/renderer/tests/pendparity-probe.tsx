// pendparity-probe.tsx — browser fixture for pendparity_probe.py.
//
// Renders the SAME mail rows through both real code paths side by side:
// settled transcript rows (Msg → typed-input → SegmentList → MailMessage)
// and pending rows (PendingMailRow / PendingGhostRow → MailMessage), inside
// the same .msgs column the desk uses. The driver then diffs COMPUTED styles
// pairwise in real Edge — the half of "visually identical" that jsdom
// structure tests cannot see.
import { createRoot } from 'react-dom/client'
import { Msg, PendingMailRow, PendingGhostRow } from '../src/canvas/desk'
import type { ChatMessage, PendingMail } from '../src/types'

const AT = '2026-09-10T12:00:00Z'
const rows: PendingMail[] = [
  { id: 'm0', from: '@user', kind: 'message', at: AT,
    body: 'A **markdown** message\n\nwith two paragraphs, a list:\n\n- one\n- two\n\nand some `inline code`.' },
  { id: 'm1', from: 'peer-agent', kind: 'question', at: AT,
    body: 'Peer question with a long unbroken token aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa and\n\n```\na code block\n```',
    attachments: [{ name: 'notes.txt', path: 'outbox/notes.txt', bytes: 1234 },
      { name: 'data.csv', path: 'outbox/data.csv' }] },
  { id: 'm2', from: '@system', kind: 'notice', at: AT, body: 'A passive *notice* row.' },
  { id: 'm3', from: '@user', kind: 'message', at: AT, body: 'The typed-copy case.' },
]

/** the user's actual 2026-09-10 case (image-34/35): the PENDING copy carries
 *  a typed `ev` while the settled transcript row does not — the pending side
 *  must still draw the transcript's plain card, not the event dress */
const typedPending = (r: PendingMail): PendingMail => r.id === 'm3'
  ? { ...r, ev: { v: 1, variant: 'ordinary.message',
      actor: { kind: 'user', id: '@user' }, object: null,
      engine_authored: false, body: r.body } } : r

const settledMsg = (mailRows: PendingMail[], key: string) =>
  <Msg key={key} m={{ role: 'user', text: '', seq: 1,
    segments: [{ kind: 'mail', rows: mailRows }] } as unknown as ChatMessage}
    slug="probe" nid="agent" />

createRoot(document.querySelector('#root')!).render(<div style={{ width: 720 }}>
  {/* settled: one transcript row per mail, exactly as the desk mounts them */}
  <div className="msgs" id="settled" style={{ height: 'auto', overflow: 'visible' }}>
    {rows.map((r, i) => settledMsg([r], 's' + i))}
  </div>
  {/* pending: the same rows as undelivered bubbles — receipt-tag form */}
  <div className="msgs" id="pending" style={{ height: 'auto', overflow: 'visible' }}>
    {rows.map(r => <PendingMailRow key={'p' + r.id} slug="probe" nid="agent"
      m={{ ...typedPending(r), delivering: true, stage: 'queued' }} />)}
  </div>
  {/* pending, retractable form (✕ button instead of the receipt) */}
  <div className="msgs" id="retract" style={{ height: 'auto', overflow: 'visible' }}>
    {rows.map(r => <PendingMailRow key={'r' + r.id} slug="probe" nid="agent"
      m={typedPending(r)} onRetract={() => {}} />)}
  </div>
  {/* the optimistic ghost of row 0, plus its failed form */}
  <div className="msgs" id="ghost" style={{ height: 'auto', overflow: 'visible' }}>
    <PendingGhostRow p={{ id: 1, text: rows[0]!.body, at: Date.parse(AT) }}
      slug="probe" nid="agent" onDismiss={() => {}} />
    <PendingGhostRow p={{ id: 2, text: rows[0]!.body, at: Date.parse(AT), failed: true }}
      slug="probe" nid="agent" onDismiss={() => {}} />
  </div>
  {/* two mails delivered by ONE turn, for the stacking-gap measurement */}
  <div className="msgs" id="settled-batch" style={{ height: 'auto', overflow: 'visible' }}>
    {settledMsg([rows[0]!, rows[2]!], 'batch')}
  </div>
</div>)
