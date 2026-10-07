import { useLayoutEffect } from 'react'

export type OpenAction = 'mail' | 'mail-item' | 'docket' | 'archive' | 'ticket'
export type OpenTiming = { action: OpenAction; sample: number; commit_ms: number;
  frame_ms: number; hidden: boolean; focused: boolean }
type Pending = { action: OpenAction; key: string; sample: number; mark: string;
  start: number; hidden: boolean; frame?: number }
let enabled = false, sequence = 0
let send: ((value: OpenTiming) => void) | undefined
const pending = new Map<OpenAction, Pending>()

function forget(p: Pending) {
  if (p.frame !== undefined) cancelAnimationFrame(p.frame)
  for (const suffix of ['click','commit','frame']) performance.clearMarks(`${p.mark}:${suffix}`)
  performance.clearMeasures(p.mark)
  if (pending.get(p.action) === p) pending.delete(p.action)
}

// Reuses ordinary API responses: no settings request, timer or observer when off.
export function configureOpenTiming(on: boolean, sink: (value: OpenTiming) => void) {
  enabled = on; send = sink
  if (!on) for (const p of pending.values()) forget(p)
}

export function beginOpen(action: OpenAction, key = '') {
  if (!enabled) return
  const old = pending.get(action)
  if (old) forget(old)
  const sample = ++sequence, mark = `orgtree.open.${action}.${sample}`
  const start = performance.mark(`${mark}:click`).startTime
  pending.set(action,{action,key,sample,mark,start,hidden:document.hidden})
}

export function cancelOpen(action: OpenAction, key = '') {
  if (!enabled) return
  const p = pending.get(action)
  if (p?.key === key) forget(p)
}

export function commitOpen(action: OpenAction, key = '') {
  if (!enabled) return
  const p = pending.get(action)
  if (!p || p.key !== key || p.frame !== undefined) return
  performance.mark(`${p.mark}:commit`)
  const commit_ms = performance.now()-p.start
  p.frame = requestAnimationFrame(() => {
    if (!enabled || pending.get(action) !== p) return
    performance.mark(`${p.mark}:frame`)
    const frame_ms = performance.measure(p.mark,`${p.mark}:click`,`${p.mark}:frame`).duration
    const value = {action,sample:p.sample,commit_ms,frame_ms,
      hidden:p.hidden || document.hidden,focused:document.hasFocus()}
    forget(p)
    try { send?.(value) } catch { /* instrumentation cannot break the UI */ }
  })
}

// The callback runs after the ready content commits, not its loading placeholder.
// rAF is the next paint opportunity, not a GPU/present timestamp.
export function useOpenCommit(action: OpenAction, key: string, ready: boolean, identity?: unknown) {
  useLayoutEffect(() => { if (ready) commitOpen(action,key) },[action,key,ready,identity])
  useLayoutEffect(() => () => cancelOpen(action,key),[action,key])
}
