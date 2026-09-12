import { useSurfaceDocument } from '../popout'
// canvas/shared.ts — the split Canvas's leaf module: the canvas view types,
// world-space geometry constants and helpers (layout/flatten/springs math),
// the chat-markdown pipeline (md), and the small shared hooks. Helpers and
// types only — this file imports no components. Extracted verbatim from
// Canvas.tsx in the phase-3 split; all comments ride with their code.

import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
// side effect: the document-level "click a markdown image → full-size viewer"
// listener — loaded here because every .md surface renders through this module
import './lightbox'
import { renderHtmlResponses } from './htmlresponse'
import { onLiveBump } from '../livebus'
import { fmtFull, localizeStamps } from '../timefmt'
import type { DependencyList } from 'react'
import type {
  ActivityInfo, AskInfo, CacheForecast, CodexRouteInfo, DirGrant, MailEntry, NodeState,
  NodeStatus, OpRequest, OpResult, PendingSwitch, ProviderInfo, ProviderTier, ReserveInfo,
  ToolGrant, TreeNode, TreePayload,
} from '../types'

// One display alphabet for every provider-backed tier. Keeping the Codex rows
// out of this shared map made every generic card/header caller fall through to
// `?` even though the hire sheet had a separate Codex-only map.
export const TIER_LETTER: Record<string, string> = {
  haiku: 'H', sonnet: 'S', opus: 'O', fable: 'F',
  'gpt-reserve': 'R', luna: 'L', terra: 'T', sol: 'S', astra: 'A',
  // flash shares F with fable by the same accepted collision as sol/sonnet's
  // S — the chip class carries the family
  flash: 'F', pro: 'P',
}
export const TIERS = ['haiku', 'sonnet', 'opus', 'fable']
/** seat cost per tier — mirrors ledger.TIERS. One table, four tiers; the
 *  frontend had four copies of this before. */
export const TIER_SEAT: Record<string, number> =
  { haiku: 1, sonnet: 2, opus: 5, fable: 10 }
/** Model VERSIONS inside a tier — mirrors ledger.MODEL_VERSIONS. A version is
 *  a subcategory of the tier (user ruling 2026-08-04): it never changes the
 *  seat cost and never appears as a chip, only in the gear. A tier absent
 *  here, or present with one entry, offers no choice.
 *  ⚠ ORDER IS THE DEFAULT-FIRST ORDER of ledger.MODEL_VERSIONS: the gear
 *  renders these in sequence and the tier's own default has to be the one at
 *  the head, or the menu reads as though the node is pinned to the older
 *  version it is merely listing. */
export const MODEL_VERSIONS: Record<string, string[]> =
  { opus: ['5', '4.8'], fable: ['5.1', '5'], flash: ['3.8', '3.7', '3.6'] }
/** The codex family (FR-15 preview) — ChatGPT/OpenAI tiers. A
 *  SEPARATE list, never merged into TIERS: every existing surface iterates
 *  TIERS, and a family that cannot be hired yet must not grow chips there by
 *  accident. Mirrors backend providers.py (CODEX_TIERS / CODEX_MODELS) the
 *  same way TIER_SEAT mirrors ledger.TIERS. Seat costs RULED 2026-08-28:
 *  API $ per M input tokens at the STANDING price (sol $5 standard, not the
 *  promo $4; gpt-reserve/luna $0.20). Those two used to floor to 1 and now
 *  cost 0.2 — sub-$1 tiers are priced fractionally by user ruling
 *  2026-09-03, so a `Record<string, number>` here genuinely holds a
 *  fraction. The hire surfaces use this family list when the Codex CLI is
 *  available. */
export const CODEX_ALWAYS_TIERS = ['luna', 'terra', 'sol']
/** LEGACY Codex tokens (user ruling 2026-09-04, audit item 12): known to the
 *  axis so a node that already wears one keeps its letter, colour, seat and
 *  provider class — but NEVER offered by any hire or switch surface
 *  (`codexTierOffer` answers 'hide' for them unconditionally). `gpt-reserve`
 *  stopped being a tier: a `luna` hire spends OpenAI's reserve pool first
 *  and falls back to the direct lane by itself; the backend's route receipt
 *  (`TreeNode.codex_route`) says which one a turn actually ran on. Mirrors
 *  providers.LEGACY_CODEX_TIERS. */
export const LEGACY_CODEX_TIERS = ['gpt-reserve']
/** All KNOWN Codex tiers — legacy tokens (for the nodes wearing them), the
 *  stable hireable family, and rollout tiers whose metadata is installed
 *  before their account access exists. A rollout tier is never offered merely
 *  because it is in this list; `codexTierOffer` requires it in the backend's
 *  live account-scoped tier rows. */
export const CODEX_TIERS = [...LEGACY_CODEX_TIERS, ...CODEX_ALWAYS_TIERS, 'astra']
export const CODEX_TIER_LETTER: Record<string, string> = {
  'gpt-reserve': 'R', luna: 'L', terra: 'T', sol: 'S', astra: 'A' }
export const CODEX_TIER_SEAT: Record<string, number> = {
  'gpt-reserve': 0.2, luna: 0.2, terra: 2, sol: 5, astra: 10 }
/** The antigravity family (D-189, re-walked for the Antigravity CLI
 *  2026-09-02) — Google tiers served by `agy`: flash (3.8-flash, with 3.7 and
 *  3.6 in the version menu) and pro (3.1-pro). Same separate-list rule as the
 *  codex family. Seats by the standing rule: flash $1.50 standing → 1 (the
 *  $0.75 launch price is a promo), pro $2 → 2 (the >200K long-context
 *  surcharge never sets a seat). */
export const ANTIGRAVITY_TIERS = ['flash', 'pro']
export const ANTIGRAVITY_TIER_LETTER: Record<string, string> = { flash: 'F', pro: 'P' }
export const ANTIGRAVITY_TIER_SEAT: Record<string, number> = { flash: 1, pro: 2 }
/** Provider-neutral surfaces (for example the live-agent summary) use this;
 * provider-specific controls keep using their family list. */
export const ALL_TIERS = [...TIERS, ...CODEX_TIERS, ...ANTIGRAVITY_TIERS]

/** Match the backend's Python len(str) character count for user-facing
 * notices. JavaScript String.length counts UTF-16 code units, so it reports
 * two for a non-BMP character while the API reports one. */
export const unicodeLength = (text: string): number => Array.from(text).length
export const formatCount = (count: number): string => count.toLocaleString('en-US')
/** Every STATIC tier's seat in one table — the merge of the three family
 *  tables above, and the frontend's whole answer for "what does a seat cost"
 *  when the payload does not say.
 *
 *  ⚠ IT EXISTS TO KILL A FIFTH COPY. `OrgCanvas` used to spell the same
 *  eleven prices out again as a literal `tree.tiers ?? {…}` fallback, and on
 *  2026-09-04 that copy was found missing `astra` — added to `ledger.TIERS`
 *  in c5049fa and to `CODEX_TIER_SEAT` here, but never to the literal. So on
 *  a payload without `tiers` the UI quoted a price the backend does not
 *  charge, and only one test noticed. Deriving the fallback from the family
 *  tables means a tier added to a family is priced everywhere at once; the
 *  families themselves are still checked against `ledger.TIERS` by
 *  chiptips §8b.
 *
 *  The OpenRouter half is deliberately NOT here: those tiers are minted at
 *  runtime from the payload, so there is no static price to fall back to. */
export const ALL_TIER_SEAT: Record<string, number> =
  { ...TIER_SEAT, ...CODEX_TIER_SEAT, ...ANTIGRAVITY_TIER_SEAT }

/* ── THE OPENROUTER FAMILY (2026-09-02) — TIERS MINTED AT RUNTIME ─────────
 *
 * Every family above is a static list mirroring a backend constant. The
 * OpenRouter lane has no constant to mirror: its tiers are the user's
 * FAVORITES (App settings → Providers → the model picker), each one
 * `or-<slugified model id>` with a seat, a letter and a canonical color the
 * backend computes and serves in the /api/providers entry. So this family is
 * a REGISTRY that the payload fills, not a list — and the surfaces that read
 * `TIER_LETTER`, `providerOf` and the `t-<tier>` / `tier-<tier>` CSS classes
 * keep working unchanged because:
 *   · `setOpenRouterTiers` writes each favorite's letter INTO `TIER_LETTER`
 *     (the one display alphabet), and
 *   · it injects a <style> element carrying the SAME rule shapes the static
 *     tiers get in styles.css (`.tier.t-x`, `.sq.tier-x`, …), so a card or
 *     chip for a runtime tier is coloured by exactly the selectors a static
 *     tier is — no render site learns a new prop for colour.
 * Membership is the prefix, as on the backend (`openrouter.is_tier`). */
export const OPENROUTER_PREFIX = 'or-'
export const isOpenRouterTier = (tier: string): boolean =>
  tier.startsWith(OPENROUTER_PREFIX)
let orTiers: ProviderTier[] = []
const OR_STYLE_ID = 'orgtree-openrouter-tiers'
const OR_TIER_RE = /^or-[a-z0-9-]+$/
const OR_COLOR_RE = /^#[0-9a-f]{6}$/i
/** the injected stylesheet for the current favorites — the six selector
 *  shapes styles.css writes per static tier, one block per favorite. Ids and
 *  colors are validated before they reach CSS text: the payload is ours, but
 *  a stylesheet built from strings is still a stylesheet built from strings. */
export const openrouterTierCss = (tiers: ProviderTier[]): string => tiers
  .filter((t) => OR_TIER_RE.test(t.tier))
  .map((t) => {
    const c = t.color && OR_COLOR_RE.test(t.color) ? t.color : '#9aa0a6'
    const id = t.tier
    const mix = (pct: number) => `color-mix(in srgb, ${c} ${pct}%, var(--line))`
    if (isDarkTierColor(c)) {
      // A DARK TIER COLOUR (the xAI black, 2026-09-03) cannot be the ink the
      // way every light colour is — black text on the dark UI is a hole —
      // so the same selectors invert: the colour becomes the FILL, the
      // letter reads in the UI's strong ink, and a lifted grey rim keeps
      // the edge off the panel and off the canvas dot grid. The three
      // guarantees a light colour gets for free (text contrast, a border,
      // a lift) are kept, not the literal rules. The node card's top edge
      // and the mini card's wash take the colour itself: black IS the theme
      // there, and both sit on a lighter panel. Where the backend serves an
      // ACCENT beside a dark colour (the brand palette, 2026-09-03: MiniMax's
      // orange-red, Z.AI's cyan) it IS the rim — the fill of a near-black
      // cannot carry identity, so the rim does; the xAI black serves none
      // and keeps the grey. A light colour never draws an accent.
      const rim = t.accent && OR_COLOR_RE.test(t.accent)
        ? t.accent : 'color-mix(in srgb, var(--ink) 40%, var(--line))'
      const fill = `color:var(--ink-strong);background:${c};border-color:${rim}`
      return [
        `.tier.t-${id}{${fill}}`,
        `.hsof button.t-${id}{${fill}}`,
        `.hsof button.t-${id}:hover:not(:disabled){border-color:var(--ink-strong)}`,
        `.chip.agents b.t-${id}{${fill};border:1px solid ${rim};border-radius:3px;padding:0 3px}`,
        `.sq.tier-${id}{border-top-color:${c}}`,
        `.sq.mini.tier-${id}{--mini-tier:${c}}`,
        `.sq.prov-openrouter.desk.tier-${id}{border-top-color:${c}}`,
      ].join('\n')
    }
    return [
      `.tier.t-${id}{color:${c};border-color:${mix(45)}}`,
      `.hsof button.t-${id}{color:${c};border-color:${mix(45)}}`,
      `.chip.agents b.t-${id}{color:${c}}`,
      `.sq.tier-${id}{border-top-color:${mix(55)}}`,
      `.sq.mini.tier-${id}{--mini-tier:${c}}`,
      `.sq.prov-openrouter.desk.tier-${id}{border-top-color:${c}}`,
    ].join('\n')
  }).join('\n')
/** is this tier colour too dark to be INK on the dark UI? WCAG relative
 *  luminance under 0.03 (≈ #323232). The xAI near-blacks (#020202…#161616,
 *  ≤ 0.007) are far below; the chrome's own line (#3c3c3c, ~0.045) and every
 *  hue-bearing tier colour the backend mints (OKLCH L ≥ .56, ≳ 0.2) are
 *  above — so no colour that was ever ink flips to a fill. */
export const isDarkTierColor = (hex: string): boolean => {
  if (!OR_COLOR_RE.test(hex)) return false
  const lin = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5) < 0.03
}
/** adopt the payload's favorites as the live family. Idempotent and cheap
 *  when nothing changed, so every surface that polls the payload may call it. */
