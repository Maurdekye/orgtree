import { createContext } from 'react'
import type { ToolTokenCount } from '../types'

export const LiveTokenContext = createContext<Record<string, ToolTokenCount>>({})

/** Counts are supplied by the engine; rendering never tokenizes transcript text. */
export function TokenCount({ count, estimated = false, thinking = false, sampled = false }:
  { count?: number; estimated?: boolean; thinking?: boolean; sampled?: boolean }) {
  if (!Number.isSafeInteger(count) || count! < 0) return null
  const n = count!
  const compact = n < 1000 ? `${n}t`
    : `${(n / 1000).toFixed(1).replace(/\.0$/, '')}kt`
  const kind = thinking ? 'thinking' : 'output'
  const label = `${estimated ? 'approximately ' : ''}${n.toLocaleString('en-US')} ${kind} tokens`
  const detail = thinking ? `${n.toLocaleString('en-US')} thinking tokens reported for this response`
    : estimated ? `Estimated text output tokens, calibrated o200k_base${sampled ? '; sampled output' : ''}. Images are excluded.`
    : `${n.toLocaleString('en-US')} output tokens reported for this result`
  const title = `${thinking ? 'thinking' : 'tool output'}: ${estimated ? '~' : ''}${n.toLocaleString('en-US')}t\n${detail}`
  return <span className={`dim token-count ${thinking ? 'thinking-tokens' : 'tool-output-tokens'}`}
    title={title} aria-label={label}>
    {' · '}<span className="token-glyph" aria-hidden="true">T</span> {estimated ? '~' : ''}{compact}
  </span>
}
