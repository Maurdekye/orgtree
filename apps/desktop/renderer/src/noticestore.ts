import { useCallback, useSyncExternalStore } from 'react'

/**
 * Per-chat send-as-notice store.
 *
 * Scopes notice-send state to individual chat windows/composers (keyed by `${slug}/${node.id}`).
 * Survives focus changes, rerenders, mail arrival, and opening/closing other chats.
 * Supports unkeyed operations for backwards compatibility and fallback/global resets.
 */

const armedByChat = new Map<string, boolean>()
const listenersByChat = new Map<string, Set<() => void>>()
const globalListeners = new Set<() => void>()
const registeredChats = new Set<string>()
let defaultArmed = false
let activeChatKey: string | null = null

function emitChange(key?: string) {
  if (key) {
    const set = listenersByChat.get(key)
    if (set) {
      for (const listener of set) {
        listener()
      }
    }
  } else {
    for (const set of listenersByChat.values()) {
      for (const listener of set) {
        listener()
      }
    }
  }
  for (const listener of globalListeners) {
    listener()
  }
}

/** Check whether notice-send is currently armed for the chat window, or active chat/fallback. */
export function isNoticeArmed(key?: string): boolean {
  if (key) {
    return armedByChat.get(key) ?? false
  }
  if (activeChatKey && armedByChat.has(activeChatKey)) {
    return armedByChat.get(activeChatKey)!
  }
  for (const v of armedByChat.values()) {
    if (v) return true
  }
  return defaultArmed
}

/**
 * Set whether notice-send is armed.
 *
 * - `setNoticeArmed(key, armed)`: sets armed state for a specific chat.
 * - `setNoticeArmed(false)`: clears all armed chats and resets default.
 * - `setNoticeArmed(true)`: arms the active chat if present, or sets default fallback.
 */
export function setNoticeArmed(armed: boolean): void
export function setNoticeArmed(key: string, armed: boolean): void
export function setNoticeArmed(keyOrArmed: string | boolean, maybeArmed?: boolean): void {
  if (typeof keyOrArmed === 'string') {
    const key = keyOrArmed
    const armed = Boolean(maybeArmed)
    const prev = armedByChat.get(key) ?? false
    if (prev !== armed) {
      if (armed) {
        armedByChat.set(key, true)
      } else {
        armedByChat.delete(key)
      }
      emitChange(key)
    }
  } else {
    const armed = keyOrArmed
    if (!armed) {
      defaultArmed = false
      const keys = Array.from(armedByChat.keys())
      armedByChat.clear()
      for (const k of keys) {
        emitChange(k)
      }
      for (const listener of globalListeners) {
        listener()
      }
    } else {
      if (activeChatKey) {
        armedByChat.set(activeChatKey, true)
        emitChange(activeChatKey)
      } else {
        defaultArmed = true
        for (const listener of globalListeners) {
          listener()
        }
      }
    }
  }
}

/** Toggle the notice-armed state for a specific chat (or the active/default chat). Returns the new state. */
export function toggleNoticeArmed(key?: string): boolean {
  const targetKey = key ?? activeChatKey
  if (targetKey) {
    const next = !(armedByChat.get(targetKey) ?? false)
    if (next) {
      armedByChat.set(targetKey, true)
    } else {
      armedByChat.delete(targetKey)
    }
    emitChange(targetKey)
    return next
  }
  defaultArmed = !defaultArmed
  emitChange()
  return defaultArmed
}

/** Subscribe to notice-armed changes (e.g. for useSyncExternalStore). */
export function subscribeNoticeArmed(listener: () => void): () => void
export function subscribeNoticeArmed(key: string | undefined, listener: () => void): () => void
export function subscribeNoticeArmed(
  keyOrListener: string | undefined | (() => void),
  maybeListener?: () => void
): () => void {
  let key: string | undefined
  let listener: () => void

  if (typeof keyOrListener === 'function') {
    listener = keyOrListener
    key = undefined
  } else {
    key = keyOrListener
    listener = maybeListener!
  }

  if (key) {
    let set = listenersByChat.get(key)
    if (!set) {
      set = new Set()
      listenersByChat.set(key, set)
    }
    set.add(listener)
    return () => {
      const s = listenersByChat.get(key!)
      s?.delete(listener)
      if (s && s.size === 0) {
        listenersByChat.delete(key!)
      }
    }
  } else {
    globalListeners.add(listener)
    return () => {
      globalListeners.delete(listener)
    }
  }
}

/** Reactive React hook for the notice-armed state of a chat. */
export function useNoticeArmed(key?: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeNoticeArmed(key, onStoreChange),
    [key]
  )
  const getSnapshot = useCallback(
    () => isNoticeArmed(key),
    [key]
  )
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}

/** Register a mounted chat instance. If defaultArmed was preset, the first chat adopts it. */
export function registerChat(key: string): void {
  registeredChats.add(key)
  if (!activeChatKey) {
    activeChatKey = key
  }
  if (defaultArmed) {
    armedByChat.set(key, true)
    defaultArmed = false
    emitChange(key)
  }
}

/** Unregister an unmounted chat instance. Does not clear armed state so switching away and back preserves it. */
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
  defaultArmed = false
  for (const set of listenersByChat.values()) {
    for (const listener of set) {
      listener()
    }
  }
  for (const listener of globalListeners) {
    listener()
  }
}