export const setOpenRouterTiers = (tiers: ProviderTier[] | null | undefined): void => {
  const next = (tiers ?? []).filter((t) => OR_TIER_RE.test(t.tier))
  const same = next.length === orTiers.length && next.every((t, i) => {
    const o = orTiers[i]
    return !!o && o.tier === t.tier && o.color === t.color
      && (o.accent ?? null) === (t.accent ?? null)
      && o.letter === t.letter && o.seat === t.seat && o.name === t.name
      && o.label === t.label && o.model === t.model
  })
  if (same) return
  orTiers = next.map((t) => ({ ...t }))
  for (const t of orTiers) {
    TIER_LETTER[t.tier] = t.letter
    tierModels[t.tier] = t.model
  }
  if (typeof document === 'undefined') return
  let el = document.getElementById(OR_STYLE_ID)
  if (!el) {
    el = document.createElement('style')
    el.id = OR_STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = openrouterTierCss(orTiers)
}
export const openrouterTiers = (): ProviderTier[] => orTiers
export const openrouterTierIds = (keep?: string | null): string[] => {
  const ids = orTiers.map((t) => t.tier)
  if (keep && isOpenRouterTier(keep) && !ids.includes(keep)) {
    return [...ids, keep]
  }
  return ids
}
export const openrouterTier = (tier: string): ProviderTier | undefined =>
  orTiers.find((t) => t.tier === tier)

/* ── WHAT THE USER READS FOR A TIER (2026-09-03) ──────────────────────────
 * User ask, verbatim: "remove the or- and provider name prefix from openrouter
 * model names". An OpenRouter tier is `or-anthropic-claude-sonnet-5` in every
 * key, class name and request — and `claude-sonnet-5` in every place a person
 * reads it. `tierLabel` is the ONE door: every surface that prints a tier
 * name goes through it, so a static tier still prints itself (`sonnet`) and
 * an OpenRouter tier prints its model's label. */
/** the model id after its vendor namespace — `anthropic/claude-sonnet-5` →
 *  `claude-sonnet-5`, the `:free` variant suffix KEPT (a different model at
 *  a different price; the live catalog has 74 such pairs). Mirrors backend
 *  `openrouter.model_label`; where the payload carries a `label` that wins,
 *  because the backend is the one that sees when two favorites would read
 *  the same and keeps both at their full ids. */
export const modelLabel = (modelId: string): string =>
  modelId.includes('/') ? modelId.slice(modelId.indexOf('/') + 1) : modelId
/** tier → model id, remembered from every providers payload and tree payload
 *  seen. A node still running on a favorite that was since DESELECTED has no
 *  registry row; the org doc's own add-only `models` table is where its name
 *  comes from, and a tier once seen is never forgotten within the session. */
const tierModels: Record<string, string> = {}
export const noteTierModels = (
  models: Record<string, string> | null | undefined): void => {
  for (const [tier, model] of Object.entries(models ?? {})) {
    if (OR_TIER_RE.test(tier) && typeof model === 'string' && model) tierModels[tier] = model
  }
}
/** what the user reads for ANY tier: a static tier is its own name; an
 *  OpenRouter tier is its model's label — from the registry, else from the
 *  remembered tier→model table, else (a tier nothing has ever described)
 *  the slug without its `or-` prefix. */
export const tierLabel = (tier: string): string => {
  if (!isOpenRouterTier(tier)) return tier
  const t = openrouterTier(tier)
  if (t) return t.label ?? modelLabel(t.model)
  const m = tierModels[tier]
  return m ? modelLabel(m) : tier.slice(OPENROUTER_PREFIX.length)
}
/* ── THE TOOL DECLARATION, IN ONE VOICE ───────────────────────────────────
 * The OpenRouter catalog says whether a model declares tool support, and
 * until 2026-09-05 that reached the picker and stopped there: the favorites
 * strip, the hire sheet and both switch selects never carried it, so every
 * decision after the first was made without it.
 *
 * ⚠ ONE FORMATTER, because four surfaces print this and four surfaces that
 * each wrote their own phrase would come to disagree — the `tierLabel`
 * lesson one screen up. Every caller renders this string verbatim.
 *
 * ⚠ THREE STATES, AND `(catalog)` ON ALL THREE. `undefined`/`null` is
 * "the catalog declared nothing readable", which is NOT "declared no
 * support" — the picker's old `!m.tools` test collapsed them and printed a
 * capability gap the catalog never claimed. And the suffix is on every
 * state, not just the unknown one, because the SOURCE is the same in all
 * three: this is what openrouter.ai's catalog declares about the model. It
 * is not an observation. Nothing here has run a turn, a tool call or a
 * refusal against the model, so no wording may imply that it has. */
export const toolsNote = (tools: boolean | null | undefined): string =>
  capabilityNote('tools', tools)
/* ── UNIT C (2026-09-05): two more declarations, the SAME voice ──────────
 * `image` is the catalog's `architecture.input_modalities` naming image;
 * `reasoning` is whether its `supported_parameters` names the `reasoning`
 * REQUEST PARAMETER. The second is deliberately worded "Reasoning parameter":
 * membership in a parameter list is not a claim about how a model thinks,
 * and the label must not assert more than the list does.
 *
 * ⚠ DISCLOSURE, NOT BEHAVIOUR. Orgtree sends image content blocks and
 * `--effort` to every OpenRouter seat regardless of these values. None of
 * these strings may read as "images work", "images will be refused",
 * "thinking is on" or "effort is honoured" — no turn is behind any of them.
 *
 * `toolsNote` keeps meaning TOOLS ONLY. Callsites that want all three move
 * to `tierCapabilityNotes` / `capabilityNotes` on purpose, so a reader of a
 * tools-only phrase is never handed three. */
export type CapabilityKind = 'tools' | 'image' | 'reasoning'
const CAPABILITY_LABEL: Record<CapabilityKind, string> = {
  tools: 'Tools', image: 'Image input', reasoning: 'Reasoning parameter',
}
export const capabilityNote = (kind: CapabilityKind,
  value: boolean | null | undefined): string =>
  value === true ? `${CAPABILITY_LABEL[kind]}: supported (catalog)`
    : value === false ? `${CAPABILITY_LABEL[kind]}: not supported (catalog)`
      : `${CAPABILITY_LABEL[kind]}: unknown (catalog)`
/** all three notes for one catalog row / tier row, in a fixed order, joined
 *  by ` · `. An absent field (older backend) is unknown, never skipped: a
 *  skipped note would render the same blank as a lane that has no catalog. */
export const capabilityNotes = (c: { tools?: boolean | null,
  image?: boolean | null, reasoning?: boolean | null } | null | undefined): string =>
  (['tools', 'image', 'reasoning'] as const)
    .map((k) => capabilityNote(k, c ? c[k] : null)).join(' · ')
/** the tools note for a TIER. '' for a static Claude/Codex/Antigravity tier —
 *  the catalog is an OpenRouter fact and inventing one for another lane would
 *  be a claim no catalog made.
 *
 *  ⚠ AN OPENROUTER TIER THE REGISTRY DOES NOT CARRY IS `unknown`, NOT SILENT.
 *  The registry holds the current favorites, so a tier missing from it has no
 *  catalog metadata available at all — which is precisely what unknown means.
 *  Returning '' would render the same blank as a fully-supported Claude tier.
 *  This is a rule about the FORMATTER's answer and claims nothing about which
 *  surfaces can reach it. */
export const tierToolsNote = (tier: string): string => {
  if (!isOpenRouterTier(tier)) return ''
  const t = openrouterTier(tier)
  return toolsNote(t ? t.tools : null)
}
/** all three notes for a TIER, the same two rules: '' for a static lane,
 *  three unknowns for an OpenRouter tier the registry does not carry. */
export const tierCapabilityNotes = (tier: string): string => {
  if (!isOpenRouterTier(tier)) return ''
  return capabilityNotes(openrouterTier(tier))
}
/** seat for ANY tier the static tables or the registry know */
export const anyTierSeat = (tier: string): number =>
  TIER_SEAT[tier] ?? CODEX_TIER_SEAT[tier] ?? ANTIGRAVITY_TIER_SEAT[tier]
    ?? openrouterTier(tier)?.seat ?? 0

/** Which PROVIDER a tier runs on — the UI mirror of backend
 *  `providers.provider_of` (D-196). Derived from the family lists ABOVE
 *  rather than a fresh table, so a tier added to one of them is classified
 *  correctly here without a second edit.
 *
 *  Every caller that needs "do these two tiers live on the same provider"
 *  must use this instead of testing membership inline — D-182's lesson, which
 *  cost a live bug: three copies of one question existed, two agreed, and the
 *  odd one out shipped. Unknown tiers answer 'claude', matching the backend:
 *  the answer decides whether a change CROSSES providers, and wrongly
 *  claiming a crossing would offer to destroy a conversation that was never
 *  at risk. The OpenRouter answer is by PREFIX, as on the backend: a favorite
 *  the registry has not seen yet is still an OpenRouter tier. */
export type ProviderId = 'openai' | 'google' | 'claude' | 'openrouter'
export const providerOf = (tier: string): ProviderId =>
  (CODEX_TIERS.includes(tier) ? 'openai'
    : ANTIGRAVITY_TIERS.includes(tier) ? 'google'
      : isOpenRouterTier(tier) ? 'openrouter' : 'claude')

/** How a provider is named to the user in prose. The dialog says "Codex",
 *  not "openai" — the user picks tiers by the product name they see on the
 *  chips and in the accounts panel. */
export const PROVIDER_LABEL: Record<string, string> = {
  openai: 'Codex', google: 'Antigravity', claude: 'Claude', openrouter: 'OpenRouter' }

/** One provider's hire state as a hire surface needs it — the `/api/providers`
 *  entry narrowed to the three things any surface asks. `null`/`undefined`
 *  means the payload has not arrived yet, which is NOT the same as absent. */
export interface HireState {
  enabled: boolean
  installed: boolean
  reason: string | null
  /** D-203's seam, agreed with `settings-menu` and built here so their change
   *  is a server field rather than a frontend refactor: the user has switched
   *  this provider OFF in settings. Distinct from `installed` ON PURPOSE —
   *  "absent" and "deliberately disabled" must stay tellable apart, because
   *  Claude reports the first on the accounts page and should not nag about
   *  installing something that is sitting right there. MISSING MEANS ON: an
   *  old backend, or one that has never heard of the setting, must not read
   *  as every provider disabled. */
  userEnabled?: boolean
  /** The reserve POOL (item 12) — what a `luna` hire spends first. Rendered
   *  for disclosure only (the accounts panel); it decides no offer. Absent
   *  on an older backend. */
  reserve?: ReserveInfo | null
  /** Tier ids this provider actually offered in its latest payload. Used only
   *  to tighten known conditional rollout tiers; stable tiers retain the
   *  family-level compatibility behavior when talking to an older backend. */
  offeredTiers?: string[]
}

/** What a hire surface should DO with one provider's tier family (D-199).
 *
 *  'offer'   — render live hire buttons.
 *  'disable' — render them, disabled, with `reason` as the tooltip.
 *  'hide'    — do not render the family at all.
 *
 *  ⚠ THE ONE IMPLEMENTATION. Every hire surface calls this — the node chips,
 *  the eye chips, the mobile sheet, and anything wrapping them (the far-zoom
 *  compact control takes its list from whatever this produced, and must not
 *  re-derive it). Before D-199 each surface decided for itself and they
 *  disagreed: an unavailable family was a disabled preview on the subordinate
 *  strip, HIDDEN on the side and top strips, and always shown in the mobile
 *  sheet — the same provider visible on one edge of a card and absent from
 *  another. Claude was not asked at all and so was always offered.
 *
 *  THE SPLIT (user 2026-08-30, "i want them to only see the hire buttons for
 *  the agent harnesses they actually have set up"; ruled by coordinator):
 *  NOT INSTALLED HIDES, SIGNED-OUT DISABLES. They are different claims. "You
 *  have not installed Codex" is a fact about the MACHINE — identical on every
 *  card, and repeating it on thirty hovers is noise, not discoverability; the
 *  accounts panel is its home and carries the install command. "Installed but
 *  signed out" is about a harness the user demonstrably HAS, where a silent
 *  gap reads as the app losing it and the remedy is one command away — so it
 *  stays visible, carrying its own reason.
 *
 *  ⚠ UNKNOWN MEANS OFFER, AND THE FIRST DRAFT OF THIS HAD IT WRONG. Hiding and
 *  disabling both require POSITIVE knowledge; until the payload arrives we
 *  behave exactly as this app always did, and the SERVER gate added in the
 *  same change is what makes that safe — a click on something unavailable is
 *  refused at the door with the same reason the chip would have carried.
 *
 *  The tempting reading is the cautious one, "unknown → disable". It is worse
 *  in both directions. The payload is not always fast (a cold codex probe can
 *  shell out to `--version`), so the common case becomes a dead hire control
 *  on a perfectly good machine for as long as that takes. And `getProviders`
 *  swallows its own failure — a fetch that never resolves leaves the state
 *  null FOREVER, so "disable" is not a brief flicker but a permanently
 *  unusable hire strip, while "offer" degrades to precisely today's
 *  behaviour. A transient detection problem must not be able to brick hiring;
 *  that is the same fear the old Claude exemption was written out of, and it
 *  was right about the danger even though it was wrong about the remedy. */
export type FamilyOffer = 'offer' | 'disable' | 'hide'

export const familyOffer = (h: HireState | null | undefined): FamilyOffer =>
  (h == null ? 'offer'
    // A provider switched off in settings is HIDDEN, not disabled: the user
    // saying "not this one" is the same request the uninstalled user makes
    // implicitly, so it takes the same answer. Checked FIRST — an explicit
    // choice outranks detection, and only `=== false` counts, so an absent
    // field changes nothing (D-203 seam).
    : h.userEnabled === false ? 'hide'
      : h.enabled ? 'offer' : h.installed ? 'disable' : 'hide')

/** The `/api/providers` entry narrowed to what any presence question needs.
 *  Lived inline in OrgCanvas until D-202 gave a second and third surface the
 *  same question; one derivation, so no caller can decide `installed`
 *  differently from the hire strips. */
export const hireOf = (p: ProviderInfo | null | undefined): HireState | null =>
  (p ? { enabled: !!p.hire_enabled, installed: !!p.status?.installed,
         reason: p.reason, userEnabled: p.user_enabled,
         reserve: p.reserve ?? null,
         offeredTiers: (p.tiers ?? []).map((t) => t.tier) } : null)

/** Offer verdict for one Codex tier. A LEGACY token (gpt-reserve) is never
 *  offered — 'hide', unconditionally, whatever the payload says: it is not a
 *  tier any more, and the ruling that removed it ("dont just grey out the
 *  reserve token. remove it entirely", 2026-09-02) already wanted it gone
 *  rather than greyed. Stable tiers preserve the established family
 *  behavior. Any known tier outside that stable set is a conditional
 *  rollout and fails closed unless the backend's fresh account inventory put
 *  it in the provider's tier rows. Missing payload is therefore NOT enough
 *  to light Astra, even though it remains optimistic for the stable family. */
export const codexTierOffer = (
  h: HireState | null | undefined, tier: string,
): FamilyOffer => {
  if (LEGACY_CODEX_TIERS.includes(tier)) return 'hide'
  const base = familyOffer(h)
  return !CODEX_ALWAYS_TIERS.includes(tier)
    && !h?.offeredTiers?.includes(tier) ? 'hide' : base
}

/** D-202: is this provider part of the product on this machine AT ALL?
 *
 *  USER RULING 2026-08-30: if codex isn't installed at all, then codex
 *  shouldn't appear anywhere in the UI whatsoever; it should be entirely
 *  absent — and the same for the other optional provider. So the question
 *  D-199 asked of the hire strips
 *  is now asked of every surface, and it is deliberately THE SAME QUESTION —
 *  `familyOffer`'s 'hide' verdict, not a second test that could drift from it.
 *  The specific defect this shape prevents is a greyed-out Codex chip on a
 *  machine that has never had Codex: "absent" and "signed out" are different
 *  claims and only one function may decide which is which.
 *
 *  ⚠ IT DOES NOT COVER CLAUDE'S EXCEPTION, and must not. The user kept one:
 *  "with claude, since orgtree is built around it, do show that its not
 *  installed on the accounts page, but make it a very small piece of ui."
 *  That is one line in one panel, written where it lives (accounts.tsx)
 *  rather than as a flag here — a general "except sometimes" in this function
 *  would be a licence for the next surface to keep Claude too.
 *
 *  UNKNOWN MEANS SHOWN, and that is a choice rather than a fallthrough.
 *  `familyOffer`'s long note has the reasoning; the short form is that
 *  `getProviders` swallows its own failure, so an unresolved payload is null
 *  FOREVER rather than briefly, and erasing a provider the user actually has
 *  is a worse failure than briefly showing one they lack. The server refuses
 *  the click either way (`provider_hire_gate`, all five doors). */
export const providerShown = (h: HireState | null | undefined): boolean =>
  familyOffer(h) !== 'hide'

/** Which provider families this machine exposes, by the id `providerOf`
 *  returns. Built once per surface that has the payload and threaded down, so
 *  a panel and the card behind it cannot disagree. */
export type ProviderPresence = Record<ProviderId, boolean>

/** Optimistic default for a surface whose payload has not arrived (or that
 *  has no access to one): everything shown, matching `providerShown(null)`. */
export const ALL_PRESENT: ProviderPresence = {
  claude: true, openai: true, google: true, openrouter: true }

export const presenceOf = (p: {
  claude?: ProviderInfo | null
  openai?: ProviderInfo | null
  google?: ProviderInfo | null
  openrouter?: ProviderInfo | null
}): ProviderPresence => ({
  claude: providerShown(hireOf(p.claude)),
  openai: providerShown(hireOf(p.openai)),
  google: providerShown(hireOf(p.google)),
  // the OpenRouter entry's `installed` is "a key is stored" — an absent key
  // hides the family exactly as an absent CLI hides Codex (D-202); the
  // settings page stays the one place it is offered, as the install door
  openrouter: providerShown(hireOf(p.openrouter)),
})

/** The same, straight off the `/api/providers` payload, for surfaces that
 *  poll it themselves rather than being handed three `ProviderInfo`s. `null`
 *  (unresolved, or a backend too old to serve the route) is ALL_PRESENT. */
export const presenceOfPayload = (
  p: { providers: ProviderInfo[] } | null | undefined,
): ProviderPresence => (p == null ? ALL_PRESENT : presenceOf({
  claude: p.providers.find((v) => v.id === 'claude'),
  openai: p.providers.find((v) => v.id === 'openai'),
  google: p.providers.find((v) => v.id === 'google'),
  openrouter: p.providers.find((v) => v.id === 'openrouter'),
}))

/** Should a TIER appear in a list on this machine?
 *
 *  `keep` is the escape hatch every such list needs: a node's OWN tier stays
 *  visible even if its provider has since been uninstalled. Two reasons, and
 *  the second is a bug rather than a nicety. It is TRUE — that agent is
 *  running on that provider, so hiding it would make the UI lie about what is
 *  in front of you. And these lists are `<select>` values: drop the option
 *  that equals the current value and the control renders blank, which turns
 *  "look at this agent's settings" into a silent model change on save. */
export const tierShown = (
  pres: ProviderPresence, tier: string, keep?: string | null,
): boolean => tier === keep || pres[providerOf(tier)]

export interface AutopsyModelOption {
  tier: string
  label: string
  seat?: number
}

export interface AutopsyModelGroup {
  label: string
  models: AutopsyModelOption[]
}

/** Available configured provider models for the auto-autopsy selector.
 *  Sourced from /api/providers payload, explicitly excluding 'fable'.
 *  Only providers with hire_enabled === true are offered.
 */
export function availableAutopsyModels(
  payload: { providers: ProviderInfo[] } | null | undefined,
  currentValue?: string | null,
): AutopsyModelGroup[] {
  const normCurrent = currentValue && currentValue !== 'fable' ? currentValue : null
  if (!payload?.providers) {
    const defaultModels: AutopsyModelOption[] = ['opus', 'sonnet', 'haiku'].map((t) => ({
      tier: t,
      label: tierLabel(t),
      seat: anyTierSeat(t),
    }))
    return [{ label: 'Claude', models: defaultModels }]
  }

  const groups: AutopsyModelGroup[] = []
  let foundCurrent = false

  for (const p of payload.providers) {
    if (!p.hire_enabled) continue
    const models: AutopsyModelOption[] = []
    for (const t of p.tiers || []) {
      if (t.tier === 'fable') continue // ⚠ FABLE NOT SELECTABLE (ruling 2026-09-03)
      if (LEGACY_CODEX_TIERS.includes(t.tier)) continue   // not a tier any more
      if (t.tier === normCurrent) foundCurrent = true
      models.push({
        tier: t.tier,
        label: t.label ?? tierLabel(t.tier),
        seat: t.seat ?? anyTierSeat(t.tier),
      })
    }
    if (models.length > 0) {
      groups.push({
        label: p.label || PROVIDER_LABEL[p.id] || p.id,
        models,
      })
    }
  }

  if (normCurrent && !foundCurrent) {
    groups.unshift({
      label: 'Configured (unavailable)',
      models: [{
        tier: normCurrent,
        label: `${tierLabel(normCurrent)} (unavailable)`,
        seat: anyTierSeat(normCurrent),
      }],
    })
  }

  return groups
}

// ---------------------------------------------------------------- view types
// The canvas overlays the payload's TreeNode with synthetic cards — the eye
// root, the draft card, live lineage bearers — plus flatten()'s plumbing.
// One structural type covers every card; fields absent on some card kinds
// are optional and consumers guard (or assert) exactly where the JS did.
export interface CanvasNode {
  id: string
  state: NodeState | 'draft' | 'user'
  /** null only on the eye root */
  tier: string | null
  /** multi-account: the bound account id, a missing:<provider> park, or
   *  absent pre-cutover (projected from the tree payload) */
  account?: string | null
  account_tint_ordinal?: number
  account_label?: string
  children: CanvasNode[]
  title?: string
  /** set by flatten(): the parent card's id (null on the eye root) */
  parent?: string | null
  /** lineage pseudo-cards: the successor node this bearer floats beside */
  isBearerOf?: string
  bearerIndex?: number
  // --- the TreeNode surface the canvas reads (synthetic cards carry a subset)
  seat?: number
  grant?: number
  free?: number | null
  model_id?: string
  scope?: CanvasScope
  /** what a turn would ACTUALLY launch with: scope.effort, else the org
   *  default, else "" (no --effort flag). Derived server-side so the control
   *  cannot disagree with the runtime — ledger.Org.effective_effort */
  effort_effective?: string
  cost_usd?: number
  occupancy?: number | null
  /** …and it was estimated, not measured (post-compaction, pre-next-turn) */
  occupancy_est?: boolean
  /** the session holds only its own summary until the next turn — no compact
   *  button, because the endpoint refuses it */
  compacted_unrun?: boolean
  context_window?: number | null
  charter?: string | null
  team_charter?: string | null
  mail_pending?: number
  limit_locked?: boolean
  last_status?: NodeStatus | null
  prev_status?: NodeStatus | null
  inflight_at?: string | null
  /** D-234: the model switch queued behind the running turn (TreeNode's) */
  pending_switch?: PendingSwitch | null
  last_denials?: TreeNode['last_denials']
  last_approvals?: TreeNode['last_approvals']
  turns?: TreeNode['turns']
  frozen?: TreeNode['frozen']
  halt?: TreeNode['halt']
  halt_queued?: number
  audiences_held?: string[]
  bearer_state?: TreeNode['bearer_state']
  generation?: number
  lineage?: TreeNode['lineage']
  /** §4.8 — the ARCHIVED-SUMMARY surface. A card reaches the canvas by
   *  spreading its tree entry, so these ride along; they are declared here so
   *  the type says what a card can actually read. `lineage_count` and
   *  `read_only` stand in for `lineage` and `scope` on a seat whose detail was
   *  omitted — go through `lineageCount`/`readOnlyAgent`, never these directly
   *  — and `detail_rev` is what keys the detail cache. */
  detail?: boolean
  charter_line?: string | null
  lineage_count?: number
  read_only?: boolean
  detail_rev?: string | null
  busy?: boolean
  /** D-201 warm-process cache state. Synthetic canvas cards never have one. */
  proc_warm?: boolean
  proc_live?: boolean
  proc_relaunch?: boolean
  proc_relaunch_reason?: string | null
  /** D-201 manual warm-process exclusion and backend-owned control gate. */
  proc_paused?: boolean
  proc_control_enabled?: boolean
  proc_control_action?: 'start' | 'stop' | null
  proc_control_reason?: string | null
  mcp_tool_count?: number | null
  last_turn_mcp_tool_count?: number | null
  mcp_tool_count_provider?: string
  mcp_tool_count_source?: string | null
  mcp_tool_count_reason?: string | null
  mcp_readiness_waiting?: boolean
  mcp_readiness_state?: string | null
  mcp_readiness_reason?: string | null
  cache_forecast?: CacheForecast | null
  /** effective cheap-compact setting for THIS node (org default merged
   *  with its own scope override) — resolved backend-side, because the
   *  org value alone would be wrong on any node that overrides it. */
  cheap_compact_on?: boolean
  /** the compactor's occupancy threshold (fraction, 0.05..0.95) for THIS
   *  node; null when the compactor is off, absent on a backend that does
   *  not report it. The mid-turn banner gates on it (user ruling
   *  2026-09-02 19:19Z). */
  cheap_compact_occ?: number | null
  /** G4: server-derived, from the supervisor's live tail (absent on the
   *  synthetic cards — eye root, draft, bearers — which never run turns) */
  activity?: ActivityInfo
  /** F-04/F-05: the ask card this node shows (ledger.node_ask) */
  ask?: AskInfo | null
  /** FR-03: presented documents — metadata only; the reader fetches the
   *  body on open */
  documents_count?: number
  documents?: { id: string; title: string; at: string; format?: 'markdown' | 'html'; bytes?: number }[] | null
  /** FR-01: parked while the user drives this session from another device */
  remote_controlled?: { at?: string } | null
  waiting?: boolean
  responding?: boolean
  phase?: string | null
  /** api_fallback: this node's in-flight turn is billing the org's own API
   *  key (absent on the synthetic cards, which never run turns) */
  on_fallback?: boolean
  /** which account actually served the last turn (resolved at spawn) */
  ran_as?: string | null
  /** "fallback 2 · <uuid>" when that account is a fallback row, else null */
  ran_as_label?: string | null
  /** item 12: which pool a luna is actually on (live or last turn) */
  codex_route?: CodexRouteInfo | null
  queued?: number
  /** concurrently running subagents (Task/Agent calls in flight) — desk
   *  header shows it beside the working clock, only when > 0 */
  tasks?: number
  /** background subagents (TreeNode.bg_tasks) — FR-2's progress panel */
  bg_tasks?: number
  last_error?: string | null
}

/** a bearer pseudo-card carries a stub scope ({tools:{}, add_dirs:[]}),
 *  so the canvas-side scope is NodeScope with everything but the two
 *  always-present lists optional */
export interface CanvasScope {
  add_dirs: DirGrant[]
  tools: Partial<ToolGrant>
  permission_mode?: string
  org_visibility?: string
  effort?: string
  /** the model VERSION pinned inside the tier — a gear-only subcategory,
   *  never a chip (ledger.MODEL_VERSIONS). Absent = the tier's latest. */
  model_version?: string
  /** item 12: a luna's pool order — reserve first or plan first; absent uses
   *  the app-wide default */
  account_fallback?: boolean
  prefer_reserve?: boolean
}

/** the app-level event feeds OrgCanvas rides (produced by App's WS handler) */
export interface PulseEvent { node: string; event: string; t: number }
export interface StreamEvent {
  assistant_row?: unknown
  committed_row?: import('../types').ChatMessage
  reply_quote?: string
  event_id?: string
  segments?: unknown
  delivery?: unknown
  node: string
  /** 'delta' | 'thinking' | 'thinking_start' | 'text' | 'tool' (supervisor.py
   *  stream()) + 'steered' (api.py) — open: built from untyped WS JSON.
   *  'thinking_start' carries no text: it marks the block opening, which is
   *  the only signal that survives when the reasoning is sealed. */
  kind: string
  text: string
  sticky?: boolean
  t: number
  /** tool_use_id on a 'tool' event — see LiveRow.id */
  id?: string
}
export interface MailEvent { from: string; to: string; t: number }
// ActivityInfo moved to types.ts with G4 — it is a TREE PAYLOAD field now, not
// a client-side accumulation, and types.ts may not import from here (this file
// imports from it). Re-exported so existing importers are untouched.
export type { ActivityInfo } from '../types'
export type OpFn = (body: OpRequest) => Promise<OpResult>
/** a chat chip's mail pointer — routed to whichever box holds the mail */
export type MailLinkFn = (
  m: { id?: string | null; to?: string | null } | null | undefined,
) => void
/** a chat chip's DOCKET pointer — the item a work write acted on, taken from
 *  the tool result rather than inferred from the chip's text (user request
 *  2026-09-05: an update should carry a button that opens the item, the way a
 *  mail send carries one that opens the mail) */
export type WorkLinkFn = (
  w: { slug?: string | null } | null | undefined,
) => void
/** the webmail row: MailEntry plus the decorations MailList's callers add */
export type MailRow = MailEntry & {
  to?: string                   // outgoing rows
  _wait?: boolean               // decorated inside MailList (pending group)
  _wait0?: boolean              // org-inbox pre-split unread flag
  _by?: string                  // org-inbox outbound attribution
  /** an ASK riding the inbox as its own mail row (user ruling 2026-08-04):
   *  the reading pane renders the response UI as the body instead of the
   *  reply UI. Never sent to markRead — it is not a real mail id. */
  _ask?: AskInfo
  /** F-06: @net: outbound delivery state (org-inbox out rows) */
  _state?: 'queued' | 'sent' | 'delivered' | 'read'
  _state_at?: string
  /** §10: wire-failure note copied off the spool entry (queued rows only) */
  _tries?: number
  _err?: string
}

// world-space geometry primitives
export interface Pt { x: number; y: number }
export interface Spring extends Pt { vx: number; vy: number }
export interface View { x: number; y: number; z: number }
export interface DraftState {
  parent: string | null
  tier: string
  /** F-03 side hire: the draft is a SIBLING placed to `side` of `anchor` —
   *  the hire lands under the same superior, and after birth a reorder pins
   *  the chosen ordering (left = before, right = after). */
  beside?: { anchor: string; side: 'left' | 'right' }
  /** FR-25 insert superior (reworked 2026-08-19): the draft WRAPS `anchor`
   *  in the preview tree — it takes the anchor's own slot with the anchor
   *  hanging beneath it (dashed edges above AND below), so the preview IS the
   *  post-splice shape and confirming causes no reflow. Nothing real changes
   *  until confirm, when the hire op carries `above` and the SERVER splices
   *  atomically (hire + ordinal pin + move in one save). `move()` is
   *  budget-neutral, so the fresh hire never needs spare grant to absorb the
   *  anchor. */
  above?: { anchor: string }
}
/** the staged pre-hire permissions (DraftScopeModal → confirmDraft); also
 *  the shape of the would-inherit prefill, whose tools may lack mcp */
export interface DraftScope {
  add_dirs: DirGrant[]
  tools: Partial<ToolGrant>
  org_visibility: string
  effort?: string
  /** item 12: a luna draft's pool order; undefined = the app-wide default */
  prefer_reserve?: boolean
  /** multi-account: explicit account binding for the new hire */
  account?: string
}
export interface Pile {
  key: string
  parent: string
  kind: 'a' | 'c'
  list: string[]
  front: string
}
/** a live-feed row: a StreamEvent copy or a folded thought line */
export interface LiveRow {
  event_id?: string
  /** THE SHARED DURABLE IDENTITY (user ruling 2026-09-11) — the CLI/journal
   *  record uuid this live row's own durable twin will carry, stamped by the
   *  emitter and carried through the reply-snapshot projection
   *  (reply_events._annotate). Present only when the emitter knew it; absent
   *  on rows that kept the server's per-row `live:` counter, and the dedup
   *  guard simply skips those. `event_id` cannot serve: the projection
   *  rewrites it per row, hashing the quoted text, and the live copy is the
   *  capped one. */
  native_event_id?: string
  segments?: unknown
  delivery?: unknown
  kind: string
  text: string
  secs?: number
  sticky?: boolean
  /** render-inline-html-custom-responses: a `kind: "text"` row that is
   *  slash-command stdout, not agent prose — see types.ts LiveRowPayload
   *  for why this is a separate field rather than a distinct `kind`. */
  cmd_output?: boolean
  _at?: number
  node?: string
  t?: number
  /** the CLI's tool_use_id on a 'tool' row — identity, so reconciliation
   *  against the transcript's chip does not have to compare rendered strings */
  id?: string
  /** the server's per-node monotonic row id — the RENDER key. An index key
   *  renames every row below one that retires from the middle (or falls off
   *  the head), remounting them; `n` names the row itself. */
  n?: number
  /** the live copy was capped at emit time; the durable twin carries it whole */
  truncated?: boolean
  /** server stamp (supervisor.live_row) — ISO, present on every server row */
  at?: string
  /** FR-2: a TodoWrite row's checklist, structurally (supervisor.
   *  _todo_live_extra) — only the newest TodoWrite row keeps it. Absent on
   *  a backend from before the live-wire fix, which the progress panel
   *  renders as "updating…" rather than as a list. */
  todos?: { content: string; status: string }[]
  /** FR-17: a Codex `turn/plan/updated` snapshot (supervisor._apply_plan) —
   *  present only on a 'plan' row. `plan` is deliberately the same shape as
   *  `todos` above once mapped through progress.tsx's status vocabulary;
   *  kept as its own field so a Codex checklist is never mistaken for a
   *  fabricated Claude TodoWrite call. */
  plan?: { step: string; status: string }[]
  explanation?: string | null
  threadId?: string
  turnId?: string
}

// the canvas exposes its inverse-zoom to CSS; React's CSSProperties has no
// custom-property indexer, so declare the one we use (type-only)
declare module 'react' {
  interface CSSProperties {
    '--invz'?: string
    /** the UNCLAMPED inverse zoom — the hire chips' counter-scale */
    '--invzf'?: string
    /** dot grid radius scaled against zoom */
    '--dot-r'?: string
  }
}
// dev/demo hook (see the launchSpark effect)
declare global {
  interface Window { __spark?: (from: string, to: string) => void }
}

// world-space geometry (px at zoom 1). Cards are SQUARE (design ruling) and never
// change size — the desk chat fades in OVER the card; you zoom to read it.
export const NODE_W = 124, NODE_H = 124
export const USER_W = 124, USER_H = 124   // the eye is a peer square (user ruling)
const SX = 186, SY = 200, PAD = 90
export const Z_MAX = 12       // enough for one desk to FILL the screen (124px card ≥ ~1450px)
// LOD thresholds on zoom
export const Z_MINI = 0.55
export const Z_DESK = 2.1
// dampened spring (underdamped → gentle elastic overshoot)
export const SPRING_K = 170, SPRING_C = 15

export const DRAFT = '__draft__'
export const USER = '@user'   // actor sentinel — never collides with a node named "user"

/** D-234: the hover text of a queued model switch — ONE wording for every
 *  surface that wears the flag (card badge, map/head/tray/jump marks, desk
 *  header), so no surface can drift into claiming the switch happened */
export const queuedSwitchTitle = (n: {
  tier?: string | null
  pending_switch?: { tier: string; by: string } | null
}): string => {
  const p = n.pending_switch
  if (!p) return ''
  const who = p.by === USER ? 'the user' : p.by
  return `model switch QUEUED by ${who}: ${n.tier ?? '?'} → ${p.tier} applies `
    + 'when the current turn ends — interrupt the turn to apply it now'
}
export const EXTERN = '@extern'      // the org-inbox audience grantor sentinel
/** the ledger's own hand — mirrors ledger.SYSTEM. Mail wearing this `from`
 *  was generated by the machine rather than by any agent, which is what the
 *  de-emphasised notice row keys on (user, 2026-08-28). */
export const SYSTEM = '@system'

/** D-173's SHORTER-ROW predicate, in one place because three renderings now
 *  key on it: the row class, the suppressed preview line, and the pile below.
 *
 *  ⚠ `kind` AND `from`, never either alone. `@system` also sends the user
 *  `kind: "decision"` mail — a Fable limit exhausted, agents halted or whole
 *  subtrees dissolved — and that is the mail they most need to see. Widening
 *  this to "notice OR from @system" would de-emphasise it; widening it to
 *  "any notice" would de-emphasise an AGENT's notice, which in a node mailbox
 *  is the ordinary traffic. This is NOT the read-on-arrival predicate, which
 *  is the kind alone and lives server-side (`Org.to_user_inbox`). */
export const isSystemNotice = (m: MailRow): boolean =>
  !m._ask && m.kind === 'notice' && m.from === SYSTEM

/** Fold each RUN of consecutive system notices into one group, leaving every
 *  other row a group of one (user, 2026-08-28: "if there are multiple
 *  consecutive system notices in a row, collapse them all into a single mail
 *  entry"). Rows in, groups out, order preserved — the caller renders group[0]
 *  as the row and the whole group in the reading pane.
 *
 *  CONSECUTIVE MEANS ADJACENCY IN THE LIST SHOWN, AND NOTHING ELSE. No time
 *  bound: two system notices a day apart with nothing between them are one
 *  entry, because the user described a position ("in a row") and not a
 *  recency, and a time window would make the same two rows fold or not fold
 *  depending on when you looked. ANY row that is not itself a foldable system
 *  notice breaks the run — read or unread, ordinary mail or a @system
 *  DECISION. That is the whole safety property: nothing but a system notice
 *  can ever end up inside a row labelled "N notices".
 *
 *  ⚠ A row still AWAITING delivery is never folded in. `_wait` carries an
 *  unread highlight and, in a node mailbox, a retract button; both are things
 *  to act on, and burying an action inside a summary is the failure this rule
 *  exists to avoid. In the user's own mailbox this clause is quiet by
 *  construction — D-173 lands notices already read — but MailList is the one
 *  mail interface everywhere, and the node and org inboxes do carry pending
 *  rows.
 *
 *  This is a DISPLAY fold and deliberately nothing else: every entry survives
 *  in the record, `user_inbox` membership still means unread (D-173), and
 *  collapsing at write time would destroy what happened for the sake of how
 *  it looks. */
export const pileNotices = (rows: MailRow[], compatible: (a: MailRow, b: MailRow) => boolean = () => true): MailRow[][] => {
  const out: MailRow[][] = []
  for (const m of rows) {
    const run = out[out.length - 1]
    const foldable = isSystemNotice(m) && !m._wait
    if (run && foldable && isSystemNotice(run[0]!) && !run[0]!._wait && compatible(run[0]!, m)) run.push(m)
    else out.push([m])
  }
  return out
}

export const INBOX = '__orginbox__'  // the org-inbox panel's layout id
export const INBOX_H = 64
// the eye's fixed world x (see layout()): generous enough that even a very
// wide left subtree (~32 leaf columns) never crosses into negative space
export const EYE_ANCHOR_X = 6000

// The desk's counter-scale, and the reader's text-size dial over it. Keep this
// the ONE definition: the factor used to live both here-ish (cards.tsx) and in
// .desk-inner's transform, which is one equation with no slack —
// 900 × 0.13333 = 120 = NODE_H − 2×inset.
export const DESK_SCALE = 0.13333
export const DESK_DPI_KEY = 'orgtree-desk-dpi'
// device preference (screen-dependent), so localStorage — never the org doc
export const deskDpi = (): number => {
  try {
    const v = parseFloat(localStorage.getItem(DESK_DPI_KEY) || '1')
    return Number.isFinite(v) && v >= 0.5 && v <= 3 ? v : 1
  } catch { return 1 }
}
const deskDpiSubs = new Set<() => void>()
export const setDeskDpi = (v: number) => {
  try { localStorage.setItem(DESK_DPI_KEY, String(v)) } catch { /* private mode */ }
  document.documentElement.style.setProperty('--desk-dpi', String(v))
  for (const fn of [...deskDpiSubs]) fn()
}
/* D-203: the control moved beside the already-live crowd preference, exposing
   that text size only snapshotted its value when the panel opened. This store
   gives both display preferences the same contract: same-tab writes notify
   immediately, and another tab's storage event updates both React state and
   the CSS variable before it renders. */
const subscribeDeskDpi = (fn: () => void): (() => void) => {
  const onStorage = (e: StorageEvent) => {
    if (e.key != null && e.key !== DESK_DPI_KEY) return
    document.documentElement.style.setProperty('--desk-dpi', String(deskDpi()))
    fn()
  }
  deskDpiSubs.add(fn)
  window.addEventListener('storage', onStorage)
  return () => {
    deskDpiSubs.delete(fn)
    window.removeEventListener('storage', onStorage)
  }
}
export const useDeskDpi = (): number =>
  useSyncExternalStore(subscribeDeskDpi, deskDpi)

/* ------------------------------------------- D-198: the crowd-pile toggle
   Collapsing a wide team's ACTIVE agents into one stack is OPT-IN (user
   ruling 2026-08-29). The behaviour it gates is the CROWD pile in
   OrgCanvas — the retired pile is a different thing and is not affected.

   ⚠ APP-WIDE, NOT PER-ORG (user, verbatim: "app wide, not org wide"), so the
   key carries NO slug — unlike `orgtree-pile-<slug>` next door, which stores
   which member fronts a pile and is genuinely per-org. A machine-level
   preference filed under an org key looks fine until you switch org, at
   which point it silently reverts to the default and reads as the app
   forgetting it.

   ⚠ OFF BY CONSTRUCTION, not by a default value written down somewhere. A
   key that was never set reads back as `null`, and `null !== '1'` is false,
   so a fresh install, a private window, a cleared cache and every existing
   user all get the uncollapsed canvas without anything having to migrate.
   There is deliberately no third "unset" state to behave differently. */
export const CROWD_PILE_KEY = 'orgtree-crowd-piles'
export const crowdPilesOn = (): boolean => {
  try { return localStorage.getItem(CROWD_PILE_KEY) === '1' } catch { return false }
}
const crowdSubs = new Set<() => void>()
export const setCrowdPilesOn = (on: boolean): void => {
  try {
    localStorage.setItem(CROWD_PILE_KEY, on ? '1' : '0')
  } catch { /* private mode */ }
  for (const fn of [...crowdSubs]) fn()          // copy: a listener may detach
}
/* useSyncExternalStore's subscribe half. Same-tab writes come through
   setCrowdPilesOn; `storage` fires only in OTHER tabs, and covers them
   because a preference that disagreed between two windows on the same
   machine would not be app-wide. The event is not filtered by key: the
   snapshot is a boolean, so a spurious wake re-reads the same value and
   React bails out of the render. */
const subscribeCrowdPiles = (fn: () => void): (() => void) => {
  crowdSubs.add(fn)
  window.addEventListener('storage', fn)
  return () => { crowdSubs.delete(fn); window.removeEventListener('storage', fn) }
}
export const useCrowdPiles = (): boolean =>
  useSyncExternalStore(subscribeCrowdPiles, crowdPilesOn)

/* --------------------------- hide retired agents (user resumed 2026-09-10)
   OPT-IN and OFF BY CONSTRUCTION, same contract as the crowd toggle above
   (unset localStorage reads null, null !== '1'). When ON, retired agents
   leave the agent views — canvas cards included — and stay reachable only
   through the retired-list token on a parent that has retired subordinates
   and through the switchboard's archived rows for retired top-levels; any
   jump to a hidden retiree reveals it. A DISPLAY preference only: no org
   record changes, and app-wide, not per-org, for the crowd toggle's reason. */
export const HIDE_RETIRED_KEY = 'orgtree-hide-retired'
export const hideRetiredOn = (): boolean => {
  try { return localStorage.getItem(HIDE_RETIRED_KEY) === '1' } catch { return false }
}
const hideRetiredSubs = new Set<() => void>()
export const setHideRetiredOn = (on: boolean): void => {
  try {
    localStorage.setItem(HIDE_RETIRED_KEY, on ? '1' : '0')
  } catch { /* private mode */ }
  for (const fn of [...hideRetiredSubs]) fn()    // copy: a listener may detach
}
const subscribeHideRetired = (fn: () => void): (() => void) => {
  hideRetiredSubs.add(fn)
  window.addEventListener('storage', fn)
  return () => { hideRetiredSubs.delete(fn); window.removeEventListener('storage', fn) }
}
export const useHideRetired = (): boolean =>
  useSyncExternalStore(subscribeHideRetired, hideRetiredOn)

// App-wide agent action buttons: off unless explicitly enabled.
export const AGENT_SHORTCUTS_KEY = 'orgtree-agent-shortcuts'
export const agentShortcutsOn = (): boolean => {
  try { return localStorage.getItem(AGENT_SHORTCUTS_KEY) === '1' } catch { return false }
}
const agentShortcutsSubs = new Set<() => void>()
export const setAgentShortcutsOn = (on: boolean): void => {
  try {
    localStorage.setItem(AGENT_SHORTCUTS_KEY, on ? '1' : '0')
  } catch { /* private mode */ }
  for (const fn of [...agentShortcutsSubs]) fn()    // copy: a listener may detach
}
const subscribeAgentShortcuts = (fn: () => void): (() => void) => {
  agentShortcutsSubs.add(fn)
  window.addEventListener('storage', fn)
  return () => { agentShortcutsSubs.delete(fn); window.removeEventListener('storage', fn) }
}
export const useAgentShortcuts = (): boolean =>
  useSyncExternalStore(subscribeAgentShortcuts, agentShortcutsOn)

/* ------------------------------------------- the startup view (D-228)
   What the canvas shows the moment an org OPENS, and whether it glides there.
   Two settings, because they answer two different questions:

     `orgtree-start-view`   'org' | 'switchboard' | 'remember'   (unset ⇒ 'org')
     `orgtree-start-zoom`   '1' | '0'                             (unset ⇒ on)

   ⚠ APP-WIDE (no slug in either key), for the same reason as the crowd
   toggle above: where you like an org to open is a habit of yours, not a
   property of one org. The REMEMBERED CAMERA is the exception and carries
   the slug — `orgtree-view-<slug>` — because a position is only meaningful
   in the org it was taken in.

   The zoom toggle is read only by the 'org' and 'switchboard' modes.
   'remember' ignores it: a restored camera never glides (the whole point is
   to be back where you were, instantly), and a brand-new org — one this
   browser has no camera for — plays the intro ONCE regardless, since there
   is nothing to restore and the glide is how the org introduces itself.

   Defaults are BY ABSENCE, as with the crowd key: a never-set view key reads
   as 'org' and a never-set zoom key reads as on, so every existing user keeps
   exactly the behaviour they had before these settings existed. */
export type StartView = 'org' | 'switchboard' | 'remember'
export const START_VIEW_KEY = 'orgtree-start-view'
export const START_ZOOM_KEY = 'orgtree-start-zoom'
export const startView = (): StartView => {
  try {
    const v = localStorage.getItem(START_VIEW_KEY)
    return v === 'switchboard' || v === 'remember' ? v : 'org'
  } catch { return 'org' }
}
export const startZoomOn = (): boolean => {
  try { return localStorage.getItem(START_ZOOM_KEY) !== '0' } catch { return true }
}
const startSubs = new Set<() => void>()
const notifyStart = () => { for (const fn of [...startSubs]) fn() }
export const setStartView = (v: StartView): void => {
  try { localStorage.setItem(START_VIEW_KEY, v) } catch { /* private mode */ }
  notifyStart()
}
export const setStartZoomOn = (on: boolean): void => {
  try { localStorage.setItem(START_ZOOM_KEY, on ? '1' : '0') } catch { /* private mode */ }
  notifyStart()
}
// same subscribe contract as the crowd toggle: same-tab writes notify here,
// another tab's write arrives as a `storage` event. Both snapshots are
// primitives, so a wake that changes nothing is a render React bails out of.
const subscribeStart = (fn: () => void): (() => void) => {
  startSubs.add(fn)
  window.addEventListener('storage', fn)
  return () => { startSubs.delete(fn); window.removeEventListener('storage', fn) }
}
export const useStartView = (): StartView =>
  useSyncExternalStore(subscribeStart, startView)
export const useStartZoom = (): boolean =>
  useSyncExternalStore(subscribeStart, startZoomOn)

/** the camera this browser last had on `slug`, or null if it never had one
 *  (a new org, a cleared cache, a hand-edited value — all the same answer) */
export const savedView = (slug: string): View | null => {
  try {
    const raw = localStorage.getItem('orgtree-view-' + slug)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<View> | null
    if (!v || typeof v.x !== 'number' || typeof v.y !== 'number'
      || typeof v.z !== 'number') return null
    if (![v.x, v.y, v.z].every(Number.isFinite) || v.z <= 0) return null
    return { x: v.x, y: v.y, z: v.z }
  } catch { return null }
}
export const saveView = (slug: string, v: View): void => {
  try {
    localStorage.setItem('orgtree-view-' + slug,
      JSON.stringify({ x: v.x, y: v.y, z: v.z }))
  } catch { /* private mode */ }
}

export function withDraftTree(tree: TreePayload, draft: DraftState | null): CanvasNode {
  const draftNode = (): CanvasNode => ({
    id: DRAFT, title: '', tier: draft!.tier, state: 'draft', children: [],
    seat: 0, grant: 0, free: 0,
  })
  // a side-hire draft (F-03) sits ADJACENT to its anchor sibling, so the form
  // previews the ordering the hire will pin; an insert-superior draft (FR-25)
  // WRAPS its anchor — the draft takes the anchor's slot and the anchor hangs
  // beneath it, previewing the exact post-splice shape without touching the
  // real structure; a plain draft appends at the end
  const place = (kids: CanvasNode[]): CanvasNode[] => {
    const a = draft!.above
    if (a) {
      const i = kids.findIndex((k) => k.id === a.anchor)
      if (i < 0) return [...kids, draftNode()]
      const d = draftNode()
      d.children = [kids[i]!]
      return [...kids.slice(0, i), d, ...kids.slice(i + 1)]
    }
    const b = draft!.beside
    const i = b ? kids.findIndex((k) => k.id === b.anchor) : -1
    if (i < 0) return [...kids, draftNode()]
    const at = b!.side === 'right' ? i + 1 : i     // nUIA: i ≥ 0 ⇒ b matched
    return [...kids.slice(0, at), draftNode(), ...kids.slice(at)]
  }
  const mk = (n: TreeNode): CanvasNode => ({
    ...n,
    children: draft && draft.parent === n.id
      ? place(n.children.map(mk)) : n.children.map(mk),
  })
  return {
    id: USER, title: 'you', tier: null, state: 'user',
    children: draft && draft.parent === null
      ? place(tree.roots.map(mk)) : tree.roots.map(mk),
  }
}

/** api_fallback (2026-08-17): is this org billing its own API key RIGHT NOW?
 *  The server ships the option plus the window edge and leaves "active" to the
 *  client's own clock (ledger.tree) — this is the single reader, so the
 *  settings banner, the canvas border and anything later added cannot drift
 *  apart on where the edge is. Re-evaluated on every tree poll, which is what
 *  makes an expiring window drop the red without an event. */
export const fallbackActive = (tree: TreePayload): boolean =>
  !!tree.api_fallback && (tree.api_fallback_until ?? 0) * 1000 > Date.now()

/** Print a credit quantity. Seats are FRACTIONAL below $1/M (user ruling
 *  2026-09-03 — a $0.20 model seats at 0.2, a `:free` one at the 0.1 floor),
 *  so a holding can be 5.2 and a sum of two of them can be
 *  5.300000000000001 in float64. The server quantises to the same 0.01 grid
 *  (`ledger._q`); this is the display half — two decimals at most, trailing
 *  zeros dropped, so a whole number still reads `5` and never `5.00`. */
export const fmtCredits = (n: number): string =>
  String(Math.round(n * 100) / 100)

/** the org's px-per-credit scale — ONE formula for the canvas bars and the
 *  credit-ask card (user ruling 2026-08-05: the ask bar must look identical
 *  to the agent's existing bar, same scale included) */
export function orgPxc(tree: TreePayload): number {
  // kiosk: the cap is the scale — the overseer bar is a fixed size (user spec)
  if (tree.kiosk?.credits) return (NODE_H * 1.6) / tree.kiosk.credits
  const holds = tree.roots
    .filter((n) => n.state === 'live')
    .map((n) => n.seat + n.grant)
  if (!holds.length) return NODE_H / 10
  if (holds.length === 1) return NODE_H / holds[0]!
  const avg = holds.reduce((a, b) => a + b, 0) / holds.length
  const max = Math.max(...holds)
  return Math.min((NODE_H * 1.25) / avg, (NODE_H * 1.6) / max)
}

export function flatten(root: CanvasNode, _seats: Record<string, number>): Map<string, CanvasNode> {
  const map = new Map<string, CanvasNode>()
  const walk = (n: CanvasNode, parent: string | null) => {
    map.set(n.id, { ...n, parent })
    // NO lineage pseudo-cards (D-120, final form). The org axis and the
    // pseudo-card path must carry DISJOINT id sets — same id from both lets
    // sibling order decide which card wins, silently — and after the ruling's
    // predicate settled on "hide iff successor AND archived", the axis
    // carries every non-archived generation (live and unrecoverable alike)
    // while archived ones were always skipped here. Nothing qualifies: the
    // synthesis that used to sit here is dead by construction, and dead
    // rendering paths get deleted, not fenced. `isBearerOf` and its gates
    // remain in the types for the tether/position plumbing until a full
    // sweep retires them — with no producer they never fire.
    n.children.forEach((c) => walk(c, n.id))
  }
  walk(root, null)
  return map
}

export function layout(root: CanvasNode, hidden: Map<string, string> = new Map()): Map<string, Pt> {
  // `hidden`: piled-away retirees (and their subtrees) — they take NO layout
  // space; their positions are assigned afterwards onto their pile's front
  const pos = new Map<string, Pt>()
  const vis = (n: CanvasNode) => !hidden.has(n.id)
  const width = (n: CanvasNode): number => {
    const kids = n.children.filter(vis)
    return kids.length ? kids.reduce((a, c) => a + width(c), 0) : 1
  }
  const place = (n: CanvasNode, x0: number, depth: number) => {
    let cx = x0
    const kids = n.children.filter(vis)
    kids.forEach((c) => { place(c, cx, depth + 1); cx += width(c) })
    const x = kids.length
      ? (pos.get(kids[0]!.id)!.x + pos.get(kids[kids.length - 1]!.id)!.x) / 2 // nUIA: kids.length checked on this branch
      : x0
    pos.set(n.id, { x, y: depth })
  }
  place(root, 0, 0)
  const out = new Map<string, Pt>()
  for (const [id, p] of pos) out.set(id, { x: p.x * SX + PAD, y: p.y * SY + PAD })
  // The EYE is the page's anchor (user ruling): its world position is a
  // CONSTANT, independent of tree shape — otherwise the coordinate space
  // hangs off the tree's left extent and the eye shifts between orgs (and on
  // every hire that widens the tree).
  const eye = out.get(USER)
  if (eye) {
    const dx = EYE_ANCHOR_X - eye.x, dy = PAD - eye.y
    for (const p of out.values()) { p.x += dx; p.y += dy }
  }
  return out
}

/** FR-18: watchdog satellite cards — the user's own sizing ("1/4 to 1/8 the
 *  area" of a 124x124 node). Shrunk from an initial 60x36 (user bug
 *  2026-08-12: read as "too magnified" against the rest of the canvas, and
 *  the name had too little room inside it) to a size closer to the 1/8 end;
 *  name + state glyph is all that fits, the click-through panel carries the
 *  detail. */
export const DOG_W = 50, DOG_H = 26

export function sizeOf(id: string): { w: number; h: number } {
  if (id === USER) return { w: USER_W, h: USER_H }
  if (id === INBOX) return { w: USER_W, h: INBOX_H }
  if (id.startsWith('dog:')) return { w: DOG_W, h: DOG_H }
  return { w: NODE_W, h: NODE_H }
}

// ------------------------------------------------------------- freeze kinds
// WHICH KIND OF FREEZE IS THIS? One classification, rendered three ways — the
// org banner's note (App.tsx), the desk badge (desk.tsx) and the compact card
// badge (cards.tsx). They are three registers of one question, and before this
// existed each made its own two-way test and every one of them ended in the
// same `else` reading "usage limit".
//
// ⚠ THAT DEFAULT IS THE BUG THIS FIXES, TWICE OVER. Every kind the payload
// could not describe fell through to "usage limit" and the display said it
// confidently:
//   · an AUTH freeze (`cause === "auth"`, the credential was rejected) carries
//     `limit: true` — it is a usage-limit freeze in SHAPE only. It read as
//     "usage limit hit", telling the operator to wait for capacity when the
//     fix is to replace a credential. ▶ really does resume it, so it is
//     counted; only the words were wrong.
//   · a SPEND freeze read as "usage limit" on the node badge. The org banner
//     was right about it only because it returns early on the org-level
//     `spend_frozen` flag — a badge has no org flag to consult.
// Both were invisible until `ledger.tree()`'s frozen projection was taught to
// carry `cause` and `spend`; it rebuilds the record key by key and silently
// drops whatever it does not name.
//
// ⚠ ORDER IS MEANING, not style. `limit_locked` outranks everything: a fable
// lock's clock can never fire, so naming any other kind there would promise a
// reset that nobody performs. `spend` outranks `limit` because a spend freeze
// also carries limit-ish shape but is released by raising the limit, not by
// waiting. `auth` outranks `limit` for the same reason — same shape, different
// remedy. `balance` (an OpenRouter 402, 2026-09-05) likewise: limit-shaped, but
// the remedy is the key's credit or its in-flight requests, and after its
// bounded probes it parks until a person resumes it. `connection` is last of
// the real kinds because it is the only one that retries itself.
export type FreezeKind = 'halted' | 'spend' | 'auth' | 'balance' | 'connection' | 'limit'

export function freezeKind(
  fz: { connection?: boolean | null; limit?: boolean | null
        cause?: string | null; spend?: boolean | null } | null | undefined,
  limitLocked?: boolean,
): FreezeKind | null {
  if (limitLocked) return 'halted'
  if (!fz) return null
  if (fz.spend) return 'spend'
  if (fz.cause === 'auth') return 'auth'
  if (fz.cause === 'balance') return 'balance'
  // a PURE connection freeze only — a record carrying both flags is a limit
  // whose wake waits on the auto-resume toggle (D-122)
  if (fz.connection && !fz.limit) return 'connection'
  return 'limit'
}

// The two badge registers. They live here, beside the classification and as
// data, for one reason: as inline ternaries in the JSX they could not be
// tested for the property that actually matters — that every kind gets its
// OWN words. A collapsed branch (two kinds sharing a string) is exactly the
// failure being fixed, and it is invisible unless something compares the
// labels to each other. `freezelabel.test.ts` asserts both maps are TOTAL over
// FreezeKind and that no two kinds share a label.
// FR-27 · the primed-restart chip's WORDS.
//
// Here rather than inline in App.tsx's header, for the reason the two freeze
// registers below are here: as a JSX ternary the one property that matters
// could not be tested. That property is NOT "the chip renders" — it is that a
// prime which will restart the orgs reading this says so, and a prime which
// will NOT (target 'mailhub' rebuilds a container and touches no agent) does
// not get to wear the same words.
//
// ⚠ The record is MACHINE-WIDE: api.py injects the same value into every org's
// tree, so most of this chip's audience did not arm it and is only finding out
// here. That is what the title has to serve — who armed it, why, whether THIS
// org gets cut, and how to stop it.
export interface PrimedChip { label: string; title: string; cutsUs: boolean }

export function primedRestartChip(
  pr: { target?: string | null; by_org?: string | null
        by_node?: string | null; at?: string | null
        reason?: string | null; state?: string | null
        triggered_at?: string | null } | null | undefined,
): PrimedChip | null {
  if (!pr) return null
  const cutsUs = pr.target !== 'mailhub'
  if (pr.state === 'executing') {
    return {
      label: 'restart in progress...',
      title: [
        `triggered at ${fmtFull(pr.triggered_at) || '?'}; deploy has started`,
        cutsUs
          ? 'this backend is shutting down; every org on this machine will restart'
          : 'the mail hub container is rebuilding; agents here are NOT restarted',
        `originally armed by ${pr.by_org ?? '?'}/${pr.by_node ?? '?'}`
          + (pr.reason ? ` — ${pr.reason}` : ''),
      ].join('\n'),
      cutsUs,
    }
  }
  return {
    label: cutsUs
      ? (pr.target === 'both' ? 'restart primed (+ mail hub)' : 'restart primed')
      : 'mail hub restart primed',
    title: [
      `armed by ${pr.by_org ?? '?'}/${pr.by_node ?? '?'} at ${fmtFull(pr.at) || '?'}`
        + (pr.reason ? ` — ${pr.reason}` : ''),
      cutsUs
        ? 'every org on this machine restarts, including this one'
        : 'rebuilds the mail hub container only — agents here are NOT restarted',
      'nothing happens while anyone is mid-turn; it fires by itself once the machine is quiet',
      'disarm with orgtree_prime_restart action=cancel',
    ].join('\n'),
    cutsUs,
  }
}

export const FREEZE_LABEL: Record<FreezeKind, string> = {
  halted: 'HALTED — fable lock',
  spend: 'spend limit',
  auth: 'credential rejected',
  balance: 'balance refused',
  connection: 'network',
  limit: 'usage limit',
}

/** the 124px card's register — same kinds, shorter words */
export const FREEZE_LABEL_SHORT: Record<FreezeKind, string> = {
  halted: 'halted',
  spend: 'spend',
  auth: 'credential',
  balance: 'balance',
  connection: 'net',
  limit: 'limit',
}

// ------------------------------------------------ edge jump card placement
// user bug 2026-08-26: the jump cards sat at a fixed 6px from the window edge
// and overlapped the focused desk on a narrow window. Cards are SQUARE, and a
// focus glide fits one to min(vw, vh) − 48 centred, so on any window taller
// than it is wide the strip beside the desk is exactly 24px — while a full
// card wants 186. Worse, coworkers share a layout row, so the card's elevation
// lands mid-screen: over the chat text, not over a corner.
//
// Placement is chosen from the desk's MEASURED screen rect rather than from
// the window, so hand-zooming past the standard fit behaves the same way —
// including the case where the focus zoom is floored at Z_DESK and the desk
// overflows the viewport entirely (see centerOn), where the gutter goes
// negative and only the bare tab can sit in the desk's own padding.
//
// The shortage flips axes: a narrow window has thin gutters but a deep band
// above and below the desk, a wide window the reverse. So prefer the gutter,
// fall back to the band (which keeps the NAME — the thing worth keeping), and
// only shed content when neither has room. A near-square window is the one
// shape that is tight both ways, and that is what the tab form is for.
// ⚠ EJ_MID IS A MEASUREMENT, NOT A GUESS, and it must stay one. jsdom has no
// box model, so the unit test cannot check any of these against a rendered
// card — it can only assume them. `tests/edgejump_probe.py` renders the real
// markup against the real sheet in Edge and fails if a form outgrows its
// number here; it reads these constants directly out of this file so the two
// cannot drift apart. First measurement came in at 101.63px against a guessed
// 58 — the guess would have shipped cards that still covered the desk on any
// gutter between 66 and 110px, with the unit test green throughout.
export const EJ_EDGE = 6     // the card's inset from its edge of the free region
export const EJ_FULL = 180   // .edge-jump max-width — the named card
export const EJ_MID = 80     // measured 78.50 worst case (busy + unread dot)
export const EJ_H = 26       // card height
export const EJ_GAP = 8      // clearance insisted on between card and desk

export type EJForm = 'full' | 'mid' | 'tab'
export type EJRect = { x0: number; y0: number; x1: number; y1: number }

/** Placement is measured against `region` — the pin-free rectangle the camera
 *  aims at — not the window (user bug 2026-09-05: cards are z-index 7, pins
 *  10–16, so a card at the window edge under a docked pin is invisible).
 *
 *  ⚠ `region` is REQUIRED: defaulting it to the viewport would give a caller
 *  that forgot it the old placement back, silently. Passing the viewport IS
 *  the unpinned case and reduces every line here to the old arithmetic —
 *  edgejump.test.ts §7 holds that identity down.
 *
 *  Coordinates: `desk`, `elev` and `region` are all viewport-local, and the
 *  returned `inset` is the distance from the window edge on the card's own
 *  side — the space CSS `left`/`right` anchor in. Unpinned it is `EJ_EDGE`.
 */
export function edgeJumpPlacement(
  side: 'l' | 'r',
  desk: EJRect,
  vp: { width: number; height: number },
  elev: number,
  region: { x: number; y: number; w: number; h: number },
): { form: EJForm; y: number; band: boolean; inset: number } {
  const rx0 = region.x, rx1 = region.x + region.w
  const ry0 = region.y, ry1 = region.y + region.h
  const inset = (side === 'l' ? rx0 : vp.width - rx1) + EJ_EDGE
  const gutter = side === 'l'
    ? desk.x0 - (rx0 + EJ_EDGE)
    : (rx1 - EJ_EDGE) - desk.x1
  // the neighbour's own elevation, kept inside the region
  const atElev = Math.min(ry1 - EJ_H, Math.max(ry0 + EJ_H, elev))
  if (gutter >= EJ_FULL + EJ_GAP) return { form: 'full', y: atElev, band: false, inset }
  // the free band above / below the desk, whichever is deeper. No clamp here:
  // the band is inside the region by construction, and clamping would push a
  // card in a shallow band back down onto the desk.
  const above = desk.y0 - ry0, below = ry1 - desk.y1
  if (Math.max(above, below) >= EJ_H + EJ_GAP) {
    return {
      form: 'full', band: true, inset,
      y: above >= below ? ry0 + above / 2 : ry1 - below / 2,
    }
  }
  if (gutter >= EJ_MID + EJ_GAP) return { form: 'mid', y: atElev, band: false, inset }
  return { form: 'tab', y: atElev, band: false, inset }
}

export const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

/** The VISIBLE form of a state word — the agent's reported status
 *  (working|done|blocked|idle), the observed turn state (active|queued|
 *  compacting) or a node state (archived…) — in Title Case, the same on the
 *  zoom card, the tray and the desk (user 2026-09-07: "match Working/Active/
 *  Idle/Blocked between zoom and desk"). Display only: the value itself, the
 *  class names built from it and sentence-case tooltips are untouched. An
 *  underscore reads as a space ("in_progress" → "In progress"). */
export const stateLabel = (word: string | null | undefined): string => {
  const w = String(word ?? '').replace(/_/g, ' ')
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : w
}

export const ago = (at: string | null | undefined) => {
  if (!at) return ''
  const s = Math.max(0, (Date.now() - Date.parse(at)) / 1000)
  return s < 90 ? `${Math.round(s)}s`
    : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
}

/** WHEN THIS AGENT WAS LAST TOUCHED, as epoch ms — the END OF ITS LAST TURN.
 *
 *  This is the same clock FR-23's card badge already shows (`TurnStat.at`,
 *  written unconditionally at turn completion, killed turns included), chosen
 *  again here so a pile row and that agent's card can never disagree about how
 *  long ago it last did anything. The two alternatives were both worse:
 *    · `last_status.at` exists only when the agent CHOSE to report a status,
 *      so a busy agent that never called orgtree_status would read as older
 *      than one that reported once and then idled (FR-23 rejected it for the
 *      same reason).
 *    · `archived_at` is the retire time, and a dissolve stamps an entire
 *      subtree with ONE instant — the order it produces for the common case
 *      (a team retired together) is a single tie, i.e. no order at all.
 *
 *  0 = never ran. A positive timestamp always beats it, so a fresh hire that
 *  was retired without ever taking a turn sorts to the BOTTOM. It is 0 and not
 *  -Infinity deliberately: `-Infinity - -Infinity` is NaN, and a comparator
 *  that returns NaN silently leaves the array in an arbitrary order. */
export const lastTouched = (n: CanvasNode | undefined | null): number => {
  const at = n?.turns?.[n.turns.length - 1]?.at
  const t = at ? Date.parse(at) : NaN
  return Number.isFinite(t) ? t : 0
}

/** the order a pile's members are LISTED in, top row first (user request
 *  2026-08-27): most recently touched at the top, so the retirees you last
 *  worked with are the ones you do not have to scroll for.
 *
 *  Ties (and the never-ran block at the bottom) keep the order the picker used
 *  before this existed — newest-archived first, which is `list` reversed —
 *  because `Array.prototype.sort` is stable. So this only ever REFINES the old
 *  order; it never scrambles the members it has no clock for.
 *
 *  ⚠ It does NOT reorder `Pile.list` itself. `list` is the stack's own order
 *  and its last entry is the default front card; re-sorting it would silently
 *  move which retiree the canvas shows on top of the pile, which is a separate
 *  decision the user already controls by hand (and one persisted per-org in
 *  localStorage). This is a display order for the picker's rows, nothing more. */
export const pileOrder = (list: string[],
  map: Map<string, CanvasNode>): string[] =>
  [...list].reverse()
    .sort((a, b) => lastTouched(map.get(b)) - lastTouched(map.get(a)))

// ------------------------------------------------- the attention pip (D-169)
/** What the user's inbox pip shows, and whether it is the ATTENTION tier.
 *  `null` = show no pip at all. */
export interface AttentionPip {
  /** the number on the badge */
  count: number
  /** the ATTENTION tier: the pulsing accent badge (`.asks`) and the header
   *  bell's `.glow`. False = the quiet ordinary-unread badge. */
  urgent: boolean
  /** the control's tooltip. Here rather than at the call sites BECAUSE they
   *  had already drifted — see the ⚠ below. */
  title: string
}

/** THE user-inbox pip rule, in one place.
 *
 *  ⚠ WHY THIS IS A FUNCTION AND NOT FOUR TERNARIES. It used to be four:
 *  the header ask-bell (App.tsx), UserNode's pip and EyeDesk's pip
 *  (cards.tsx), and the compact map eye (OrgCanvas.tsx) each wrote
 *  `asks > 0 ? asks : unread` out by hand with its own title string — and
 *  they had ALREADY diverged before this feature (the bell's tooltip named
 *  the unread count alongside the asks; EyeDesk's said only "your inbox").
 *  Threading a THIRD input through four hand-written copies is exactly how
 *  one of them ends up wrong, and this codebase has paid for that shape more
 *  than once (freeze labels, three surfaces, one wrong default in each).
 *
 *  THE RULE. Attention = open asks + unread URGENT mail (D-169: an agent may
 *  tag user-bound mail urgent, and the inbox then pulses the way it does for
 *  an unanswered question). When that total is non-zero it OVERRIDES the
 *  ordinary unread count and pulses.
 *
 *  THE ZERO EDGE, stated because the spec did not settle it: with nothing
 *  urgent and no ask open, an inbox holding ordinary unread mail falls back
 *  to the plain unread count, NOT pulsing — 12 unread reads "12", quietly.
 *  The two branches are named (`attention` vs `unread`) rather than nested
 *  so which is which can be read rather than inferred.
 *
 *  ⚠ `urgent_unread` is a SUBSET of `user_inbox_count` (both count entries
 *  still sitting in `user_inbox`, which is what unread means server-side),
 *  so the title lists them side by side and never adds them together. */
export const attentionPip = (t: {
  asks_open?: number | null
  urgent_unread?: number | null
  user_inbox_count?: number | null
}): AttentionPip | null => {
  const asks = t.asks_open ?? 0
  const urgent = t.urgent_unread ?? 0
  const unread = t.user_inbox_count ?? 0
  const attention = asks + urgent
  if (attention > 0) {
    const parts: string[] = []
    if (asks > 0) parts.push(`${asks} ask${asks > 1 ? 's' : ''} waiting on your answer`)
    if (urgent > 0) parts.push(`${urgent} urgent mail`)
    if (unread > 0) parts.push(`${unread} unread`)
    return { count: attention, urgent: true, title: parts.join(' · ') }
  }
  return unread > 0
    ? { count: unread, urgent: false, title: `${unread} unread` }
    : null
}

/** the gallery button's corner count (user request 2026-09-03): documents
 *  presented by agents that are CURRENTLY HIRED — the same set the gallery
 *  lists with "show retired agents" unticked, and the same badge idiom as
 *  the unread-mail count beside it.
 *
 *  Counted off the TREE, not a second poll: the tree payload already carries
 *  each node's own `documents` metadata, and a LIVE node is never one of the
 *  ones `org_children` hides — that hiding only ever affects an archived
 *  node with a successor, which by definition is not currently hired. So the
 *  walk is authoritative for exactly this question, and the button costs
 *  nothing that was not already being fetched.
 *
 *  WHAT IT DOES NOT COUNT, both deliberate:
 *  · dismissed cards — the server drops those from `documents` outright, so
 *    they are gone here for free. The user removed them; counting them would
 *    make the badge un-clearable.
 *  · EVICTED cards — the gallery still LISTS those (a tombstone: the title
 *    survives, the body does not), so the badge can read one lower than the
 *    rows on screen. That is the intended reading: this badge counts
 *    documents there is something to go and read, the way the mail count
 *    counts mail you can open. A tombstone is a record, not an errand. */
export interface DocCountNode {
  state?: string | null
  documents_count?: number
  documents?: { id: string }[] | null
  children?: DocCountNode[] | null
}

export const activeDocCount = (roots: DocCountNode[] | null | undefined): number => {
  let n = 0
  const walk = (list: DocCountNode[] | null | undefined): void => {
    for (const node of list ?? []) {
      if (node.state === 'live') n += node.documents_count ?? (node.documents ?? []).length
      walk(node.children)
    }
  }
  walk(roots)
  return n
}

// chat markdown: gfm + hard line breaks, sanitized (agents echo web content).
// №21: cached by text identity — every streamed token used to re-parse the
// ENTIRE visible transcript (~8 Hz × every message × every open panel)
const _mdCache = new Map<string, { __html: string }>()
// №16: outside code fences and inline code, a bare <Token> parses as an HTML
// tag — DOMPurify then strips it and keeps only the inner text, so
// `Sync<float3>` silently became `Sync` and changed the sentence's meaning.
// Escape `<` in plain prose; fenced/inline code is already safe.
// Review C8: the old closed-fence regex OVER-escaped inside every block it
// didn't recognise — an UNTERMINATED fence (every streaming code block, on
// every delta until the closing ``` arrives), ~~~ fences, and 4-space
// indented blocks all rendered a literal "&lt;". Line-walk instead: one
// inCode flag, an unterminated opener stays open to EOF, and only prose
// lines are escaped (inline `spans` protected within them).
const escapeAngles = (src: string) => {
  const lines = src.split('\n')
  let fence: { ch: string; len: number } | null = null   // {ch, len} of the open fence
  let indented = false                   // inside a 4-space indented block
  let prevBlank = true                   // indented blocks open after a blank
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(l)
    if (fence) {
      // closed only by a run of the SAME char, at least as long as the opener
      if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len) fence = null // nUIA: group 1 is unconditional in the regex
      prevBlank = false
      continue
    }
    if (m) {
      fence = { ch: m[1]![0]!, len: m[1]!.length } // nUIA: group 1 is unconditional and non-empty ({3,})
      prevBlank = false
      continue
    }
    const blank = /^\s*$/.test(l)
    if (indented) {
      if (!blank && !/^(?: {4}|\t)/.test(l)) indented = false
      else { prevBlank = blank; continue }
    } else if (prevBlank && /^(?: {4}|\t)/.test(l) && !blank) {
      indented = true
      prevBlank = false
      continue
    }
    prevBlank = blank
    // prose line: escape < outside inline `spans`
    const parts = l.split(/(`[^`\n]*`)/)
    for (let j = 0; j < parts.length; j += 2) {
      parts[j] = parts[j]!.replace(/</g, '&lt;')
    }
    lines[i] = parts.join('')
  }
  return lines.join('\n')
}
// click-to-copy on code blocks: every <pre> gets wrapped in a .codewrap with a
// copy button as a SIBLING (not a child of the scrolling <pre> — an absolute
// child would ride along on horizontal scroll, and its label would pollute
// pre.textContent). Injected AFTER DOMPurify, so the markup is ours; a spoofed
// button in agent output is harmless — the handler only ever reads code text.
export const CopyIcon =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">'
  + '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1"/></svg>'
const CheckIcon =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">'
  + '<path d="M3 8.5l3.5 3.5L13 4.5"/></svg>'
const wrapCodeBlocks = (html: string, imgBase?: string, agentHtmlResponse?: boolean) => {
  if (!html.includes('<pre') && !html.includes('<img')) return html
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  // render-inline-html-custom-responses: an explicit ```orgtree-html-response
  // fence becomes a sandboxed frame BEFORE the generic pre-wrapping below —
  // it has no code left to attach a copy button to once swapped.
  //
  // ⚠ SCOPE RULING: this is EXPLICITLY OPT IN PER CALL SITE, not "every
  // markdown surface" — `agentHtmlResponse` is true ONLY where `md()` is
  // rendering an agent's OWN chat response text (desk.tsx, gated on
  // `role === 'assistant'`). Mail bodies, the user's own messages, tool
  // output (`cmd_out`) and presented documents all call `md()` WITHOUT it,
  // and the exact same fence there renders as an inert, ordinary code block
  // — see the cache-key note on `md()` for why this can't leak between them.
  if (agentHtmlResponse) renderHtmlResponses(tpl.content, document)
  tpl.content.querySelectorAll('pre').forEach(pre => {
    const wrap = document.createElement('div')
    wrap.className = 'codewrap'
    pre.replaceWith(wrap)
    wrap.appendChild(pre)
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'code-copy'
    btn.title = 'Copy code'
    btn.setAttribute('aria-label', 'Copy code')
    btn.innerHTML = CopyIcon
    wrap.appendChild(btn)
  })
  // images (user spec 2026-08-25): a RELATIVE src — `![](outbox/plot.png)` in
  // an agent's reply, a mail body, a presented doc — names a file in the
  // author's working folder, which the /file endpoint already serves. Resolve
  // it against the caller's per-node base; absolute/data/anchor srcs pass
  // untouched. Runs on SANITIZED html, and builds only same-origin /file URLs
  // from the path, so no new scheme can enter here. decode-then-encode:
  // marked percent-encodes what it parses, the query param needs exactly one
  // layer. (No base → leave the src alone; it 404s visibly rather than
  // silently pointing at the SPA route.)
  tpl.content.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('src') ?? ''
    if (imgBase && src && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(src)) {
      let rel = src
      try { rel = decodeURIComponent(src) } catch { /* malformed % — keep raw */ }
      img.setAttribute('src', imgBase + encodeURIComponent(rel))
    }
    img.setAttribute('loading', 'lazy')
  })
  return tpl.innerHTML
}
// one delegated listener for every panel (content is innerHTML, so per-element
// React handlers don't exist). Streaming re-renders replace the button node,
// which simply drops the transient ✓ state — harmless.
export function copyCodeFromEvent(e: { target: EventTarget | null }) {
  // no `instanceof HTMLButtonElement` here — that global doesn't exist in the
  // node+jsdom test scope and the check threw on every unrelated click
  const btn = (e.target as Element | null)?.closest?.('button.code-copy')
  if (!btn) return
  const pre = btn.closest('.codewrap')?.querySelector('pre')
  // innerText, not textContent — the diff pre renders each line as a <div>,
  // whose textContent concatenates with NO newlines
  const text = (pre?.innerText ?? '').replace(/\n$/, '')
  btn.ownerDocument.defaultView?.navigator.clipboard?.writeText(text).then(() => {
    btn.innerHTML = CheckIcon
    btn.classList.add('copied')
    setTimeout(() => {
      if (!btn.isConnected) return
      btn.innerHTML = CopyIcon
      btn.classList.remove('copied')
    }, 1200)
  }).catch(() => {})
}
if (typeof document !== 'undefined') document.addEventListener('click', copyCodeFromEvent)
/** `imgBase` (optional): the node-scoped /file URL prefix relative image
 *  srcs resolve against — pass `fileBase(slug, nid)` where the author's
 *  files are known; the cache keys on it (NUL joins the fields — it never
 *  occurs in a URL prefix, so two pairs cannot alias), and the same text
 *  rendered for two nodes never crosses.
 *
 *  `agentHtmlResponse` (optional, default off — render-inline-html-custom-
 *  responses): the ONE call passed `true` where the caller can vouch this
 *  text is a genuine agent chat response, and nowhere else. It is IN THE
 *  CACHE KEY for exactly the reason `imgBase` is: without it, an assistant
 *  message and a mail body that happened to hold the identical text could
 *  share one cache entry — whichever rendered first would decide whether
 *  BOTH surfaces got the live sandboxed frame, silently making the mail
 *  surface (which must stay inert) match whatever the chat surface did.
 *
 *  ⚠ THE FLAG GOES FIRST IN THE KEY, not last (redteam-opus, ac588dd
 *  review): a NUL is assumed never to occur inside `imgBase` — true today
 *  (it's a server-minted slug/node id, `fileBase(slug, nid)`), which is
 *  why joining fields on NUL is safe at all. But with the flag placed
 *  AFTER a variable-length `imgBase`, a NUL smuggled into `imgBase` could
 *  shift the field boundary and alias an agent-mode key with an inert
 *  one holding a differently-split `imgBase`+text — e.g. imgBase="x" in
 *  agent mode vs imgBase="x\0client-supplied" in inert mode collapsing to
 *  the same string. Leading with the flag means the FIRST character alone
 *  decides the mode before any variable-length field is read, so no
 *  content anywhere else in the key can ever cross it — the property no
 *  longer depends on the NUL-free assumption at all. */
