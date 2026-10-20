import { createRoot } from 'react-dom/client'
import { TicketStaffFixture, item, preview } from './ticketstaffmenu.fixture'

const value = item()
const writes: string[] = []
Object.assign(window, { syntheticWrites: writes })
window.fetch = async (input, init) => {
  const url = String(input)
  if (init?.method === 'POST') writes.push(url)
  return new Response(JSON.stringify(url.endsWith('/quick-staff') ? preview(value)
    : url.includes('/work-items/') ? { item: value } : { providers: [] }))
}
createRoot(document.getElementById('root')!).render(<main style={{ padding: 36, fontFamily: 'Segoe UI, sans-serif' }}>
  <h2>Backlogged ticket · shared context menu</h2>
  <p>Synthetic docket row and transcript references</p>
  <TicketStaffFixture value={value} />
</main>)
