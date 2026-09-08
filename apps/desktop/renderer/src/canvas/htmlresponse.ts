// canvas/htmlresponse.ts — render-inline-html-custom-responses.
//
// An agent's chat reply is Markdown, sanitized (`shared.ts` md()) and never
// executed — DOMPurify strips scripts, event handlers and iframes from
// ordinary prose, and that is correct: a chat message is not a place code
// runs. This module adds ONE explicit exception, opt-in per message rather
// than a mode switch on the surface: a fenced code block tagged with the
// exact info string below. Any other fence — including a plain ```html
// sample — renders as ordinary code, unchanged.
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
//    allow-popups.
//  - the payload is assigned to the `.srcdoc` DOM PROPERTY, never written
//    into an HTML string that gets re-parsed — so it needs no attribute
//    escaping (unlike the backend's new-tab mockup wrapper, which builds a
//    srcdoc="..." attribute in a text response and must escape it there).
//  - a strict CSP is carried as a <meta> tag INSIDE that srcdoc document
//    (there is no HTTP response here to carry a header): default-src 'none'
//    blocks network by default (fetch/XHR/websocket/remote images/frames);
//    script-src/style-src 'unsafe-inline' is what lets the agent's own
//    inline <script>/<style> run; img/font/media-src data: allows embedded
//    data URIs without allowing a network fetch.
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