export const md = (text: string | null | undefined,
                   imgBase?: string, agentHtmlResponse?: boolean): { __html: string } => {
  // assignment 19: server-written prose carries its timestamps as canonical
  // instants in `⟦t:…⟧` tokens, and this is where they become the user's
  // local time. Doing it here rather than at each call site means every
  // rendered surface — chat, mail bodies, documents, the gallery — gets it,
  // and a durable row relocalises on every read instead of freezing what the
  // server saw when it wrote the row.
  //
  // ⚠ IT RUNS BEFORE THE CACHE KEY, NOT INSIDE THE MISS, and that ordering IS
  // the correctness of the cache. Keyed on the RAW text, one source string
  // has one entry forever — so a row first drawn in Asia/Jerusalem kept
  // serving Jerusalem's HTML after the zone changed, and a `clock` token
  // rendered "4:11 AM" today went on saying it after local midnight, when it
  // should have gained a date. Keying on the LOCALISED text makes the entry
  // identify what was actually drawn: change the zone or cross midnight and
  // the string differs, so it is a different key and a genuine miss.
  // (`mdlocaltime.test.ts` fails on the old key and passes on this one.)
  //
  // Hit-path cost is one `includes('⟦t:')` — `localizeStamps` returns its
  // input unchanged when there is no token, which is almost every string.
  const local = localizeStamps(text ?? '')
  const key = (agentHtmlResponse ? '1' : '0') + '\u0000' + (imgBase ?? '') + '\u0000' + local
  let hit = _mdCache.get(key)
  if (hit === undefined) {
    hit = { __html: wrapCodeBlocks(DOMPurify.sanitize(
      marked.parse(escapeAngles(local),
        { gfm: true, breaks: true, async: false })), imgBase, agentHtmlResponse) }
    // LRU eviction, not clear-all (perf-redesign 2026-09-12): a long
    // expanded chat plus mail previews cycles past the bound, and the old
    // wholesale clear re-parsed EVERYTHING visible on the next paint.
    // Map iterates in insertion order, so the first key is the oldest.
    if (_mdCache.size > 800) {
      const oldest = _mdCache.keys().next()
      if (!oldest.done) _mdCache.delete(oldest.value)
    }
    _mdCache.set(key, hit)
  } else {
    _mdCache.delete(key)          // re-insert: a hit is recent again
    _mdCache.set(key, hit)
  }
  return hit
}
/** What the CLI REPORTED about the messages a turn delivered, for the $ badge
 *  tooltip — OpenRouter lane only, absent everywhere else.
 *
 *  ⚠ THE WORD "SERVED" IS NOT AVAILABLE TO THIS SURFACE, and that is the whole
 *  point of the function. On a gateway lane the reported model is routinely an
 *  ECHO of the id that was requested, so "served by x-ai/grok-4.6" would be a
 *  claim about which machine answered that nothing here can support. It says
 *  `reported`, it names every distinct value rather than picking one, and when
 *  the turn saw more than one it says so instead of hiding it behind the last
 *  one. `partial` marks a turn whose per-message records hit their cap: the
 *  values listed are then the ones kept, so `mixed` is a floor and never a
 *  denial that the rest differed. */
