import type { ReactNode } from 'react'
import { readReplySource } from '../api'
import { sourceDigest, selectionSnapshot, utf8Size } from '../replySelection'
import type { SourceIdentity, SourcePart } from '../replySelection'
import { captureSelectionComposer } from './selectioncomposer'
import { selectedSourceRange } from './selectionmap'
import { copyToClipboard, useContextMenu, useCopyFeedback } from './contextmenu'

export type SelectionSource = { org: string; target: SourceIdentity; part: SourcePart; text: string; format?: 'markdown' | 'plain' }

/** One source part per gesture. The wrapper adds no layout box. Rendered
 * selection is mapped before menus/focus, then the engine verifies its digest. */
export function ReplySelectionSurface({ source, children }: { source: SelectionSource; children: ReactNode }) {
  const menu = useContextMenu(); const feedback = useCopyFeedback()
  return <><div className="selection-source" data-selection-source="" style={{ display: 'contents' }} onContextMenuCapture={event => {
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
    const mapped = selectedSourceRange(anchor, captured.text, range, captured.format)
    const excerpt = mapped ? [...captured.text].slice(mapped.start, mapped.end).join('') : ''
    const why = !mapped ? 'This selection includes text that cannot be mapped exactly to one source part.'
      : !excerpt || utf8Size(excerpt) > 4096 ? 'Select a passage of at most 4,096 UTF-8 bytes.' : undefined
    const opening = menu.open(event, [
      { label: 'Reply to selection', disabled: Boolean(why), title: why ?? 'Stage this exact passage in the owning reply box', onSelect: () => {
        if (!mapped || why) return
        void sourceDigest(captured.text).then(async expected_sha256 => {
          const current = await readReplySource(captured.org, captured.target, captured.part, { expected_sha256 })
          const selector = { ...captured.part, projection: 'source-v1' as const, unit: 'unicode-scalar' as const,
            expected_sha256, start: mapped.start, end: mapped.end }
          stage({ target: captured.target, selection: selector, snapshot: selectionSnapshot(captured.text, selector, current.revision) })
        }).catch(error => feedback?.([error instanceof Error ? error.message : String(error)]))
      } },
      { label: 'Copy selection', onSelect: () => { void copyToClipboard(anchor, selectedText).then(ok => feedback?.([ok ? 'copied the selection' : 'clipboard unavailable'])) } },
    ], anchor, { textSelection: true })
    if (opening !== undefined) event.stopPropagation()
  }}>{children}</div>{menu.node}</>
}
