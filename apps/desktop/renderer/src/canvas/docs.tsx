import { AgentGalleryModal } from './gallery'
import { DocumentDownload, downloadDocument } from './download'
// canvas/docs.tsx — FR-03: presented documents (user request 2026-08-05).
// An agent presents a plan/report with orgtree_present; a small card pops
// out the SIDE of its node, and clicking it opens the markdown in-page for
// review. A reading surface, not a download (orgtree_send_file is the
// download path). The tree payload carries metadata only — the reader
// fetches the body on open.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import type { ToastFn } from '../types'
import { dismissDocument, fileBase, getDocument, getPresentationHtml, mockupUrl } from '../api'
import { md } from './shared'
import { RefMdBody } from './refmd'
import type { RefWorld, ResolvedRef } from './reflinks'
import { openLightboxIfEligibleImage } from './lightbox'
import { PinFrame } from './modalpin'
import { docUnread, markDocViewed, useDocViewedVersion } from './docviewed'
import { CloseIcon, DocIcon } from '../icons'
import { fmtFull } from '../timefmt'
import { copyToClipboard, useContextMenu } from './contextmenu'
import type { MenuEntry } from './contextmenu'
import { refToken } from './reflinks'
import { nodeMenuAction } from './identity'
import { useAgentNavRegistry } from './agentnav'
import type { AgentNavMenu } from './agentnav'
import { objectTooltipProps } from './objecttooltip'
import { captureObjectActions } from './composerobjects'

export interface DocMeta { id: string; title: string; at: string; viewed_at?: string | null; format?: 'markdown' | 'html'; bytes?: number; node?: string; presented_by?: string; presenter_tier?: string | null }

/** The tree feed is newest first. Both compact surfaces show its first four
 *  presented documents; sent files belong to the separate deliveries feed. */
export function recentDocumentChips(docs: readonly DocMeta[]): DocMeta[] {
  return docs.slice(0, 4)
}

export interface LoadedDoc { node_state?: 'live' | 'archived' | 'unrecoverable' | 'deleted'; tier?: string | null; presented_by?: string; presenter_tier?: string | null; title: string; node: string; at: string; body: string; format?: 'markdown' | 'html'; bytes?: number }

/** Reuse the ticket Owner action's canonical node menu, focus gate and tooltip.
 * The owning surface reads the shared window registry at menu-open time. */
export function presentationIdentityActions(el: Element | null,
  doc: {node?: string; presented_by?: string}, nodeMenu?: AgentNavMenu, toast?: ToastFn): MenuEntry[] {
  if (!el) return []
  const presenter = doc.presented_by || doc.node
  const identities = [['Presenter…', presenter],
    ...(doc.node && presenter && doc.node !== presenter ? [['Project…', doc.node]] : [])]
  return identities.flatMap(([label, name]) => {
    const action = nodeMenuAction(label!, el, name, name ? nodeMenu?.(name, el) ?? [] : [], toast)
    return action ? [action] : []
  })
}

/** Stored HTML format has the same compact identity on every presentation surface.
 *  Users see "</> HTML" ("</>" compact), never "mockup" (user 2026-10-26 21:34Z
 *  mb8b511d41e12) and no longer "presentation" either (user 2026-10-27
 *  mbebb35945cb1, "remove the word presentation from here"); the accessible
 *  name still says "HTML presentation". The component, class and route names
 *  stay internal. */
export function MockupBadge({ compact = false }: { compact?: boolean }) {
  return <span className={'mockup-format' + (compact ? ' compact' : '')}
    aria-label="HTML presentation"><span aria-hidden="true">{'</>'}</span>
    {!compact && ' HTML'}</span>
}

/** Both source formats use the engine attachment route and its filename. */
export function downloadDocMarkdown(el: Element | null, slug: string, docId: string,
  toast?: ToastFn): Promise<void> {
  return downloadDocument(el?.ownerDocument ?? document, slug, docId, docId, 'markdown')
    .catch((e: Error) => { toast?.([`could not download the document: ${e.message}`]) })
}