export const reportedLabel = (r: {
  models?: string[]
  providers?: string[]
  mixed?: boolean
  truncated?: boolean
} | null | undefined): string => {
  const providers = (r?.providers ?? []).filter(Boolean)
  const models = (r?.models ?? []).filter(Boolean)
  if (!providers.length && !models.length) return ''
  const parts = [
    providers.length ? `upstream ${providers.join(', ')}` : '',
    models.length ? `model ${models.join(', ')}` : '',
  ].filter(Boolean)
  return `reported ${parts.join(' · ')}`
    + (r?.mixed ? ' (mixed)' : '')
    + (r?.truncated ? ' (partial)' : '')
}

export const smooth = (t: number) => t * t * (3 - 2 * t)

// ---- connection segments (world space). kind 'c' = cubic bezier, 'l' = line.
export type Seg =
  | { kind: 'l'; pts: [Pt, Pt] }
  | { kind: 'c'; pts: [Pt, Pt, Pt, Pt] }
export const segD = (s: Seg) => (s.kind === 'l'
  ? `M ${s.pts[0].x} ${s.pts[0].y} L ${s.pts[1].x} ${s.pts[1].y}`
  : `M ${s.pts[0].x} ${s.pts[0].y} C ${s.pts[1].x} ${s.pts[1].y}, `
    + `${s.pts[2].x} ${s.pts[2].y}, ${s.pts[3].x} ${s.pts[3].y}`)
