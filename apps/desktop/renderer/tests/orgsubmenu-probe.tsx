// orgsubmenu-probe.tsx — the ☰ menu's "Open organization…" submenu, mounted
// with the app's real stylesheets for `orgsubmenu_probe.py` to measure and
// photograph in a real browser (docket
// v3-menu-open-organization-opens-a-submenu-to-the).
//
// Scenes, picked by the URL hash:
//   #left   the menu at the window's left edge, as in a real header
//   #right  the menu near the RIGHT edge, where the submenu must flip left
//           (placed so the main panel itself still fits in the window)
import { createRoot } from 'react-dom/client'
import '../src/App'
import '../src/styles.css'
import '../src/shell.css'
import { OrgtreeMenu } from '../src/shell/menu'
import type { OrgListEntry } from '../src/types'

const entry = (slug: string, name: string, working: number, live: number): OrgListEntry => ({
  slug, name, nodes: live, live, working, kiosk: false, created: null,
} as OrgListEntry)
const ORGS = [
  entry('maurdekye-works', 'Maurdekye Works', 0, 3),
  entry('orgtree', 'Orgtree', 2, 23),
  entry('resonite', 'Resonite', 0, 1),
  entry('unity', 'Unity', 0, 1),
]

const scene = location.hash.replace(/^#/, '') || 'left'
const host = document.getElementById('root')!
host.style.cssText = 'position:absolute;inset:0'
const bar = document.createElement('div')
// #right: the main panel (260px) still fits, its submenu (240px+) does not
bar.style.cssText = 'position:absolute;top:8px;display:flex;'
  + (scene === 'right' ? 'right:300px' : 'left:12px')
host.appendChild(bar)
const opened: string[] = []
;(window as unknown as { opened: string[] }).opened = opened
createRoot(bar).render(
  <OrgtreeMenu orgs={ORGS} freshness="current" ageMs={0} error={null}
    currentOrg="maurdekye-works"
    isOpenElsewhere={(s) => s === 'orgtree'}
    onOpenOrg={(s) => opened.push(s)} onNewWindow={() => {}} onCreateOrg={() => {}}
    onUsage={() => {}} onAppSettings={() => {}} />)
