// palette.dump.tsx — the markup half of `palette_probe.py` (2026-09-03): the
// WHOLE OpenRouter vendor palette on one page, so it can be judged the only
// way a palette can be — by looking at it. For every vendor the backend
// minted (palette_probe.py hands the rows over as JSON): the researched
// BRAND swatch beside the four price-band monogram cards, the hire-strip
// chip and the tier chip — with the SAME generated stylesheet the app
// injects (`openrouterTierCss`) and the real `<ModelCard/>`. Then the blue
// family and the dark trio at chip size over the canvas dot grid, where the
// question "can these be told apart?" is actually asked.
//
//   node tests/palette_dump.mjs <out.html> <palette.json>

// the harness first: it installs the jsdom globals the app modules expect at
// import time (shared.ts registers a document listener when it loads)
import '../tests/harness'
import { readFileSync, writeFileSync } from 'node:fs'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { ModelCard } from '../src/canvas/openrouter'
import { openrouterTierCss } from '../src/canvas/shared'
import type { ProviderTier } from '../src/types'

type Row = {
  vendor: string
  brand: string | null
  note: string
  tiers: ProviderTier[]   // the four price bands, cheapest first
}
type Palette = {
  groups: { title: string; rows: Row[] }[]
  blues: ProviderTier[]   // the blue family at one band, in table order
  blues_pale: ProviderTier[]
  darks: ProviderTier[]   // the dark trio, cheap + dear
}

const [dest, jsonPath] = process.argv.slice(2)
if (!dest || !jsonPath) {
  console.error('usage: node tests/palette_dump.mjs <out.html> <palette.json>')
  process.exit(2)
}
const pal = JSON.parse(readFileSync(jsonPath, 'utf-8')) as Palette
const every: ProviderTier[] = [
  ...pal.groups.flatMap((g) => g.rows.flatMap((r) => r.tiers)),
  ...pal.blues, ...pal.blues_pale, ...pal.darks,
]
// one rule block per distinct tier id (the same tier may appear in two lists)
const seen = new Set<string>()
const tiers = every.filter((t) => (seen.has(t.tier) ? false : (seen.add(t.tier), true)))

function Strip({ items }: { items: ProviderTier[] }) {
  return (
    <div className="hsof sample-strip">
      {items.map((t) => (
        <button key={t.tier} className={`t-${t.tier}`} title={`hire a ${t.label}`}>{t.letter}</button>
      ))}
    </div>
  )
}

function Cards({ items, large }: { items: ProviderTier[]; large?: boolean }) {
  return (
    <div className="cards">
      {items.map((t) => (
        <ModelCard key={t.tier} letter={t.letter} color={t.color ?? '#9aa0a6'} accent={t.accent}
          title={`${t.label} · ${t.name} — ${t.vendor} · $${t.prompt}/M in`} large={large} />
      ))}
    </div>
  )
}

function Grid({ z }: { z: number }) {
  return (
    <div className="canvas-bg" style={{
      backgroundSize: `${28 * z}px ${28 * z}px`,
      ['--dot-r' as string]: `${Math.max(1, 1.1 * z).toFixed(2)}px`,
    }} />
  )
}

const host = document.createElement('div')
document.body.appendChild(host)
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
const root = createRoot(host)
flushSync(() => root.render(
  <div className="pal">
    <div className="cap-main">
      OpenRouter vendor palette — brand swatch (as researched) · minted cards at $0.5 / $2 / $5 / $9 per M input · hire-strip chip · tier chip
    </div>
    {pal.groups.map((g) => (
      <section key={g.title} data-group={g.title}>
        <h2>{g.title}</h2>
        {g.rows.map((r) => {
          const mid = r.tiers[1] ?? r.tiers[0]!
          return (
            <div key={r.vendor} className="prow" data-vendor={r.vendor}>
              <span className="vname">{r.vendor}</span>
              <span className="brand">
                {r.brand
                  ? <><span className="brand-sw" style={{ background: r.brand }} />{r.brand}</>
                  : <span className="dim">—</span>}
              </span>
              <Cards items={r.tiers} large />
              <Strip items={[mid]} />
              <span className="tchip">
                <span className={`tier t-${mid.tier}`}>{mid.letter}</span>
                <span className="lbl">{mid.label}</span>
              </span>
              <span className="note">{r.note}</span>
            </div>
          )
        })}
      </section>
    ))}
    <div className="zrow" data-zoom="blue family — chips at desk zoom ×1, $5 band then $0.5 band">
      <Grid z={1} />
      <div className="cap">the blue family at chip size — $5 band, then $0.5 band (letters R L K N G C D Q G)</div>
      <div className="stack">
        <Strip items={pal.blues} />
        <Strip items={pal.blues_pale} />
        <Cards items={pal.blues} />
      </div>
    </div>
    <div className="zrow" data-zoom="blue family — ×0.6 over the overview dot grid">
      <Grid z={0.6} />
      <div className="cap">the same, scaled ×0.6 (overview zoom)</div>
      <div className="stack" style={{ transform: 'scale(0.6)', transformOrigin: 'top left' }}>
        <Strip items={pal.blues} />
        <Cards items={pal.blues} />
      </div>
    </div>
    <div className="zrow" data-zoom="dark trio">
      <Grid z={1} />
      <div className="cap">the dark trio — xAI black · MiniMax navy + orange rim · Z.AI grey + cyan rim (cheap, then dear)</div>
      <div className="stack">
        <Strip items={pal.darks} />
        <Cards items={pal.darks} large />
        <span className="chip agents">
          {pal.darks.length} live
          {pal.darks.map((t) => <b key={t.tier} className={`t-${t.tier}`}>{t.letter}1</b>)}
        </span>
      </div>
    </div>
  </div>,
))
writeFileSync(dest,
  `<style id="orgtree-openrouter-tiers">\n${openrouterTierCss(tiers)}\n</style>\n${host.innerHTML}\n`,
  'utf-8')
console.log(`wrote ${dest} (${tiers.length} tiers)`)
