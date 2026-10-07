export type EnterKeyBehavior = 'send' | 'newline'

/** Shared by message composers, never by single-line inputs or document editors. */
export function composerSendKey(e: {
  key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean
  repeat?: boolean; defaultPrevented?: boolean
  nativeEvent?: { isComposing?: boolean; keyCode?: number }
}, behavior: EnterKeyBehavior, mobile = false): boolean {
  if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.repeat || e.defaultPrevented
      || e.nativeEvent?.isComposing || e.nativeEvent?.keyCode === 229) return false
  // A deliberate shortcut still works with a hardware keyboard on mobile;
  // a soft-keyboard Enter keeps its existing newline behavior.
  return e.ctrlKey || e.metaKey || (behavior === 'send' && !mobile)
}

export function composerKeyHint(behavior: EnterKeyBehavior, mobile = false): string {
  return behavior === 'newline' || mobile
    ? 'Enter inserts a new line; Ctrl+Enter sends'
    : 'Enter sends; Shift+Enter inserts a new line'
}
