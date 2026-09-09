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
// ISOLATION, two independent layers — CSP inside the frame, and a session-
// level request guard in the ASSEMBLED APP outside it. Neither is sufficient
// alone; do not describe this feature's isolation from only one of them.
//
// LAYER 1 — the frame's own sandbox + CSP:
//  - `sandbox="allow-scripts"` and nothing else: no allow-same-origin (the
//    frame gets an opaque origin — no access to the parent DOM, cookies,
//    storage or IPC), no allow-forms, no allow-top-navigation, no
//    allow-popups. Together these mean the frame can never reach outside
//    its own rectangle: it cannot navigate the parent tab, open a new
//    window/tab, or touch anything the app itself holds.
//  - the payload is assigned to the `.srcdoc` DOM PROPERTY, not written into
//    an HTML string by hand — but `wrapCodeBlocks` DOES end by serializing
//    the whole template back to a string (`tpl.innerHTML`), and `md()`'s
//    caller sets THAT via `dangerouslySetInnerHTML`, which the browser
//    re-parses. So the round trip is real, not skipped — the safety
//    property is that both halves (`Element.innerHTML` getter, then the
//    browser's own HTML parser on the way back in) are the platform's own
//    serializer and parser, not hand-written string concatenation. That is
//    exactly the escaping discipline the backend's new-tab mockup wrapper
//    has to perform ITSELF with `html.escape(payload, quote=True)` because
//    it is building a text HTTP response by hand; here the browser does it,
//    correctly, for free. `htmlresponse.test.ts` exercises this exact
//    round trip (parses `md()`'s returned string a second time and reads
//    `.srcdoc` back) rather than assuming it.
//  - a strict CSP is carried as a <meta> tag INSIDE that srcdoc document
//    (there is no HTTP response here to carry a header): default-src 'none'
//    blocks every FETCH-governed network path by default (fetch/XHR/
//    websocket/EventSource/remote images/fonts/media/nested frames);
//    script-src/style-src 'unsafe-inline' is what lets the agent's own
//    inline <script>/<style> run; img/font/media-src data: allows embedded
//    data URIs without allowing a network fetch.
//  - what this layer does NOT cover: CSP's fetch directives (default-src,
//    connect-src included) do not govern NAVIGATION — a clicked <a href>,
//    a script `location = ...`, or a <meta http-equiv=refresh> is not a
//    fetch, so CSP alone does not stop the frame sending ITSELF (never the
//    parent tab — allow-top-navigation is what would allow that, and it is
//    not granted) to an external URL. No CSP directive with reliable
//    cross-browser support closes this (`navigate-to` exists on paper and
//    is not shipped anywhere).
//
// LAYER 2 — the actual defense against that gap, OUTSIDE this module:
//    `apps/desktop/main/windows.ts`'s `configureEngineSession` installs a
//    SESSION-LEVEL `webRequest.onBeforeRequest` on the app's session —
//    every request Chromium's network stack would make for ANY frame in
//    that session, main or sub, passes through it before it is sent. Its
//    rule cancels every `resourceType === 'subFrame'` request whose URL
//    does not start with `about:` — the srcdoc load itself (`about:srcdoc`)
//    is exempt, but a navigation attempt to `https://…` from inside the
//    frame is exactly a non-`about:` subFrame request and is cancelled at
//    the network layer before it leaves the process. This is a general app
//    guard, not code added for this feature, and it is why the CSP gap
//    above is closed in the app agents actually run in — Opus confirmed
//    empirically (bounded Electron check, this session): the navigation
//    attempt was blocked and the parent window remained responsive
//    (a bounded measurement — no memory-exhaustion guarantee is claimed).
//    Do not restate the CSP-only gap as still-open without also naming this
//    layer; do not claim the isolation as airtight from the CSP alone.
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
