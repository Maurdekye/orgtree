import type { ActiveAgentOrgPreferences } from '../../../../packages/contracts'
import type { NativePreferences } from './desktop'

export type ActiveAgentSurface = keyof ActiveAgentOrgPreferences
type LegacyActiveAgentPreference = 'activeAgentsOnly' | 'quickChatActiveAgentsOnly' | 'attentionDeskActiveAgentsOnly'

const legacyPreference: Record<ActiveAgentSurface, LegacyActiveAgentPreference> = {
  agents: 'activeAgentsOnly',
  quickChat: 'quickChatActiveAgentsOnly',
  attentionDesk: 'attentionDeskActiveAgentsOnly',
}

export function activeAgentsOnlyForOrg(
  prefs: Pick<NativePreferences, 'activeAgentsOnly' | 'quickChatActiveAgentsOnly' | 'attentionDeskActiveAgentsOnly' | 'activeAgentsByOrg'> | null | undefined,
  org: string | null | undefined,
  surface: ActiveAgentSurface,
): boolean {
  const scoped = org ? prefs?.activeAgentsByOrg?.[org]?.[surface] : undefined
  return scoped ?? prefs?.[legacyPreference[surface]] ?? false
}

export function mergeActiveAgentsPreference(
  prefs: NativePreferences,
  org: string,
  surface: ActiveAgentSurface,
  enabled: boolean,
): NativePreferences {
  return {
    ...prefs,
    activeAgentsByOrg: {
      ...prefs.activeAgentsByOrg,
      [org]: { ...prefs.activeAgentsByOrg?.[org], [surface]: enabled },
    },
  }
}

export function activeAgentsPreferencePatch(
  org: string,
  surface: ActiveAgentSurface,
  enabled: boolean,
): Pick<NativePreferences, 'activeAgentsByOrg'> {
  return { activeAgentsByOrg: { [org]: { [surface]: enabled } } }
}
