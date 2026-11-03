import { sensitiveSpans, STREAMER_HIDDEN } from '../../../../packages/contracts/streamer'

export interface StreamerBoundary {
  update(on: boolean, known?: readonly string[], ready?: boolean): void
  dispose(): void
}
// Content surfaces only. The canvas's wire <canvas>, its edges <svg> and every
// icon are app chrome: covering them hid the whole canvas behind one opaque
// slab (USER 2026-11-03 m84db138f69e6 "i cant see anything at all").
const OPAQUE = 'iframe,img,video,object,embed'
const STYLE = `
html.streamer-on ::highlight(streamer-sensitive){color:transparent!important;background-color:#686868!important;text-shadow:none!important}
html.streamer-on ::selection{color:transparent!important;text-shadow:none!important;background:#686868!important}
html.streamer-on input:not([type=file]):not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]),
html.streamer-on textarea,html.streamer-on select,html.streamer-on [contenteditable=true]{color:transparent!important;text-shadow:none!important;-webkit-text-fill-color:transparent!important}
html.streamer-on input::placeholder,html.streamer-on textarea::placeholder{color:transparent!important}
html.streamer-on input::-webkit-datetime-edit{color:transparent!important}
html.streamer-on input[type=color]::-webkit-color-swatch{background:#686868!important}
html.streamer-on *{background-image:none!important}
html.streamer-on *::before,html.streamer-on *::after{content:none!important}
html.streamer-on :is(${OPAQUE}):not([data-streamer-revealed]){visibility:hidden!important}
html.streamer-textless body :not([data-streamer-ui],[data-streamer-ui] *){color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}
[data-streamer-ui]{font:13px system-ui!important;color:#fff!important;-webkit-text-fill-color:#fff!important;background:#292929!important;text-shadow:none!important;box-sizing:border-box!important}
[data-streamer-ui] button{color:var(--ink)!important;-webkit-text-fill-color:currentColor!important;background:var(--input)!important;border:1px solid var(--line)!important;border-radius:4px;cursor:pointer}
[data-streamer-ui] button:hover{border-color:var(--button-accent)!important}
[data-streamer-ui] button:focus-visible{outline:2px solid var(--button-accent);outline-offset:2px}
[data-streamer-cover]{position:absolute;z-index:1;display:flex;align-items:center;justify-content:center;gap:8px;overflow:hidden;border:1px solid #888}
[data-streamer-banner]{position:fixed;z-index:2147483647;right:8px;bottom:8px;padding:7px 10px;border:1px solid #888;border-radius:4px}
`
type HighlightWindow = Window & Pick<typeof globalThis, 'MutationObserver'> & { Highlight?: new (...ranges: Range[]) => unknown; CSS?: { highlights?: { set(k: string, v: unknown): void; delete(k: string): void } } }
export function installStreamerBoundary(doc: Document, turnOff?: () => void): StreamerBoundary {
  const win = doc.defaultView as HighlightWindow | null
  if (!win) return { update() {}, dispose() {} }
  const style = doc.createElement('style'); style.dataset.streamerStyle = ''; style.textContent = STYLE; doc.head.appendChild(style)
  let active = false, known: readonly string[] = [], ready = true, originalTitle = doc.title, frame = 0
  const covered = new Map<Element, HTMLElement>(), revealed = new Set<Element>()
  const attributes = new Map<Element, Map<string, string>>()
  const autocomplete = new Map<Element, string | null>()
  const banner = doc.createElement('div'); banner.dataset.streamerUi = ''; banner.dataset.streamerBanner = ''; banner.setAttribute('role', 'status')
  const bannerLabel = doc.createElement('span'); banner.appendChild(bannerLabel)
  if (turnOff) { const off = doc.createElement('button'); off.type = 'button'; off.textContent = 'Turn off'; off.onclick = turnOff; banner.appendChild(off) }
  function position() {
    let reopened = false
    for (const el of revealed) if (!el.isConnected || !el.getClientRects().length) {
      el.removeAttribute('data-streamer-revealed'); revealed.delete(el); reopened = true
    }
    if (reopened) scan()
    for (const [el, cover] of covered) place(el as HTMLElement, cover)
    if (active && win?.requestAnimationFrame) frame = win.requestAnimationFrame(position)
  }
  // A cover is the hidden element's next sibling, in the same stacking context:
  // whatever the app draws above that surface (menus, settings, modals) stays
  // above its cover. It never becomes a window-wide topmost layer.
  function place(el: HTMLElement, cover: HTMLElement) {
    if (cover.previousSibling !== el) el.after(cover)
    if (!el.getClientRects().length) { cover.style.display = 'none'; return }
    cover.style.display = ''
    let left = el.offsetLeft, top = el.offsetTop
    if (el.offsetParent !== cover.offsetParent) {
      const r = el.getBoundingClientRect(), base = (cover.offsetParent ?? doc.documentElement).getBoundingClientRect()
      left = r.left - base.left; top = r.top - base.top
    }
    Object.assign(cover.style, { left: `${left}px`, top: `${top}px`, width: `${el.offsetWidth}px`, height: `${el.offsetHeight}px` })
  }
  function restore() {
    doc.documentElement.classList.remove('streamer-on', 'streamer-textless')
    win?.CSS?.highlights?.delete('streamer-sensitive')
    for (const cover of covered.values()) cover.remove()
    covered.clear()
    for (const el of revealed) el.removeAttribute('data-streamer-revealed')
    revealed.clear()
    for (const [el, attrs] of attributes) for (const [key, value] of attrs) if (el.getAttribute(key) === STREAMER_HIDDEN) el.setAttribute(key, value)
    attributes.clear(); banner.remove()
    for (const [el, value] of autocomplete) if (el.getAttribute('autocomplete') === 'off') {
      if (value === null) el.removeAttribute('autocomplete'); else el.setAttribute('autocomplete', value)
    }
    autocomplete.clear()
    if (doc.title === 'Orgtree — Streamer mode') doc.title = originalTitle
    if (frame) win?.cancelAnimationFrame(frame)
    frame = 0
  }
  function scan() {
    if (!active || !doc.body) return
    // Virtualized transcripts must not retain detached history through our restoration maps.
    for (const [el, attrs] of attributes) if (!el.isConnected) {
      for (const [key, value] of attrs) if (el.getAttribute(key) === STREAMER_HIDDEN) el.setAttribute(key, value)
      attributes.delete(el)
    }
    for (const [el, value] of autocomplete) if (!el.isConnected) {
      if (el.getAttribute('autocomplete') === 'off') { if (value === null) el.removeAttribute('autocomplete'); else el.setAttribute('autocomplete', value) }
      autocomplete.delete(el)
    }
    doc.documentElement.classList.add('streamer-on')
    const supported = !!win?.Highlight && !!win.CSS?.highlights
    // Masking fails per value, never per window: unready identities keep the
    // pattern and known-value masks; without the Highlight API only text paint
    // is withheld, and layout, controls and the Turn off button stay usable.
    doc.documentElement.classList.toggle('streamer-textless', !supported)
    bannerLabel.textContent = !supported ? 'Streamer mode — text hidden: this window cannot mask single values'
      : ready ? 'Streamer mode' : 'Streamer mode — some account names may still be visible'
    if (!banner.isConnected) doc.body.appendChild(banner)
    if (doc.title !== 'Orgtree — Streamer mode') { originalTitle = doc.title; doc.title = 'Orgtree — Streamer mode' }
    for (const el of doc.querySelectorAll('input,textarea,select')) {
      const value = el.getAttribute('autocomplete')
      if (value !== 'off') { autocomplete.set(el, value); el.setAttribute('autocomplete', 'off') }
    }
    for (const el of doc.querySelectorAll('[title],[alt],[aria-label]')) {
      if (el.closest('[data-streamer-ui]')) continue
      for (const key of ['title', 'alt', 'aria-label']) {
        const value = el.getAttribute(key)
        if (value && value !== STREAMER_HIDDEN) {
          let attrs = attributes.get(el); if (!attrs) { attrs = new Map(); attributes.set(el, attrs) }
          attrs.set(key, value); el.setAttribute(key, STREAMER_HIDDEN)
        }
      }
    }
    for (const [el, cover] of covered) if (!el.isConnected) { cover.remove(); covered.delete(el) }
    for (const el of revealed) if (!el.isConnected) { el.removeAttribute('data-streamer-revealed'); revealed.delete(el) }
    for (const el of doc.querySelectorAll(OPAQUE)) {
      if (el.closest('[data-streamer-ui]') || revealed.has(el) || covered.has(el) || el.parentElement?.closest(OPAQUE)) continue
      const cover = doc.createElement('div'); cover.dataset.streamerUi = ''; cover.dataset.streamerCover = ''
      const label = doc.createElement('span'); label.textContent = STREAMER_HIDDEN
      const dismiss = doc.createElement('button'); dismiss.type = 'button'; dismiss.className = 'icon-btn'; dismiss.dataset.streamerDismiss = ''
      dismiss.textContent = '×'; dismiss.setAttribute('aria-label', 'Dismiss cover for this surface')
      dismiss.title = 'Reveal this surface until it closes or Streamer mode restarts'
      dismiss.onclick = () => { revealed.add(el); el.setAttribute('data-streamer-revealed', ''); cover.remove(); covered.delete(el) }
      // Inside a link or button, a click on the cover must not activate the hidden surface's owner.
      cover.addEventListener('click', e => { e.preventDefault(); e.stopPropagation() })
      cover.append(label, dismiss); covered.set(el, cover); place(el as HTMLElement, cover)
    }
    if (!frame) position()
    if (!supported) return
    const nodes: { node: Text; start: number; end: number }[] = []
    let text = '', block: Element | null = null
    const walker = doc.createTreeWalker(doc.body, 4)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const node = n as Text, parent = node.parentElement
      if (!parent || parent.closest('script,style,textarea,select,[contenteditable=true],[data-streamer-ui]')) continue
      const nextBlock = parent.closest('p,div,li,pre,td,th,section,h1,h2,h3,h4,button,label')
      if (nextBlock !== block) { text += '\n'; block = nextBlock }
      const start = text.length; text += node.data; nodes.push({ node, start, end: text.length })
    }
    const ranges: Range[] = []
    let firstIndex = 0, lastIndex = 0
    for (const span of sensitiveSpans(text, known)) {
      while (nodes[firstIndex] && nodes[firstIndex]!.end <= span.start) firstIndex++
      lastIndex = Math.max(firstIndex, lastIndex)
      while (nodes[lastIndex] && nodes[lastIndex]!.end < span.end) lastIndex++
      const first = nodes[firstIndex], last = nodes[lastIndex]
      if (!first || !last) continue
      const range = doc.createRange(); range.setStart(first.node, span.start - first.start); range.setEnd(last.node, span.end - last.start); ranges.push(range)
    }
    win!.CSS!.highlights!.set('streamer-sensitive', new win!.Highlight!(...ranges))
  }
  const observer = new win.MutationObserver(records => {
    if (!active) return
    // A close/reopen can remove and reinsert the same runtime node in one turn.
    for (const record of records) for (const removed of record.removedNodes) for (const el of revealed) {
      if (removed.contains(el)) { el.removeAttribute('data-streamer-revealed'); revealed.delete(el) }
    }
    if (records.every(r => (r.target.nodeType === 1 ? r.target as Element : r.target.parentElement)?.closest('[data-streamer-ui]'))) return
    scan()
  })
  observer.observe(doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'alt', 'aria-label', 'autocomplete'] })
  return {
    update(on, values = [], hydrated = true) { if (!on) { active = false; restore(); return } active = true; known = values; ready = hydrated; scan() },
    dispose() { active = false; observer.disconnect(); restore(); style.remove() },
  }
}
