import { useCallback, useEffect, useRef, useState } from 'react'
import { getScratch } from './api'
import { usePolled } from './canvas/shared'
import { useRecordsEnabled } from './recordpanelhooks'
import { onAgentPanelEvent } from './recordevents'
import type { ScratchPayload } from './types'

/** Files are outside PG: mount, relevant agent events and surface focus read
 * them. The effect identity and request serialization fence late path replies. */
export function useRecordScratch(slug: string, node: string, path: string) {
  const enabled = useRecordsEnabled(slug)
  const legacy = usePolled(() => getScratch(slug, node, path), [slug, node, path], 5000, 0, !enabled)
  const key = JSON.stringify([slug, node, path])
  const [value, setValue] = useState<{ key: string; data: ScratchPayload } | null>(null)
  const [surface, setSurface] = useState<HTMLElement | null>(null)
  const refresh = useRef<() => void>(() => {})
  const focus = useCallback(() => refresh.current(), [])
  useEffect(() => {
    if (!enabled) return
    let dead = false, busy = false, again = false
    const tick = () => {
      if (dead) return
      if (busy) { again = true; return }
      busy = true
      void getScratch(slug, node, path).then(data => {
        if (!dead) setValue({ key, data })
      }).catch(() => {}).finally(() => {
        busy = false
        if (!dead && again) { again = false; tick() }
      })
    }
    refresh.current = tick
    const off = onAgentPanelEvent(event => {
      if (event.org === slug && event.node === node && event.type === 'node_event'
          && (event.event === 'turn_done' || event.event === 'file_presented')) tick()
    })
    tick()
    return () => { dead = true; refresh.current = () => {}; off() }
  }, [enabled, key, slug, node, path])
  useEffect(() => {
    if (!enabled || !surface) return
    // A detached portal belongs to its own native window, not global window.
    const owner = surface.ownerDocument.defaultView
    owner?.addEventListener('focus', focus)
    return () => owner?.removeEventListener('focus', focus)
  }, [enabled, surface, focus])
  return { data: enabled ? value?.key === key ? value.data : null : legacy,
    ref: setSurface, onFocus: focus }
}