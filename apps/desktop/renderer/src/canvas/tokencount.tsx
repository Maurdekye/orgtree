import { DataUsageIcon } from '../icons'

/** Counts are supplied by the engine; rendering never tokenizes transcript text. */
export function TokenCount({ count, estimated = false, thinking = false, sampled = false }:
  { count?: number; estimated?: boolean; thinking?: boolean; sampled?: boolean }) {
  if (!Number.isSafeInteger(count) || count! < 0) return null
  const n = count!
  const compact = n < 1000 ? String(n) : n < 1_000_000
    ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
    : `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
  const kind = thinking ? 'thinking' : 'output'
  const label = `${estimated ? 'approximately ' : ''}${n.toLocaleString('en-US')} ${kind} tokens`
  const title = thinking ? `${n.toLocaleString('en-US')} thinking tokens reported for this response`
    : estimated ? `Estimated text output tokens, calibrated o200k_base${sampled ? '; sampled output' : ''}. Images are excluded.`
    : `${n.toLocaleString('en-US')} output tokens reported for this result`
  return <span className={`dim token-count ${thinking ? 'thinking-tokens' : 'tool-output-tokens'}`}
    title={title} aria-label={label}>
    {' · '}<DataUsageIcon fontSize="inherit" /> {estimated ? '~' : ''}{compact}
  </span>
}
