import { useEffect, useState } from 'react'
import type { RuntimeSettingsPayload } from '../types'
import { SetRow } from './settingskit'

export function AgentBuildCacheSetting({ runtime, busy, onSave }: {
  runtime: RuntimeSettingsPayload | null; busy: boolean; onSave: (folder: string) => void
}) {
  const stored = runtime?.agent_build_cache_folder ?? ''
  const [folder, setFolder] = useState(stored)
  useEffect(() => setFolder(stored), [stored])
  const disabled = !runtime || busy || folder.trim() === stored
  const save = () => { if (!disabled) onSave(folder.trim()) }
  return <SetRow label="Agent build cache folder"
    hint="Rust build output goes into a separate folder for each organization and agent. Empty = off. Applies when an agent's CLI starts; existing processes keep their current folder.">
    <input type="text" aria-label="Agent build cache folder" value={folder}
      placeholder="E:\orgtree-build-cache" disabled={!runtime || busy}
      onChange={e => setFolder(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); save() } }} />
    <button type="button" disabled={disabled} onClick={save}>Save</button>
  </SetRow>
}
