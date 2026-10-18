// canvas/copytext.ts — WHAT "Copy contents" PUTS ON THE CLIPBOARD (user
// request 2026-09-11: transcript messages had no right-click action for
// copying their contents).
//
// ONE RULE: copy the text the row is MADE OF, for every part of it the desk
// actually draws. Two shortcuts look right and are both wrong, so they are
// written down here rather than rediscovered:
//
//   ⚠ NOT `data-reply-quote`. That attribute is the reply QUOTE, and
//     reply_events.py caps every one of them at 4000 characters. Copying from
//     it truncates a long message silently — the worst possible failure for a
//     clipboard action, because the paste looks complete.
//
//   ⚠ NOT the row's `textContent`. Twice wrong. It yields RENDERED text, so
//     the markdown source the message was written in — fenced code, link
//     targets, list markers — is gone; and the folds are not all CSS. A
//     received-mail body folds with `maxHeight` and is fully present in the
//     DOM, but `ThoughtLine` and `SysLine`'s compaction summary are
//     CONDITIONALLY RENDERED: collapsed, they are not in the document at all.
//     A textContent read would miss precisely the "text hidden by collapsed
//     presentation" this feature exists to copy.
//
// THE ENVELOPE STAYS OFF THE CLIPBOARD, and not by a second rule of its own.
// A user turn that carries an envelope renders through `SegmentList`, which
// draws nothing for a `state`/`drive` segment whose event is human-hidden
// (`humanSegmentEvent` — org state, provider usage, the charter, the drive
// pointers). This walks the segments through THAT SAME gate, so what is
// copied is what is on screen by construction. A private copy of the rule
// here could drift from the renderer's; an import cannot.
//
// Row METADATA — ids, timestamps, sender chips, delivery badges — is never
// copied. It is chrome around the message, not the message.
import { getMailById } from '../api'
import { decodeEventRow } from '../events/decode'
import type { EventProfile } from '../events/decode'
import { humanSegmentEvent, isSegments } from '../events/segments'
import type { ChatMessage, ToolChip } from '../types'

export interface CopyableMailRow {
  id?: string | null
  from?: string | null
  to?: string | null
  body?: string | null
  content?: string | null
  preview?: string | null
  truncated?: boolean
  body_bytes?: number
  chunk_index?: number
  chunk_total?: number
  complete?: boolean
  ev?: unknown
}

const MAIL_BY_REF_RE = /^\[MAIL BY REFERENCE\b[^\]]*\]/

export function isMailByReferencePreview(text: string | null | undefined): boolean {
  return typeof text === 'string' && MAIL_BY_REF_RE.test(text.trimStart())
}

/** Immediate copyable body text of a mail row (incoming agent, @user, external
 *  @net:/@org:, or outgoing). Preserves leading indentation and trailing newlines
 *  byte-for-byte when non-empty. */
export function mailRowCopyText(row: CopyableMailRow | null | undefined, profile: EventProfile = 'operator'): string {
  if (!row) return ''
  if (typeof row.body === 'string' && row.body.trim() !== '') return row.body
  if (typeof row.content === 'string' && row.content.trim() !== '') return row.content
  if (row.ev !== undefined) {
    const decoded = decodeEventRow({ ev: row.ev, text: '' }, profile)
    if (decoded.kind === 'known' && 'body' in decoded.event && typeof decoded.event.body === 'string' && decoded.event.body.trim() !== '') {
      return decoded.event.body
    }
  }
  return ''
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length
}

/** True when a mail row holds only a preview, is truncated, or is chunked and
 *  can be fetched in full by id. */
export function mailRowNeedsFullFetch(row: CopyableMailRow | null | undefined): boolean {
  if (!row || typeof row.id !== 'string' || !row.id.trim()) return false
  const body = typeof row.body === 'string' ? row.body : typeof row.content === 'string' ? row.content : ''
  if (isMailByReferencePreview(body)) return true
  if (row.truncated === true) return true
  if (typeof row.chunk_total === 'number' && row.chunk_total > 1) return true
  if (row.complete === false) return true
  if (typeof row.body_bytes === 'number' && row.body_bytes > utf8Bytes(body)) return true
  if (body.trim() === '' && typeof row.preview === 'string' && row.preview.trim() !== '') return true
  return false
}

