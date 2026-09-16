import { useSyncExternalStore } from 'react'

let noticeArmed = false
const listeners = new Set<() => void>()

function emitChange() {
  for (const listener of listeners) {
    listener()
  }
}

/** Check whether notice-send is currently armed for the next user message. */
export function isNoticeArmed(): boolean {
  return noticeArmed
}

/** Set whether notice-send is armed for the next user message. */
export function setNoticeArmed(armed: boolean): void {
  if (noticeArmed !== armed) {
    noticeArmed = armed
    emitChange()
  }
}

/** Toggle the notice-armed state. Returns the new state. */
export function toggleNoticeArmed(): boolean {
  noticeArmed = !noticeArmed
  emitChange()
  return noticeArmed
}

/** Subscribe to notice-armed changes (e.g. for useSyncExternalStore). */
export function subscribeNoticeArmed(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Reactive React hook for the notice-armed state. */
export function useNoticeArmed(): boolean {
  return useSyncExternalStore(subscribeNoticeArmed, isNoticeArmed, () => false)
}