/** The presentation context menu's entries, shared by every surface that
 *  lists a card — the canvas chips, the desk badges, the two galleries. Each
 *  entry is an action that surface already has; a surface without one (no
 *  reader, no dismiss) passes nothing for it and the entry is absent. */
export function presentationMenu(el: Element | null, slug: string,
  doc: { id: string; title: string; format?: 'markdown' | 'html'; evicted?: boolean; node?: string; presented_by?: string },
  acts: {
    open?: () => void
    openLabel?: string
    reply?: () => void
    replyLabel?: string
    toast?: ToastFn
    dismiss?: () => void
    nodeMenu?: AgentNavMenu
    composer?: ReturnType<typeof captureObjectActions>
  }): MenuEntry[] {
  const html = doc.format === 'html'
  const gone = Boolean(doc.evicted)
  const composer = acts.composer ?? captureObjectActions(el, refToken({ kind: 'doc', org: slug, id: doc.id }))
  const entries: MenuEntry[] = []
  if (composer.mention && !gone) entries.push({ label: 'Mention', onSelect: composer.mention })
  if (composer.reply && !gone) entries.push({ label: 'Reply', onSelect: () => composer.reply!({
    kind: 'document', org: slug, id: doc.id, title: doc.title, sender: doc.node,
  }) })
  if (acts.open) entries.push({ label: acts.openLabel ?? 'Open reader', onSelect: acts.open })
  if (html && !gone) {
    entries.push({
      label: 'Open HTML presentation in a new window',
      onSelect: () => {
        const win = el?.ownerDocument.defaultView ?? window
        win.open(mockupUrl(slug, doc.id), '_blank', 'noopener,noreferrer')
      },
    })
  }
  if (!composer.reply && acts.reply && !gone) entries.push({ label: acts.replyLabel ?? 'Reply', onSelect: acts.reply })
  entries.push(...presentationIdentityActions(el, doc, acts.nodeMenu, acts.toast))
  const copied = (what: string) => (ok: boolean) =>
    acts.toast?.([ok ? `copied ${what}` : `could not copy ${what} — clipboard unavailable`])
  const ref = refToken({ kind: 'doc', org: slug, id: doc.id })
  entries.push('sep',
    { label: 'Copy title', disabled: !doc.title,
      onSelect: () => { void copyToClipboard(el, doc.title).then(copied('the title')) } },
    { label: 'Copy reference', title: ref,
      onSelect: () => { void copyToClipboard(el, ref).then(copied('the reference ' + ref)) } })
  if (!gone) {
    entries.push({ label: html ? 'Download HTML presentation' : 'Download as Markdown',
      onSelect: () => { void downloadDocument(el?.ownerDocument ?? document, slug, doc.id, doc.title, doc.format)
        .catch((e: Error) => acts.toast?.([e.message])) } })
  }
  if (acts.dismiss && !gone) {
    entries.push('sep', { label: 'Dismiss', danger: true, onSelect: acts.dismiss,
      title: 'remove the card (the document is gone)' })
  }
  return entries
}

/** The same activation in the canvas chips and titled desk cards. Markdown
 *  and HTML both open the owning agent collection; the preview is inside it. */