/** Resolve the full untruncated body of a mail row, fetching all chunks in
 *  order when chunked or preview-only. Falls back to the row's local text if
 *  the lookup is unavailable. */
export async function resolveFullMailCopyText(
  row: CopyableMailRow,
  fetchChunk: (id: string, chunk?: number) => Promise<CopyableMailRow | null | undefined>,
  profile: EventProfile = 'operator',
): Promise<string> {
  const fallback = () => {
    const direct = mailRowCopyText(row, profile)
    if (direct !== '') return direct
    return typeof row.preview === 'string' && row.preview.trim() !== '' ? row.preview : ''
  }
  const id = typeof row.id === 'string' ? row.id.trim() : ''
  if (!id || !mailRowNeedsFullFetch(row)) return fallback()
  const isChunkedHint = (typeof row.chunk_total === 'number' && row.chunk_total > 1) || row.complete === false
  try {
    const first = await fetchChunk(id, isChunkedHint ? 0 : undefined)
    if (!first) return fallback()
    const total = typeof first.chunk_total === 'number' && first.chunk_total > 1
      ? first.chunk_total
      : (typeof row.chunk_total === 'number' && row.chunk_total > 1 ? row.chunk_total : 1)
    if (total > 1) {
      const parts: string[] = [typeof first.body === 'string' && first.body !== '' ? first.body : String(first.content ?? '')]
      for (let idx = 1; idx < total; idx++) {
        const part = await fetchChunk(id, idx)
        if (part) {
          parts.push(typeof part.body === 'string' && part.body !== '' ? part.body : String(part.content ?? ''))
        }
      }
      const joined = parts.join('')
      return joined.trim() !== '' ? joined : fallback()
    }
    if (first.complete === false) {
      const parts: string[] = [typeof first.body === 'string' && first.body !== '' ? first.body : String(first.content ?? '')]
      for (let idx = (first.chunk_index ?? 0) + 1; idx < 128; idx++) {
        const part = await fetchChunk(id, idx)
        if (!part) break
        parts.push(typeof part.body === 'string' && part.body !== '' ? part.body : String(part.content ?? ''))
        if (part.complete !== false) break
      }
      const joined = parts.join('')
      return joined.trim() !== '' ? joined : fallback()
    }
    const resolved = mailRowCopyText(first, profile)
    return resolved !== '' ? resolved : fallback()
  } catch {
    return fallback()
  }
}

/** Fetch one mail row (or chunk) by id across its known or candidate boxes. */
export async function fetchMailRowForCopy(
  slug: string,
  id: string,
  opts?: { box?: 'user' | 'org' | 'node'; node?: string; chunk?: number },
): Promise<CopyableMailRow | null> {
  const candidates: Array<{ box: 'user' | 'org' | 'node'; node?: string }> = []
  if (opts?.box) {
    candidates.push({ box: opts.box, node: opts.box === 'node' ? opts.node : undefined })
  }
  if (opts?.node && opts?.box !== 'node') {
    candidates.push({ box: 'node', node: opts.node })
  }
  if (opts?.box !== 'user') candidates.push({ box: 'user' })
  if (opts?.box !== 'org') candidates.push({ box: 'org' })
  for (const c of candidates) {
    try {
      const res = await getMailById(slug, c.box, id, c.node, opts?.chunk)
      if (res?.found && res.mail) return res.mail as CopyableMailRow
    } catch {
      // try next candidate box
    }
  }
  return null
}

