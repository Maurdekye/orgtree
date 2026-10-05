/** One socket per renderer document, shared by every app-wide consumer. */
import { useCallback, useSyncExternalStore } from 'react'
import { AppFeedConnection } from '../../../../packages/contracts/app-feed-connection'
import type { AppSnapshot } from '../../../../packages/contracts/app-feed'
import { req } from './api'

const listeners = new Set<() => void>()
let revision = 0
const connection = new AppFeedConnection({
  copy: () => req<AppSnapshot>('/api/app/records'),
  socket(receive, closed) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${location.host}/api/app/ws`)
    socket.onmessage = event => receive(String(event.data))
    socket.onclose = closed
    socket.onerror = () => socket.close()
    return socket
  },
  changed() { revision++; for (const listener of listeners) listener() },
})
function subscribe(listener: () => void) {
  listeners.add(listener)
  connection.start()
  return () => {
    listeners.delete(listener)
    if (!listeners.size) connection.stop()
  }
}
const inactive = () => () => {}
const snapshot = () => revision

export function useAppFeed(active = true) {
  const version = useSyncExternalStore(active ? subscribe : inactive, snapshot, snapshot)
  const refresh = useCallback(() => connection.refresh(), [])
  return { state: connection.state, status: connection.status, error: connection.error,
    version, refresh }
}

export function useAppValue<T>(key: string, active = true): T | undefined {
  return useAppFeed(active).state.value<T>(key)
}
