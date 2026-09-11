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
import { decodeEventRow } from '../events/decode'
import type { EventProfile } from '../events/decode'
import { humanSegmentEvent, isSegments } from '../events/segments'
import type { ChatMessage, ToolChip } from '../types'

/** Join the parts of a row with a blank line, dropping the ones that have no
 *  text at all. A row made only of empty parts copies as '' — the caller
 *  offers a DISABLED menu item for that, never an empty clipboard write. */
function join(parts: (string | null | undefined)[]): string {
  return parts.map(p => (typeof p === 'string' ? p.trim() : '')).filter(Boolean).join('\n\n')
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
          : 'event_public' in segment ? { ev_public: segment.event_public, text: segment.text }
            : { text: segment.text }
        const decoded = decodeEventRow(row, profile)
        // the renderer's own gate, imported rather than restated
        if (decoded.kind === 'known' && !humanSegmentEvent(decoded.event)) break
        parts.push(segment.text)
        break
      }
      case 'notices': for (const row of segment.rows) parts.push(row.text); break
      case 'mail': for (const row of segment.rows) parts.push(row.body); break
    }
  }
  return join(parts)
}

/** The text of a tool CALL chip — the one line the chip shows. `reply_quote`
 *  is the server's own rendering of it and is not capped for this shape (it
 *  is built from the name and argument, not from a body), so it is the
 *  faithful source; the name/argument pair is the same fallback the chip
 *  itself uses. */
export function toolCallCopyText(t: ToolChip): string {
  const quote = typeof t.reply_quote === 'string' ? t.reply_quote : ''
  return quote.trim() || join([String(t.name ?? ''), t.arg == null ? '' : String(t.arg)])
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
