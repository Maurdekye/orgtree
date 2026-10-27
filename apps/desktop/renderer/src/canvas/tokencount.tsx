import { createContext } from 'react'
import SvgIcon from '@mui/material/SvgIcon'
import type { OwnTokens, RowTokens, ToolTokenCount } from '../types'

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

/** A message's count in its card header, right after its time (user 2026-10-27
 *  m4bad9bdbd3a1 "for messages, like user messages, place the count in the header, next to
 *  the time. or everything else jkust omit it."): what the message itself adds, its text
 *  with the framing that always comes with it (m7c48d80b13f4, m90b8a18987ea), and on the
 *  delivery's last card `+N` for the conditional parts sent with it, itemized on hover
 *  (md965e01802ba). Engine estimates; a message delivered before own counts shows none. */
export function MessageTokens({ own, envelope }: { own?: OwnTokens; envelope?: RowTokens }) {
  const mine = own && counted(own.count) ? own : undefined
  const extra = envelope?.extra
  const plus = counted(extra) && extra > 0 ? extra : undefined
  if (!mine && plus === undefined) return null
  const ownTitle = mine ? [`this message: about ${full(mine.count)} tokens, estimated`, 'its text with the framing that always comes with it',
    ...(mine.sampled ? ['counted from the start and end of a long text'] : [])].join('\n') : ''
  const plusTitle = plus === undefined ? '' : [`+${full(plus)} tokens, estimated: surrounding data hidden in the turn envelope, sent with this message but not part of it`,
    ...(envelope?.extras ?? []).filter(part => counted(part.count)).map(part => `${part.label}: about ${full(part.count)}`)].join('\n')
  return <span className="dim token-count msg-tokens">{' · '}<TokenGlyph />
    {mine && <span className="own-tokens" title={ownTitle} aria-label={`this message: about ${full(mine.count)} tokens`}>
      {' '}{mine.estimated !== false ? '~' : ''}{compactTokens(mine.count)}</span>}
    {plus !== undefined && <span className="envelope-tokens" title={plusTitle} aria-label={`plus about ${full(plus)} tokens of surrounding data hidden in the turn envelope`}>
      {' '}+{compactTokens(plus)}</span>}
  </span>
}