/** Join the parts of a row with a blank line, dropping the ones that have no
 *  text at all. A row made only of empty parts copies as '' — the caller
 *  offers a DISABLED menu item for that, never an empty clipboard write.
 *
 *  ⚠ A KEPT PART IS NEVER TOUCHED (coordinator-astra review of f910f75). The
 *  first cut ran every part through `trim()`, which silently ate leading
 *  indentation and trailing blank lines — so a fenced block, a YAML fragment
 *  or a patch pasted back somewhere indentation-sensitive was BROKEN, while
 *  reading as a complete copy. Emptiness is still judged by whether a part
 *  has any non-whitespace in it; the part that survives that judgement goes
 *  on the clipboard byte for byte. The blank line is inserted only BETWEEN
 *  distinct parts the UI model shows as separate things, never around one. */
function join(parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').join('\n\n')
}

/** The visible prose of a typed turn's composition.
 *
 *  Each segment contributes its OWN underlying text — the same string the
 *  renderer draws (or falls back to when an event will not decode) — and a
 *  machine-context segment contributes it only when the desk shows the
 *  segment at all. `notices` and `mail` are always drawn, so they always
 *  contribute; of a mail row only the BODY, since its sender, kind and time
 *  are the card's metadata strip rather than anything anybody wrote. */
export function segmentsCopyText(segments: unknown, profile: EventProfile): string {
  if (!isSegments(segments, profile)) return ''
  const parts: string[] = []
  for (const segment of segments) {
    switch (segment.kind) {
      case 'text': parts.push(segment.text); break
      case 'state': case 'drive': {
        const row = 'event' in segment ? { ev: segment.event, text: segment.text }
          : { text: segment.text }
        const decoded = decodeEventRow(row, profile)
        // the renderer's own gate, imported rather than restated
        if (decoded.kind === 'known' && !humanSegmentEvent(decoded.event)) break
        parts.push(segment.text)
        break
      }
      case 'notices': for (const row of segment.rows) parts.push(row.text); break
      case 'mail': for (const row of segment.rows) parts.push(mailRowCopyText(row, profile)); break
    }
  }
  return join(parts)
}

/** The text of a tool CALL chip — the one line the chip shows, as stored.
 *  `reply_quote` is the server's own rendering of it (reply_events.py builds
 *  it as `name + ' ' + arg`), so it is the faithful source and is returned
 *  UNCHANGED; the same name-space-argument shape is the fallback when a row
 *  predates the quote, and it is one line, not two parts. */
export function toolCallCopyText(t: ToolChip): string {
  const quote = typeof t.reply_quote === 'string' ? t.reply_quote : ''
  if (quote.trim() !== '') return quote
  const call = String(t.name ?? '') + ' ' + (t.arg == null ? '' : String(t.arg))
  return call.trim() === '' ? '' : call
}

/** A tool RESULT: the result itself, whole. `result_reply_quote` is capped at
 *  4000 and is deliberately NOT consulted — `result` is the untruncated value
 *  the payload carries. */
export function toolResultCopyText(t: ToolChip): string {
  return t.result == null ? '' : String(t.result)
}

/** The complete text of one transcript message row.
 *
 *  A SYSTEM row is its slash-command output when it has one, else its line
 *  plus the compaction summary that sits behind a click — the summary is the
 *  collapsed text this feature was asked for, and it is not in the DOM until
 *  the row is opened.
 *
 *  A USER turn with a typed composition copies that composition's visible
 *  prose; `m.text` on such a row is the WHOLE enveloped byte string that went
 *  to the model, which is exactly what must not reach the clipboard.
 *
 *  Any other row is its body. Thinking and tool output are deliberately NOT
 *  folded in: each carries its own `data-reply-event` and is its own
 *  right-click target, so a menu raised on the thought copies the thought and
 *  one raised on the message copies the message. */
export function messageCopyText(m: ChatMessage, profile: EventProfile): string {
  if (m.role === 'system') {
    return m.cmd_out ? String(m.cmd_out) : join([m.text, m.summary])
  }
  if (m.role === 'user' && isSegments(m.segments, profile)) {
    return segmentsCopyText(m.segments, profile)
  }
  return join([m.text])
}
