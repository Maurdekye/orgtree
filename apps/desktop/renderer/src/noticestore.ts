import { useCallback, useSyncExternalStore } from 'react'

/**
 * Per-chat send-as-notice store.
 *
 * Scopes notice-send state to individual chat windows/composers, keyed by
 * `${slug}/${node.id}`. State survives focus changes, rerenders, mail arrival,
 * and opening or closing other chats.
 *
 * THE KEY IS REQUIRED ON EVERY ACCESSOR, DELIBERATELY. An earlier revision of
 * this file carried an unkeyed compatibility layer whose fallback reported
 * ARMED if ANY chat was armed -- which is precisely the shared-toggle bug this
 * store exists to remove. Nothing in the product called it, but it was one
 * careless call site away from bringing the bug back, and the type system now
 * refuses that call rather than guessing which chat was meant.
 */

const armedByChat = new Map<string, boolean>()
const listenersByChat = new Map<string, Set<() => void>>()
const registeredChats = new Set<string>()
let activeChatKey: string | null = null

function emitChange(key: string) {
  const set = listenersByChat.get(key)
  if (!set) return
  for (const listener of set) {
    listener()
  }
}

/** Check whether notice-send is armed for this chat window. */
export function isNoticeArmed(key: string): boolean {
  return armedByChat.get(key) ?? false
}

/** Set whether notice-send is armed for this chat window. */
export function setNoticeArmed(key: string, armed: boolean): void {
  const prev = armedByChat.get(key) ?? false
  if (prev === armed) return
  if (armed) {
    armedByChat.set(key, true)
  } else {
    armedByChat.delete(key)
  }
  emitChange(key)
}

/** Toggle this chat window's notice-armed state. Returns the new state. */
export function toggleNoticeArmed(key: string): boolean {
  const next = !(armedByChat.get(key) ?? false)
  if (next) {
    armedByChat.set(key, true)
  } else {
    armedByChat.delete(key)
  }
  emitChange(key)
  return next
}

/** Subscribe to one chat window's notice-armed changes. */
export function subscribeNoticeArmed(key: string, listener: () => void): () => void {
  let set = listenersByChat.get(key)
  if (!set) {
    set = new Set()
    listenersByChat.set(key, set)
  }
  set.add(listener)
  return () => {
    const s = listenersByChat.get(key)
    s?.delete(listener)
    if (s && s.size === 0) {
      listenersByChat.delete(key)
    }
  }
}

/** Reactive React hook for one chat window's notice-armed state. */
export function useNoticeArmed(key: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeNoticeArmed(key, onStoreChange),
    [key]
  )
  const getSnapshot = useCallback(() => isNoticeArmed(key), [key])
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}

/** Register a mounted chat instance. */
export function registerChat(key: string): void {
  registeredChats.add(key)
  if (!activeChatKey) {
    activeChatKey = key
  }
}

/**
 * Unregister an unmounted chat instance. Deliberately does NOT clear the armed
 * state: a chat closed and reopened before sending comes back armed, which is
 * what this ticket's third acceptance condition requires.
 */
export function unregisterChat(key: string): void {
  registeredChats.delete(key)
  if (activeChatKey === key) {
    activeChatKey = registeredChats.values().next().value ?? null
  }
}

/** Set the currently active/focused chat key. */
export function setActiveChatKey(key: string | null): void {
  activeChatKey = key
}

/** Get the currently active chat key. */
export function getActiveChatKey(): string | null {
  return activeChatKey
}

/** Check if the given chat is currently active. */
export function isChatActive(key: string): boolean {
  if (activeChatKey === key) return true
  if (registeredChats.size === 1 && registeredChats.has(key)) return true
  return false
}

/** Reset the entire notice store (for test harness isolation). */
export function resetNoticeStore(): void {
  armedByChat.clear()
  registeredChats.clear()
  activeChatKey = null
  for (const set of listenersByChat.values()) {
    for (const listener of set) {
      listener()
    }
  }
}
