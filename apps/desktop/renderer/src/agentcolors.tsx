import { useEffect, useRef, useState } from 'react'
import { desktop } from './desktop'
import { SetToggle } from './canvas/settingskit'
import { isAgentColorSource } from '../../../../packages/contracts/agent-colors'
import type { AgentColorSource } from '../../../../packages/contracts/agent-colors'

const STORAGE_KEY = 'orgtree-agent-colors'
const STORED_EVENT = 'orgtree:agent-colors-stored'
const CLASS = 'agent-colors-organization'
const hex = (value: string) => /^#[0-9a-f]{6}$/i.test(value)
const channels = (value: string) => [1,3,5].map(i => parseInt(value.slice(i, i + 2), 16))
const luminance = (value: string) => channels(value).reduce((sum, value, i) => {
  const n = value / 255, linear = n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4
  return sum + linear * [.2126, .7152, .0722][i]!
}, 0)
const ratio = (a: string, b: string) => {
  const x = luminance(a), y = luminance(b)
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05)
}
const contrastingInk = (background: string) => ratio('#000000', background) >= ratio('#ffffff', background) ? '#000000' : '#ffffff'
const blend = (accent: string, background: string, amount: number) => '#' + channels(accent).map((c, i) =>
  Math.round(c * amount + channels(background)[i]! * (1 - amount)).toString(16).padStart(2, '0')).join('')

/** Keep the chosen hue for text, moving toward black or white only as far as
 * needed for all core surfaces. Borders and activity marks keep the exact
 * selected accent; filled controls get their own contrasting label color. */
export function readableAgentAccent(accent: string, surfaces: string[]) {
  const minimum = (color: string) => Math.min(...surfaces.map(bg => ratio(color, bg)))
  const ink = contrastingInk(accent)
  if (minimum(accent) >= 4.5) return { text: accent, ink }
  const target = minimum('#000000') >= minimum('#ffffff') ? 0 : 255
  const mix = (n: number) => '#' + channels(accent).map(c => Math.round(c + (target - c) * n).toString(16).padStart(2, '0')).join('')
  let low = 0, high = 1
  for (let i = 0; i < 24; i++) {
    const middle = (low + high) / 2
    if (minimum(mix(middle)) >= 4.5) high = middle
    else low = middle
  }
  return { text: mix(high), ink }
}

function refreshAgentText() {
  const root = document.documentElement
  if (!root.classList.contains(CLASS)) {
    root.style.removeProperty('--org-agent-text'); root.style.removeProperty('--org-agent-ink'); root.style.removeProperty('--org-agent-count-ink')
    return
  }
  const computed = window.getComputedStyle(root)
  const value = (name: string) => computed.getPropertyValue(name).trim()
  const selected = value('--accent'), accent = hex(selected) ? selected : '#d97757'
  const measured = ['--bg', '--side', '--panel', '--panel-2', '--input'].map(value).filter(hex)
  const surfaces = measured.length ? measured : ['#1f1f1f', '#181818', '#252526', '#2d2d30', '#313131']
  // Selected/urgent rows also wash the surface with up to 21% accent.
  const colors = readableAgentAccent(accent, [...surfaces, ...surfaces.map(bg => blend(accent, bg, .21))])
  root.style.setProperty('--org-agent-text', colors.text)
  root.style.setProperty('--org-agent-ink', colors.ink)
  const panel = value('--panel-2')
  root.style.setProperty('--org-agent-count-ink', contrastingInk(blend(accent, hex(panel) ? panel : '#2d2d30', .42)))
}

export function applyAgentColorSource(value: unknown) {
  document.documentElement.classList.toggle(CLASS, value === 'organization')
  refreshAgentText()
}
function preference(value: unknown): AgentColorSource {
  const source = value && typeof value === 'object' ? (value as { agentColorSource?: unknown }).agentColorSource : null
  return isAgentColorSource(source) ? source : 'provider'
}
function watch(accept: (value: AgentColorSource) => void, failed: (e: unknown) => void = () => {}) {
  const bridge = desktop()
  if (!bridge) {
    const read = () => {
      let value: unknown
      try { value = localStorage.getItem(STORAGE_KEY) } catch { /* use the original provider colors */ }
      accept(isAgentColorSource(value) ? value : 'provider')
    }
    read()
    const storage = (e: StorageEvent) => { if (e.key === STORAGE_KEY || e.key === null) read() }
    window.addEventListener('storage', storage); window.addEventListener(STORED_EVENT, read)
    return () => { window.removeEventListener('storage', storage); window.removeEventListener(STORED_EVENT, read) }
  }
  let alive = true, revision = 0
  const stop = bridge.onEvent(e => { if (alive && e.type === 'preferences') { revision++; accept(preference(e.data)) } })
  const initial = revision
  void bridge.getPreferences().then(p => { if (alive && initial === revision) accept(preference(p)) })
    .catch(e => { if (alive && initial === revision) failed(e) })
  return () => { alive = false; stop() }
}
export function startAgentColorSync() {
  applyAgentColorSource('provider')
  const stop = watch(applyAgentColorSource)
  window.addEventListener('orgtree:visual-theme-changed', refreshAgentText)
  window.addEventListener('orgtree:contrast-changed', refreshAgentText)
  return () => {
    stop()
    window.removeEventListener('orgtree:visual-theme-changed', refreshAgentText)
    window.removeEventListener('orgtree:contrast-changed', refreshAgentText)
  }
}

export function AgentColorSetting() {
  const [source, setSource] = useState<AgentColorSource>('provider')
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const alive = useRef(false), revision = useRef(0)
  const accept = (value: AgentColorSource) => { revision.current++; setSource(value); applyAgentColorSource(value); setReady(true); setError('') }
  useEffect(() => {
    alive.current = true
    const stop = watch(accept, e => setError(`Could not load agent colors: ${String(e instanceof Error ? e.message : e)}`))
    return () => { alive.current = false; stop() }
  }, [])
  const change = async (value: AgentColorSource) => {
    const attempt = ++revision.current
    setBusy(true); setError('')
    try {
      const bridge = desktop()
      if (bridge) {
        const saved = await bridge.setPreferences({ agentColorSource: value })
        if (alive.current && attempt === revision.current) accept(preference(saved))
      } else {
        localStorage.setItem(STORAGE_KEY, value)
        window.dispatchEvent(new window.Event(STORED_EVENT))
      }
    } catch (e) {
      if (alive.current && attempt === revision.current) setError(`Could not save agent colors: ${String(e instanceof Error ? e.message : e)}`)
    } finally { if (alive.current) setBusy(false) }
  }
  return <>
    <SetToggle label="organization theme color for agents" checked={source === 'organization'} disabled={!ready || busy}
      onChange={value => void change(value ? 'organization' : 'provider')}
      hint={source === 'organization' ? 'Organization theme color: agents follow the selected visual theme.' : 'Provider colors: each agent keeps its provider color.'} />
    {error && <p role="alert">{error}</p>}
  </>
}
