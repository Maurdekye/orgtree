import { createRoot } from 'react-dom/client'
import { CollapsibleMailer } from '../src/canvas/narrowlist'
import { MovableSurface, PopoutButton, useSurface } from '../src/popout'
import { openSurfaces } from '../src/windowlife'
import '../src/styles.css'

function Contents() {
  const surface = useSurface()
  return <div className="proof-panel">
    <header><PopoutButton /><button onClick={() => surface?.redock()}>Return panel</button></header>
    <CollapsibleMailer collapsible listLabel="document list"
      list={<div className="mailer-list"><input defaultValue="Retained filter" /><button className="mailrow">Selected document</button></div>}>
      <div className="mailer-read"><h2>Selected document</h2><p>Reading and list state survive width changes.</p></div>
    </CollapsibleMailer>
  </div>
}
createRoot(document.getElementById('root')!).render(<MovableSurface org="synthetic-org" kind="sidebar-proof" title="Sidebar width proof"
  sourceBox={() => ({ x: 0, y: 0, w: 960, h: 620 })}><Contents /></MovableSurface>)
let original: Element | null = null
const proof = {
  snapshot() {
    const doc = openSurfaces()[0]?.window.document ?? document
    const box = doc.querySelector<HTMLElement>('.mailer')
    const input = box?.querySelector('input')
    if (!original && input) original = input
    return { width: box?.getBoundingClientRect().width ?? 0, narrow: box?.classList.contains('narrow-list') ?? false,
      toggle: !!box?.querySelector('.mailer-listtoggle'), sameInput: !!input && input === original,
      filter: input?.value, ownerIsPopout: doc !== document }
  },
  contentWidth(width: number | null) {
    const doc = openSurfaces()[0]?.window.document ?? document
    doc.querySelector<HTMLElement>('.proof-panel')!.style.width = width === null ? '' : width + 'px'
  },
}
Object.assign(window, { __sidebarProof: proof })
