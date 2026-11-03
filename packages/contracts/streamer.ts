/** Screen presentation only; never modify persisted or agent-facing values. */
export type SensitiveSpan = { start: number; end: number }
export const STREAMER_HIDDEN = 'Hidden in Streamer mode'
// Deliberately conservative: URLs with query/fragment data and uncertain long
// identifiers are hidden in full. Values never leave the presentation process.
const patterns = [
  /-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?(?:-----END [\w ]*PRIVATE KEY-----|$)/g,
  /\b(?:password|passwd|secret|token|api[_ -]?key|authorization|credential)["']?\s*[:=]\s*[^\r\n]+/gi,
  /\bBearer\s+[^\s<>]+/gi,
  // The lookbehind keeps a long unspaced run linear: without it every start inside
  // the run rescans to its end (a 40 KB token took 7 s and froze the window).
  /(?<![\p{L}\p{N}.!#$%&'*+/=?^`{|}~-])[\p{L}\p{N}.!#$%&'*+/=?^`{|}~-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu,
  /@net:[^\s<>"']+/gi,
  /\b[a-z]:[\\/](?:[^\\/\r\n<>"']{1,64}[\\/])*[^\s\\/<>"']*/gi,
  /\\\\[^\s\\]+\\[^\r\n<>"']*/g,
  // A path starts at a boundary (never inside "orgtree/build-slot", "integ/4.5.5" or "and/or"); a space belongs
  // to it only inside a segment that a later separator follows ("/Users/John Smith/x"), never after the last one.
  /(?<![\p{L}\p{N}_.~:/@\\-])(?:~|\.{1,2})?\/[\w.@~+-]+(?:(?: [\w.@~+-]+)*[\\/][\w.@~+-]*)*(?:[\\/][^\s<>"']*)?/gu,
  /\b(?:https?|wss?|ftp):\/\/[^\s<>"']+/gi,
  /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g,
  // Eight groups, or a "::" compression; never a clock time such as 19:19:15.
  /(?<![\w:])(?:(?:[\da-f]{1,4}:){7}[\da-f]{1,4}|(?:[\da-f]{1,4}:){1,7}:(?:[\da-f]{1,4}(?::[\da-f]{1,4}){0,6})?|::(?:[\da-f]{1,4}(?::[\da-f]{1,4}){0,6})?)(?:%[\w.-]+)?(?![\w:])/gi,
  // Phones: "+..." forms, grouped national forms (3 groups, or 3-4 digits twice) and a bare 7-15 digit run.
  // Dates (2026-11-03), times, "GMT+2" and versions never match.
  /(?<![\p{L}\p{N}])\+\p{Nd}[\p{Nd} ().-]{5,}\p{Nd}/gu,
  /(?<![\p{L}\p{N}.:/+-])(?:\(\p{Nd}{2,4}\)[ .-]?)?\p{Nd}{2,4}[ .-]\p{Nd}{3,4}[ .-]\p{Nd}{3,4}(?![\p{L}\p{N}:]|[.-]\p{N})/gu,
  /(?<![\p{L}\p{N}.:/+-])\p{Nd}{3}-\p{Nd}{4}(?![\p{L}\p{N}:]|[.-]\p{N})/gu,
  /(?<![\p{L}\p{N}.:/+-])\p{Nd}{7,15}(?![\p{L}\p{N}:]|[.-]\p{N})/gu,
  /\b(?:sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[\w-]+/g,
]
const LONG_RUN = /\b[A-Za-z0-9_+/=-]{20,}\b/g
/** A long unspaced run is a secret only if it looks random: not a git SHA, not a slug or branch of words
 *  and short numbers ("streamer-mode-hide-4-5-5", "feature/fix-x"), not a plain camelCase identifier. */
export function tokenLike(run: string): boolean {
  if (/^(?:[\da-f]{40}|[\da-f]{64})$/.test(run)) return false
  if (run.split(/[-_/]/).every(part => part === '' || /^(?:[a-z]+|[A-Z][a-z]+|\d{1,4})$/.test(part))) return false
  if (/\d/.test(run)) return true
  const upper = (run.match(/[A-Z]/g) ?? []).length, letters = (run.match(/[A-Za-z]/g) ?? []).length
  return letters >= 20 && upper / letters >= 0.3 && upper / letters <= 0.7
}
export function sensitiveSpans(text: string, known: readonly string[] = []): SensitiveSpan[] {
  if (text.length > 1_000_000) return [{ start: 0, end: text.length }]
  const spans: SensitiveSpan[] = []
  for (const pattern of patterns) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) spans.push({ start: match.index!, end: match.index! + match[0].length })
  }
  LONG_RUN.lastIndex = 0
  for (const match of text.matchAll(LONG_RUN)) if (tokenLike(match[0])) spans.push({ start: match.index!, end: match.index! + match[0].length })
  const folded = text.toLowerCase()
  for (const value of known) {
    // A one- or two-character identity ("." as a path, "ab" as an id) would
    // mask every occurrence in ordinary prose; it identifies no one.
    if (!value || value.trim().length < 3) continue
    const needle = value.toLowerCase()
    let at = 0
    // Whole words only: "Con" must not mask the start of "Context".
    const word = /[\p{L}\p{N}_]/u, head = word.test(needle[0]!), tail = word.test(needle[needle.length - 1]!)
    while ((at = folded.indexOf(needle, at)) !== -1) {
      const end = at + value.length
      if (!(head && at > 0 && word.test(folded[at - 1]!)) && !(tail && end < folded.length && word.test(folded[end]!))) spans.push({ start: at, end })
      at += value.length
    }
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
// Provider and selector names are product vocabulary shown on every surface
// ("Claude Terracotta", provider chips); an account id equal to one of them
// identifies no one, and learning it masked those words window-wide.
const PRODUCT_WORDS = new Set(['claude', 'anthropic', 'openai', 'codex', 'google', 'gemini', 'antigravity', 'muse', 'openrouter', 'langserver', 'opencode', 'primary', 'default', 'host'])
/** Only structured identity/secret fields, never an agent's narrative or payload mutation. */
export function knownScreenValues(value: unknown): string[] {
  const values = new Set<string>(), seen = new Set<object>()
  function visit(v: unknown, sensitive = false, account = false, depth = 0) {
    if (depth > 20 || values.size > 10_000) return
    if (typeof v === 'string') { if (sensitive && v.trim() && !PRODUCT_WORDS.has(v.trim().toLowerCase())) values.add(v); return }
    if (!v || typeof v !== 'object' || seen.has(v)) return
    seen.add(v)
    if (Array.isArray(v)) { for (const child of v) visit(child, sensitive, account, depth + 1); return }
    for (const [key, child] of Object.entries(v)) {
      const identity = account || /account|identity|credential/i.test(key)
      const strong = /email|secret|token|password|phone|username|config_dir|authorization|identity|(?:^|_)key(?:$|_(?!behavior|binding|mode|hint|label))/i.test(key) && !/^key$/i.test(key)
      // "address", "path" and a bare "key" also carry agent, project and org names (mail from_address
      // "liaison-opus"): learned only when the value itself looks personal (an email, a path, a host).
      const weak = !strong && /address|path|^key$/i.test(key)
      if (weak && typeof child === 'string' && !/[@\\/:]|\w\.\w/.test(child)) continue
      visit(child, sensitive || strong || weak || (identity && /^(name|label|id|primary)$/i.test(key)), identity, depth + 1)
    }
  }
  visit(value)
  return [...values]
}
/** Native text has no DOM context: uncertain dynamic strings fail closed. */
export function nativeScreenText(text: string, enabled: boolean): string { return enabled && text ? STREAMER_HIDDEN : text }
