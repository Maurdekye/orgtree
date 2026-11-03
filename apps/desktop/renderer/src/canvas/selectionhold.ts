import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'

/** A TRANSCRIPT SELECTION SURVIVES ARRIVING EVENTS (user 2026-11-03 17:38:15Z
 *  md2483ac2412a: "when i have a transcript element selected to reply to it
 *  deselects when a new event arrives").
 *
 *  The highlighted passage is native DOM selection, and the transcript re-keys
 *  and rewrites rows as events arrive (a streaming row becomes its final row),
 *  which makes the browser drop a selection whose nodes were replaced. So the
 *  desk remembers the selection by ROW IDENTITY plus text offsets, never by DOM
 *  node, and puts it back after a render until the user deliberately changes it:
 *  a press anywhere else, a key, or a new selection. A row that is not loaded
 *  (paged out) keeps the memory; the selection returns when the row does.
 *  Focus and the composer are never touched: nothing is restored while an
 *  editable field has focus. One hook per desk, bound to ITS document, so a
 *  popped-out desk holds its own selection. */
type End = { key: string; offset: number }
type Held = { start: End; end: End }

const ROW = '[data-transcript-row]'
function keyOf(node: Node, root: Element): string | null {
  for (let el: Element | null = node.nodeType === 1 ? node as Element : node.parentElement; el && el !== root; el = el.parentElement) {
    const ev = el.getAttribute('data-reply-event')
    if (ev) return 'e:' + ev
    if (el.matches(ROW)) {
      const a = el.getAttribute('data-assistant-id')
      return a ? 'a:' + a : null
    }
  }
  return null
}
function find(root: Element, key: string): Element | null {
  const kind = key[0], id = key.slice(2)
  const all = [...root.querySelectorAll(kind === 'a' ? `${ROW}[data-assistant-id]` : '[data-reply-event]')]
    .filter(el => el.getAttribute(kind === 'a' ? 'data-assistant-id' : 'data-reply-event') === id)
  return all.find(el => !all.some(o => o !== el && el.contains(o))) ?? null
}
function offsetOf(el: Element, node: Node, off: number): number {
  const r = el.ownerDocument.createRange(); r.selectNodeContents(el); r.setEnd(node, off)
  return r.toString().length
}
function pointAt(el: Element, offset: number): [Node, number] | null {
  const walker = el.ownerDocument.createTreeWalker(el, 4)
  let n = 0, last: Text | null = null
  for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
    const len = (t.nodeValue ?? '').length; last = t
    if (offset <= n + len) return [t, offset - n]
    n += len
  }
  return last ? [last, (last.nodeValue ?? '').length] : null
}
const editable = (el: Element | null) => Boolean(el?.matches?.('input,textarea,select,[contenteditable="true"]'))

export function useTranscriptSelectionHold(scroller: RefObject<HTMLElement | null>) {
  const held = useHeld()
  // after EVERY render: this is exactly when the nodes may have been replaced
  useLayoutEffect(() => {
    const root = scroller.current, mem = held.current
    if (!root || !mem.value) return
    const doc = root.ownerDocument, sel = doc.getSelection()
    if (!sel || (sel.rangeCount > 0 && !sel.isCollapsed)) return
    if (editable(doc.activeElement)) return
    const a = find(root, mem.value.start.key), b = find(root, mem.value.end.key)
    if (!a || !b) return                       // paged out: kept, restored when it returns
    const s = pointAt(a, mem.value.start.offset), e = pointAt(b, mem.value.end.offset)
    if (!s || !e) return
    const range = doc.createRange(); range.setStart(...s); range.setEnd(...e)
    sel.removeAllRanges(); sel.addRange(range)
  })
  useLayoutEffect(() => {
    const root = scroller.current
    if (!root) return
    const doc = root.ownerDocument, mem = held.current
    const onChange = () => {
      const sel = doc.getSelection()
      if (!sel || sel.rangeCount !== 1 || sel.isCollapsed) return
      const r = sel.getRangeAt(0)
      if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return
      const ks = keyOf(r.startContainer, root), ke = keyOf(r.endContainer, root)
      if (!ks || !ke) return
      const a = find(root, ks), b = find(root, ke)
      if (!a || !b) return
      mem.value = { start: { key: ks, offset: offsetOf(a, r.startContainer, r.startOffset) },
        end: { key: ke, offset: offsetOf(b, r.endContainer, r.endOffset) } }
    }
    const release = (ev: Event) => {
      const t = ev.target as Element | null
      if (ev.type === 'pointerdown' || ev.type === 'mousedown') {
        if ((ev as MouseEvent).button === 2 || t?.closest?.('.ctxmenu')) return   // a right-click keeps its passage
      } else {
        const k = ev as KeyboardEvent
        if (k.ctrlKey || k.metaKey || ['Control', 'Shift', 'Alt', 'Meta'].includes(k.key)) return
      }
      mem.value = null
    }
    doc.addEventListener('selectionchange', onChange)
    doc.addEventListener('pointerdown', release, true)
    doc.addEventListener('mousedown', release, true)
    doc.addEventListener('keydown', release, true)
    return () => {
      doc.removeEventListener('selectionchange', onChange)
      doc.removeEventListener('pointerdown', release, true)
      doc.removeEventListener('mousedown', release, true)
      doc.removeEventListener('keydown', release, true)
    }
  }, [scroller.current])   // eslint-disable-line react-hooks/exhaustive-deps
}

function useHeld() { return useRef<{ value: Held | null }>({ value: null }) }