export const segPoint = (s: Seg, t: number): Pt => {
  if (s.kind === 'l') {
    const [p, q] = s.pts
    return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }
  }
  const [p0, p1, p2, p3] = s.pts, u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  }
}

// Escape closes any overlay panel (they had no keyboard exit at all)
const escapeStacks = new WeakMap<Document, { current: () => void }[]>()
export function useEsc(close: () => void, enabled = true) {
  const ownerDocument = useSurfaceDocument()
  const latest = useRef(close); latest.current = close
  useEffect(() => {
    if (!enabled) return
    const stack = escapeStacks.get(ownerDocument) ?? []
    escapeStacks.set(ownerDocument, stack)
    const entry = { current: () => latest.current() }; stack.push(entry)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && stack[stack.length - 1] === entry
        && !ownerDocument.querySelector('.lb-overlay, .picker-overlay')) {
        e.preventDefault(); entry.current()
      }
    }
    const w = ownerDocument.defaultView ?? window
    w.addEventListener('keydown', onKey, true)
    return () => { const i = stack.indexOf(entry); if (i >= 0) stack.splice(i, 1); w.removeEventListener('keydown', onKey, true) }
  }, [ownerDocument, enabled])
}

/** G5 — the panel heartbeat.
 *
 *  An audit of the read endpoints found 18 of 19 call sites fetching ONCE on
 *  mount: open a panel, and whatever it showed at that instant is what it
 *  shows until you close it. Some of those panels display data that changes
 *  while you are looking at it — mail arriving, an agent writing files, disk
 *  filling — and the node inbox had a workaround for exactly this, refetching
 *  when a `pulse` prop changed, which covered turn events and nothing else
 *  (a mail delivery is not a pulse).
 *
 *  Same rule as the tree and the chat: liveness is gated on "this panel is
 *  mounted", which is known locally and cannot be stale — never on a piece of
 *  the data being refreshed. The fetcher is held in a ref so an inline arrow
 *  does not restart the timer on every render; `deps` decides identity.
 */
