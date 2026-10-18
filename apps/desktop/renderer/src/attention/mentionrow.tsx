// attention/mentionrow.tsx — ONE @user MENTION IN THE ATTENTION LIST.
//
// Drawn as the inbox draws an unread mail that mentions @user (user
// 2026-10-18 14:39Z: "this looks bad, get an opus to clean that up"): the
// same `.mailrow` with the urgent attention cue such mail wears
// (`hasMailAttention`, user 14:38-14:41Z). Line 1 is the agent, a "mention"
// pill in the list's pill language and the time; line 2 is ONE excerpt, cut
// at word boundaries (`mentionExcerpt`), with @user marked in the run of text
// so it sits flush with its punctuation.

import type { ReactNode } from 'react'
import { fmtShort } from '../timefmt'
import type { UserMentionInfo } from '../types'
import { mentionExcerpt } from './feed'

export function MentionRowView({ mention, party, selected, onClick }: {
  mention: UserMentionInfo
  /** the agent, already rendered by the list's sender renderer */
  party: ReactNode
  selected: boolean
  onClick: () => void
}) {
  const cut = mentionExcerpt(mention.blurb)
  return (
    <div className={'mailrow unread urgent attn-mention-row' + (selected ? ' on' : '')} onClick={onClick}>
      <div className="l1">
        <span className="mfrom">{party}</span>
        <span className="mentionkind">mention</span>
        <span className="mtime">{fmtShort(mention.at)}</span>
      </div>
      <div className="l2" data-mention-blurb={mention.blurb}>
        <span className="mail-preview-text">{cut.lead}<span className="attn-mention-token">{cut.token}</span>{cut.tail}</span>
      </div>
    </div>
  )
}
