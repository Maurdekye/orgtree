import { desktop } from '../desktop'
import type { ToastFn } from '../types'
import type { MenuEntry } from './contextmenu'

export type LocalFileState = 'checking' | 'present' | 'missing' | 'unavailable' | 'unresolved'
export const localFileTitle = (path: string, state: LocalFileState = 'present') =>
  `${state === 'present' ? 'Show in folder' : state === 'missing' ? 'File not found'
    : state === 'unresolved' ? 'Unresolved path' : state === 'checking' ? 'Checking file' : 'File status unavailable'} — ${path}`

/** Explicit normalized identity, never inferred from author-supplied text. */
export function localFileLinkAt(target: EventTarget | null, within?: Element): HTMLElement | null {
  const link = (target as Element | null)?.closest?.('a[data-local-path]') as HTMLElement | null
  return link?.getAttribute('data-local-path') && (!within || within.contains(link)) ? link : null
}

/** Signed tool-file actions, also used by prose links. The caller owns the
 * opening token and originating document; this function never opens a menu. */
export async function localFileMenu(anchor: Element, path: string,
  copy: (el: Element, text: string) => Promise<boolean>, toast?: ToastFn): Promise<MenuEntry[]> {
  // Clipboard actions depend on the attempted path, never on its existence or
  // the native bridge. A relative path without a cwd has no safe native target.
  const relative = anchor.getAttribute('data-local-relative') === 'true'
  let status: { ok: boolean; exists?: boolean; error?: string } | undefined
  if (!relative) try { status = await desktop()?.localFileStatus?.(path) } catch { /* disabled state below */ }
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
  const copies: MenuEntry[] = [
    { label: 'Copy path', onSelect: () => copied(path, 'path') },
    { label: 'Copy file name', onSelect: () => copied(path.split(/[\\/]/).filter(Boolean).at(-1) || path, 'file name') },
  ]
  if (relative || !status?.ok || status.exists !== true) return [{
    label: relative ? 'Unresolved path' : status?.ok && status.exists === false ? 'File no longer exists' : 'File actions unavailable',
    disabled: true, title: `${relative ? 'No working directory was supplied' : status?.error ?? 'This path cannot be opened'} — ${path}`,
    onSelect: () => {},
  }, 'sep', ...copies]
  return [
    { label: 'Open', onSelect: () => { void action('open') } },
    { label: 'Show in folder', onSelect: () => { void action('reveal') } }, 'sep',
    ...copies,
  ]
}
