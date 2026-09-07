// xai.dump.tsx — the markup half of `xai_theme_probe.py` (2026-09-03).
//
// Renders every surface an OpenRouter tier colour reaches — the node card at
// three zooms (mini / middle / desk), the hire-chip strip, the header
// inventory chip, the settings monogram cards and a picker row — for one xAI
// favorite (the black theme) beside an OpenAI and an Anthropic favorite that
// share its letter or its provider, with the SAME generated stylesheet the
// app injects (`openrouterTierCss`) and the real `<ModelCard/>`. The probe
// wraps this in styles.css over the canvas dot grid and measures it in Edge.
//
//   node tests/xai_dump.mjs <out.html>

// the harness first: it installs the jsdom globals the app modules expect at
// import time (shared.ts registers a document listener when it loads)
import '../tests/harness'
import { writeFileSync } from 'node:fs'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { ModelCard } from '../src/canvas/openrouter'
import { openrouterTierCss } from '../src/canvas/shared'
import type { ProviderTier } from '../src/types'

// what the backend serves for these three favorites (letters by the first
// word, colours by vendor + price band; grok's is the xAI near-black)
export const TIERS: ProviderTier[] = [
  { tier: 'or-x-ai-grok-4-6', provider: 'openrouter', seat: 2, model: 'x-ai/grok-4.6',
    letter: 'G', color: '#0d0d0d', name: 'Grok 4.6', label: 'grok-4.6', vendor: 'x-ai',
    prompt: 2, completion: 6, context: 2000000 },
  { tier: 'or-openai-gpt-5-6-luna', provider: 'openrouter', seat: 1, model: 'openai/gpt-5.6-luna',
    letter: 'G', color: '#9fe3d1', name: 'GPT-5.6 Luna', label: 'gpt-5.6-luna', vendor: 'openai',
    prompt: 0.2, completion: 1.2, context: 1050000 },
  { tier: 'or-anthropic-claude-sonnet-5', provider: 'openrouter', seat: 2,
    model: 'anthropic/claude-sonnet-5', letter: 'C', color: '#f9907f', name: 'Claude Sonnet 5',
    label: 'claude-sonnet-5', vendor: 'anthropic', prompt: 2, completion: 10, context: 1000000 },
]
const GROK = TIERS[0]!

const ZOOMS = [
  { z: 0.4, kind: 'mini', label: 'overview zoom ×0.4 — mini card' },
  { z: 0.75, kind: 'norm', label: 'middle zoom ×0.75' },
  { z: 1, kind: 'norm', label: 'desk zoom ×1' },
] as const

function Card({ kind, tier }: { kind: 'mini' | 'norm'; tier: ProviderTier }) {
  const cls = `sq ${kind} prov-openrouter tier-${tier.tier}`
  return kind === 'mini'
    ? <div className={cls}><div className="mini-name">grok-agent</div></div>
    : (
      <div className={cls}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: 8 }}>
          <span className={`tier t-${tier.tier}`}>{tier.letter}</span>
          <span className="name">grok-agent</span>
        </div>
      </div>
    )
}

function Strip() {
  // the hire strip: the xAI G beside the OpenAI G (same letter, told apart by
  // colour alone) and the Anthropic C, plus a static Claude chip for scale
  return (
    <div className="hsof sample-strip">
      {TIERS.map((t) => (
        <button key={t.tier} className={`t-${t.tier}`} title={`hire a ${t.label}`}>{t.letter}</button>
      ))}
      <button className="t-sonnet" title="hire a sonnet">S</button>
    </div>
  )
}

// rendered with the client renderer under the harness's jsdom (the server
// renderer needs a CommonJS `require("stream")` the bundled ESM cannot do)
const host = document.createElement('div')
document.body.appendChild(host)
// a dump is not a test: no act() bookkeeping, no act() warning
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
const root = createRoot(host)
flushSync(() => root.render(
  <>
    {ZOOMS.map(({ z, kind, label }) => (
      <div key={z} className="zrow" data-zoom={label}>
        <div className="canvas-bg" style={{
          backgroundSize: `${28 * z}px ${28 * z}px`,
          ['--dot-r' as string]: `${Math.max(1, 1.1 * z).toFixed(2)}px`,
        }} />
        <div className="cap">{label}</div>
        <div className="sample" style={{ transform: `scale(${z})` }}>
          <Card kind={kind} tier={GROK} />
        </div>
        <Strip />
      </div>
    ))}
    <div className="settings-row" data-zoom="settings">
      <div className="cap">App settings → Providers: the favorites row, the header inventory, a picker row</div>
      <div className="orr-favs" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        {TIERS.map((t) => (
          <ModelCard key={t.tier} letter={t.letter} color={t.color ?? '#9aa0a6'}
            title={`${t.label} · ${t.name} — ${t.vendor}`} />
        ))}
        <span className="orr-hint">3 models hireable · click to change</span>
      </div>
      <span className="chip agents" style={{ marginLeft: 24 }}>
        3 live
        {TIERS.map((t) => <b key={t.tier} className={`t-${t.tier}`}>{t.letter}1</b>)}
      </span>
      <div className="orr-list" style={{ maxWidth: 560 }}>
        <button type="button" className="orr-row on" aria-pressed="true">
          <ModelCard letter={GROK.letter} color={GROK.color ?? '#9aa0a6'} large />
          <span className="orr-name">
            <b>{GROK.name}</b>
            <span className="dim">{GROK.vendor} · {GROK.label} · 2M ctx</span>
          </span>
          <span className="orr-price">$2 in<br />$6 out<br /><span>per 1M</span></span>
          <span className="orr-check">✓ selected</span>
        </button>
      </div>
    </div>
  </>,
))
const html = host.innerHTML

const dest = process.argv[2]
if (!dest) {
  console.error('usage: node tests/xai_dump.mjs <out.html>')
  process.exit(2)
}
writeFileSync(dest,
  `<style id="orgtree-openrouter-tiers">\n${openrouterTierCss(TIERS)}\n</style>\n${html}\n`,
  'utf-8')
console.log(`wrote ${dest}`)
