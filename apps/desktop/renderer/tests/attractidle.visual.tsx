// attractidle.visual.tsx — capture fixture for
// @item:orgtree/attract-mode-only-canvas-interaction-interrupts-i (start-after field).
// App settings › Display, rendered by the app's own AccountsPanel and styles, scrolled to the
// Modes group: the Attract mode switch with the "Attract mode starts after" row directly under it.
//   window.attractIdleVisual.theme('light' | 'charcoal' | 'obsidian-black' | 'solarized-light')
//   window.attractIdleVisual.set('0')   types a value into the field (to show 0 / a large number / an invalid one)
// Browser-only data: no engine, bridge or live org; the clipboard is refused.
import { createRoot } from 'react-dom/client'
import { AccountsPanel } from '../src/canvas/accounts'
import { applyTheme } from '../src/themes'
import { applyContrast } from '../src/contrast'
import '../src/styles.css'
import '../src/shell.css'

const refused = () => Promise.reject(new DOMException('clipboard disabled in this fixture', 'NotAllowedError'))
const owned = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
if (!owned || owned.configurable) Object.defineProperty(navigator, 'clipboard', { configurable: true,
  value: { readText: refused, writeText: refused, read: refused, write: refused } })

;(window as unknown as { WebSocket: unknown }).WebSocket = class { onclose: (() => void) | null = null; close() { this.onclose?.() } }
window.fetch = (async (url: string, init?: RequestInit) => {
  const p = new URL(String(url), 'http://localhost').pathname
  const method = init?.method ?? 'GET'
  const payload = p === '/api/accounts' ? { version: 2, primary: null, keys: [], assignments: {}, accounts: [] }
    : p === '/api/providers' ? { providers: [] }
      : p === '/api/app-settings/runtime' && method === 'GET'
        ? { warming_enabled: true, verbose_logging: false, verbose_logging_pinned: false }
        : {}
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

;(window as unknown as { attractIdleVisual: unknown }).attractIdleVisual = {
  theme: (contrast: string, accent = 'claude') => { applyContrast(contrast); applyTheme(accent) },
  set: (v: string) => {
    const input = document.querySelector<HTMLInputElement>('[data-settings-field="attractIdleSeconds"] input')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  },
  reveal: () => document.querySelector('[data-settings-field="attractIdleSeconds"]')?.scrollIntoView({ block: 'center' }),
}
createRoot(document.getElementById('root')!).render(
  <div style={{ width: 760, margin: '0 auto' }}><AccountsPanel toast={() => {}} close={() => {}} initialTab="display" /></div>)
