// canvas/htmlresponse.ts — render-inline-html-custom-responses.
//
// An agent's chat reply is Markdown, sanitized (`shared.ts` md()) and never
// executed — DOMPurify strips scripts, event handlers and iframes from
// ordinary prose, and that is correct: a chat message is not a place code
// runs. This module adds ONE explicit exception, opt-in per message rather
// than a mode switch on the surface: a fenced code block whose LANGUAGE TOKEN
// — the first whitespace-delimited word of the fence's info string, exactly
// what `marked` already keys every other language's code-block class on —
// is the reserved word below. (` ```orgtree-html-response some note ` still
// matches, the trailing note is simply not part of the language token, same
// as ` ```python 3.12 ` renders as ordinary Python.) Any other fence —
// including a plain ```html sample — renders as ordinary code, unchanged.
//
// ⚠ THE MATCH RUNS ON THE SANITIZED DOM, NOT THE SOURCE MARKDOWN — it looks
// for `<pre><code class="language-orgtree-html-response">` after DOMPurify,
// not for the literal fence text. That is deliberately robust rather than
// fragile against a different renderer path, but it means the guarantee this
// module rests on is upstream: `shared.ts`'s `escapeAngles` escapes `<`
// outside of fences/inline-code/indented blocks BEFORE `marked` ever runs, so
// an agent cannot type a bare `<pre><code class="language-orgtree-html-
// response">` in ordinary prose and have it survive as a real element — it
// arrives at DOMPurify already entity-escaped, decodes back to inert TEXT,
// and never becomes DOM. `htmlresponse.test.ts` pins this with a positive
// control (a message that says exactly that, verbatim, in prose).
//
// The swap happens where `wrapCodeBlocks` already walks the sanitized DOM
// once per unique source text (cached by `md()`), so it costs nothing extra
// on re-render and needs no separate DOM pass or cheap-exit tracking the way
// a per-render effect (`refmd.tsx`'s linkifyRefs) would.
//
// ISOLATION, by construction:
//  - `sandbox="allow-scripts"` and nothing else: no allow-same-origin (the
//    frame gets an opaque origin — no access to the parent DOM, cookies,
//    storage or IPC), no allow-forms, no allow-top-navigation, no
//    allow-popups. Together these mean the frame can never reach outside
//    its own rectangle: it cannot navigate the parent tab, open a new
//    window/tab, or touch anything the app itself holds.
//  - the payload is assigned to the `.srcdoc` DOM PROPERTY, never written
//    into an HTML string that gets re-parsed — so it needs no attribute
//    escaping (unlike the backend's new-tab mockup wrapper, which builds a
//    srcdoc="..." attribute in a text response and must escape it there).
//  - a strict CSP is carried as a <meta> tag INSIDE that srcdoc document
//    (there is no HTTP response here to carry a header): default-src 'none'
//    blocks every FETCH-governed network path by default (fetch/XHR/
//    websocket/EventSource/remote images/fonts/media/nested frames);
//    script-src/style-src 'unsafe-inline' is what lets the agent's own
//    inline <script>/<style> run; img/font/media-src data: allows embedded
//    data URIs without allowing a network fetch.
//
//  ⚠ WHAT THIS DOES NOT COVER — CSP's fetch directives (default-src,
//    connect-src included) explicitly do not govern NAVIGATION: a clicked
//    `<a href>`, a script `location = ...`, or a `<meta http-equiv=refresh>`
//    can still send the FRAME ITSELF (never the parent tab — that is what
//    the missing allow-top-navigation prevents) to an external URL. No CSP
//    directive with reliable cross-browser support blocks this today
//    (`navigate-to` exists on paper and is not shipped). This is a property
//    of iframes in general, not a gap specific to this feature — the same
//    is true of the document-mockup route's frame (api.py), which accepts
//    it deliberately by permitting outbound network altogether. Here it is
//    a real, open residual: contained to the frame's own rectangle (it
//    still cannot read anything the app holds), but it IS an outbound
//    network action a "no network by default" claim should not paper over.
export const HTML_RESPONSE_LANG = 'orgtree-html-response'
const HTML_RESPONSE_CLASS = 'language-' + HTML_RESPONSE_LANG

// a generous but bounded size — this is an inline chat surface, not the
// document-mockup route's file-backed 4 MB preview. Past this, the block is
// left as an ordinary code block rather than handed to an iframe: silently
// truncating executable HTML would render something the agent didn't write.
export const HTML_RESPONSE_MAX_CHARS = 300_000

const HTML_RESPONSE_CSP = "default-src 'none'; script-src 'unsafe-inline'; "
  + "style-src 'unsafe-inline'; img-src data:; font-src data:; "
  + "media-src data:; connect-src 'none'; form-action 'none'; "
  + "frame-src 'none'; base-uri about:"

/** The isolated document an `orgtree-html-response` block renders inside.
 *  `payload` becomes the frame's own body — it is parsed as HTML BY THE
 *  FRAME, which is exactly the point, so it is never escaped here. */
function wrapHtmlResponseDoc(payload: string): string {
  return '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + '<base href="about:blank">'
    + `<meta http-equiv="Content-Security-Policy" content="${HTML_RESPONSE_CSP}">`
    + '<style>html,body{margin:0}</style>'
    + '</head><body>' + payload + '</body></html>'
}

/** Build the sandboxed iframe for one `orgtree-html-response` block's raw
 *  (already-unescaped) source. Exported for the render pass and for tests
 *  that want the element without going through a full `md()` parse. */
export function htmlResponseFrame(doc: Document, raw: string): HTMLIFrameElement {
  const el = doc.createElement('iframe')
  el.className = 'html-response-frame'
  el.setAttribute('sandbox', 'allow-scripts')
  el.setAttribute('referrerpolicy', 'no-referrer')
  el.setAttribute('loading', 'lazy')
  el.title = 'agent HTML response — sandboxed, isolated from the app'
  el.srcdoc = wrapHtmlResponseDoc(raw)
  return el
}

/** Swap every `\`\`\`orgtree-html-response` fenced block under `root` for its
 *  sandboxed frame, in place. Runs on the sanitized template DOM inside
 *  `wrapCodeBlocks`, BEFORE the copy-button wrapping that function also does
 *  — a swapped block has no code left to copy-button.
 *
 *  Only a `<pre>` whose sole child is the tagged `<code>` matches (exactly
 *  what `marked` emits for a fenced block) — a hand-authored `<pre>` with
 *  other children is left as prose, never guessed at.
 *
 *  `doc` builds the replacement frame — passed explicitly (never
 *  `root.ownerDocument`) because a `<template>`'s `.content` owns its nodes
 *  through a separate "template contents" document in the DOM spec, and an
 *  element created there would not behave as a normal frame once moved. */
export function renderHtmlResponses(root: ParentNode, doc: Document): void {
  const blocks = root.querySelectorAll(`pre > code.${HTML_RESPONSE_CLASS}`)
  blocks.forEach((code) => {
    const pre = code.parentElement
    if (!pre || pre.children.length !== 1) return
    // `textContent` decodes the entities `marked`/DOMPurify left behind
    // (`&lt;` → `<`), returning exactly the source the agent fenced.
    const raw = code.textContent ?? ''
    if (raw.length > HTML_RESPONSE_MAX_CHARS) return
    pre.replaceWith(htmlResponseFrame(doc, raw))
  })
}
