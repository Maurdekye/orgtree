import { desktop } from './desktop'
import type { ToastFn } from './types'

/** Capability is absent in a plain browser/phone and in an older shell. */
export function scratchFolderAction(org: string, node: string, toast: ToastFn,
  scope?: 'team' | 'shared'): (() => void) | undefined {
  const bridge = desktop()
  if (!bridge?.openAgentScratchFolder) return undefined
  if (scope && !bridge.scratchFolderScopes?.includes(scope)) return undefined
  const description = scope === 'shared' ? 'the shared scratch folder'
    : scope === 'team' ? `${node}'s team scratch folder` : `${node}'s scratch folder`
  return () => {
    // Preserve the two-argument personal action for old-shell compatibility.
    const request = scope ? bridge.openAgentScratchFolder!(org, node, scope)
      : bridge.openAgentScratchFolder!(org, node)
    void request.then(result => {
      if (!result.ok) toast([`Could not open ${description}: ${result.error || 'unknown error'}`])
    }).catch((error: Error) => toast([`Could not open ${description}: ${error.message}`]))
  }
}
