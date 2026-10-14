import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EMPTY_LAYOUT, TemplatePicker, type LayoutChoice } from '../src/shell/templatepicker'
import type { TemplatePlan } from '../src/api'
import { presetPlan, presetSummaries } from './templateavailability.fixture'
import '../src/styles.css'

// Standalone fake-data surface: no backend, provider, organization or bridge.
window.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {}
  const payload = String(url).includes('/resolve') ? presetPlan(body.id, body.overrides) :
    { templates: presetSummaries(), dir: '/fixture', loading: false }
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

function Surface() {
  const [choice, setChoice] = useState<LayoutChoice>(EMPTY_LAYOUT)
  const [plan, setPlan] = useState<TemplatePlan | null>(null)
  useEffect(() => {
    Object.assign(window, { presetVisual: {
      select: (id: string) => setChoice({ ...EMPTY_LAYOUT, id }),
      contrast: (light: boolean) => {
        document.documentElement.classList.toggle('contrast-light', light)
        document.documentElement.classList.toggle('contrast-charcoal', !light)
      },
    } })
  }, [])
  return <main className="settings" style={{ margin: '24px auto', width: 940, maxWidth: 'calc(100vw - 48px)' }}>
    <h2>Create organization</h2>
    <TemplatePicker choice={choice} onChange={setChoice} plan={plan} onPlan={setPlan} orgName="Availability" dirs={[]} />
  </main>
}
document.body.style.background = 'var(--bg)'
createRoot(document.getElementById('root')!).render(<Surface />)
