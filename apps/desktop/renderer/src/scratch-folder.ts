import { desktop } from './desktop'
import { remoteHere } from './remotehere'
import { filesNeedUpdate, filesUpdateText, openRemoteFiles } from './remotefiles'
import type { ToastFn } from './types'

export type ScratchFolderAction = (() => void) & {
  folderAgentsFile?: { exists: () => Promise<boolean>; edit: () => void }
}

/** Capability is absent in a plain browser/phone and in an older shell. */
export function scratchFolderAction(org: string, node: string, toast: ToastFn,
  scope?: 'team' | 'shared'): ScratchFolderAction | undefined {
  const bridge = desktop()
  if (!bridge?.openAgentScratchFolder) return undefined
  if (scope && !bridge.scratchFolderScopes?.includes(scope)) return undefined
  const description = scope === 'shared' ? 'the shared scratch folder'
    : scope === 'team' ? `${node}'s team scratch folder` : `${node}'s scratch folder`
  // An organization on a remote engine keeps its folders on that engine's computer, where this
  // computer's file manager cannot go. The entry opens the Files panel instead (remotefiles.ts):
  // the folder is listed there, with download and upload. No AGENTS.md here is offered. An
  // engine too old to list a folder is told so here by its version, or by the panel when its answer shows it.
  if (remoteHere()) return () => {
    // asked at the click: the connection may have learned the engine's version since this entry was made
    const remote = remoteHere()
    if (remote && filesNeedUpdate(remote.version)) toast([filesUpdateText(remote.name, remote.version)])
    else openRemoteFiles({ org, node, ...(scope ? { scope } : {}), title: description })
  }
  const action: ScratchFolderAction = () => {
    // Preserve the two-argument personal action for old-shell compatibility.
    const request = scope ? bridge.openAgentScratchFolder!(org, node, scope)
      : bridge.openAgentScratchFolder!(org, node)
    void request.then(result => {
      if (!result.ok) toast([`Could not open ${description}: ${result.error || 'unknown error'}`])
    }).catch((error: Error) => toast([`Could not open ${description}: ${error.message}`]))
  }
  if (bridge.openAgentScratchAgentsFile) {
    action.folderAgentsFile = {
      exists: async () => {
        if (!bridge.agentScratchAgentsFileExists) return false
        const result = scope
          ? await bridge.agentScratchAgentsFileExists!(org, node, scope)
          : await bridge.agentScratchAgentsFileExists!(org, node)
        return result.ok && result.exists === true
      },
      edit: () => {
        const request = scope ? bridge.openAgentScratchAgentsFile!(org, node, scope)
          : bridge.openAgentScratchAgentsFile!(org, node)
        void request.then(result => {
          if (!result.ok) toast([`Could not open ${description}/AGENTS.md: ${result.error || 'unknown error'}`])
        }).catch((error: Error) => toast([`Could not open ${description}/AGENTS.md: ${error.message}`]))
      },
    }
  }
  return action
}
