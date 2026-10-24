import { createContext, useContext, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { listenSelectionLocation } from './selectionlocation'
import { verifySelectionProjection } from './selectionprojection'
import { selectionSnapshot, utf8Size } from '../replySelection'
import type { SourceIdentity, SourcePart } from '../replySelection'
import { captureSelectionComposer } from './selectioncomposer'
import { selectedSourceRange } from './selectionmap'
import { textSelectionMenuEntries, useContextMenu, useCopyFeedback } from './contextmenu'

export type SelectionSource = { org: string; target: SourceIdentity; part: SourcePart; text: string; format?: 'markdown' | 'plain'; offset?: number; shown?: string; partial?:boolean }

const SelectionTextContext=createContext<SelectionSource|null>(null)
/** Typed mail fields may expose only the canonical body's visible prefix. */
export function ReplySelectionText({text,children}:{text:string;children:ReactNode}){
  const source=useContext(SelectionTextContext)
  return source && text && source.text.startsWith(text) ? <ReplySelectionSurface source={{...source,shown:text,offset:0}}>{children}</ReplySelectionSurface> : children
}

/** One source part per gesture. The wrapper adds no layout box. Rendered
 * selection is mapped before menus/focus, then the engine verifies its digest. */
export function ReplySelectionSurface({ source, children }: { source: SelectionSource; children: ReactNode }) {
  const menu = useContextMenu(); const feedback = useCopyFeedback()
  const root=useRef<HTMLDivElement>(null)
  useLayoutEffect(()=>root.current ? listenSelectionLocation(root.current,source) : undefined,[source])
  return <SelectionTextContext.Provider value={source}><div ref={root} className="selection-source" data-selection-source="" style={{ display: 'contents' }} onContextMenuCapture={event => {
    const anchor = event.currentTarget
    if ((event.target as Element)?.closest?.('input,textarea,select,[contenteditable="true"]')) return
    const selection = anchor.ownerDocument.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return
    const range = selection.getRangeAt(0).cloneRange()
    const owner = (node: Node) => (node.nodeType === 1 ? node as Element : node.parentElement)?.closest('[data-selection-source]')
    if (owner(range.startContainer) !== anchor || owner(range.endContainer) !== anchor) return
    const stage = captureSelectionComposer(anchor)
    if (!stage) return
    const selectedText = selection.toString()
    const captured = source
    const tooLarge=utf8Size(captured.text)>1024*1024
    const local = tooLarge ? null : selectedSourceRange(anchor, captured.shown ?? captured.text, range, captured.format)
    const mapped = local ? { start: local.start + (captured.offset ?? 0), end: local.end + (captured.offset ?? 0) } : null
    const excerpt = mapped ? [...captured.text].slice(mapped.start, mapped.end).join('') : ''
    const why = tooLarge ? 'This source part exceeds 1 MiB; choose a smaller retained field or JSON scalar.' : !mapped ? 'This selection includes text that cannot be mapped exactly to one source part.'
      : !excerpt || utf8Size(excerpt) > 4096 ? 'Select a passage of at most 4,096 UTF-8 bytes.' : undefined
    const opening = menu.open(event, [
      { label: 'Reply to selection', disabled: Boolean(why), title: why ?? 'Stage this exact passage in the owning reply box', onSelect: () => {
        if (!mapped || why) return
        void verifySelectionProjection(captured).then(current => {
          const expected_sha256=current.sha256
          const selector = { ...captured.part, projection: 'source-v1' as const, unit: 'unicode-scalar' as const,
            expected_sha256, start: mapped.start, end: mapped.end }
          stage({ target: captured.target, selection: selector, snapshot: selectionSnapshot(captured.text, selector, current.revision) })
        }).catch(error => feedback?.([error instanceof Error ? error.message : String(error)]))
      } },
      ...textSelectionMenuEntries(anchor, selectedText, feedback),
    ], anchor, { textSelection: true })
    if (opening !== undefined) event.stopPropagation()
  }}>{children}</div>{menu.node}</SelectionTextContext.Provider>
}
