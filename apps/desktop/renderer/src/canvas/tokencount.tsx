import { createContext } from 'react'
import SvgIcon from '@mui/material/SvgIcon'
import type { ToolTokenCount } from '../types'

export const LiveTokenContext = createContext<Record<string, ToolTokenCount>>({})

/** Counts are supplied by the engine; rendering never tokenizes transcript text. */
export function TokenCount({ count, estimated = false, thinking = false }:
  { count?: number; estimated?: boolean; thinking?: boolean; sampled?: boolean }) {
  if (!Number.isSafeInteger(count) || count! < 0) return null
  const n = count!
  const compact = n < 1000 ? `${n}t`
    : `${(n / 1000).toFixed(1).replace(/\.0$/, '')}kt`
  const kind = thinking ? 'thinking' : 'output'
  const label = `${estimated ? 'approximately ' : ''}${n.toLocaleString('en-US')} ${kind} tokens`
  const detail = thinking ? `${n.toLocaleString('en-US')} thinking tokens reported for this response`
    : estimated ? '' : `${n.toLocaleString('en-US')} output tokens reported for this result`
  const title = `${thinking ? 'thinking' : 'tool output'}: ${estimated ? '~' : ''}${n.toLocaleString('en-US')}t${detail ? `\n${detail}` : ''}`
  return <span className={`dim token-count ${thinking ? 'thinking-tokens' : 'tool-output-tokens'}`}
    title={title} aria-label={label}>
    {' · '}<SvgIcon className="token-glyph" fontSize="inherit" aria-hidden="true" data-testid="TextCursorIcon">
      <path d="M8 4h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8m8-16h-2a2 2 0 0 0-2 2m4 14h-2a2 2 0 0 1-2-2"
        fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </SvgIcon> {estimated ? '~' : ''}{compact}
  </span>
}
