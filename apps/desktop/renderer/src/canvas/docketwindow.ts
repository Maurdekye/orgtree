import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DocketRowInfo, Section } from './docket'

export interface WindowSection extends Section {
  rows: DocketRowInfo[]
  folded: boolean
}

const ROW_HEIGHT = 48
const HEAD_HEIGHT = 30
const OVERSCAN = 192
const SMALL_LIST = 80
const rowKey = (slug: string) => 'row:' + slug
const headKey = (key: string) => 'head:' + key

/** One scroll window for all groups, including lists with thousands of heads.
 * Spacers stay inside the original section boxes so their sticky headings and
 * category controls keep their normal layout. Heights use layout pixels, not
 * screen rectangles: a pinned desk may be scaled or live in another window. */
export function useDocketWindow(sections: WindowSection[], reveal: string | null = null) {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 0, width: 0 })
  const heights = useRef(new Map<string, number>())
  const [revision, setRevision] = useState(0)
  const seenWidth = useRef(0)
  const windowed = sections.reduce((n, section) => n + section.rows.length + 1, 0) > SMALL_LIST
  const readViewport = useCallback(() => {
    if (!element) return
    const next = { top: element.scrollTop, height: element.clientHeight, width: element.clientWidth }
    setViewport(prev => prev.top === next.top && prev.height === next.height && prev.width === next.width ? prev : next)
  }, [element])
  const layout = useMemo(() => {
    let top = 0
    const offsets = new Map<string, { top: number; height: number }>()
    const groups = sections.map(section => {
      const start = top
      if (section.tone) top++ // the appended section's top border
      if (section.heading) {
        const height = heights.current.get(headKey(section.key)) ?? HEAD_HEIGHT
        offsets.set(headKey(section.key), { top, height })
        top += height
      }
      const rowsTop = top
      const starts = [top]
      if (!section.folded) for (const row of section.rows) {
        const key = rowKey(row.item.slug)
        const height = heights.current.get(key) ?? ROW_HEIGHT
        offsets.set(key, { top, height })
        top += height
        starts.push(top)
      }
      return { section, top: start, bottom: top, rowsTop, starts }
    })
    return { groups, offsets, total: top }
  }, [sections, revision])
  const currentLayout = useRef(layout)
  currentLayout.current = layout

  // Polls replace item objects, but measurements are keyed by identity. Prune
  // removed rows so visiting different orgs cannot accumulate their history.
  useLayoutEffect(() => {
    const keep = new Set(sections.flatMap(section => [headKey(section.key), ...section.rows.map(row => rowKey(row.item.slug))]))
    for (const key of heights.current.keys()) if (!keep.has(key)) heights.current.delete(key)
  }, [sections])

  useLayoutEffect(() => {
    if (!element || !windowed) return
    const measure = () => {
      let changed = false, above = 0
      const width = element.clientWidth
      if (width && seenWidth.current && width !== seenWidth.current) {
        heights.current.clear()
        changed = true
      }
      seenWidth.current = width
      for (const child of element.querySelectorAll<HTMLElement>('[data-docket-measure]')) {
        const key = child.dataset.docketMeasure!
        const height = child.offsetHeight
        if (!height || heights.current.get(key) === height) continue
        const old = currentLayout.current.offsets.get(key)
        if (old && old.top + old.height <= element.scrollTop) above += height - old.height
        heights.current.set(key, height)
        changed = true
      }
      if (above) element.scrollTop += above
      if (changed) setRevision(n => n + 1)
      readViewport()
    }
    measure()
    const Observer = element.ownerDocument.defaultView?.ResizeObserver ?? ResizeObserver
    const observer = new Observer(measure)
    observer.observe(element)
    for (const child of element.querySelectorAll('[data-docket-measure]')) observer.observe(child)
    return () => observer.disconnect()
  }, [element, windowed, layout, viewport.top, viewport.height, readViewport])

  const revealed = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!reveal) { revealed.current = null; return }
    if (!element || !windowed || revealed.current === reveal) return
    const row = layout.offsets.get(rowKey(reveal))
    if (!row) return // a reference may still be opening its category
    revealed.current = reveal
    if (row.top < element.scrollTop || row.top + row.height > element.scrollTop + element.clientHeight) {
      element.scrollTop = row.top
      readViewport()
    }
  }, [element, windowed, reveal, layout, readViewport])

  // Before the first measurement, mount a bounded first viewport, never the
  // entire list. A zero-height hidden panel remains bounded as well.
  const low = Math.max(0, viewport.top - OVERSCAN)
  const high = viewport.top + (viewport.height || 480) + OVERSCAN
  const groups = layout.groups.filter(group => !windowed || (group.bottom >= low && group.top <= high))
  const windows = groups.map(group => {
    let start = 0, end = group.section.rows.length
    if (windowed) {
      if (group.section.folded) end = 0
      else {
        while (start < end && group.starts[start + 1] < low) start++
        end = start
        while (end < group.section.rows.length && group.starts[end] <= high) end++
      }
    }
    return { ...group.section, visibleRows: group.section.rows.slice(start, end),
      before: windowed && !group.section.folded ? group.starts[start] - group.rowsTop : 0,
      after: windowed && !group.section.folded ? group.bottom - group.starts[end] : 0 }
  })
  return { ref: setElement, onScroll: readViewport, windows,
    before: windowed ? groups[0]?.top ?? 0 : 0,
    after: windowed ? layout.total - (groups.at(-1)?.bottom ?? 0) : 0,
    windowed }
}
