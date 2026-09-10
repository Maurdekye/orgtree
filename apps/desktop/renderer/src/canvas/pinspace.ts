import { useEffect, useState, useSyncExternalStore } from 'react'
import type { RefObject } from 'react'
import type { PinRect } from './pins'

// Mounted desks and modal pins share viewport coordinates and stacking order.
// This registry is transient; each existing store still owns persistence.
export interface PinSurface { key: string; org: string; rect: PinRect; modal: boolean; order: number }
let surfaces: PinSurface[] = []
let order = 0
const listeners = new Set<() => void>()
const notify = () => { for (const fn of listeners) fn() }
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
export const readPinSurfaces = () => surfaces
export const usePinSurfaces = () => useSyncExternalStore(subscribe, readPinSurfaces)
export const pinSurfaceKey = (org: string, kind: string, modal = false) => JSON.stringify([org, modal, kind])
// Keep desk IDs compatible with their persisted snap history; modal keys are
// namespaced because a modal and an agent may have the same name.
export const pinSnapId = (surface: PinSurface): string => surface.modal ? surface.key : JSON.parse(surface.key)[2]
export function updatePinSurface(key: string, org: string, rect: PinRect, modal: boolean) {
  const old = surfaces.find(p => p.key === key)
  if (old && ['x','y','w','h'].every(k => old.rect[k as keyof PinRect] === rect[k as keyof PinRect])) return
  surfaces = [...surfaces.filter(p => p.key !== key), {key, org, rect, modal, order: old?.order ?? ++order}]
  notify()
}
export function removePinSurface(key: string) {
  if (!surfaces.some(p => p.key === key)) return
  surfaces = surfaces.filter(p => p.key !== key); notify()
}
export function raisePinSurface(key: string) {
  if (!surfaces.some(p => p.key === key)) return
  surfaces = surfaces.map(p => p.key === key ? {...p, order: ++order} : p); notify()
}
export function usePinSurface(org: string | null, kind: string, rect: PinRect | null, modal: boolean) {
  const key = pinSurfaceKey(org ?? '', kind, modal)
  const all = usePinSurfaces()
  useEffect(() => {
    if (org && rect) updatePinSurface(key, org, rect, modal)
    else removePinSurface(key)
  }, [key, org, rect?.x, rect?.y, rect?.w, rect?.h, modal])
  useEffect(() => () => removePinSurface(key), [key])
  const peers = all.filter(p => p.org === org).sort((a,b) => a.order - b.order)
  const rank = peers.findIndex(p => p.key === key)
  // Fractional ranks allow all windows to raise within the existing 10..16 band.
  return {key, z: 10 + Math.max(0, rank) * 6 / Math.max(1, peers.length), peers}
}

export interface CanvasBox { x: number; y: number; w: number; h: number }
export function canvasBox(doc: Document, org: string | null): CanvasBox | null {
  if (!org) return null
  const el = [...doc.querySelectorAll<HTMLElement>('[data-pin-org]')].find(e => e.dataset.pinOrg === org)
  if (!el) return null
  const r = el.getBoundingClientRect(), cs = doc.defaultView!.getComputedStyle(el)
  const n = (s: string) => parseFloat(s) || 0
  const w = r.width - n(cs.borderLeftWidth) - n(cs.borderRightWidth)
  const h = r.height - n(cs.borderTopWidth) - n(cs.borderBottomWidth)
  return w > 0 && h > 0 ? {x:r.left+n(cs.borderLeftWidth), y:r.top+n(cs.borderTopWidth), w,h} : null
}
export function useCanvasBox(doc: Document, org: string | null) {
  const [box, setBox] = useState(() => canvasBox(doc, org))
  useEffect(() => {
    if (!org) { setBox(null); return }
    let observed: HTMLElement | null = null
    const measure = () => {
      const el = [...doc.querySelectorAll<HTMLElement>('[data-pin-org]')].find(e => e.dataset.pinOrg === org) ?? null
      if (el !== observed) {
        if (observed) resize.unobserve(observed)
        observed = el
        if (observed) resize.observe(observed)
      }
      const next = canvasBox(doc, org)
      setBox(old => JSON.stringify(old) === JSON.stringify(next) ? old : next)
    }
    const resize = new ResizeObserver(measure)
    resize.observe(doc.documentElement)
    const mutation = new doc.defaultView!.MutationObserver(measure)
    mutation.observe(doc.body, {childList:true, subtree:true})
    doc.defaultView?.addEventListener('resize', measure)
    measure()
    return () => {resize.disconnect(); mutation.disconnect(); doc.defaultView?.removeEventListener('resize', measure)}
  }, [doc, org])
  return box
}

export function useDeskOverlap(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  const [overlap, setOverlap] = useState(false)
  useEffect(() => {
    if (!enabled) {setOverlap(false); return}
    const check = () => {
      const el = ref.current
      if (!el) {setOverlap(false); return}
      const a = el.getBoundingClientRect()
      setOverlap([...el.ownerDocument.querySelectorAll<HTMLElement>('.sq.desk')].some(desk => {
        if (el.contains(desk) || !desk.querySelector('.desk-over')) return false
        const b = desk.getBoundingClientRect()
        return a.width > 0 && b.width > 0 && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
      }))
    }
    check(); const timer = setInterval(check, 120)
    return () => clearInterval(timer)
  }, [ref, enabled])
  return overlap
}
