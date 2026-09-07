// Browser fixture uses the real card components and URL construction.
import { createRoot } from 'react-dom/client'
import { DocChips, PresentationCard } from '../src/canvas/docs'

const id = new URLSearchParams(location.search).get('id') ?? 'missing'
const slug = new URLSearchParams(location.search).get('org') ?? 'mockup-probe'
const doc = { id, title: 'Interactive HTML prototype', at: '2026-09-06T16:00:00Z', format: 'html' as const }
createRoot(document.getElementById('app')!).render(<>
  <h1>Presentation cards</h1>
  <div className="desk-docs">
    <PresentationCard slug={slug} doc={doc} className="doc-badge"
      onOpen={() => { throw new Error('HTML incorrectly opened the markdown reader') }}>
      <span>{doc.title}</span>
    </PresentationCard>
  </div>
  <div style={{ position: 'relative', width: 80, height: 80 }}>
    <DocChips slug={slug} docs={[doc]}
      onOpen={() => { throw new Error('HTML incorrectly opened the markdown reader') }} />
  </div>
</>)
