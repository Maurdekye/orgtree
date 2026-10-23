import type { EventSourceRef } from './eventReply'

export type SourceIdentity = string | { kind: 'mail' | 'document' | 'presentation'; org: string; id: string }
  | { kind: 'work_item'; org: string; slug: string }
  | { source_event_ref: EventSourceRef; mail_id?: string }
export type SourcePart = { part: string; tool_id?: string; pointer?: string; role?: 'key' | 'value'; entry?: number }
export type SelectionSelector = SourcePart & { projection: 'source-v1'; unit: 'unicode-scalar'; expected_sha256: string; start: number; end: number }
export type SelectionSnapshot = { version: 1; selector: SelectionSelector; revision: unknown;
  excerpt: string; prefix: string; suffix: string; state: 'exact' }
export type SelectionTarget = { target: SourceIdentity; selection: SelectionSelector }
export type SelectionDraft = SelectionTarget & { snapshot: SelectionSnapshot }
export type SourceWindow = { text: string; sha256: string; revision: unknown; projection: 'source-v1'; unit: 'unicode-scalar';
  offset: number; next_offset: number | null; total_scalars: number; location?: { state: 'exact' | 'relocated' | 'changed' | 'unavailable'; start?: number; end?: number } }

export const utf8Size = (text: string) => new TextEncoder().encode(text).length
export function selectionKey(target: SelectionTarget): string { return JSON.stringify([target.target, target.selection]) }
export function appendSelection(current: SelectionDraft[], next: SelectionDraft): SelectionDraft[] {
  if (current.some(item => selectionKey(item) === selectionKey(next))) return current
  if (current.length >= 8) throw Error('A reply can contain at most 8 selected passages.')
  const result = [...current, next]
  if (utf8Size(JSON.stringify(result.map(item => item.snapshot))) > 48 * 1024) throw Error('Selection metadata exceeds 48 KiB; split this reply.')
  return result
}
export function contextBytes(text: string, side: 'prefix' | 'suffix'): string {
  const chars = [...text]; if (side === 'prefix') chars.reverse()
  let out = ''; let bytes = 0
  for (const char of chars) { bytes += utf8Size(char); if (bytes > 256) break; out += char }
  return side === 'prefix' ? [...out].reverse().join('') : out
}
export async function sourceDigest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
}
export function selectionSnapshot(text: string, selector: SelectionSelector, revision: unknown): SelectionSnapshot {
  const chars = [...text]; const excerpt = chars.slice(selector.start, selector.end).join('')
  if (selector.start < 0 || selector.end <= selector.start || selector.end > chars.length || utf8Size(excerpt) > 4096) {
    throw Error('Select a nonempty passage of at most 4,096 UTF-8 bytes from one source part.')
  }
  return { version: 1, selector, revision, excerpt,
    prefix: contextBytes(chars.slice(0, selector.start).join(''), 'prefix'), suffix: contextBytes(chars.slice(selector.end).join(''), 'suffix'), state: 'exact' }
}
