import { createRoot } from 'react-dom/client'
import { CONTACT_NET, ContactLists, type ContactSurface } from './net-contact-lists.fixture'
import { setHubchatInstalled } from '../src/canvas/agentmentions'
import { setNetRoster } from '../src/canvas/netmentions'

window.fetch = (async (input: RequestInfo | URL) => new Response(JSON.stringify(
  String(input).endsWith('/api/desktop/phone') ? { hubchat_pc: true } : { entries: [], total: 0, transfers: [] }),
  { headers: { 'Content-Type': 'application/json' } })) as typeof fetch
setNetRoster('contact-fixture', CONTACT_NET); setHubchatInstalled(true)
const opened: string[] = []
window.open = ((url: string | URL | undefined) => { opened.push(String(url)); return null }) as typeof window.open
const root = createRoot(document.getElementById('root')!)
Object.assign(window, { contactFixture: {
  show: (surface: ContactSurface) => root.render(<ContactLists key={surface} surface={surface} />),
  installed: setHubchatInstalled, opened,
} })
root.render(<ContactLists surface="mailservers" />)
