/** One socket per renderer document, shared by every app-wide consumer. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AppFeedConnection } from '../../../../packages/contracts/app-feed-connection'
import type { AppSnapshot } from '../../../../packages/contracts/app-feed'
import { req } from './api'
import { onLiveBump } from './livebus'

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

/** Pushed app values with an explicit manual refresh. Only an older/switched-off
 * engine gets the legacy timer; a disconnected capable feed retains its value
 * and reconnects through the shared connection. */
export function useAppReadout<T>(key: string, fetcher: (force?: boolean) => Promise<T>,
  member?: string, liveBumps = false) {
  const feed = useAppFeed()
  const entry = feed.state.values.get(key)
  const whole = entry?.value?.value
  const pushed = member === undefined ? whole as T | undefined
    : (whole as Record<string, T> | undefined)?.[member]
  const token = `${feed.state.epoch}:${entry?.seq ?? -1}:${key}:${member ?? ''}`
  const current = useRef(token)
  current.current = token
  const fetchRef = useRef(fetcher)
  fetchRef.current = fetcher
  const [manual, setManual] = useState<{ token: string; value: T } | null>(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const inFlight = useRef<Promise<void> | null>(null)
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const refresh = useCallback((force = false): Promise<void> => {
    if (inFlight.current) return inFlight.current
    const started = current.current
    setPending(true)
    setFailure(null)
    const request = Promise.resolve().then(() => fetchRef.current(force)).then(value => {
      if (alive.current && current.current === started) setManual({ token: started, value })
    }).catch((error: unknown) => {
      if (alive.current && current.current === started)
        setFailure(error instanceof Error ? error.message : String(error))
    }).finally(() => {
      inFlight.current = null
      if (alive.current) setPending(false)
    })
    inFlight.current = request
    return request
  }, [])
  useEffect(() => {
    if (feed.status !== 'unsupported') return
    void refresh()
    const timer = setInterval(() => { void refresh() }, 60000)
    const off = liveBumps ? onLiveBump(() => { void refresh() }) : () => {}
    return () => { clearInterval(timer); off() }
  }, [feed.status, key, member, refresh, liveBumps])
  const value = manual?.token === token ? manual.value : pushed ?? null
  return { value, pending: pending || (value === null && feed.status === 'connecting'),
    failure: failure ?? (value === null ? feed.error : null), refresh }
}

export function useAppRead<T>(key: string, fetcher: () => Promise<T>): T | null {
  return useAppReadout(key, fetcher, undefined, true).value
}