export function PresentationCard({ slug, doc, onOpen, onReply, replyLabel, className, children, compact = false, toast, inert = false, direct = false }: {
    slug: string; doc: Pick<DocMeta, 'id' | 'title' | 'format' | 'node' | 'presented_by'> & { at?: string; viewed_at?: string | null }; onOpen: (id: string) => void
  onReply?: () => void
  replyLabel?: string
  className: string; children: ReactNode; compact?: boolean
  /** for the context menu's copy/download confirmations; optional because
   *  the canvas chips have no toast to hand */
  toast?: ToastFn
  /** SHOWN BUT NOT OPERABLE — why, and at which zoom, is at the DocChips
   *  call site in canvas/cards.tsx.
   *
   *  A span, not a disabled button: at this zoom the chip is not an action at
   *  all, so there is nothing to disable and nothing to announce as
   *  unavailable. It carries no role, is not focusable, has no handlers — so
   *  the press it used to swallow reaches the card — and is aria-hidden,
   *  because a mark that means "this agent has presented something" is
   *  already carried by the agent's own controls at a zoom where they exist. */
  inert?: boolean
  /** an HTML mockup opens straight in its own window on one click (the desk
   *  header badges and the canvas chips); every other surface keeps the
   *  reader, whose mockup link is the second click */
  direct?: boolean
}) {
  // the card's context menu (contextmenu.tsx): the same open the click does,
  // plus copy/download. No dismiss here — that control lives in the reader
  // and the gallery pane, and this chip has neither's confirmation context.
  const menu = useContextMenu()
  const nodeNav = useAgentNavRegistry()
  useDocViewedVersion()
  const unread = docUnread(slug, doc.id, doc.at, doc.viewed_at)
  const open = (e?: ReactMouseEvent<HTMLElement>) => {
    markDocViewed(slug, doc.id, doc.at)
    if (direct && doc.format === 'html') {
      const win = e?.currentTarget.ownerDocument.defaultView ?? window
      win.open(mockupUrl(slug, doc.id), '_blank', 'noopener,noreferrer')
    } else onOpen(doc.id)
  }
  const onContextMenu = (e: ReactMouseEvent<HTMLElement>) => {
    const anchor = e.currentTarget
    const nodeMenu: AgentNavMenu = (id, el) => nodeNav?.current?.(id, el) ?? []
    const actions = {
      composer: captureObjectActions(anchor, refToken({ kind: 'doc', org: slug, id: doc.id })),
      open: () => onOpen(doc.id), reply: onReply, replyLabel, toast, nodeMenu,
    }
    const opening = menu.open(e, () => presentationMenu(anchor, slug, doc, actions))
    // Old tree payloads and transcript cards carry only a document id. Resolve
    // their recorded attribution on demand; append is guarded by this opening.
    if (opening !== undefined && (!doc.node || !doc.presented_by)) {
      void getDocument(slug, doc.id).then(meta => {
        menu.replace(presentationMenu(anchor, slug, { ...doc, ...meta }, actions), opening)
      }).catch(() => {}) // existing reader/copy/download actions remain available
    }
  }
  const body = <>{doc.format === 'html' && <MockupBadge compact={compact} />}{children}</>
  const mark = unread ? ' doc-' + unread : ''
  if (inert) return <span className={className + ' inert' + mark} data-doc-id={doc.id} data-doc-unread={unread ?? undefined} aria-hidden="true">{body}</span>
  return <button className={className + mark} data-doc-id={doc.id} data-doc-unread={unread ?? undefined}
    {...objectTooltipProps('document', doc.id, slug)} title={doc.title}
    onPointerDown={(e) => e.stopPropagation()}
    onClick={(e) => { e.stopPropagation(); open(e) }}
    onContextMenu={onContextMenu}>{body}{menu.node}</button>
}

/** History rows keep a plain link; no surface puts HTML into the app's own DOM. */
export function MockupOpen({ slug, docId }: { slug: string; docId: string }) {
  return <div className="mockup-open">
    <a href={mockupUrl(slug, docId)} target="_blank" rel="noopener noreferrer">
      Open HTML presentation in a new window
    </a>
  </div>
}

/** INLINE HTML PRESENTATIONS (user 2026-10-26 21:33Z m027a7754ab06; "yes"
 *  21:36:52Z m180c5c6cad58). The reader shows the SELECTED presentation in
 *  its pane; a list never renders one. It borrows only the chat HTML reply's
 *  isolation (htmlresponse.ts), never the custom-app panel model:
 *  - sandbox="allow-scripts" and nothing else: an opaque origin with no app
 *    DOM, storage, forms, popups, modals or top navigation;
 *  - the window viewer's own CSP (http/docs.rs `mockup`) as the frame
 *    document's first element: no network, inline and data: scripts and
 *    styles only, data:/blob: media;
 *  - the main session cancels every subframe request that is not about:
 *    (main/windows.ts configureEngineSession), closing CSP's navigation gap,
 *    and signs and permits only the app's own top frame.
 *  ONE-WAY (user 21:36:16Z m2da6e3eb205d, mc5f0c7fac8ff): presentations and
 *  apps stay separate features. Nothing in the app listens to this frame;
 *  the reader only posts its Fit width / 100% choice INTO it.
 *  Size: up to 4 MiB of stored preview, the existing HTML presentation limit
 *  (provisional, liaison/user 2026-10-26). A larger preview, possible only for
 *  a folder bundle's inlined assets, opens in its window alone. */
