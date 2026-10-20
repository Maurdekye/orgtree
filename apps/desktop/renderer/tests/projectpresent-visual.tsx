import { createRoot } from 'react-dom/client'
import { CurrentOrg } from '../src/popout'
import { presentationChain, ProjectPresentationCards, ProjectPresentationHeaders } from './projectpresent.fixture'

const chain = presentationChain()
window.fetch = (async () => new Response(JSON.stringify({ items: [], documents: [], rows: [], total: 0, next_offset: null }),
  { headers: { 'Content-Type': 'application/json' } })) as typeof fetch
localStorage.clear()
const expected = chain.projects.map((p) => ({ node: p.id, documents: p.documents!.map((d) => d.id) }))
Object.assign(window, { expectedProjectDocuments: expected })
createRoot(document.getElementById('root')!).render(<CurrentOrg.Provider value="project-doc-fixture">
  <style>{`
    .project-doc-proof {padding:24px;font-family:Segoe UI,sans-serif}
    .project-doc-proof .cards {display:flex;gap:70px;margin:18px 25px 0;height:165px}
    .project-card-case {position:relative;width:230px;flex-shrink:0}
    .project-doc-proof .headers {display:flex;gap:16px}
    .project-header-case {width:306px;height:340px;border:1px solid var(--line);border-radius:6px;overflow:hidden;flex-shrink:0}
    .project-header-case .desk {position:relative!important;inset:auto!important;transform:none!important;width:100%!important;box-sizing:border-box}
    .project-doc-proof h3 {margin:12px 0}
  `}</style>
  <main className="project-doc-proof">
    <h2>Project presentations · own documents only</h2>
    <p className="dim">Synthetic chain: outer-project → middle-project → leaf-project → author</p>
    <h3>Canvas cards: one outer document · no middle documents · four leaf documents</h3>
    <div className="cards"><ProjectPresentationCards chain={chain} /></div>
    <h3>The same project desk headers</h3>
    <div className="headers"><ProjectPresentationHeaders chain={chain} /></div>
  </main>
</CurrentOrg.Provider>)
