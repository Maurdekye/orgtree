// appsrowhover.visual.tsx — the hover capture for USER 2026-10-27 mdba9ae69ac16 ("these buttons should highlight
// when hovered (+, gear)"; @item:orgtree/4-5-0-apps-list-stable-order-regardless-of-panel). The app's own Apps button
// and Apps list: two apps, each with one panel that is off; browser-only fixture data, no engine, bridge or live org.
// A red swatch in the bottom-left corner tells the driver the screenshot's byte order.
// tools/rig/appsrowhover-visual.mjs drives it.
import { createRoot } from 'react-dom/client'
import { AppsButton, AppsWorkspace } from '../src/canvas/apps/ui'
import { applyTheme, THEMES } from '../src/themes'
import { applyContrast } from '../src/contrast'
import { CONTRAST_THEMES } from '../../../../packages/contracts/contrast-theme'
import '../src/styles.css'

const slug = 'org'
const app = (id: string, name: string, description: string, created_at: string) => ({ id, name, description, rev: 1, permission_rev: 1,
  width: 360, height: 280, capabilities: [], permissions: {}, created_by: 'maker', updated_at: '', created_at,
  definition: { name, description, html: '<p>x</p>', initial_state: {}, capabilities: [], width: 360, height: 280 } })
// newest first: Caption placement is listed first, as in the user's screenshot
const apps = [app('captions', 'Caption placement', 'events', '2026-10-27T10:00:00Z'), app('notes', 'Notes', 'Saved notes', '2026-10-27T09:00:00Z')]
const panel = (id: string, appId: string, label: string) => ({ id, app: appId, label, rev: 1, open: false, running: false, state: {}, event_seq: 0,
  placement: { mode: 'float', x: 40, y: 40, width: 360, height: 280 }, used_at: '2026-10-27', updated_at: '', created_at: '2026-10-27T11:00:00Z' })
const panels = [panel('p1', 'captions', 'Lower third'), panel('p2', 'notes', 'Panel 1')]
const json = (out: unknown) => new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } })
window.fetch = (async (raw: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(raw), 'http://fixture.invalid')
  const input = init?.method === 'POST' ? JSON.parse(String(init.body)) : JSON.parse(url.searchParams.get('request') ?? '{}')
  if (input.action === 'list') return json({ items: input.kind === 'apps' ? apps : panels, next_cursor: null, new_count: 0 })
  if (input.action === 'app_get') return json(apps.find(a => a.id === input.app))
  if (input.action === 'events') return json({ events: [], next_cursor: null, oldest_retained: null })
  return json({ items: [], next_cursor: null })
}) as typeof fetch

const box = (el: Element | null | undefined) => { const r = el?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null }
const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
const ctx = canvas.getContext('2d', { willReadFrequently: true })!
/** a computed colour, in any CSS syntax, as [r, g, b, a] */
const rgba = (css: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = 'rgba(0,0,0,0)'; ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data] }
const BUTTONS = { plus: 'New panel for Caption placement', gear: 'Settings for Caption placement', panelGear: 'Settings for Lower third' }
const button = (key: keyof typeof BUTTONS) => document.querySelector<HTMLElement>(`.custom-apps-menu [aria-label="${BUTTONS[key]}"]`)
Object.assign(window, { appsRowHover: {
  themes: Object.keys(THEMES), contrasts: [...CONTRAST_THEMES],
  labels: Object.fromEntries(Object.entries(THEMES).map(([id, t]) => [id, t.label])),
  apply: (visual: string, contrast: string) => { applyTheme(visual); applyContrast(contrast) },
  ready: () => !!document.querySelector('.custom-apps-menu') && getComputedStyle(document.querySelector('.custom-apps-menu')!).visibility !== 'hidden' && !!button('plus') && !!button('panelGear'),
  /** where everything is, and what each button computes to now */
  probe: () => {
    const menu = document.querySelector<HTMLElement>('.custom-apps-menu')!, row = button('plus')!.closest('.custom-apps-menu-app')!
    const one = (key: keyof typeof BUTTONS) => { const el = button(key)!, cs = getComputedStyle(el)
      return { box: box(el), title: el.title, hover: el.matches(':hover'), focusVisible: el.matches(':focus-visible'), cls: el.className,
        background: rgba(cs.backgroundColor), color: rgba(cs.color), outline: cs.outlineStyle === 'none' ? null : { width: cs.outlineWidth, color: rgba(cs.outlineColor), offset: cs.outlineOffset } } }
    return { menu: box(menu), row: box(row), rowHover: row.matches(':hover'), rowBackground: rgba(getComputedStyle(row).backgroundColor),
      name: box(row.querySelector('.custom-apps-open b')), panelRow: box(button('panelGear')!.closest('.custom-apps-saved-row')),
      // the accent as + itself resolves it, which its focus ring uses
      menuBackground: rgba(getComputedStyle(menu).backgroundColor), accent: rgba(getComputedStyle(button('plus')!).getPropertyValue('--accent').trim()),
      plus: one('plus'), gear: one('gear'), panelGear: one('panelGear') }
  },
  /** keyboard focus onto + comes from the row's own open button, by Tab */
  focusBeforePlus: () => { button('plus')!.closest('.custom-apps-menu-app')!.querySelector<HTMLElement>('.custom-apps-open')!.focus(); return document.activeElement?.className },
  activeLabel: () => document.activeElement?.getAttribute('aria-label') ?? null,
  /** the background transitions settle before a frame is read */
  settled: () => Promise.all(document.getAnimations().map(a => a.finished.catch(() => null))).then(() => true),
} })

function Surface() {
  return <>
    <div style={{ position: 'fixed', left: 8, top: 8, display: 'flex' }}><AppsButton slug={slug} /></div>
    <AppsWorkspace slug={slug} />
    <div data-swatch style={{ position: 'fixed', left: 0, bottom: 0, width: 6, height: 6, background: 'rgb(255,0,0)' }} />
  </>
}
document.body.style.background = 'var(--bg)'
document.body.style.margin = '0'
createRoot(document.getElementById('root')!).render(<Surface />)