export function usePolled<T>(
  fetcher: () => Promise<T>, deps: DependencyList, ms = 5000,
  refreshKey: unknown = 0,
): T | null {
  const [v, setV] = useState<T | null>(null)
  const ref = useRef(fetcher)
  ref.current = fetcher
  // ⚠ a DEPS change is an IDENTITY change (new folder, new node, new org) —
  // the previous identity's data must not stay on screen until the new fetch
  // lands (redteam finding, render.test §6.10: a slow fetch left folder A's
  // listing rendered under folder B's path). Reset here, once, rather than
  // per call site — patching one panel recreates the N-writers problem the
  // state review opens with. `refreshKey` is the OTHER kind of restart: same
  // identity, fetch again now (the read-ack bump, 89fecd9) — resetting there
  // would blank the inbox on every mark-read, so it deliberately does not.
  useEffect(() => { setV(null) },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [...deps])
  useEffect(() => {
    let dead = false
    const tick = () => {
      void ref.current().then((r) => { if (!dead) setV(r) }).catch(() => {})
    }
    tick()
    const t = setInterval(tick, ms)
    // the client's G2 (livebus.ts): every mutation and every ws 'changed'
    // wakes this surface immediately — the interval above is only the
    // fallback for a dropped ws. This is what makes a grant rescinded in
    // one panel disappear from another within a beat instead of a poll
    // interval (user bug 2026-08-14).
    const off = onLiveBump(tick)
    return () => { dead = true; clearInterval(t); off() }
    // the fetcher rides a ref on purpose; `deps` is the identity of the thing
    // being fetched (slug, node, folder), which is what should restart it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, ms, refreshKey])
  return v
}

/** A NAVIGATION REQUEST, with an identity of its own.
 *
 *  ⚠ AN ID IS NOT A REQUEST. A latch that compares the target id swallows a
 *  second deliberate click on the SAME reference — the reader selects
 *  something else, clicks the reference again, and nothing happens. The latch
 *  still has to exist, or an unrelated poll re-runs the jump and drags them
 *  back. So the request carries a sequence number and the latch compares THAT:
 *  repeats are new requests, repolls are not.
 */
export interface JumpReq { id: string; seq: number }

let jumpSeq = 0

export const jumpTo = (id: string): JumpReq => ({ id, seq: ++jumpSeq })

/** the pair a latch stores, as one comparable string */
export const jumpKey = (id: string | null | undefined,
                        seq: number | null | undefined): string =>
  `${seq ?? ''}|${id ?? ''}`
