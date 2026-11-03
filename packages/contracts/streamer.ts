/** Screen presentation only; never modify persisted or agent-facing values.
 *
 *  THE DEFINITIVE LIST (USER 2026-11-03 m63438d6bebc3, amended maad1c88abeba): streamer mode may hide ONLY these
 *  six types of information (plus m4c7b46b6cffb's seventh, external addresses and other orgs), each switchable in
 *  Settings > Streamer mode, and nothing else:
 *    paths (local absolute file paths; default OFF), ips, emails, secrets, phones, tokenUrls, externals (@net:/@org: addresses), orgs (other orgs' names).
 *  Account, agent, project and org names, timestamps, SHAs, branch names and model names are never hidden.
 *  Pattern matching runs ONLY in free-form content (transcripts, mail, docket text, presentations, ...); structured
 *  fields are never pattern-matched: a field is either always one of the six (data-streamer-field in the renderer) or
 *  never hidden. See streamer-boundary.ts STREAMER_ZONES for the one explicit table. */
export type SensitiveSpan = { start: number; end: number }
export const STREAMER_HIDDEN = 'Hidden in Streamer mode'

export type StreamerType = 'paths' | 'ips' | 'emails' | 'secrets' | 'phones' | 'tokenUrls' | 'externals' | 'orgs'
export type StreamerTypes = Record<StreamerType, boolean>
export const STREAMER_TYPE_LIST: readonly StreamerType[] = ['paths', 'ips', 'emails', 'secrets', 'phones', 'tokenUrls', 'externals', 'orgs']
/** Defaults (USER maad1c88abeba "file paths can be fine"): paths are OFF, the other five are ON. */
export const DEFAULT_STREAMER_TYPES: StreamerTypes = { paths: false, ips: true, emails: true, secrets: true, phones: true, tokenUrls: true, externals: true, orgs: true }
/** The persisted preference keys, one boolean per type plus the opaque-surface cover. */
export const STREAMER_TYPE_PREF: Record<StreamerType, string> = {
  paths: 'streamerPaths', ips: 'streamerIps', emails: 'streamerEmails', secrets: 'streamerSecrets', phones: 'streamerPhones', tokenUrls: 'streamerTokenUrls', externals: 'streamerExternals', orgs: 'streamerOrgs',
}
export const STREAMER_COVER_PREF = 'streamerCover'
/** Resolve the switches from a preferences object (absent key = its default). */
export function streamerTypesFrom(prefs: unknown): StreamerTypes {
  const p = (prefs ?? {}) as Record<string, unknown>, out = { ...DEFAULT_STREAMER_TYPES }
  for (const type of STREAMER_TYPE_LIST) { const v = p[STREAMER_TYPE_PREF[type]]; if (typeof v === 'boolean') out[type] = v }
  return out
}
export const streamerCoverFrom = (prefs: unknown): boolean => ((prefs ?? {}) as Record<string, unknown>)[STREAMER_COVER_PREF] !== false

