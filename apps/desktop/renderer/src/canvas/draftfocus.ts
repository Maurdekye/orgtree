import type { CanvasNode } from './shared'

export interface DraftDeskFocus {
  id: string
  generation: number | undefined
  keyboard: HTMLElement | null
  selection: [number, number, 'forward' | 'backward' | 'none'] | null
}

function composer(root: HTMLElement, id: string): HTMLTextAreaElement | undefined {
  return [...root.querySelectorAll<HTMLTextAreaElement>('.desk-over textarea[data-first-use-chat]')]
    .find(el => el.dataset.firstUseChat === id)
}

/** Snapshot only an actual full desk, never a previously visited/closed desk. */
export function captureDraftDeskFocus(root: HTMLElement | null,
  node: CanvasNode | undefined): DraftDeskFocus | null {
  if (!root || !node?.tier) return null
  const input = composer(root, node.id)
  if (!input) return null
  const active = root.ownerDocument.activeElement as HTMLElement | null
  const scope = input.closest('.desk-control-scope')
  return {
    id: node.id, generation: node.generation,
    keyboard: active && scope?.contains(active) ? active : input,
    selection: [input.selectionStart, input.selectionEnd, input.selectionDirection],
  }
}

/** Called after the original desk is back, so a remounted composer works too. */
export function restoreDraftDeskKeyboard(root: HTMLElement | null,
  saved: DraftDeskFocus): boolean {
  if (!root) return false
  const input = composer(root, saved.id)
  if (!input) return false
  const target = saved.keyboard?.isConnected && root.contains(saved.keyboard)
    ? saved.keyboard : input
  target.focus({ preventScroll: true })
  if (target === input && saved.selection) input.setSelectionRange(...saved.selection)
  return true
}
