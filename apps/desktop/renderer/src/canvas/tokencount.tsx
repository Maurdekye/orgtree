import { createContext } from 'react'
import SvgIcon from '@mui/material/SvgIcon'
import type { RowTokens, ToolTokenCount } from '../types'

export const LiveTokenContext = createContext<Record<string, ToolTokenCount>>({})

const full = (n: number) => n.toLocaleString('en-US')
/** `820t`, `1.2kt`: the compact form every token count uses. */
export const compactTokens = (n: number) => n < 1000 ? `${n}t`
  : `${(n / 1000).toFixed(1).replace(/\.0$/, '')}kt`
const counted = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0

function TokenGlyph() {
  return <SvgIcon className="token-glyph" fontSize="inherit" aria-hidden="true" data-testid="TextCursorIcon">
    <path d="M8 4h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8m8-16h-2a2 2 0 0 0-2 2m4 14h-2a2 2 0 0 1-2-2"
      fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </SvgIcon>
}

/** Counts are supplied by the engine; rendering never tokenizes transcript text. */
export function TokenCount({ count, estimated = false, thinking = false }:
  { count?: number; estimated?: boolean; thinking?: boolean; sampled?: boolean }) {
  if (!counted(count)) return null
  const n = count
  const kind = thinking ? 'thinking' : 'output'
  const label = `${estimated ? 'approximately ' : ''}${full(n)} ${kind} tokens`
  const detail = thinking ? `${full(n)} thinking tokens reported for this response`
    : estimated ? '' : `${full(n)} output tokens reported for this result`
  const title = `${thinking ? 'thinking' : 'tool output'}: ${estimated ? '~' : ''}${full(n)}t${detail ? `\n${detail}` : ''}`
  return <span className={`dim token-count ${thinking ? 'thinking-tokens' : 'tool-output-tokens'}`}
    title={title} aria-label={label}>
    {' · '}<TokenGlyph /> {estimated ? '~' : ''}{compactTokens(n)}
  </span>
}

/** Thinking whose tokens the provider did not report for this response: a dash and
 *  why, never 0 (user 2026-10-27 m10e4ca6d8934). Rows from before 4.5.0 show nothing. */
export function UnreportedThinking() {
  const title = 'thinking tokens were not reported for this response'
  return <span className="dim token-count thinking-tokens" title={title} aria-label={title}>{' · '}<TokenGlyph /> —</span>
}

/** A tool call's input, the arguments the agent wrote, estimated at the end of its turn. */
export function ToolInputCount({ count, estimated = true }: { count?: number; estimated?: boolean }) {
  if (!counted(count)) return null
  const title = estimated ? `tool call: about ${full(count)} tokens, estimated` : `tool call: ${full(count)} tokens`
  return <span className="dim token-count tool-input-tokens" title={title} aria-label={title}>
    {' · '}<TokenGlyph /> {estimated ? '~' : ''}{compactTokens(count)}
  </span>
}

/** A conversation row's count (user 2026-10-27 m10e4ca6d8934 "token counts in messages
 *  of all kinds", mafe020c4912b "and user messages"): what the provider reported for
 *  exactly this row, the engine's estimate marked ~ with what it covers and the parts
 *  it was sent as, or a dash and why the row is not counted. Never 0 for something
 *  uncounted; rows from before 4.5.0 carry nothing and show nothing. */
export function RowTokenCount({ tokens, before }: { tokens?: RowTokens; before?: number }) {
  if (!tokens || typeof tokens !== 'object') return null
  if (!counted(tokens.count)) {
    if (!tokens.not_counted) return null
    const title = `tokens not counted: ${tokens.not_counted}${counted(before) ? `\ncontext was ${full(before)} tokens before, reported` : ''}`
    return <span className="dim token-count row-tokens" title={title} aria-label={`tokens not counted: ${tokens.not_counted}`}><TokenGlyph /> —</span>
  }
  const n = tokens.count
  if (tokens.reported) {
    const title = `${full(n)} output tokens reported by ${tokens.reported} for this response`
    return <span className="dim token-count row-tokens" title={title} aria-label={title}><TokenGlyph /> {compactTokens(n)}</span>
  }
  const lines = [`about ${full(n)} tokens, estimated${tokens.covers ? ` (${tokens.covers})` : ''}`]
  if (tokens.sampled) lines.push('counted from the start and end of a long text')
  for (const part of tokens.parts ?? []) if (counted(part.count)) lines.push(`${part.label}: about ${full(part.count)}`)
  return <span className="dim token-count row-tokens" title={lines.join('\n')} aria-label={lines[0]}><TokenGlyph /> ~{compactTokens(n)}</span>
}
