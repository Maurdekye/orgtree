import { createRoot } from 'react-dom/client'
import { ComposerFocusFixture, seedComposer } from './composerfocus-fixture'
import '../src/styles.css'
import '../src/shell.css'

seedComposer()
globalThis.fetch = async () => new Response(JSON.stringify({ messages: [], live: [], pending_mail: [],
  busy: false, responding: false, windowed: true, has_older: false, before: null, draft_epoch: 'synthetic:0' }),
{ headers: { 'Content-Type': 'application/json' } })
document.documentElement.dataset.theme = 'dark'
createRoot(document.getElementById('root')!).render(<>
  {/* Keep the real composer and its layout intact; omit unrelated desk content
      so the entire 32-row input fits into a Session 0 capture. */}
  <style>{`
    [data-grow] *:not(:has(.cc-composer)):not(.cc-composer):not(.cc-composer *) { display:none!important; }
    [data-grow] *:has(.cc-composer) { display:block!important;height:auto!important;min-height:0!important;padding:0!important;margin:0!important; }
  `}</style>
  <div style={{ display: 'flex', gap: 12, padding: 10 }}>
    {(['agent', 'project'] as const).map(surface => <article key={surface} style={{ flex: 1, minWidth: 0 }}>
      <h4 style={{ margin: '0 0 8px' }}>{surface} composer</h4>
      <section data-grow={surface}><ComposerFocusFixture surface={surface}/></section>
    </article>)}
  </div>
</>)
