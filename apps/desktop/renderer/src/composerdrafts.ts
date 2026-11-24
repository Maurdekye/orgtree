// composerdrafts.ts — what was typed in a message box, kept while the app runs.
//
// USER 2026-11-24 m15c78be3a1db: "when i leave and return to a chat it should
// retain the typed text and attachments". A message box that is given a key
// (canvas/mail.tsx MailReplyBox `draftKey`) writes its text and its attached
// files here on every change and starts from them when it mounts again: after
// another chat was opened, and after the panel itself was closed. Sending
// empties the box, which removes the entry.
//
// Kept for the app session only, in memory: a draft is not written to disk and
// does not outlive the window. The files are already uploaded when they are
// listed (the box uploads first), so an entry holds their paths, not bytes.

export interface ComposerDraft {
  text: string
  attached: { name: string; path: string; bytes: number }[]
}

const drafts = new Map<string, ComposerDraft>()

export const readComposerDraft = (key: string): ComposerDraft | null => drafts.get(key) ?? null

export function writeComposerDraft(key: string, draft: ComposerDraft): void {
  if (draft.text || draft.attached.length) drafts.set(key, { text: draft.text, attached: draft.attached })
  else drafts.delete(key)
}

/** A list kept beside a draft under the same key (the chats: which messages
 *  the next send answers). */
const lists = new Map<string, string[]>()
export const readDraftList = (key: string): string[] => lists.get(key) ?? []
export function writeDraftList(key: string, ids: readonly string[]): void {
  if (ids.length) lists.set(key, [...ids]); else lists.delete(key)
}

/** tests: every box starts empty */
export function resetComposerDrafts(): void { drafts.clear(); lists.clear() }
