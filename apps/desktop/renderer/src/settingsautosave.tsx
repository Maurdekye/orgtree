import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ToastFn } from './types'

type Fields = Record<string, unknown>
type Entry = { value: unknown; due: number }
type Save = (fields: Fields) => Promise<{ warnings?: string[] }>
type Status = { pending: boolean; error: string | null; warnings: string[] }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** One request at a time, with an independent debounce deadline per field.
 * Failed fields stay dirty until an explicit retry or a newer edit. */
export class SettingsSaveQueue {
  private pending = new Map<string, Entry>()
  private flight: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private listeners = new Set<() => void>()
  private status: Status = { pending: false, error: null, warnings: [] }
  constructor(public save: Save, public report: (error: string) => void = () => {}) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.status
  private publish(patch: Partial<Status> = {}) {
    this.status = { ...this.status, ...patch, pending: !!this.flight || this.pending.size > 0 }
    this.listeners.forEach(f => f())
  }
  enqueue(key: string, value: unknown, delay = 0) {
    this.pending.set(key, { value, due: Date.now() + delay })
    this.publish()
    this.schedule()
  }
  private schedule() {
    clearTimeout(this.timer)
    const due = Math.min(...[...this.pending.values()].map(e => e.due))
    if (!Number.isFinite(due) || this.flight) return
    if (due <= Date.now()) void this.drain()
    else this.timer = setTimeout(() => { void this.drain() }, due - Date.now())
  }
  private async drain(): Promise<void> {
    if (this.flight) { await this.flight; return this.drain() }
    // A later failure must never replay a successful folder/permission write.
    const batch = [...this.pending].filter(([, entry]) => entry.due <= Date.now()).slice(0, 1)
    if (!batch.length) { this.schedule(); return }
    batch.forEach(([key]) => this.pending.delete(key))
    // Start on a microtask so flight is assigned before the writer can settle.
    this.flight = Promise.resolve().then(async () => {
      try {
        const result = await this.save(Object.fromEntries(batch.map(([k, e]) => [k, e.value])))
        this.publish({ error: [...this.pending.values()].some(e => e.due === Infinity) ? this.status.error : null,
          warnings: result.warnings ?? [] })
      } catch (e) {
        batch.forEach(([key, entry]) => {
          if (!this.pending.has(key)) this.pending.set(key, { ...entry, due: Infinity })
        })
        const error = e instanceof Error ? e.message : 'Unable to save settings'
        this.publish({ error }); this.report(error)
      }
    })
    this.publish()
    await this.flight
    this.flight = null
    this.publish()
    this.schedule()
  }
  async flush(retry = false): Promise<boolean> {
    clearTimeout(this.timer)
    this.pending.forEach(e => { if (retry || Number.isFinite(e.due)) e.due = 0 })
    await this.drain()
    // A newer edit may have arrived while the previous request was in flight.
    if ([...this.pending.values()].some(e => Number.isFinite(e.due))) return this.flush()
    return this.pending.size === 0
  }
}

/** Untouched fields follow server props. Acknowledged edits bridge the gap
 * until the tree feed catches up; a later server change replaces that bridge. */
export function useSettingsAutosave(scope: string, server: Fields, write: Save, toast: ToastFn) {
  type Cell = { value: unknown; saved: boolean; base: unknown }
  const [buffer, setBuffer] = useState<{ scope: string; fields: Record<string, Cell> }>({ scope, fields: {} })
  const current = useRef({ scope, server })
  current.current = { scope, server }
  const queue = useMemo(() => new SettingsSaveQueue(async () => ({})), [scope])
  queue.report = error => toast([`error: ${error}`])
  queue.save = async fields => {
    const result = await write(fields)
    if (current.current.scope === scope) setBuffer(b => {
      if (b.scope !== scope) return b
      const next = { ...b.fields }
      Object.entries(fields).forEach(([key, value]) => {
        if (next[key] && equal(next[key].value, value)) next[key] = { value, saved: true, base: current.current.server[key] }
      })
      return { scope, fields: next }
    })
    return result
  }
  const status = useSyncExternalStore(queue.subscribe, queue.snapshot)
  useEffect(() => () => { void queue.flush() }, [queue])
  useEffect(() => {
    setBuffer(b => {
      if (b.scope !== scope) return { scope, fields: {} }
      const fields = Object.fromEntries(Object.entries(b.fields).filter(([key, cell]) =>
        !cell.saved || equal(server[key], cell.base)))
      return Object.keys(fields).length === Object.keys(b.fields).length ? b : { scope, fields }
    })
  }, [scope, server])
  const value = <T,>(key: string, fallback: T): T => {
    const cell = buffer.scope === scope ? buffer.fields[key] : undefined
    return cell && (!cell.saved || equal(server[key], cell.base)) ? cell.value as T : fallback
  }
  const set = <T,>(key: string, previous: T, delay = 0) => (update: T | ((old: T) => T)) => {
    const next = typeof update === 'function' ? (update as (v: T) => T)(previous) : update
    if (equal(next, previous)) return
    setBuffer(b => ({ scope, fields: { ...(b.scope === scope ? b.fields : {}),
      [key]: { value: next, saved: false, base: server[key] } } }))
    queue.enqueue(key, next, delay)
  }
  return { value, set, queue, status }
}

export function SettingsSaveStatus({ status, retry }: { status: Status; retry: () => void }) {
  return <div className="settings-save-status">
    {status.error ? <div role="alert">Unable to save settings: {status.error}{' '}
      <button type="button" aria-label="Retry saving settings" onClick={retry}>Retry</button>
    </div> : <div role="status" aria-live="polite">{status.pending ? 'Saving changes…' : 'Changes saved automatically'}</div>}
    {status.warnings.map((warning, i) => <div role="status" key={i}>{warning}</div>)}
  </div>
}

export function settingNumber(value: unknown, min: number, max = Infinity) {
  if (String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max)
    throw new Error(Number.isFinite(max) ? `Enter a number from ${min} to ${max}` : `Enter a number of ${min} or higher`)
  return Number(value)
}
