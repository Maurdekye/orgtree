import { DEFAULT_STREAMER_TYPES, sensitiveSpans, STREAMER_HIDDEN, type SensitiveSpan, type StreamerType, type StreamerTypes } from '../../../../packages/contracts/streamer'

/** What the boundary hides right now (Settings > Streamer mode). */
export interface StreamerConfig {
  types?: StreamerTypes
  /** the opaque cover over HTML apps, HTML presentations and video */
  cover?: boolean
  /** names and slugs of the OTHER orgs of this installation (never the current one), for the External switch */
  orgNames?: readonly string[]
  /** preferences read; false keeps the pre-load fail-closed banner wording */
  ready?: boolean
  note?: string
}
export interface StreamerBoundary {
  update(on: boolean, config?: StreamerConfig): void
  dispose(): void
}
/** THE ONE TABLE (USER 2026-11-03 m63438d6bebc3 + maad1c88abeba): where streamer mode looks, and what it does there.
 *  - `freeform`: containers of variadic, user- or agent-written content. Only here is TEXT pattern-matched, and only the
 *    matching span of an enabled type is blurred. Everything outside both lists is never hidden: names, chips, headers,
 *    timestamps, queue lines, selects, chart rows, settings labels.
 *  - `always`: structured fields, marked in the renderer with data-streamer-field="<kind>", that ALWAYS hold one type
 *    (the usage panel's account email, folder/path fields, IP/host fields, API key fields). Wholly blurred while their
 *    type is on, and wholly visible while it is off; never pattern-matched. */
export const STREAMER_ZONES = {
  freeform: ['.md', '.msg', '.msgtext', '.mailer-body', '.turn-mail-body', '.docket-desc-body', '.event-prose', '.compaction-summary',
    '.thoughtbody', '.ask-q', '.answered-qbody', 'pre', 'code', '.tool-live-output', '.filepre', '.typed-input', '.trunc-note',
    // agent status summaries (agent-written free-form): tray / attention rows, the progress line, and any element that carries one in a tooltip
    '.tray-sum', '.progress-summary',
    // user/agent-written excerpts: the sticky user-message preview, mail and reply previews, selection excerpts, dead-desk previews
    '.pinuser-t', '.mail-preview-text', '.turn-mail-preview-content', '.reply-preview-content', '.selection-excerpt', '.dead-preview', '.dead-summary',
    // a tool call's argument (the line around it is structured)
    '.targ',
    '[data-streamer-freeform]'].join(','),
  /** STRUCTURED row headers and markers (USER 2026-11-04 m8183a66a1f68): they sit inside a free-form `.msg`/`.mailer-body`, and
   *  their adjacent inline fields (name, q-id, status, date) concatenate into one long token-like run. A text node whose nearest
   *  structured ancestor is INSIDE (or is) its free-form zone is never matched; a free-form zone nested inside a structured
   *  one (a tool argument, a summary body) is matched as usual. */
  structured: ['.event-head', '.turn-mail-head', '.mailer-head', '.event-head-field', '.event-family', '.event-actor', '.event-row-kind', '.event-time',
    '.event-field-label', '.event-change-label', '.event-change-agent', '.event-change-sep', '.event-context', '.turn-mail-passive', '.urgentkind',
    '.reply-source-meta', '.answered-chip', '.answered-card > summary', '.resolved-label', '.resolved-verdict', '.resolved-mark', '.tline',
    '[data-streamer-structured]'].join(','),
  always: { email: 'emails', path: 'paths', ip: 'ips', secret: 'secrets', external: 'externals', org: 'orgs' } as Record<string, StreamerType>,
} as const
// Content surfaces that cannot be pattern-matched: sandboxed HTML apps, HTML presentations, video. Images are NOT hidden.
// The canvas's wire <canvas>, its edges <svg> and every icon are app chrome: covering them hid the whole canvas behind one
// opaque slab (USER 2026-11-03 m84db138f69e6 "i cant see anything at all").
const OPAQUE = 'iframe,video,object,embed'
// Masked values are BLURRED in place (USER 2026-11-03 m4f8233662107 "make it blur things"): same box, no reflow.
// ::highlight takes no `filter`, so text is drawn as transparent glyphs plus a heavy blurred shadow of the glyphs;
// the radius is in em so it scales with the text and with zoom (0.7em ~ 9 px at 13 px: a 4-character token is a
// featureless smudge at 100% and 200% zoom, measured in the capture). Two stacked shadows keep a faint token visible.
export const BLUR_EM = 0.7
const SMUDGE = `0 0 ${BLUR_EM}em #686868,0 0 ${BLUR_EM}em #686868`
const STYLE = `
html.streamer-on ::highlight(streamer-sensitive){color:transparent!important;background-color:transparent!important;text-shadow:${SMUDGE}!important}
[data-streamer-selmask]{position:fixed;z-index:2147483646;pointer-events:none;background:#686868;border-radius:2px}
html.streamer-on [data-streamer-pending],html.streamer-on [data-streamer-pending] *{color:transparent!important;text-shadow:${SMUDGE}!important;-webkit-text-fill-color:transparent!important}
html.streamer-on [data-streamer-blur] :is(img,svg,canvas){filter:blur(6px)!important}
html.streamer-on [data-streamer-blur]{color:transparent!important;text-shadow:${SMUDGE}!important;-webkit-text-fill-color:transparent!important}
html.streamer-on [data-streamer-blur]::placeholder{color:transparent!important}
html.streamer-on:not(.streamer-nocover) :is(${OPAQUE}):not([data-streamer-revealed]){visibility:hidden!important}
html.streamer-textless body :not([data-streamer-ui],[data-streamer-ui] *){color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}
[data-streamer-ui]{font:13px system-ui!important;color:#fff!important;-webkit-text-fill-color:#fff!important;background:#292929!important;text-shadow:none!important;box-sizing:border-box!important}
[data-streamer-ui] button{color:var(--ink)!important;-webkit-text-fill-color:currentColor!important;background:var(--input)!important;border:1px solid var(--line)!important;border-radius:4px;cursor:pointer}
[data-streamer-ui] button:hover{border-color:var(--button-accent)!important}
[data-streamer-ui] button:focus-visible{outline:2px solid var(--button-accent);outline-offset:2px}
[data-streamer-cover]{position:absolute;z-index:1;display:flex;align-items:center;justify-content:center;gap:8px;overflow:hidden;border:1px solid #888}
[data-streamer-banner]{position:fixed;z-index:2147483647;left:0;right:0;bottom:0;height:30px;display:flex;align-items:center;justify-content:center;gap:8px;padding:0 10px;border-top:1px solid #888}
[data-streamer-banner][data-streamer-inline]{position:static;z-index:auto;height:auto;flex:none;padding:1px 8px;border:1px solid #888;border-radius:4px;font-size:11px!important;white-space:nowrap}
[data-streamer-banner][data-streamer-inline] button{padding:0 6px;font-size:11px}
html.streamer-banner-fixed body{height:calc(100% - 30px)!important;overflow:hidden}
`
interface HighlightLike { add(range: Range): unknown; delete(range: Range): unknown }
const samePlace = (a: Range, b: Range) => a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset
type HighlightWindow = Window & Pick<typeof globalThis, 'MutationObserver'> & { Highlight?: new (...ranges: Range[]) => unknown; CSS?: { supports?(property: string, value: string): boolean; highlights?: { set(k: string, v: unknown): void; delete(k: string): void } } }
/** The last 32 scans (UI stall spec R8b, rev 1.2): a read-only snapshot for the stall watch; it never triggers a scan. */
export interface StreamerScan { start: number; ms: number; trigger: 'mutation' | 'update' | 'prefs' | 'org-list' | 'other'; mutations: number; cause: string; nodes_walked: number; text_nodes: number; regex_chars: number; text_chars: number; ranges_after: number }
/** One maskSelection call. */
export interface StreamerMask { start: number; ms: number }
export interface StreamerScanStats { on: boolean; pace_ms: number; scans: readonly StreamerScan[]; masks: readonly StreamerMask[] }
const scanRing: StreamerScan[] = [], maskRing: StreamerMask[] = []
let ringOn = false, ringPace = 0
export const streamerScanStats = (): StreamerScanStats => ({ on: ringOn, pace_ms: ringPace, scans: scanRing.slice(), masks: maskRing.slice() })
/** A text node's classification, cached because deriving it (four closest() calls over long selector lists) was the whole cost
 *  of a scan: 2.2 s per scan at 18k text nodes (measured, streamerperf.test.tsx). The TEXT is never cached; it is read fresh from
 *  the node every scan, so new or edited text is masked in the same microtask. Mutation records invalidate what they touch. */
