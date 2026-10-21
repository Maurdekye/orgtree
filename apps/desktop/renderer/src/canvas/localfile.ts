import { desktop } from '../desktop'
import type { ToastFn } from '../types'
import type { MenuEntry } from './contextmenu'

export const localFileTitle = (path: string) => `Show in folder — ${path}`

/** Explicit normalized identity, never inferred from author-supplied text. */
export function localFileLinkAt(target: EventTarget | null, within?: Element): HTMLElement | null {
  const link = (target as Element | null)?.closest?.('a[data-local-path]') as HTMLElement | null
  return link?.getAttribute('data-local-path') && (!within || within.contains(link)) ? link : null
}

/** Signed tool-file actions, also used by prose links. The caller owns the
 * opening token and originating document; this function never opens a menu. */
export async function localFileMenu(anchor: Element, path: string,
  copy: (el: Element, text: string) => Promise<boolean>, toast?: ToastFn): Promise<MenuEntry[]> {
  let status: { ok: boolean; exists?: boolean; error?: string } | undefined
  try { status = await desktop()?.localFileStatus?.(path) } catch { /* disabled state below */ }
  if (!status?.ok) return [{ label: 'File actions unavailable', disabled: true,
    title: status?.error ?? 'File actions are unavailable in this window', onSelect: () => {} }]
  if (!status.exists) return [{ label: 'File no longer exists', disabled: true,
    title: 'This path no longer names a file', onSelect: () => {} }]
  const action = async (kind: 'open' | 'reveal') => {
    try {
      const result = kind === 'open' ? await desktop()?.openLocalFile?.(path) : await desktop()?.revealFile?.(path)
      toast?.([result?.ok ? (kind === 'open' ? 'Opened file' : 'Showed file in folder')
        : result?.error ?? 'File actions are unavailable in this window'])
    } catch (error) { toast?.([error instanceof Error ? error.message : String(error)]) }
  }
  const copied = (text: string, label: string) => {
    void copy(anchor, text).then(ok => toast?.([ok ? `Copied ${label}` : 'Could not copy — clipboard unavailable']))
  }
  return [
    { label: 'Open', onSelect: () => { void action('open') } },
    { label: 'Show in folder', onSelect: () => { void action('reveal') } }, 'sep',
    { label: 'Copy path', onSelect: () => copied(path, 'path') },
    { label: 'Copy file name', onSelect: () => copied(path.split(/[\\/]/).filter(Boolean).at(-1) || path, 'file name') },
  ]
}
