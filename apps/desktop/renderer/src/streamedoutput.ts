import type { ToolChip } from './types'
import { useStreamerMode } from './streamer'

/** NO PARTIAL STREAMED OUTPUT (USER 2026-11-04 ma9e5fa2baad4 + m1acf87406e09): while streamer mode is on, a half-written value
 *  cannot be pattern-matched (half of an sk-ant key is not yet a key), so nothing in progress is shown.
 *  - Responses and thinking are revealed one COMPLETE line at a time: the line being written stays hidden until its newline,
 *    and the whole line then appears with the usual masking. The end of a message is the row being retired for its
 *    transcript twin, which carries every line; no extra delay is added.
 *  - A tool input still being written (bash command, file write or edit, MCP arguments) is never shown; its written
 *    description is shown instead, else a neutral placeholder. Once complete the call renders normally, masked. */
export function wholeLines(text: string): string {
  const at = text.lastIndexOf('\n')
  return at < 0 ? '' : text.slice(0, at + 1)
}
/** `text` as it may be shown right now while it is still streaming. */
export function useStreamedLines(text: string): string {
  return useStreamerMode().enabled ? wholeLines(text) : text
}
const SHELL = /(^|__|\.)(bash|shell|powershell|pwsh|cmd|exec|command)/i
/** What a still-writing tool call may show: `null` = unchanged (streamer mode off or not writing). */
export function useWritingMask(t: Pick<ToolChip, 'name' | 'writing_started_at' | 'preview_input'>): { arg: string } | null {
  const on = useStreamerMode().enabled
  if (!on || !t.writing_started_at) return null
  const input = t.preview_input as { description?: unknown } | null | undefined
  const description = typeof input?.description === 'string' ? input.description.trim() : ''
  return { arg: description || (SHELL.test(t.name) ? 'writing command…' : 'writing input…') }
}
