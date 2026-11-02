/** Screen presentation only; never modify persisted or agent-facing values. */
export type SensitiveSpan = { start: number; end: number }
export const STREAMER_HIDDEN = 'Hidden in Streamer mode'
// Deliberately conservative: URLs with query/fragment data and uncertain long
// identifiers are hidden in full. Values never leave the presentation process.
const patterns = [
  /-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?(?:-----END [\w ]*PRIVATE KEY-----|$)/g,
  /\b(?:password|passwd|secret|token|api[_ -]?key|authorization|credential)["']?\s*[:=]\s*[^\r\n]+/gi,
  /\bBearer\s+[^\s<>]+/gi,
  /[\p{L}\p{N}.!#$%&'*+/=?^`{|}~-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu,
  /@net:[^\s<>"']+/gi,
  /\b[a-z]:[\\/][^\r\n<>"']+/gi,
  /(?:\\\\[^\s\\]+\\|(?:~|\.{1,2})?\/)[\w.@~+ -]+(?:[\\/][^\s<>"']*)+/g,
  /\b(?:https?|wss?|ftp):\/\/[^\s<>"']+/gi,
  /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g,
  /(?<![\w])(?:[\da-f]{0,4}:){2,}[\da-f]{0,4}(?:%[\w.-]+)?(?![\w])/gi,
  /\+?\p{Nd}[\p{Nd} ().-]{6,}\p{Nd}/gu,
  /\b(?:sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[\w-]+/g,
  /\b[A-Za-z0-9_+/=-]{20,}\b/g,
]
export function sensitiveSpans(text: string, known: readonly string[] = []): SensitiveSpan[] {
  if (text.length > 1_000_000) return [{ start: 0, end: text.length }]
  const spans: SensitiveSpan[] = []
  for (const pattern of patterns) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) spans.push({ start: match.index!, end: match.index! + match[0].length })
  }
  const folded = text.toLowerCase()
  for (const value of known) {
    if (!value) continue
    const needle = value.toLowerCase()
    let at = 0
    while ((at = folded.indexOf(needle, at)) !== -1) { spans.push({ start: at, end: at + value.length }); at += value.length }
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: SensitiveSpan[] = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }
  return merged
}
export function redactScreenText(text: string, known: readonly string[] = []): string {
  let result = '', at = 0
  for (const span of sensitiveSpans(text, known)) { result += text.slice(at, span.start) + '[hidden]'; at = span.end }
  return result + text.slice(at)
}
/** Only structured identity/secret fields, never an agent's narrative or payload mutation. */
export function knownScreenValues(value: unknown): string[] {
  const values = new Set<string>(), seen = new Set<object>()
  function visit(v: unknown, sensitive = false, account = false, depth = 0) {
    if (depth > 20 || values.size > 10_000) return
    if (typeof v === 'string') { if (sensitive && v.trim()) values.add(v); return }
    if (!v || typeof v !== 'object' || seen.has(v)) return
    seen.add(v)
    if (Array.isArray(v)) { for (const child of v) visit(child, sensitive, account, depth + 1); return }
    for (const [key, child] of Object.entries(v)) {
      const identity = account || /account|identity|credential/i.test(key)
      visit(child, sensitive || /email|secret|token|password|phone|address|username|path|config_dir/i.test(key)
        || (identity && /^(name|label|id|primary)$/i.test(key)), identity, depth + 1)
    }
  }
  visit(value)
  return [...values]
}
/** Native text has no DOM context: uncertain dynamic strings fail closed. */
export function nativeScreenText(text: string, enabled: boolean): string { return enabled && text ? STREAMER_HIDDEN : text }
