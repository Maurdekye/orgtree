import { desktop } from './desktop'
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
  const action: ScratchFolderAction = () => {
    // Preserve the two-argument personal action for old-shell compatibility.
    const request = scope ? bridge.openAgentScratchFolder!(org, node, scope)
      : bridge.openAgentScratchFolder!(org, node)
    void request.then(result => {
      if (!result.ok) toast([`Could not open ${description}: ${result.error || 'unknown error'}`])
    }).catch((error: Error) => toast([`Could not open ${description}: ${error.message}`]))
  }
  if (bridge.agentScratchAgentsFileExists && bridge.openAgentScratchAgentsFile) {
    action.folderAgentsFile = {
      exists: async () => {
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
