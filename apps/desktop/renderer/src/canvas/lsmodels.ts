// canvas/lsmodels.ts — a language server's models as the settings read them:
// window sizes, the window a model starts with, the 64K version an Ollama
// model can get, its chip letter, and the window the server really runs it
// with against the one agents are told (user 2026-10-10: the card showed
// 65536 for a model Ollama ran at 4096).

import type { LangServerProbeModel } from '../types'

/** 65536 → "64K", 262144 → "256K" */
export const fmtTokens = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n) || n <= 0) return '?'
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024}K`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

export const fmtBytes = (n: number | null | undefined): string | null =>
  n == null || n <= 0 ? null : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`

/** the window a model found on a server should start with: the one its
 *  Modelfile sets (Ollama: every request that names none gets it), else the
 *  one it runs with now, else the default (never more than it was trained for) */
export const startWindow = (m: LangServerProbeModel, dflt: number): number => {
  if (m.configured_context && m.configured_context > 0) return m.configured_context
  if (m.loaded_context && m.loaded_context > 0) return m.loaded_context
  if (m.max_context && m.max_context > 0) return Math.min(m.max_context, dflt)
  return dflt
}

/** the window of the version the button makes (langserver.rs VARIANT_CONTEXT) */
export const VARIANT_CONTEXT = 65536

/** the name the 64K version gets: the window added to the tag
 *  (`qwen3.8:27b` → `qwen3.8:27b-64k`); mirrors langserver.rs `variant_name` */
export const variantName = (model: string): string => {
  const m = model.trim()
  const at = m.lastIndexOf('/') + 1
  const colon = m.slice(at).lastIndexOf(':')
  const [base, tag] = colon >= 0 ? [m.slice(0, at + colon), m.slice(at + colon + 1)] : [m, 'latest']
  return `${base}:${tag.slice(0, 76)}-64k`
}

/** an Ollama model whose Modelfile sets no 64K window, that was trained for
 *  one, and has no 64K version on the server yet */
export const wantsVariant = (m: LangServerProbeModel, all: LangServerProbeModel[]): boolean =>
  !(m.configured_context && m.configured_context >= VARIANT_CONTEXT)
  && !(m.max_context && m.max_context < VARIANT_CONTEXT)
  && !all.some((x) => x.id === variantName(m.id))

/** a model's chip letter: the first letter of its first word, as the
 *  engine gives a language-server tier (catalog.rs `monogram`) */
export const monogram = (id: string): string =>
  (id.split(/[:\-_./ ]/).find((t) => t) ?? '?').charAt(0).toUpperCase() || '?'

/** the lane's colour on a model card: its gold, the deep gold on light themes */
export const LANE_CARD_COLOR = 'var(--prov-langserver)'

/** what the server says it does: tool use, thinking, vision… (Ollama) */
export const capsOf = (m: LangServerProbeModel): string[] => Array.isArray(m.capabilities) ? m.capabilities : []

/** the window the server really runs a model with, when it says: the one it
 *  runs with now (loaded), else the one its Modelfile sets */
export const realWindow = (m: LangServerProbeModel | null | undefined): number | null => {
  if (m?.loaded_context && m.loaded_context > 0) return m.loaded_context
  if (m?.configured_context && m.configured_context > 0) return m.configured_context
  return null
}

/** where agents are told one window and the server runs another, the
 *  sentence that says so (null: they agree, or nothing is known). An Ollama
 *  model with no window of its own runs at Ollama's default, which no API
 *  reports (OLLAMA_CONTEXT_LENGTH, 4096 on cards under 24 GB unless set). */
export const windowMismatch = (told: number, m: LangServerProbeModel | null | undefined, ollama: boolean): string | null => {
  const real = realWindow(m)
  if (real != null) {
    return real === told ? null : `the server runs it with ${fmtTokens(real)}, but agents are told ${fmtTokens(told)}`
  }
  if (ollama && m) {
    return `Ollama runs it with its default window (4K on cards under 24 GB unless OLLAMA_CONTEXT_LENGTH is set), `
      + `but agents are told ${fmtTokens(told)}`
  }
  return null
}

/** one model's facts on one line: size, the windows, what it can do */
export const probeFacts = (m: LangServerProbeModel): string => [
  m.family, m.parameters, m.quantization, fmtBytes(m.size),
  m.max_context ? `trained for ${fmtTokens(m.max_context)}` : null,
  m.configured_context ? `its Modelfile sets ${fmtTokens(m.configured_context)}` : null,
  m.loaded_context ? `running with ${fmtTokens(m.loaded_context)}` : null,
  m.tools === false ? 'no tool use declared' : null,
  capsOf(m).includes('thinking') ? 'thinking' : null,
].filter(Boolean).join(' · ')
