# Offline Markdown mathematics

The shared `md()` pipeline renders LaTeX on every Markdown reading surface.
Inline delimiters are `$...$` and `\(...\)`; display delimiters are `$$...$$`
and `\[...\]`, including multiline display environments. This includes desk
transcripts and thoughts, helper prose, mail, quick chat, docket descriptions
and presentations. Every caller of `md()` inherits the same renderer;
standalone HTML previews and external Hubchat clients keep their own renderers.

`markdownmath.ts` owns an isolated Marked parser with math token extensions.
Code blocks and inline code retain Markdown's lexer precedence. Invalid LaTeX
is escaped as its complete delimited source rather than swallowed or emitted as
an error element. Ordinary Markdown still passes through `escapeAngles` and
DOMPurify. The reference decorator excludes KaTeX's HTML and MathML subtrees.
DOMPurify explicitly retains KaTeX's text-only MathML `annotation` source;
its default tag set otherwise discards that accessibility metadata.

Dollar syntax is deliberately conservative: no whitespace at the inner edges,
no digit or identifier immediately after the closing dollar, and no plain
numeric amount or bare uppercase shell identifier. Use explicit `\(...\)`
for ambiguous formulas such as numeric-only expressions or `$HOME$`.
Currency, escaped dollars and shell commands remain prose. An unfinished
delimiter remains ordinary Markdown, so streaming prose continues to render.

KaTeX is pinned to **0.16.47**. `styles.css` imports its bundled CSS and fonts;
the normal renderer build resolves them into local assets. Pop-out windows
inherit the renderer stylesheets through the existing pop-out style mirroring.
There is no CDN or runtime download. `trust:false`, strict parsing, an expansion
ceiling and a fresh macro dictionary for every formula prevent network/HTML
commands and cross-message macro definitions.

Author verification uses the shared production `md()` plus the real DOM
reference pass. `markdownmath.test.ts` covers delimiters, code, currency, shell
text, errors, HTML-like input, references, document ownership and trust/macros.
`tools/markdownmath-smoke.mjs` also produces a synthetic dark/light fixture
with bundled fonts and rejects HTTP requests and stale capture palettes. This
is focused renderer evidence, not a native detached-window lifecycle proof or
an app/installer build. Raw receipts stay under the author's own build scope.
