import type { TreePayload } from '../types'
import { dismissUserMention, hasUnseenUserMention, useSeenMentions } from '../canvas/agentmentions'
import { flatNodes } from './treeinfo'
import { ShellAction } from './header'

/** These markers come only from assistant transcript prose. Mail's derived
 * mailbox_attention and unread counts never enter this collection. */
export function unobservedTranscriptMentions(tree: TreePayload) {
  return [...flatNodes(tree).values()]
    .filter(n => n.state === 'live' && n.kind !== 'project' && hasUnseenUserMention(n, tree.slug))
    .sort((a, b) => {
      const at = a.user_mention!.at ?? '', bt = b.user_mention!.at ?? ''
      return at === bt ? a.id.localeCompare(b.id) : at < bt ? 1 : -1
    })
}

export function TranscriptMentionButton({ tree, onFocusAgent }: {
  tree: TreePayload; onFocusAgent: (id: string) => void
}) {
  useSeenMentions()
  const mentions = unobservedTranscriptMentions(tree)
  const newest = mentions[0]
  if (!newest) return null
  return <ShellAction className="mention-bell" glow label="Unobserved transcript mentions"
    title={`${mentions.length} unobserved transcript mention${mentions.length === 1 ? '' : 's'} — open newest`}
    icon={<span aria-hidden="true">@</span>} badge={<b className="eye-count asks">{mentions.length}</b>}
    onClick={() => {
      const mention = newest.user_mention!
      void dismissUserMention(tree.slug, newest.id, mention.id, mention.event_id, { highlight: true })
      onFocusAgent(newest.id)
    }} />
}
