import { desktop } from './desktop'
import type { ToastFn } from './types'

/** Capability is absent in a plain browser/phone and in an older shell. */
export function scratchFolderAction(org: string, node: string, toast: ToastFn): (() => void) | undefined {
  const bridge = desktop()
  if (!bridge?.openAgentScratchFolder) return undefined
  return () => {
    void bridge.openAgentScratchFolder!(org, node).then(result => {
      if (!result.ok) toast([`Could not open ${node}'s scratch folder: ${result.error || 'unknown error'}`])
    }).catch((error: Error) => toast([`Could not open ${node}'s scratch folder: ${error.message}`]))
  }
}
