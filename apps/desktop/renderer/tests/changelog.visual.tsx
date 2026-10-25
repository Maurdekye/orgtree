// changelog.visual.tsx — captures for docket
// changelog-window-one-row-per-version-pinnable-po: the Changelog panel on the
// latest release with its real notes and GitHub publish times (the repo's own
// release-notes files and docs/releases.json), an older release selected, the
// header's "Show this every time" checkbox cleared, the version list collapsed
// in a narrower window and opened, and the app menu with the Changelog entry
// below Usage history. The panel, menu and styles are the
// app's own; the engine's two reads are answered here from those rows.
// Browser-only fixture data: no engine, bridge or live org. The page has no
// clipboard: its APIs are replaced below, before anything renders.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChangelogModal, setChangelogAfterUpdateOn } from '../src/changelog'
import { OrgtreeMenu } from '../src/shell/menu'
import { fmtStamp } from '../src/timefmt'
import type { ChangelogEntry, ChangelogRow } from '../src/api'
import '../src/styles.css'
// the v3 shell's own sheet, loaded after styles.css as main.tsx loads it: the app menu's dropdown lives there
import '../src/shell.css'
// put in by tools/rig/changelog-visual.mjs: the repo's own notes for 4.4.4, 4.4.3 and 4.4.2, and the
// newest seven entries of docs/releases.json
declare const __CHANGELOG_NOTES__: string
declare const __CHANGELOG_RELEASES__: string

// ── no clipboard in this page ───────────────────────────────────────────────
const refused = () => Promise.reject(new DOMException('clipboard disabled in this fixture', 'NotAllowedError'))
Object.defineProperty(navigator, 'clipboard', { configurable: true,
  value: { readText: refused, writeText: refused, read: refused, write: refused } })
const exec = document.execCommand.bind(document)
document.execCommand = ((command: string, ...rest: unknown[]) =>
  /^(copy|cut|paste)$/i.test(command) ? false : exec(command, ...(rest as [boolean, string]))) as typeof document.execCommand

interface Listed { version: string; published_at: string; tagged_at: string }
const listed: Listed[] = JSON.parse(__CHANGELOG_RELEASES__)
// what the engine sends (crate::changelog): published releases at GitHub's publish time
const published: ChangelogRow[] = listed.map((r) => ({ version: r.version, released_at: r.published_at, notes: true }))
const NOTES: Record<string, string> = JSON.parse(__CHANGELOG_NOTES__)

window.fetch = (async (url: RequestInfo | URL) => {
  const u = new URL(String(url), 'http://fixture.invalid')
  if (u.pathname === '/api/changelog') {
    return new Response(JSON.stringify({ running: '4.4.5-alpha.6', time_source: 'published', releases: published }),
      { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const version = decodeURIComponent(u.pathname.replace(/^\/api\/changelog\//, ''))
  const row = published.find((r) => r.version === version)
  if (!row) return new Response(JSON.stringify({ detail: 'no row' }), { status: 404 })
  const notes = (NOTES[version] ?? `# Orgtree ${version}\n\nNotes for ${version}.\n`).replace(/\r\n/g, '\n')
  const entry: ChangelogEntry = { version: row.version, released_at: row.released_at, notes }
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
    /** a fresh opening of the panel, with Open changelog after updates on */
    open: () => { setChangelogAfterUpdateOn(true); setView('panel'); setMount((n) => n + 1) },
    menu: () => setView('menu'),
    /** for the probes: the rows' two times, and the app's own row format */
    listed, stamp: fmtStamp,
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
