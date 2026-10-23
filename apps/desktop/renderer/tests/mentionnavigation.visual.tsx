import { createRoot } from 'react-dom/client'
import { useEffect } from 'react'
import { ShortcutsSettings } from '../src/canvas/shortcutsettings'
import { MentionLanding, requestMentionLanding } from '../src/canvas/mentionlanding'
import { applyTheme } from '../src/themes'
window.fetch = async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })
function Fixture() {
  useEffect(() => { requestMentionLanding('fixture', {
    id: '1', cursor: '2026-10-22T23:00:00Z|1', at: '2026-10-22T23:00:00Z',
    target: { kind: 'work', item: 'release-notes', rev: 3 },
    blurb: 'Ready for review, @user. The release notes are complete.',
  }) }, [])
  return <main style={{ display: 'grid', gridTemplateColumns: '760px 550px', gap: 24, padding: 24, height: 740 }}>
    <section className="settings" style={{ overflow: 'auto', background: 'var(--surface)' }}><h2>Keyboard shortcuts</h2><ShortcutsSettings mac={false} /></section>
    <section><h2>Release notes</h2><div className="mailer-read" style={{ maxHeight: 600, overflow: 'auto', padding: 16 }}>
      <h3>Recorded mention</h3><MentionLanding org="fixture" kind="work" id="release-notes" />
      <p>The ticket description has since been edited. Its recorded mention is still available.</p>
    </div></section>
  </main>
}
applyTheme('custom:#b6bdc8')
createRoot(document.getElementById('root')!).render(<Fixture />)