export const HTML_PRESENTATION_INLINE_MAX = 4 * 1024 * 1024

/** The window viewer's policy as a meta element. Its sandbox is the frame's
 *  attribute, frame-ancestors has no meta form, and base-uri admits only the
 *  about:srcdoc base, which keeps `#section` links inside the document. */
const PRESENTATION_CSP = "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; "
  + "style-src 'unsafe-inline' data:; script-src 'unsafe-inline' data:; connect-src 'none'; "
  + "form-action 'none'; frame-src 'none'; base-uri about:"

/** The frame's own script, first in its document.
 *  - Fit width: content wider than the frame is scaled down to the frame's
 *    width by CSS zoom on the root, measured unzoomed, and fitted again on
 *    resize, load and structural changes. The setting arrives only by a
 *    message from the parent.
 *  - A link click that would leave the document does nothing, as in the
 *    window viewer (main/index.ts openArtifact prevents its navigations);
 *    otherwise the main session's guard would cancel it and leave an error
 *    page in the frame. Same-document #fragment and javascript: links work. */
const FRAME_SCRIPT = "(()=>{'use strict';let fit=__FIT__;const root=document.documentElement;let queued=0;"
  + "const apply=()=>{queued=0;root.style.removeProperty('zoom');if(!fit)return;"
  + "const w=root.scrollWidth,v=root.clientWidth;if(v>0&&w>v+1)root.style.setProperty('zoom',String(v/w))};"
  + "const later=()=>{if(!queued)queued=requestAnimationFrame(apply)};"
  + "addEventListener('message',e=>{if(e.source!==parent||!e.data||typeof e.data.orgtreePresentationFit!=='boolean')return;"
  + "fit=e.data.orgtreePresentationFit;apply()});"
  + "addEventListener('resize',later);addEventListener('load',later);"
  + "document.addEventListener('click',e=>{const a=e.target instanceof Element?e.target.closest('a[href],area[href]'):null;"
  + "if(!a)return;let u;try{u=new URL(a.getAttribute('href'),document.baseURI)}catch{return}"
  + "if(u.protocol==='javascript:')return;u.hash='';if(u.href!==location.href.split('#')[0])e.preventDefault()},true);"
  + "document.addEventListener('DOMContentLoaded',()=>{apply();new MutationObserver(later).observe(root,"
  + "{childList:true,subtree:true,attributes:true,attributeFilter:['class','hidden','open','width','height']})})})()"

/** Where the author's leading doctype ends (0 without one), after leading
 *  whitespace and comments. A linear scan: a backtracking pattern over
 *  agent-written HTML could stall the renderer. */
function doctypeEnd(html: string): number {
  let at = 0
  for (;;) {
    while (at < html.length && /\s/.test(html[at]!)) at++
    if (html.startsWith('<!--', at)) {
      const close = html.indexOf('-->', at + 4)
      if (close < 0) return 0
      at = close + 3
    } else if (html.slice(at, at + 9).toLowerCase() === '<!doctype') {
      const close = html.indexOf('>', at)
      return close < 0 ? 0 : close + 1
    } else return 0
  }
}

/** The frame document: the author's doctype stays first, so standards or
 *  quirks mode is the window's; everything of ours precedes the author's
 *  first element, so the policy covers every script and resource. */
