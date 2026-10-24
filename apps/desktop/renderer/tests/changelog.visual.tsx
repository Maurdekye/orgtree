// changelog.visual.tsx — captures for docket
// changelog-window-one-row-per-version-pinnable-po: the Changelog panel on the
// latest release with its real notes (the repo's own release-notes files), a
// local alpha's build with its unpublished row on top, and the app menu with
// the Changelog entry below Usage history. The panel, menu and styles are the
// app's own; the engine's two reads are answered here from fixture rows.
// Browser-only fixture data: no engine, bridge or live org. The page has no
// clipboard: its APIs are replaced below, before anything renders.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChangelogModal } from '../src/changelog'
import { OrgtreeMenu } from '../src/shell/menu'
import type { ChangelogEntry, ChangelogRow } from '../src/api'
import '../src/styles.css'
// the v3 shell's own sheet, loaded after styles.css as main.tsx loads it: the app menu's dropdown lives there
import '../src/shell.css'
// the repo's own notes for 4.4.4, 4.4.3 and 4.4.2, put in by tools/rig/changelog-visual.mjs
declare const __CHANGELOG_NOTES__: string

// ── no clipboard in this page ───────────────────────────────────────────────
const refused = () => Promise.reject(new DOMException('clipboard disabled in this fixture', 'NotAllowedError'))
Object.defineProperty(navigator, 'clipboard', { configurable: true,
  value: { readText: refused, writeText: refused, read: refused, write: refused } })
const exec = document.execCommand.bind(document)
document.execCommand = ((command: string, ...rest: unknown[]) =>
  /^(copy|cut|paste)$/i.test(command) ? false : exec(command, ...(rest as [boolean, string]))) as typeof document.execCommand

const published: ChangelogRow[] = [
  { version: '4.4.4', released_at: '2026-10-24T02:58:37Z', unpublished: false, notes: true },
  { version: '4.4.3', released_at: '2026-10-23T13:05:20Z', unpublished: false, notes: true },
  { version: '4.4.2', released_at: '2026-10-23T07:41:02Z', unpublished: false, notes: true },
  { version: '4.4.1', released_at: '2026-10-23T03:30:09Z', unpublished: false, notes: true },
  { version: '4.4.0', released_at: '2026-10-22T17:44:41Z', unpublished: false, notes: true },
  { version: '4.3.3', released_at: '2026-10-19T11:30:12Z', unpublished: false, notes: true },
  { version: '4.3.2', released_at: '2026-10-17T16:55:40Z', unpublished: false, notes: true },
]
const alpha: ChangelogRow = { version: '4.4.5-alpha.4', released_at: '2026-10-24T18:01:12Z', unpublished: true, notes: false }
const NOTES: Record<string, string> = JSON.parse(__CHANGELOG_NOTES__)

let scenario: 'release' | 'alpha' = 'release'
window.fetch = (async (url: RequestInfo | URL) => {
  const u = new URL(String(url), 'http://fixture.invalid')
  const rows = scenario === 'alpha' ? [alpha, ...published] : published
  if (u.pathname === '/api/changelog') {
    return new Response(JSON.stringify({ running: rows[0]!.version, time_source: 'tagged', releases: rows }),
      { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const version = decodeURIComponent(u.pathname.replace(/^\/api\/changelog\//, ''))
  const row = rows.find((r) => r.version === version)
  if (!row) return new Response(JSON.stringify({ detail: 'no row' }), { status: 404 })
  const notes = NOTES[version] ?? (row.unpublished ? null : `# Orgtree ${version}\n\nNotes for ${version}.\n`)
  const entry: ChangelogEntry = { ...row, notes_version: notes ? version : null, notes: notes?.replace(/\r\n/g, '\n') ?? null }
  return new Response(JSON.stringify(entry), { status: 200, headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

function Fixture() {
  const [mount, setMount] = useState(0)
  const [view, setView] = useState<'panel' | 'menu'>('panel')
  ;(window as unknown as { changelogVisual: unknown }).changelogVisual = {
    /** dark or light contrast, as App settings › Display sets it */
    contrast: (light: boolean) => {
      document.documentElement.classList.toggle('contrast-light', light)
      document.documentElement.classList.toggle('contrast-charcoal', !light)
    },
    /** a fresh opening of the panel for the release or the alpha build */
    open: (which: 'release' | 'alpha') => { scenario = which; setView('panel'); setMount((n) => n + 1) },
    menu: () => setView('menu'),
  }
  return view === 'menu'
    ? <div data-fixture="menu" style={{ padding: 12 }}>
        <OrgtreeMenu orgs={[]} freshness="current" ageMs={0} error={null} currentOrg={null}
          onOpenOrg={() => {}} onNewWindow={() => {}} onCreateOrg={() => {}} onAppSettings={() => {}}
          onUsage={() => {}} onUsageHistory={() => {}} onChangelog={() => {}} />
      </div>
    : <div data-fixture="changelog" key={mount}><ChangelogModal close={() => {}} opening={mount} /></div>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