interface SeqEntry { node: Text; sep: boolean; field: string | null; data: string; run: number }
interface TextClass { kind: 0 | 1 | 2; field: string | null; block: Element | null }
const BLOCKS = 'p,div,li,pre,td,th,section,h1,h2,h3,h4,button,label,.katex-mathml,.katex-html'
// [data-streamer-visible]: text that is known NOT to be sensitive and must not be pattern-matched (the current org's own address chip)
const SKIP = 'script,style,textarea,select,[contenteditable=true],[data-streamer-ui],[data-streamer-visible]'
/** True when the nearest preceding node in document order is a <br> (the text after a line break starts a new run). */
function afterLineBreak(from: Node): boolean {
  let n: Node | null = from
  for (;;) {
    let p: Node | null = n!.previousSibling
    while (!p) { n = n!.parentNode; if (!n || n.nodeType === 9) return false; p = n.previousSibling }
    while (p.lastChild) p = p.lastChild
    if (p.nodeName === 'BR') return true
    if (p.nodeType === 3) return false
    n = p
  }
}
const ZONE_TOKENS = new Set(`${STREAMER_ZONES.freeform},${STREAMER_ZONES.structured},${BLOCKS}`.match(/\.[\w-]+/g)?.map(t => t.slice(1)))
const ZONE_ATTRS = new Set(['data-streamer-field', 'data-streamer-freeform', 'data-streamer-structured', 'contenteditable'])
const classTouchesZone = (value: string | null) => !!value && value.split(/\s+/).some(t => ZONE_TOKENS.has(t))
/** Anything whose appearance can change a mask; the rest of the page is chrome. */
const WATCHED = `${STREAMER_ZONES.freeform},${STREAMER_ZONES.structured},[data-streamer-field],[title],[alt],[aria-label],input,textarea,select,[contenteditable],${OPAQUE}`
/** The text before a possible multi-line match: a key word (optionally quoted, with an optional `:`/`=`) or `Bearer` at the very end. */
const KEY_TAIL = /(?:password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|api[_ -]?key|apikey|authorization|credential)["']?\s*(?:[:=]\s*)?$|\bBearer\s*$/i
/** Characters handed to the regex pass since the last scan began (the work a keystroke costs; exposed in the scan ring). */
let regexWork = 0
/** A short label for a mutation target, for the scan ring's `cause` (which mutation made a scan relevant). */
function describe(node: Node | null): string {
  const el = node && node.nodeType === 1 ? node as Element : node?.parentElement ?? null
  if (!el) return '?'
  const one = (e: Element) => e.localName + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '')
  return (el.parentElement ? one(el.parentElement) + ' > ' : '') + one(el)
}
const SEAM_WORDS = 2, RUN_CACHE_MAX = 6000, KEY_SCAN = 100_000
/** Where a key word (with only whitespace and an optional `:`/`=` after it) that could pair with a value in the NEXT run starts in
 *  `run`, or -1. Whitespace between the key word and the end can be any length, so the whole run is searched (the last KEY_SCAN chars
 *  of a huge one). */
