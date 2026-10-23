import { createRoot } from 'react-dom/client'
import { CreateOrgView } from '../src/shell/createorg'
import { presetPlan, presetSummaries } from './templateavailability.fixture'
import '../src/styles.css'
import '../src/shell/shell.css'

// Disposable Create form, with every API response owned by this fixture.
// The driver holds each name request pending across rendered frames.
const requests: { name: string; reply: () => void }[] = []
let initial = true
window.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const u = new URL(String(url), 'http://fixture')
  const response = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  if (u.pathname.endsWith('/resolve')) {
    const body = JSON.parse(String(init!.body))
    return response(presetPlan(body.id, body.overrides))
  }
  if (u.pathname !== '/api/templates') throw Error('Unexpected fixture API: ' + u.pathname)
  const payload = { templates: presetSummaries(), dir: '/fixture', loading: false }
  if (initial) { initial = false; return response(payload) }
  return new Promise(resolve => requests.push({ name: u.searchParams.get('name') ?? '', reply: () => resolve(response(payload)) }))
}) as typeof fetch
Object.assign(window, { templateTyping: { requests } })
document.body.style.background = 'var(--bg)'
createRoot(document.getElementById('root')!).render(<CreateOrgView
  onCreated={() => { throw Error('No organization creation in this capture') }} onRequestClose={() => {}} />)
