// imgcap.dump.tsx — STEP 1 of the presented-image caption probe.
//
// Renders the REAL <ImgCardCaption/> (the component desk.tsx uses) at several
// filename lengths, inside the real .filecard.imgcard wrapper, and writes the
// markup to a file for imgcap_probe.py to measure in a real layout engine.
//
// Kept OUT of the `*.test.tsx` glob deliberately: it asserts nothing and would
// otherwise sit in the suite looking like a passing test.

import { renderToStaticMarkup } from 'react-dom/server'
import { ImgCardCaption } from '../src/canvas/img'
import { writeFileSync } from 'node:fs'

// the case from the user's screenshot, plus the ends of the range
const CASES: { id: string; name: string }[] = [
  { id: 'reported', name: 'kyo_spotlight_fixed_front.png' },
  { id: 'short', name: 'a.png' },
  { id: 'brutal', name: 'a_really_extremely_long_generated_filename_with_no_'
      + 'break_opportunities_at_all_whatsoever_final_v2.png' },
]

const card = (id: string, name: string) => (
  <div className="filecard imgcard" id={`card-${id}`}
    style={{ maxWidth: '420px' }}>
    <img className="imgcard-img" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="
      alt={name} />
    <ImgCardCaption name={name} bytes={194560} href="#dl"
      note="a caption the agent wrote about this picture" />
  </div>
)

const html = `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="__CSS__">
<body style="margin:0;background:#111">
${CASES.map((c) => `<div class="case" data-case="${c.id}" data-name="${c.name}">
${renderToStaticMarkup(card(c.id, c.name))}</div>`).join('\n')}
</body>`

const out = process.argv[2]
if (!out) throw new Error('usage: node tests/imgcap_dump.mjs <out.html>')
writeFileSync(out, html, 'utf8')
console.log(`wrote ${out} (${CASES.length} cases)`)