export function presentationDocument(html: string, fit: boolean): string {
  const lead = doctypeEnd(html)
  return html.slice(0, lead)
    + `<meta http-equiv="Content-Security-Policy" content="${PRESENTATION_CSP}">`
    + '<meta name="referrer" content="no-referrer"><base href="about:srcdoc">'
    + `<script>${FRAME_SCRIPT.replace('__FIT__', String(fit))}</script>`
    + html.slice(lead)
}

/** the Fit width / 100% choice carries to the next presentation opened */
let presentationFit = true
const mib = (bytes: number) => (bytes / 1048576).toFixed(1)

export function HtmlPresentationView({ slug, docId, title }: { slug: string; docId: string; title: string }) {
  const [loaded, setLoaded] = useState<{ html: string } | { tooLarge: number } | { err: string } | null>(null)
  const [fit, setFit] = useState(presentationFit)
  const frame = useRef<HTMLIFrameElement>(null)
  const fitNow = useRef(fit)
  fitNow.current = fit
  useEffect(() => {
    let live = true
    setLoaded(null)
    getPresentationHtml(slug, docId, HTML_PRESENTATION_INLINE_MAX)
      .then((r) => { if (live) setLoaded(r) })
      .catch((e: Error) => { if (live) setLoaded({ err: e.message }) })
    return () => { live = false }
  }, [slug, docId])
  const html = loaded && 'html' in loaded ? loaded.html : null
  // Built once per load: the setting is posted, so switching keeps the
  // presentation's own state instead of reloading it.
  const srcDoc = useMemo(() => html === null ? null : presentationDocument(html, fitNow.current), [html])
  const post = () => frame.current?.contentWindow?.postMessage({ orgtreePresentationFit: fitNow.current }, '*')
  useEffect(() => { presentationFit = fit; post() }, [fit])
  return <div className="html-presentation">
    <div className="html-presentation-bar">
      <div className="html-presentation-size" role="group" aria-label="Presentation size">
        <button type="button" className={fit ? 'sel' : ''} aria-pressed={fit} onClick={() => setFit(true)}
          title="Scale a presentation wider than this pane down to its width">Fit width</button>
        <button type="button" className={fit ? '' : 'sel'} aria-pressed={!fit} onClick={() => setFit(false)}
          title="Show the presentation at its actual size">100%</button>
      </div>
      <span className="spacer" />
      <a className="html-presentation-window" href={mockupUrl(slug, docId)} target="_blank" rel="noopener noreferrer"
        title="Open this HTML presentation in its own window">Open in a new window</a>
    </div>
    {srcDoc !== null
      ? <iframe ref={frame} className="html-presentation-frame" title={`HTML presentation: ${title}`}
          sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc} onLoad={post} />
      : <div className={'html-presentation-note ' + (loaded && 'err' in loaded ? 'ask-warn' : 'dim')}>
          {!loaded ? 'Loading presentation…'
            : 'err' in loaded ? `Could not load the HTML presentation: ${loaded.err}`
            : 'tooLarge' in loaded ? `This presentation is ${mib(loaded.tooLarge)} MiB. Presentations over 4 MiB open only in their own window.`
            : null}
        </div>}
  </div>
}

/** fetch one document's body by id — the tree payload and the gallery list
 *  both carry metadata only, so every reading surface starts here.
 *
 *  Shared by the overlay reader (the canvas doc chips) and the gallery's
 *  reading pane so the fetch, the cancel-on-swap latch and the error state
 *  exist ONCE. The two surfaces render different chrome (overlay vs the
 *  mail-idiom right pane) — that is presentation; this is not.
 *
 *  An EMPTY `docId` fetches nothing: the gallery lists evicted cards, whose
 *  body is gone for good, and a request for one would only buy back the 404
 *  the caller already knows about. A hook cannot be called conditionally,
 *  so the condition lives here. */
