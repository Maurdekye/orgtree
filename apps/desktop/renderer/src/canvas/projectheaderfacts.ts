import type { TreePayload } from '../types'
import type { CanvasNode } from './shared'
import { projectSlotState, slotBadgeText, slotCount } from './slots'
import { listenerCards, mailQueueCard, projectListenerState, queueAckMode } from './listeners'

/** One source for the coloured project header chips and identity hover.
 * USER 2026-10-21 15:56:49Z: no coloured chips means the name alone,
 * including on name-visible links and far-zoom cards. Grey retired badges
 * and summary text do not count as coloured fact chips. */
export function projectHeaderFacts(node: CanvasNode,
  tree?: Pick<TreePayload, 'slot_leases' | 'watchdogs'>) {
  const dogs = tree?.watchdogs ?? []
  const slots = projectSlotState(node.id, slotCount(node), tree?.slot_leases ?? [], dogs)
  const slotBadge = slotBadgeText(slots)
  const listeners = projectListenerState(node.id, dogs)
  const listenerBadges = listenerCards(node.id, listeners)
  const queue = mailQueueCard(node.id, node.mail_pending ?? 0, node.mail_held ?? 0, queueAckMode(node), dogs)
  // USER 16:00:17Z: group multiple cyan chips in the tooltip only.
  // Keep their header rendering unchanged; at most three category sections.
  const texts = [slotBadge, listenerBadges.map(c => c.text).join('; '), queue?.text]
    .filter((text): text is string => !!text)
  return { slots, slotBadge, listeners, listenerBadges, queue, texts, hasChips: texts.length > 0 }
}
