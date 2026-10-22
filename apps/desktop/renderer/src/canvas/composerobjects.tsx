import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { captureDeskMentionAt, DESK_MENTION_ATTR } from './agentmentions'
import type { ReplyTarget } from '../generated/events'
import { ReplyPreviewFrame } from './replypreview'
import { objectNavProps } from './objectnav'

export type ComposerObject = { kind: 'document' | 'work_item'; org: string; id: string; title: string; sender?: string }
export const composerTarget = (target: ComposerObject): ReplyTarget => target.kind === 'work_item'
  ? { kind: 'work_item', org: target.org, slug: target.id }
  : { kind: 'document', org: target.org, id: target.id }
type Composer = {
  key: string
  mention: (text: string) => (() => void) | null
  down: () => void
  reply: (target: ComposerObject) => void
  disabled?: boolean
}
const scopes = new WeakMap<Element, { current: Composer }>()

/** Register the content owned by this box, including sibling reading content.
 * Quick chat owns only canvas-world, never the window's modals or pin layer. */
export function useObjectComposer(input: RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
  composer: Composer, kind: 'desk' | 'mail' | 'quick' | 'nested' | null) {
  const current = useRef(composer)
  current.current = composer
  useLayoutEffect(() => {
    const box = input.current
    if (!box || !kind) return
    if (kind === 'nested' && !box.closest('.desk-body, .project-desk')) return
    const scope = kind === 'quick'
      ? box.closest('main')?.querySelector('.canvas-world')
      : kind === 'mail' || kind === 'nested' ? box.closest('.mailer-read')
        : box.closest(`.desk-body, .project-desk, [${DESK_MENTION_ATTR}]`)
    if (!scope) return
    const down = (event: Event) => { if ((event as MouseEvent).button === 2) current.current.down() }
    scopes.set(scope, current)
    scope.addEventListener('pointerdown', down, true)
    scope.addEventListener('mousedown', down, true)
    return () => {
      if (scopes.get(scope) === current) scopes.delete(scope)
      scope.removeEventListener('pointerdown', down, true)
      scope.removeEventListener('mousedown', down, true)
    }
  })
}

export function captureObjectActions(anchor: Element | null, reference: string): {
  mention: (() => void) | null; reply: ((target: ComposerObject) => void) | null
} {
  for (let scope = anchor; scope; scope = scope.parentElement) {
    const holder = scopes.get(scope)
    if (holder) {
      const picked = holder.current
      if (picked.disabled) return { mention: null, reply: null }
      const mention = picked.mention(reference)
      // Capture the element, not the loop variable after it advances.
      const owner = scope
      const valid = () => owner.isConnected && scopes.get(owner) === holder && !holder.current.disabled && holder.current.key === picked.key
      return {
        mention: mention ? () => { if (valid()) mention() } : null,
        reply: target => { if (valid()) holder.current.reply(target) },
      }
    }
    // An unavailable nearer desk must not fall through to Quick chat.
    if (scope.hasAttribute(DESK_MENTION_ATTR)) return { mention: captureDeskMentionAt(anchor, reference), reply: null }
    if (scope.matches('.desk-body, .desk-over, .desk-bare, .project-desk')) return { mention: null, reply: null }
  }
  return { mention: null, reply: null }
}

/** A staged object identity, with the same removable annotation as chat replies. */
export function ObjectReplyDraft({ target, onRemove }: { target: ComposerObject; onRemove?: () => void }) {
  return <ReplyPreviewFrame label={target.kind === 'work_item' ? 'Replying to ticket' : 'Replying to presentation'}
    onRemove={onRemove} action={<span {...objectNavProps(target.kind === 'work_item' ? 'ticket' : 'document', target.id, target.org)}>
      {target.kind === 'work_item' ? 'Ticket' : 'Presentation'}: {target.title || target.id}
    </span>}>
    <span className="dim">{target.id}</span>
  </ReplyPreviewFrame>
}
