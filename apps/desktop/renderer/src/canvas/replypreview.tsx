import type { ReplyContext } from '../eventReply'

export function ReplyPreview({ reply, available, onLocate, onRemove }: {
  reply: ReplyContext; available: boolean; onLocate: () => void; onRemove?: () => void
}) {
  // resize-reply-annotations-above-the-message-box (user clarification,
  // 2026-09-09 11:07: the composer annotation ONLY, not a sent/settled
  // reply's own quoted-context card). `onRemove` is the one prop that is
  // ONLY ever supplied at the composer call site (desk.tsx) — every other
  // caller (a settled message's `reply_to`, a pending row, draft recovery)
  // renders this same component read-only, with no remove control. That
  // existing distinction is reused as the styling hook rather than
  // threading a new boolean through every call site.
  const composing = Boolean(onRemove)
  return <aside className={'reply-preview' + (composing ? ' reply-preview-composing' : '')}
    aria-label="Replying to chat event">
    <div className="reply-preview-head">
      <button type="button" onClick={onLocate} disabled={!available}
        title={available ? 'Show the original event' : 'Original event is not in this loaded conversation'}>
        Reply to {reply.agent} · generation {reply.generation}
      </button>
      {onRemove && <button type="button" aria-label="Remove reply" onClick={onRemove}>×</button>}
    </div>
    <blockquote>{reply.quote || '(event without visible text)'}</blockquote>
    {!available && <span className="dim">Original event unavailable here; quoted context is retained.</span>}
  </aside>
}
