/** UP / DOWN THROUGH THE SENT-MESSAGE HISTORY, shared by every composer that
 *  has it (the agent desk and the project desk), so they cannot drift apart.
 *
 *  THE DRAFT IS NEVER LOST (docket pressing-up-into-message-history-throws-
 *  away-the, USER 2026-10-30 08:14:27Z mdad6a41f1f3e: hitting Up one time too
 *  many "loses my in-progress typing message"). Entering history from a
 *  non-empty box sets the draft aside - text AND caret - in a persisted stash
 *  (composerhistory.writeStash), so it outlives the desk component: switching
 *  to another agent and back resumes the walk, and Down past the newest entry
 *  or Escape puts the draft back exactly as it was. Attachments and reply
 *  targets are not touched by a recall, so they stay where they are. Editing
 *  a recalled entry never rewrites the stored history; the edit is kept while
 *  you walk on (as a shell keeps an edited line) and only sending drops it.
 *
 *  Up and Down are history ONLY on the top / bottom VISUAL ROW of the text,
 *  with nothing selected (USER 2026-10-30 08:30:07Z m9a02035a079d, "Top visible
 *  row": Up walks up through the wrapped rows first, history only from the very
 *  top row). A newline and a soft wrap both start a row; anywhere else the
 *  arrow moves the caret, so a long message can never be replaced out from
 *  under you. Where there is no layout to measure (caretrow.ts) only the
 *  newline rule applies.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { caretRows } from './caretrow'
import { clearStash, readStash, recordStranded, writeStash } from './composerhistory'
import type { HistoryEntry } from './composerhistory'

interface Draft { text: string; start: number; end: number }

export interface HistoryNavHost {
  slug: string
  /** the agent or project whose history this box walks */
  id: string
  /** oldest first, as composerhistory.readHistory returns it */
  history: HistoryEntry[]
  /** what the box shows right now */
  text: string
  /** the composer's own setter: it also persists the draft key */
  setText: (value: string) => void
  field: () => HTMLTextAreaElement | null
}

const entryAt = (history: HistoryEntry[], at: number): HistoryEntry | undefined =>
  history[history.length - 1 - at]

/** Where a walk that was under way when the desk went away resumes. The box
 *  still holds what was on screen (the draft key stores it), the stash holds
 *  the draft that was set aside. A stash that no longer makes sense (an empty
 *  history) is not dropped: its text goes into the history as a message that
 *  was never sent, so even that case keeps what was typed. */
function resume(slug: string, id: string, history: HistoryEntry[], shown: string): { at: number | null; draft: Draft | null } {
  const saved = readStash(slug, id)
  if (!saved) return { at: null, draft: null }
  if (!history.length) {
    recordStranded(slug, id, saved.text)
    clearStash(slug, id)
    return { at: null, draft: null }
  }
  const last = history.length - 1
  let at = Math.min(saved.at, last)
  // an entry recorded since (a stranded draft is appended) shifts positions:
  // prefer the one the box is actually showing
  if (entryAt(history, at)?.text !== shown) {
    for (let p = 0; p <= last; p++) if (entryAt(history, p)?.text === shown) { at = p; break }
  }
  return { at, draft: { text: saved.text, start: saved.start, end: saved.end } }
}

export function useHistoryNav({ slug, id, history, text, setText, field }: HistoryNavHost) {
  const first = useRef<ReturnType<typeof resume> | null>(null)
  if (!first.current) first.current = resume(slug, id, history, text)
  const [at, setAtState] = useState<number | null>(first.current.at)
  const atRef = useRef(at)
  /** the draft that was in the box when history was entered */
  const draft = useRef<Draft | null>(first.current.draft)
  /** an entry you edited while it was on screen, by position */
  const edits = useRef(new Map<number, string>())
  /** where the caret goes once React has put the new text in the textarea */
  const caret = useRef<'end' | [number, number] | null>(null)
  const setAt = (next: number | null) => { atRef.current = next; setAtState(next) }

  // The textarea only holds the new text once React has committed it, so the
  // caret is placed here and not in the key handler (which would move it within
  // the OLD value).
  useLayoutEffect(() => {
    const want = caret.current
    if (!want) return
    caret.current = null
    const el = field()
    if (!el) return
    const length = el.value.length
    el.selectionStart = want === 'end' ? length : Math.min(want[0], length)
    el.selectionEnd = want === 'end' ? length : Math.min(want[1], length)
  }, [text, at]) // eslint-disable-line react-hooks/exhaustive-deps

  const persist = (position: number) => {
    const set = draft.current
    if (set) writeStash(slug, id, { ...set, at: position })
  }
  /** keep what is on screen if it is not the stored entry, before leaving it */
  const keepEdit = (position: number) => {
    if (text !== entryAt(history, position)?.text) edits.current.set(position, text)
    else edits.current.delete(position)
  }
  const show = (position: number) => {
    setAt(position)
    caret.current = 'end'
    setText(edits.current.get(position) ?? entryAt(history, position)?.text ?? '')
    persist(position)
  }

  /** Up: one step further back. False when nothing moved. */
  const back = () => {
    if (!history.length) return false
    const from = atRef.current
    const next = from === null ? 0 : Math.min(from + 1, history.length - 1)
    if (next === from) return false
    if (from === null) {
      const el = field()
      draft.current = { text, start: el?.selectionStart ?? text.length, end: el?.selectionEnd ?? text.length }
    } else keepEdit(from)
    show(next)
    return true
  }
  /** Back to the draft that was set aside. */
  const restore = () => {
    const from = atRef.current
    if (from === null) return false
    keepEdit(from)
    const set = draft.current
    draft.current = null
    clearStash(slug, id)
    setAt(null)
    caret.current = set ? [set.start, set.end] : 'end'
    setText(set?.text ?? '')
    return true
  }
  /** Down: one step forward, and past the newest entry back to the draft. */
  const forward = () => {
    const from = atRef.current
    if (from === null) return false
    if (from === 0) return restore()
    keepEdit(from)
    show(from - 1)
    return true
  }
  /** The message went out: the walk, the stash and any edits are finished. */
  const reset = () => {
    setAt(null)
    draft.current = null
    edits.current.clear()
    clearStash(slug, id)
  }

  /** The textarea's onKeyDown. True when the key was history's. */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false
    if (e.key === 'Escape') {
      // takes the key before the desk's Escape-cancels-reply, which skips a
      // key that is already defaultPrevented
      if (e.nativeEvent.isComposing || !restore()) return false
      e.preventDefault()
      e.stopPropagation()
      return true
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return false
    const el = e.currentTarget
    const from = el.selectionStart ?? 0
    const to = el.selectionEnd ?? 0
    const up = e.key === 'ArrowUp'
    if (from !== to) return false
    // a newline is a row boundary whatever the layout; a soft wrap is one only
    // the layout knows, and only when there is history to enter or leave
    if (up ? el.value.slice(0, from).includes('\n') : el.value.slice(to).includes('\n')) return false
    if (up ? history.length : atRef.current !== null) {
      const rows = caretRows(el, from)
      if (rows && !(up ? rows.first : rows.last)) return false
    }
    if (!(up ? back() : forward())) return false
    e.preventDefault()
    return true
  }

  const entry = at === null ? null : entryAt(history, at) ?? null
  return {
    at,
    /** the entry the box is showing from, null when it shows your own text */
    entry,
    /** a draft is set aside and can be brought back */
    stashed: at !== null && !!draft.current?.text,
    back, forward, restore, reset, onKeyDown,
  }
}