const QUERY_KEYS = 'token|access_token|refresh_token|id_token|key|api_key|apikey|secret|client_secret|sig|signature|auth|authorization|code|password|passwd|pwd|invite|magic'
const patterns: Record<StreamerType, RegExp[]> = {
  // External addresses (USER m4c7b46b6cffb): @net:/@org: tokens; OTHER orgs' names are matched from the install's org list below.
  externals: [/@(?:net|org):[^\s<>"']+/gi],
  orgs: [], // matched from the install's org list in sensitiveSpans
  // Absolute local paths only: drive-letter, UNC, /c/-style (MSYS) and the unix home/system roots. Relative and
  // repo-relative paths ("apps/desktop/x.ts", "integ/4.5.5", "orgtree/build-slot") are never matched. Windows paths
  // may contain spaces only inside a segment a later separator follows.
  paths: [
    /(?<![\p{L}\p{N}_])[a-z]:[\\/](?:[^\\/\r\n<>"'|?*]{1,64}[\\/])*[^\s\\/<>"'|?*]*/giu,
    /(?<![\p{L}\p{N}_\\])\\\\[^\s\\/]+[\\/](?:[^\\/\r\n<>"'|?*]{1,64}[\\/])*[^\s\\/<>"'|?*]*/gu,
    /(?<![\p{L}\p{N}_.~:/@\\-])\/[a-z]\/(?:[\w.@~+-]+(?: [\w.@~+-]+)*\/)*[\w.@~+-]*/giu,
    /(?<![\p{L}\p{N}_.~:/@\\-])(?:~(?=\/)|\/(?:home|Users|root|mnt|tmp|var|etc|opt|usr)(?![\p{L}\p{N}_-]))(?:\/[\w.@~+-]+(?: [\w.@~+-]+)*(?=\/)|\/[\w.@~+-]*)*/gu,
  ],
  ips: [
    /(?<![\p{L}\p{N}_.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?::\d{1,5})?(?![\p{L}\p{N}_]|\.\d)/gu,
    // Eight groups, or a "::" compression; never a clock time such as 19:19:15.
    /(?<![\w:])(?:(?:[\da-f]{1,4}:){7}[\da-f]{1,4}|(?:[\da-f]{1,4}:){1,7}:(?:[\da-f]{1,4}(?::[\da-f]{1,4}){0,6})?|::(?:[\da-f]{1,4}(?::[\da-f]{1,4}){0,6})?)(?:%[\w.-]+)?(?![\w:])/gi,
  ],
  // The lookbehind keeps a long unspaced run linear (a 40 KB token once took 7 s and froze the window).
  emails: [/(?<![\p{L}\p{N}.!#$%&'*+/=?^`{|}~-])[\p{L}\p{N}.!#$%&'*+/=?^`{|}~-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu],
  secrets: [
    /-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?(?:-----END [\w ]*PRIVATE KEY-----|$)/g,
    // key=value context: the value is one token or one quoted string, never the rest of the line
    /\b(?:password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|api[_ -]?key|apikey|authorization|credential)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&"'<>]+)/gi,
    /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    /\b(?:sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|AIza)[\w-]{8,}/g,
    /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g,
  ],
  phones: [
    // Explicit +country forms, grouped national forms and "555-0123"; never dates, times, "GMT+2", versions, plain digit runs.
    /(?<![\p{L}\p{N}])\+\p{Nd}[\p{Nd} ().-]{5,}\p{Nd}/gu,
    /(?<![\p{L}\p{N}.:/+-])(?:\(\p{Nd}{2,4}\)[ .-]?)?\p{Nd}{2,4}[ .-]\p{Nd}{3,4}[ .-]\p{Nd}{3,4}(?![\p{L}\p{N}:]|[.-]\p{N})/gu,
    /(?<![\p{L}\p{N}.:/+-])\p{Nd}{3}-\p{Nd}{4}(?![\p{L}\p{N}:]|[.-]\p{N})/gu,
  ],
  tokenUrls: [
    // user:pass@host, a credential query/fragment parameter, or an invite / magic-link path: the whole URL. Plain URLs stay visible.
    new RegExp(String.raw`\b(?:https?|wss?|ftp):\/\/[^\s<>"'/@:]+:[^\s<>"'/@]+@[^\s<>"']+`, 'gi'),
    new RegExp(String.raw`\b(?:https?|wss?|ftp):\/\/[^\s<>"']*[?&#;](?:${QUERY_KEYS})=[^\s<>"']*`, 'gi'),
    /\b(?:https?|wss?|ftp):\/\/[^\s<>"'?#]*\/(?:invite|invites|magic|magic-link|join|reset-password|verify)\/[^\s<>"']+/gi,
  ],
}
// A long unspaced run is a secret only if it looks random. Git SHAs and any other pure-hex digest, slugs/branches of words
// and short numbers ("streamer-mode-hide-4-5-5"), and plain camelCase identifiers are not.
const LONG_RUN = /\b[A-Za-z0-9_+/=-]{24,}\b/g
export function tokenLike(run: string): boolean {
  if (/^[\da-f]+$/.test(run)) return false
  if (run.split(/[-_/]/).every(part => part === '' || /^(?:[a-z]+|[A-Z][a-z]+|\d{1,4})$/.test(part))) return false
  if (/\d/.test(run)) return /[A-Za-z]/.test(run)
  const upper = (run.match(/[A-Z]/g) ?? []).length, letters = (run.match(/[A-Za-z]/g) ?? []).length
  return letters >= 24 && upper / letters >= 0.3 && upper / letters <= 0.7
}
/** Spans of the enabled types inside FREE-FORM text. Structured fields never come through here. */
export function sensitiveSpans(text: string, types: StreamerTypes = DEFAULT_STREAMER_TYPES, orgNames: readonly string[] = []): SensitiveSpan[] {
  if (text.length > 1_000_000) return [{ start: 0, end: text.length }]
  const spans: SensitiveSpan[] = []
  for (const type of STREAMER_TYPE_LIST) {
    if (!types[type]) continue
    for (const pattern of patterns[type]) {
      pattern.lastIndex = 0
      for (const match of text.matchAll(pattern)) spans.push({ start: match.index!, end: match.index! + match[0].length })
    }
  }
  if (types.orgs) {
    // other orgs of this installation: exact, case-insensitive, word-bounded; names under 3 characters are ignored
    const folded = text.toLowerCase(), word = /[\p{L}\p{N}_]/u
    for (const name of orgNames) {
      const needle = name.trim().toLowerCase()
      if (needle.length < 3) continue
      for (let at = folded.indexOf(needle); at !== -1; at = folded.indexOf(needle, at + needle.length)) {
        const end = at + needle.length
        if ((at > 0 && word.test(folded[at - 1]!)) || (end < folded.length && word.test(folded[end]!))) continue
        spans.push({ start: at, end })
      }
    }
  }
  if (types.secrets) {
    LONG_RUN.lastIndex = 0
    for (const match of text.matchAll(LONG_RUN)) if (tokenLike(match[0])) spans.push({ start: match.index!, end: match.index! + match[0].length })
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
export function redactScreenText(text: string, types: StreamerTypes = DEFAULT_STREAMER_TYPES, orgNames: readonly string[] = []): string {
  let result = '', at = 0
  for (const span of sensitiveSpans(text, types, orgNames)) { result += text.slice(at, span.start) + '[hidden]'; at = span.end }
  return result + text.slice(at)
}
/** Native text has no DOM context: uncertain dynamic strings fail closed. */
export function nativeScreenText(text: string, enabled: boolean): string { return enabled && text ? STREAMER_HIDDEN : text }