function keyTailAt(run: string): number {
  const part = run.length > KEY_SCAN ? run.slice(-KEY_SCAN) : run
  const m = KEY_TAIL.exec(part)
  return m ? run.length - part.length + m.index : -1
}
/** `sensitiveSpans(runs.join('\n'))`, computed per run and cached by run text (a run is a block's text, so a keystroke re-matches the
 *  one run that changed). Matches that can cross a run boundary are handled exactly: (1) a private key (`-----BEGIN`, which may run
 *  unterminated to the end of the text) sends the whole text through the one global pass; (2) `key = value` and `Bearer x` split by
 *  a run boundary (their `\s` takes the newline) are found in a bounded window at each seam whose preceding text ends like a key
 *  word. Every other pattern is whitespace-bounded, so it cannot cross the boundary. */
export function spansByRun(runs: readonly string[], types: StreamerTypes, orgNames: readonly string[], cache: Map<string, SensitiveSpan[]>, cacheKey: string): SensitiveSpan[] {
  let total = runs.length - 1
  for (const run of runs) total += run.length
  if (total > 1_000_000) return [{ start: 0, end: total }]
  if (runs.some(run => run.includes('-----BEGIN'))) { regexWork += total; return sensitiveSpans(runs.join('\n'), types, orgNames) }
  const out: SensitiveSpan[] = []
  let offset = 0
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!
    const key = cacheKey + run
    let rel = cache.get(key)
    if (!rel) { regexWork += run.length; rel = sensitiveSpans(run, types, orgNames); if (cache.size >= RUN_CACHE_MAX) cache.clear(); cache.set(key, rel) }
    for (const span of rel) out.push({ start: offset + span.start, end: offset + span.end })
    if (i + 1 < runs.length) {
      const tailAt = keyTailAt(run)
      if (tailAt >= 0) {
        // one character of context before the key word: the patterns start with a word boundary (`tokenapi key` has none before `api`)
        const from = tailAt > 0 ? tailAt - 1 : 0
        const tail = run.slice(from)
        // A match after a key word is `\s*`, an optional `:`/`=`, `\s*`, then ONE value (a quoted value cannot cross a newline): so the
        // window takes any number of whitespace-only runs, and at most SEAM_WORDS runs that have text (the separator, the value).
        let words = 0, head = ''
        for (let j = i + 1; j < runs.length && words < SEAM_WORDS; j++) {
          head += '\n' + runs[j]!   // whole runs: a value of any length is masked in full, as the global pass does
          if (runs[j]!.trim() !== '') words++
        }
        const window = tail + head
        const base = offset + from
        regexWork += window.length
        for (const span of sensitiveSpans(window, types, orgNames)) if (span.start < tail.length && span.end > tail.length) out.push({ start: base + span.start, end: base + span.end })
      }
    }
    offset += run.length + 1
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: SensitiveSpan[] = []
  for (const span of out) {
    const last = merged[merged.length - 1]
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }
  return merged
}
export function installStreamerBoundary(doc: Document, turnOff?: () => void): StreamerBoundary {
  const win = doc.defaultView as HighlightWindow | null
  if (!win) return { update() {}, dispose() {} }
  const style = doc.createElement('style'); style.dataset.streamerStyle = ''; style.textContent = STYLE; doc.head.appendChild(style)
  let active = false, types: StreamerTypes = { ...DEFAULT_STREAMER_TYPES }, coverOn = true, orgNames: readonly string[] = [], ready = true, note = '', originalTitle = doc.title, frame = 0
  let lastEnd = 0, lastCost = 0, timer = 0, scanWalked = 0, scanTextNodes = 0, firstCause = '', scanChars = 0, pendingMutations = 0, trigger: StreamerScan['trigger'] = 'other'
  let seq: SeqEntry[] | null = null, textOnly = false
  const runCache = new Map<string, SensitiveSpan[]>()
  // the last full pass's runs (entries per run, whether each ends like a key word, the total text length), for the edit fast path
  let lastRunEntries: SeqEntry[][] | null = null, lastRunTail: boolean[] = [], lastTotal = 0, lastPem = false, lastTextNodes = 0
  /** A batch of edits to already-classified free-form text whose runs stay CLEAN (no hidden span before or after, no key-word tail
   *  that could join the next run, no private-key marker, under the 1M cap) changes no mask anywhere: the entries take the new
   *  text and the scan stops, with no join and no walk. Anything else returns false and takes the full pass. */
  function fastEdit(): boolean {
    // a private-key marker anywhere may run unterminated over every later run, so with one present every edit takes the full pass
    if (!lastRunEntries || lastPem) return false
    const changes = new Map<SeqEntry, string>(), runsHit = new Set<number>()
    for (const node of editedTexts) {
      const e = seqIndex.get(node)
      if (!e) continue
      if (e.field !== null || node.parentElement?.closest('.katex')) return false
      const data = node.data.includes('\u2212') ? node.data.replace(/\u2212/g, '-') : node.data
      if (data === e.data) continue
      changes.set(e, data); runsHit.add(e.run)
    }
    if (!changes.size) return true
    const key = `${JSON.stringify(types)}|${orgNames.join(',')}|`
    let total = lastTotal
    const spansOf = (run: string) => {
      let rel = runCache.get(key + run)
      if (!rel) { regexWork += run.length; rel = sensitiveSpans(run, types, orgNames); if (runCache.size >= RUN_CACHE_MAX) runCache.clear(); runCache.set(key + run, rel) }
      return rel
    }
    for (const run of runsHit) {
      const entries = lastRunEntries[run]
      if (!entries) return false
      let before = '', after = ''
      for (const e of entries) { before += e.data; after += changes.get(e) ?? e.data }
      if (before.includes('-----BEGIN') || after.includes('-----BEGIN')) return false
      total += after.length - before.length
      if (total > 1_000_000 || lastTotal > 1_000_000) return false
      if (lastRunTail[run] || keyTailAt(after) >= 0) return false
      // an earlier key-word run whose seam window reaches this run (whitespace-only runs are free, at most SEAM_WORDS runs with text)
      for (let j = run - 1, words = 0; j >= 0 && words < SEAM_WORDS; j--) {
        if (lastRunTail[j]) return false
        if ((lastRunEntries[j] ?? []).some(e => e.data.trim() !== '')) words++
      }
      if (spansOf(before).length || spansOf(after).length) return false
    }
    for (const [e, data] of changes) e.data = data
    lastTotal = total
    return true
  }
  // Elements whose new or changed text is blurred WHOLE while a paced scan has not run yet (nothing may show, even briefly)
  const pending = new Set<Element>(), touched = new Set<Element>()
  const clearPending = () => { for (const el of pending) el.removeAttribute('data-streamer-pending'); pending.clear() }
  const seqIndex = new Map<Text, SeqEntry>(), editedTexts = new Set<Text>()
  let textClass = new WeakMap<Text, TextClass>(), attrMemo = new WeakMap<Element, string>()
  function classify(node: Text): TextClass {
    let cls = textClass.get(node)
    if (cls) return cls
    const parent = node.parentElement
    if (!parent || parent.closest(SKIP)) cls = { kind: 0, field: null, block: null }
    else {
      const field = parent.closest('[data-streamer-field]')
      if (field) cls = { kind: 1, field: field.getAttribute('data-streamer-field'), block: null }
      else if (!inFreeform(parent)) cls = { kind: 0, field: null, block: null }
      else cls = { kind: 2, field: null, block: parent.closest(BLOCKS) }
    }
    textClass.set(node, cls)
    return cls
  }
  /** Could this mutation change what the scan would mask? A change that touches no free-form text, field, labelled element,
   *  input or media element (typing counters, hints, chrome) cannot, so it costs no scan. When unsure it says yes. */
  function relevant(r: MutationRecord): boolean {
    if (r.type === 'characterData') return classify(r.target as Text).kind !== 0
    const target = r.target as Element
    if (target.closest('[data-streamer-ui]')) return false
    if (r.type === 'attributes') {
      if (r.attributeName === 'class') return classTouchesZone(r.oldValue) || classTouchesZone(target.getAttribute('class'))
      if (ZONE_ATTRS.has(r.attributeName ?? '')) return true
      return !!target.closest('[data-streamer-field]') || inFreeform(target) || r.attributeName === 'autocomplete'
    }
    if (r.removedNodes.length || target.closest('[data-streamer-field]') || inFreeform(target)) return true
    for (const a of r.addedNodes) {
      if (a.nodeType === 3) { if (classify(a as Text).kind !== 0) return true } else if (a.nodeType === 1 && ((a as Element).matches(WATCHED) || (a as Element).querySelector(WATCHED))) return true
    }
    return false
  }
  const invalidate = (root: Node | null) => {
    if (!root) return
    if (root.nodeType === 3) { textClass.delete(root as Text); return }
    if (root.nodeType !== 1) return
    attrMemo.delete(root as Element)
    const walker = doc.createTreeWalker(root, 5)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) { if (n.nodeType === 3) textClass.delete(n as Text); else attrMemo.delete(n as Element) }
  }
  const covered = new Map<Element, HTMLElement>(), revealed = new Set<Element>(), tinyEls = new Set<Element>()
  // Icon-sized media (avatars, logos, glyph images) is hidden without a cover:
  // a bordered box with a label and a button would not fit and would be noise.
  const TINY = 48
  const isTiny = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.width < TINY && r.height < TINY }
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
    let rescan = false
    for (const [el, cover] of covered) {
      if (isTiny(el)) { cover.remove(); covered.delete(el); tinyEls.add(el) } else place(el as HTMLElement, cover)
    }
    for (const el of tinyEls) if (!el.isConnected) tinyEls.delete(el); else if (el.getClientRects().length && !isTiny(el)) { tinyEls.delete(el); rescan = true }
    if (rescan) scan()
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
  // A changed configuration may un-hide a label (a type switched off): restore them all, the scan hides what still qualifies.
  function restoreAttributes() {
    for (const [el, attrs] of attributes) for (const [key, value] of attrs) if (el.getAttribute(key) === STREAMER_HIDDEN) el.setAttribute(key, value)
    attributes.clear()
  }
  function restore() {
    clearPending()
    doc.documentElement.classList.remove('streamer-on', 'streamer-textless', 'streamer-nocover', 'streamer-banner-fixed')
    for (const el of doc.querySelectorAll('[data-streamer-blur]')) el.removeAttribute('data-streamer-blur')
    win?.CSS?.highlights?.delete('streamer-sensitive'); highlightObj = null
    for (const cover of covered.values()) cover.remove()
    covered.clear()
    for (const el of revealed) el.removeAttribute('data-streamer-revealed')
    revealed.clear(); tinyEls.clear()
    for (const [el, attrs] of attributes) for (const [key, value] of attrs) if (el.getAttribute(key) === STREAMER_HIDDEN) el.setAttribute(key, value)
    attributes.clear(); banner.remove(); removeSelectionLayer(); sensitiveRanges = []
    for (const [el, value] of autocomplete) if (el.getAttribute('autocomplete') === 'off') {
      if (value === null) el.removeAttribute('autocomplete'); else el.setAttribute('autocomplete', value)
    }
    autocomplete.clear()
    if (doc.title === 'Orgtree — Streamer mode') doc.title = originalTitle
    if (frame) win?.cancelAnimationFrame(frame)
    frame = 0
    if (timer) win?.clearTimeout(timer)
    timer = 0
  }
  // Mutation-driven rescans are paced by their own cost: a scan that took T ms
  // of 16 ms or more is followed by at least min(4T, 250) ms before the next (cheap
  // scans stay immediate, so new values are masked at once), so a page that
  // mutates every frame cannot keep the main thread inside the scanner. A
  // direct update() always scans at once.
  const clock = () => (win?.performance ?? performance).now()
  function requestScan() {
    if (!active) return
    // Only a scan of 16 ms or more is paced: the next one waits 4x its cost (at most 1 s, was 250 ms: a 2 s scan then kept the main thread
    // ~90% busy), so the scan share stays near 20%. The incremental scan costs a few ms, so new text is normally masked in the same
    // microtask, before the next paint.
    const wait = lastCost < 16 ? 0 : lastEnd + Math.min(1000, lastCost * 4) - clock()
    ringPace = Math.max(0, Math.round(wait))
    trigger = 'mutation'
    if (wait > 0) for (const el of touched) { if (el.isConnected && !pending.has(el)) { el.setAttribute('data-streamer-pending', ''); pending.add(el) } }
    touched.clear()
    if (wait <= 0) scan()
    else if (!timer) timer = win!.setTimeout(() => { timer = 0; scan() }, wait)
  }
  function scan() {
    if (!active || !doc.body) return
    if (timer) { win?.clearTimeout(timer); timer = 0 }
    const began = clock()
    scanWalked = 0; scanTextNodes = 0; scanChars = 0; regexWork = 0
    try { scanNow() } finally {
      lastEnd = clock(); lastCost = lastEnd - began
      scanRing.push({ start: began, ms: lastCost, trigger, mutations: pendingMutations, cause: firstCause, nodes_walked: scanWalked, text_nodes: scanTextNodes, regex_chars: regexWork, text_chars: Math.floor(scanChars / 1000) * 1000, ranges_after: sensitiveRanges.length })
      if (scanRing.length > 32) scanRing.shift()
      pendingMutations = 0; trigger = 'other'; firstCause = ''; clearPending()
    }
  }
  function scanNow() {
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
    doc.documentElement.classList.toggle('streamer-nocover', !coverOn)
    const enabledType = (kind: string | undefined) => { const type = kind ? STREAMER_ZONES.always[kind] : undefined; return !!type && types[type] }
    const supported = !!win?.Highlight && !!win.CSS?.highlights
    // Only text changed, in nodes already classified (a streaming message, an edit): the order, labels, fields and media are as they
    // were, so the scan reuses the last walk's sequence and re-matches the text (a cheap pass, no tree walk, no closest()).
    const light = textOnly && seq !== null && supported
    if (!light) {
      // Always-fields hold one type for sure: an input-like one is blurred through CSS (its value is not text), others by range below.
      for (const el of doc.querySelectorAll('[data-streamer-field]')) {
        const on = enabledType(el.getAttribute('data-streamer-field') ?? undefined)
        // a field whose visible text is NOT a text node (a chip's display name is drawn from data-net-name by CSS, its initials from
      // data-initials, its picture is an <img>) cannot be covered by a text range: the whole element is blurred instead
      if (el.matches('input,textarea,select,[contenteditable=true]') || el.querySelector('[data-net-name],[data-initials],img')) el.toggleAttribute('data-streamer-blur', on)
      }
      // Masking fails per value, never per window: unready identities keep the
      // pattern and known-value masks; without the Highlight API only text paint
      // is withheld, and layout, controls and the Turn off button stay usable.
      doc.documentElement.classList.toggle('streamer-textless', !supported)
      bannerLabel.textContent = (!supported ? 'Streamer mode — text hidden: this window cannot mask single values' : 'Streamer mode') + (note ? ` — ${note}` : '')
      // USER 2026-11-04 m27bbbf036a7a "blocks the version number": the banner lives IN the footer strip, just before the version
      // label (the strip's end group), never over a control. A window with no footer (a popout) reserves a bottom strip instead.
      const host = doc.querySelector('.shell-statusbar-end') ?? doc.querySelector('.shell-statusbar')
      if (host) {
        banner.dataset.streamerInline = ''; doc.documentElement.classList.remove('streamer-banner-fixed')
        const before = host.querySelector('.shell-version')
        if (banner.parentElement !== host || (before && banner.nextElementSibling !== before)) host.insertBefore(banner, before && before.parentElement === host ? before : host.firstChild)
      } else {
        delete banner.dataset.streamerInline; doc.documentElement.classList.add('streamer-banner-fixed')
        if (banner.parentElement !== doc.body) doc.body.appendChild(banner)
      }
      if (doc.title !== 'Orgtree — Streamer mode') { originalTitle = doc.title; doc.title = 'Orgtree — Streamer mode' }
      for (const el of doc.querySelectorAll('input,textarea,select')) {
        const value = el.getAttribute('autocomplete')
        if (value !== 'off') { autocomplete.set(el, value); el.setAttribute('autocomplete', 'off') }
      }
      for (const el of doc.querySelectorAll('[title],[alt],[aria-label]')) {
        const sig = `${el.getAttribute('title')}|${el.getAttribute('alt')}|${el.getAttribute('aria-label')}`
        if (attrMemo.get(el) === sig) continue
        if (el.closest('[data-streamer-ui],[data-streamer-visible]')) continue
        const field = el.closest('[data-streamer-field]')
        const inFree = !field && inFreeform(el)
        for (const key of ['title', 'alt', 'aria-label']) {
          const value = el.getAttribute(key)
          // a label inside an always-field is hidden with it; in free-form it is hidden only if it matches an enabled type
          if (value && value !== STREAMER_HIDDEN && (field ? enabledType(field.getAttribute('data-streamer-field') ?? undefined) : inFree && sensitiveSpans(value, types, orgNames).length > 0)) {
            let attrs = attributes.get(el); if (!attrs) { attrs = new Map(); attributes.set(el, attrs) }
            attrs.set(key, value); el.setAttribute(key, STREAMER_HIDDEN)
          }
        }
        attrMemo.set(el, `${el.getAttribute('title')}|${el.getAttribute('alt')}|${el.getAttribute('aria-label')}`)
      }
      for (const [el, box] of covered) if (!el.isConnected || !coverOn) { box.remove(); covered.delete(el) }
      for (const el of revealed) if (!el.isConnected) { el.removeAttribute('data-streamer-revealed'); revealed.delete(el) }
      for (const el of doc.querySelectorAll(OPAQUE)) {
        if (!coverOn) continue
        if (el.closest('[data-streamer-ui]') || revealed.has(el) || covered.has(el) || el.parentElement?.closest(OPAQUE)) continue
        if (isTiny(el)) { tinyEls.add(el); continue }
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
    }
    // a clean text-only batch: nothing to re-match, re-join or re-walk
    if (light && fastEdit()) { scanWalked = 0; scanTextNodes = lastTextNodes; scanChars = lastTotal; editedTexts.clear(); return }
    if (!frame) position()
    if (!supported) return
    const nodes: { node: Text; start: number; end: number }[] = [], whole: Text[] = []
    let text = '', block: Element | null = null
    const runStarts = [0]
    const runEntries: SeqEntry[][] = [[]]
    let walked = 0
    const fresh: SeqEntry[] = []
    // KaTeX draws a hyphen in math as U+2212; the key patterns are ASCII, and the swap keeps every offset (one char for one char)
    const read = (node: Text) => node.data.includes('−') ? node.data.replace(/−/g, '-') : node.data
    const add = (e: SeqEntry) => {
      if (e.field !== null) { if (enabledType(e.field)) whole.push(e.node); return }
      if (e.sep) { text += '\n'; runStarts.push(text.length); runEntries.push([]) }
      e.run = runStarts.length - 1; runEntries[e.run]!.push(e)
      const start = text.length; text += e.data; nodes.push({ node: e.node, start, end: text.length })
    }
    if (light) {
      for (const node of editedTexts) { const e = seqIndex.get(node); if (e && e.field === null) e.data = read(node) }
      for (const e of seq!) { walked++; add(e) }
    }
    else {
      const walker = doc.createTreeWalker(doc.body, 4)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        walked++
        const node = n as Text
        const cls = classify(node)
        if (cls.kind === 0) continue
        if (cls.kind === 1) { const e = { node, sep: false, field: cls.field ?? '', data: '', run: 0 }; fresh.push(e); add(e); continue }
        // a KaTeX formula is two copies of its text (a hidden MathML half with the TeX annotation, then the visible HTML half):
        // each is its own run, or a key matches across the seam and the mask lands on the wrong glyphs (spec R10)
        // a <br> is a line break: the text node after it starts a new run, or a key and the next line become one token
        let sep = false
        if (cls.block !== block) { sep = true; block = cls.block } else if (afterLineBreak(node)) sep = true
        const e = { node, sep, field: null, data: read(node), run: 0 }; fresh.push(e); add(e)
      }
      seq = fresh; seqIndex.clear(); for (const e of fresh) seqIndex.set(e.node, e)
    }
    editedTexts.clear()
    scanWalked = walked; scanTextNodes = nodes.length; scanChars = text.length
    const ranges: Range[] = []
    let firstIndex = 0, lastIndex = 0
    const runs = runStarts.map((at, i) => text.slice(at, i + 1 < runStarts.length ? runStarts[i + 1]! - 1 : text.length))
    lastRunEntries = runEntries; lastRunTail = runs.map(r => keyTailAt(r) >= 0); lastTextNodes = nodes.length; lastTotal = text.length; lastPem = runs.some(r => r.includes('-----BEGIN'))
    for (const span of spansByRun(runs, types, orgNames, runCache, `${JSON.stringify(types)}|${orgNames.join(',')}|`)) {
      while (nodes[firstIndex] && nodes[firstIndex]!.end <= span.start) firstIndex++
      lastIndex = Math.max(firstIndex, lastIndex)
      while (nodes[lastIndex] && nodes[lastIndex]!.end < span.end) lastIndex++
      const first = nodes[firstIndex], last = nodes[lastIndex]
      if (!first || !last) continue
      const range = doc.createRange(); range.setStart(first.node, Math.max(0, span.start - first.start)); range.setEnd(last.node, Math.max(0, span.end - last.start)); ranges.push(range)
    }
    // A formula is judged by its TeX source (the annotation), never by its drawn text: subscripts, superscripts, spacing and
    // symbol swaps all change what is drawn. A sensitive match anywhere in the source masks the whole visible half (spec R10, D3).
    for (const ann of doc.querySelectorAll('.katex annotation[encoding="application/x-tex"]')) {
      const source = ann.textContent ?? ''
      if (!source || ann.closest('[data-streamer-ui]') || !inFreeform(ann) || !sensitiveSpans(source, types, orgNames).length) continue
      const html = ann.closest('.katex')?.querySelector('.katex-html')
      if (!html) continue
      const range = doc.createRange(); range.selectNodeContents(html); ranges.push(range)
    }
    for (const node of whole) { if (!node.data.trim()) continue; const range = doc.createRange(); range.selectNodeContents(node); ranges.push(range) }
    // ONE Highlight object is registered once and diffed in place (add/delete only the ranges that changed): re-registering a new
    // Highlight invalidates highlight paint for the whole document. A keystroke in the composer usually changes no span, so it
    // touches neither the object nor CSS.highlights. Ranges are live; old and new are matched by position.
    const registry = win!.CSS!.highlights!
    if (!highlightObj || typeof highlightObj.add !== 'function' || typeof highlightObj.delete !== 'function') {
      // a Highlight without add/delete (test doubles): replace it, but only when the spans changed
      const unchanged = highlightObj && ranges.length === sensitiveRanges.length && ranges.every((r, i) => samePlace(r, sensitiveRanges[i]!))
      if (!unchanged) { highlightObj = new win!.Highlight!(...ranges) as HighlightLike; registry.set('streamer-sensitive', highlightObj); sensitiveRanges = ranges }
    } else {
      const old = new Map<Node, Range[]>()
      for (const o of sensitiveRanges) { const list = old.get(o.startContainer); if (list) list.push(o); else old.set(o.startContainer, [o]) }
      const keep = new Set<Range>(), kept: Range[] = []
      for (const r of ranges) {
        const match = old.get(r.startContainer)?.find(o => !keep.has(o) && samePlace(o, r))
        if (match) { keep.add(match); kept.push(match) } else { highlightObj.add(r); kept.push(r) }
      }
      for (const o of sensitiveRanges) if (!keep.has(o)) highlightObj.delete(o)
      sensitiveRanges = kept
    }
    maskSelection()
  }
  // A ::selection layer is drawn ABOVE the custom highlight, so a selected key would show in the clear; and a blanket
  // ::selection blanking rule hid every selected word (USER 2026-11-04 m79874151077c). The selection is drawn normally;
  // the part of it that overlaps a hidden-type span gets a mask box over its client rects.
  let sensitiveRanges: Range[] = [], selFrame = 0
  let highlightObj: HighlightLike | null = null
  // the boxes live in one data-streamer-ui layer, so adding them is not a page mutation (no rescan loop)
  const selLayer = doc.createElement('div'); selLayer.dataset.streamerUi = ''; selLayer.dataset.streamerSelLayer = ''
  selLayer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;background:none;border:0;padding:0'
  // The layer is attached to <body> ONCE and left there while the mode is on: every later change is inside it (the observer
  // ignores data-streamer-ui targets). Removing and re-adding it per pass mutated <body>, re-triggered the scan and looped.
  function clearSelectionMasks() { selLayer.replaceChildren() }
  function removeSelectionLayer() { selLayer.replaceChildren(); selLayer.remove() }
  function maskSelection() {
    const began = clock()
    try { maskSelectionNow() } finally { maskRing.push({ start: began, ms: clock() - began }); if (maskRing.length > 64) maskRing.shift() }
  }
  function maskSelectionNow() {
    // nothing to draw (no selection, a caret, or nothing hidden): return before any work, clearing only boxes that exist
    const sel = active ? win!.getSelection?.() : null
    if (!sel || !sel.rangeCount || sel.isCollapsed || !sensitiveRanges.length) { if (selLayer.firstChild) clearSelectionMasks(); return }
    clearSelectionMasks()
    const chosen = sel.getRangeAt(0), R = (win as unknown as { Range: typeof Range }).Range
    for (const span of sensitiveRanges) {
      if (chosen.compareBoundaryPoints(R.START_TO_END, span) <= 0 || chosen.compareBoundaryPoints(R.END_TO_START, span) >= 0) continue
      const inter = doc.createRange()
      const startFrom = chosen.compareBoundaryPoints(R.START_TO_START, span) > 0 ? chosen : span
      const endFrom = chosen.compareBoundaryPoints(R.END_TO_END, span) < 0 ? chosen : span
      inter.setStart(startFrom.startContainer, startFrom.startOffset); inter.setEnd(endFrom.endContainer, endFrom.endOffset)
      for (const rect of Array.from(inter.getClientRects())) {
        if (!rect.width || !rect.height) continue
        const box = doc.createElement('div'); box.dataset.streamerSelmask = ''
        box.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`
        selLayer.appendChild(box)
      }
    }
    if (selLayer.firstChild && !selLayer.isConnected) doc.body.appendChild(selLayer)
  }
  const requestSelectionMask = () => { if (!active || selFrame) return; selFrame = win!.requestAnimationFrame(() => { selFrame = 0; maskSelection() }) }
  const onSelection = () => { if (active) maskSelection() }
  doc.addEventListener('selectionchange', onSelection)
  win.addEventListener('scroll', requestSelectionMask, true); win.addEventListener('resize', requestSelectionMask)
  const observer = new win.MutationObserver(all => {
    if (!active) return
    // the root element's own class list is ours (streamer-on, ...) or the theme's: it changes no text's classification
    const records = all.filter(r => !(r.type === 'attributes' && r.attributeName === 'class' && r.target === doc.documentElement))
    if (!records.length) return
    pendingMutations += records.length
    for (const r of records) {
      if (r.type === 'characterData') invalidate(r.target)
      else if (r.type === 'childList') {
        for (const a of r.addedNodes) invalidate(a)
        invalidate(r.previousSibling); invalidate(r.nextSibling)
      } else if (r.attributeName === 'class' || ZONE_ATTRS.has(r.attributeName ?? '')) invalidate(r.target)
      else attrMemo.delete(r.target as Element)
    }
    // scan only if some record could change a mask (invalidation above is already done, so classification is current)
    let needScan = false
    for (const r of records) if (relevant(r)) {
      if (!needScan) firstCause = `${r.type}${r.attributeName ? ':' + r.attributeName : ''} ${describe(r.target)}`
      needScan = true
      // remember where the new text is: a deferred scan blurs these elements until it runs
      if (r.type === 'characterData') { const el = r.target.parentElement; if (el) touched.add(el.closest(BLOCKS) ?? el) }
      else if (r.type === 'childList') for (const a of r.addedNodes) { const el = a.nodeType === 1 ? a as Element : a.parentElement; if (el) touched.add(el) }
      else if (r.target.nodeType === 1) touched.add(r.target as Element)
    }
    // A close/reopen can remove and reinsert the same runtime node in one turn.
    for (const record of records) for (const removed of record.removedNodes) for (const el of revealed) {
      if (removed.contains(el)) { el.removeAttribute('data-streamer-revealed'); revealed.delete(el) }
    }
    if (!needScan) return
    // a batch of nothing but edits to classified free-form text keeps the last walk's sequence; anything structural drops it
    if (records.every(r => r.type === 'characterData')) { textOnly = true; for (const r of records) editedTexts.add(r.target as Text) } else seq = null
    if (records.every(r => (r.target.nodeType === 1 ? r.target as Element : r.target.parentElement)?.closest('[data-streamer-ui]'))) return
    requestScan()
  })
  // A select's value changes without any DOM mutation.
  const onChange = (e: Event) => { if (active && (e.target as Element | null)?.localName === 'select') requestScan() }
  doc.addEventListener('change', onChange, true)
  observer.observe(doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true, attributeFilter: ['title', 'alt', 'aria-label', 'autocomplete', 'class', 'data-streamer-field', 'data-streamer-freeform', 'data-streamer-structured', 'contenteditable'] })
  return {
    update(on, config) { if (!on) { active = false; ringOn = false; ringPace = 0; restore(); return } ringOn = true; if (active) restoreAttributes(); textClass = new WeakMap(); attrMemo = new WeakMap(); seq = null; runCache.clear(); active = true; types = config?.types ?? { ...DEFAULT_STREAMER_TYPES }; coverOn = config?.cover !== false; orgNames = config?.orgNames ?? []; ready = config?.ready !== false; note = config?.note ?? ''; trigger = 'update'; scan() },
    dispose() { active = false; observer.disconnect(); doc.removeEventListener('change', onChange, true); doc.removeEventListener('selectionchange', onSelection); win.removeEventListener('scroll', requestSelectionMask, true); win.removeEventListener('resize', requestSelectionMask); if (selFrame) win.cancelAnimationFrame(selFrame); ringOn = false; restore(); style.remove() },
  }
}

/** True when `el` is inside a free-form zone and not inside a structured header/marker nested in that zone. */
export function inFreeform(el: Element): boolean {
  const free = el.closest(STREAMER_ZONES.freeform)
  if (!free) return false
  const st = el.closest(STREAMER_ZONES.structured)
  return !(st && free.contains(st))
}