export function useDoc(slug: string, docId: string, preloaded?: LoadedDoc): {
  doc: LoadedDoc | null
  err: string | null
} {
  const [doc, setDoc] = useState<LoadedDoc | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setDoc(null)
    setErr(null)
    if (!docId) return
    if (preloaded) { setDoc(preloaded); markDocViewed(slug, docId, preloaded.at); return }
    getDocument(slug, docId)
      .then((d) => { if (live) { setDoc(d); markDocViewed(slug, docId, d.at) } })
      .catch((e: Error) => { if (live) setErr(e.message) })
    return () => { live = false }
  }, [slug, docId, preloaded])
  return { doc, err }
}

/** the one dismiss path (user request 2026-09-03 put a second one in the
 *  gallery's viewer). DELETE runs through `req`, which bumps the livebus, so
 *  every polled surface — the gallery list included — drops the row without
 *  anyone wiring a refresh. `after` is for chrome that must also close. */
export function dismissDoc(slug: string, docId: string, title: string,
  toast: ToastFn, after?: () => void): void {
  dismissDocument(slug, docId)
    .then(() => { toast([`dismissed “${title}”`]); after?.() })
    .catch((e: Error) => toast([`error: ${e.message}`]))
}

/** the outboard chips on the node square — one per presented document.
 *  Square ICONS only (user report 2026-08-05: the titled chips were wide
 *  enough to overlap the adjacent card) — the title lives in the tooltip;
 *  the desk header carries the readable titled badges. */
export function DocChips({ slug, docs, onOpen, inert = false }: {
  slug: string
  docs: DocMeta[]
  onOpen: (id: string) => void
  /** far zoom: visible, but nothing on them activates. See PresentationCard. */
  inert?: boolean
}) {
  return (
    <div className={'doc-chips' + (inert ? ' inert' : '')}>
      {recentDocumentChips(docs).map((d) => (
        <PresentationCard key={d.id} slug={slug} doc={d}
          className="doc-chip" compact direct onOpen={onOpen} inert={inert}>
          {d.format !== 'html' && <DocIcon fontSize="inherit" />}
        </PresentationCard>
      ))}
    </div>
  )
}

/** the in-page reader: title bar (✕ closes the reader; "dismiss" removes
 *  the card itself), markdown body under the desk's .md styling */
export function DocReader({ slug, docId, toast, close, refs,
  pinKind = 'doc' }: {
  slug: string
  docId: string
  toast: ToastFn
  close: () => void
  /** canonical references (`@item:org/slug`) written INSIDE the document.
   *  A presented plan is exactly the kind of prose that names an item, an
   *  agent or the mail it answers, and it is rendered markdown — so this is
   *  the DOM pass, not the React renderer. Omitted, the tokens are prose:
   *  a reader with nowhere to send anybody must not draw controls. */
  refs?: { world: RefWorld; onOpen?: (r: ResolvedRef) => void }
  /** ⚠ THIS READER IS THE ONE SURFACE WITH TWO MOUNT SITES, and a pin identity
   *  is per SURFACE, not per component: the canvas opens one of these and the
   *  docket opens another, and both can be on screen at once. Sharing one kind
   *  made the two windows one window — same rect, same z, neither movable,
   *  raisable or resizable apart from the other (found by codex-delivery,
   *  2026-09-06). Each site passes its own stable identity instead. The canvas
   *  keeps the original `doc`, so pins stored before this fix still open where
   *  they were left. */
  pinKind?: string
}) {
  const { doc, err } = useDoc(slug, docId)
  if (!doc) return <PinFrame kind={pinKind} pinnable={false} title="Presented documents"
    panel="settings wide gallery-modal" close={close}>
    <div className={err ? 'ask-warn' : 'dim pad'}>{err ? `Could not load presentation: ${err}` : 'Loading presentation?'}</div>
  </PinFrame>
  return <AgentGalleryModal key={`${slug}/${doc.node}`} slug={slug} nid={doc.node}
    toast={toast} close={close} refs={refs} initialDocument={docId} initialLoaded={doc}
    selectedRow={{...doc, id:docId, evicted:false, node_state:doc.node_state ?? 'deleted', tier:doc.tier ?? null}} pinKind={pinKind} />
}
