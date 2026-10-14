/** Shared shortcut classification for transient toasts and durable history.
 *  Callers decide whether an action exists and consume the event themselves. */
export type HistoryDirection = 'undo' | 'redo'

const EDITOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .monaco-editor, .cm-editor, .CodeMirror'
function editing(target: EventTarget | null): boolean {
  const node = target as Node | null
  const element = node?.nodeType === 1 ? node as Element : node?.parentElement
  return !!element?.closest(EDITOR)
}

export function historyShortcut(event: KeyboardEvent, doc: Document): HistoryDirection | null {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey
    || !(event.ctrlKey || event.metaKey)) return null
  if (event.composedPath().some(editing) || editing(doc.activeElement)) return null
  const key = event.key.toLowerCase()
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (key === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey) return 'redo'
  return null
}
