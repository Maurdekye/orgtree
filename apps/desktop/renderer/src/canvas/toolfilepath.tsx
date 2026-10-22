import { useCallback, useEffect, useRef, useState, type MouseEventHandler } from 'react'
import { desktop } from '../desktop'
import { localFileTitle, type LocalFileState } from './localfile'

/** Every harness shares ToolChip's explicit file_paths projection. `link`
 * means a native target can be resolved, not that a file exists there. */
export function ToolFilePath({ path, link, completed, onContextMenu }: {
  path: string; link: boolean; completed?: string | null
  onContextMenu: MouseEventHandler<HTMLAnchorElement>
}) {
  const [checked, setChecked] = useState<{ path: string; link: boolean; state: LocalFileState }>()
  const request = useRef(0)
  const refresh = useCallback(async () => {
    const id = ++request.current
    if (!link) return
    let state: LocalFileState = 'unavailable'
    try {
      const status = await desktop()?.localFileStatus?.(path)
      if (status?.ok && typeof status.exists === 'boolean') state = status.exists ? 'present' : 'missing'
    } catch { /* An unavailable path still has a copyable identity. */ }
    if (request.current === id) setChecked({ path, link, state })
  }, [path, link])
  useEffect(() => {
    void refresh()
    return () => { request.current++ }
  }, [refresh, completed])
  const state = !link ? 'unresolved'
    : checked?.path === path && checked.link === link ? checked.state : 'checking'
  const split = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1
  return <a className="local-file tool-file-link" href="#" data-local-path={path}
    data-local-relative={!link ? 'true' : undefined} data-local-file-state={state}
    aria-disabled={state !== 'present' ? true : undefined} title={localFileTitle(path, state)}
    onMouseEnter={() => { void refresh() }} onFocus={() => { void refresh() }}
    onClick={e => { e.preventDefault(); e.stopPropagation() }} onContextMenu={onContextMenu}>
    {state === 'present' ? path.split(/[\\/]/).filter(Boolean).at(-1) || path
      : <><span className="dim tool-file-directory">{path.slice(0, split)}</span>{path.slice(split)}</>}
  </a>
}
