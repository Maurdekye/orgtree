import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { SelectionDraft } from '../replySelection'

type Composer = { key: string; disabled: boolean; stage: (selection: SelectionDraft) => void }
const scopes = new WeakMap<Element, { current: Composer }>()

/** Reading content and its reply textarea share one concrete owning scope.
 * Capturing that scope before focus/metadata work prevents stale rerouting. */
export function useSelectionComposer(input: RefObject<HTMLTextAreaElement | null>, composer: Composer) {
  const current = useRef(composer); current.current = composer
  useLayoutEffect(() => {
    const scope = input.current?.closest('.mailer-read, .selection-composer-scope, .desk-body, .project-desk')
    if (!scope) return
    scopes.set(scope, current)
    return () => { if (scopes.get(scope) === current) scopes.delete(scope) }
  })
}

export function captureSelectionComposer(anchor: Element): ((selection: SelectionDraft) => void) | null {
  for (let owner: Element | null = anchor; owner; owner = owner.parentElement) {
    const holder = scopes.get(owner)
    if (holder) {
      const picked = holder.current; const scope = owner
      if (picked.disabled) return null
      return selection => {
        if (scope.isConnected && scopes.get(scope) === holder && !holder.current.disabled && holder.current.key === picked.key) holder.current.stage(selection)
      }
    }
    if (owner.matches('.desk-body,.project-desk,.desk-over,.desk-bare')) return null
  }
  return null
}
