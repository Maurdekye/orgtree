/** Display names for a registered account row, whose `provider` field is the
 *  backend's lowercase id.
 *
 *  ⚠ TWO NAMES, ON PURPOSE, AND THEY ARE NOT INTERCHANGEABLE. The row's
 *  HEADING names the harness the account signs into; the line under the bars
 *  names the SUBSCRIPTION the tier belongs to. For Anthropic those are
 *  different products — the harness is Claude Code, the subscription is Claude
 *  Max — so the same row legitimately reads `Claude Code · claude-0 · …` above
 *  `Claude max`.
 *
 *  This lived as a single map inside App.tsx and said `claude: 'Claude'`, which
 *  made a second signed-in account read as a different product from the primary
 *  section three rows above it (user report, screenshot 2026-09-11). Collapsing
 *  the two back into one map fixes one of those lines and breaks the other. */

export const REGISTRY_PROVIDER_NAME: Record<string, string> = {
  claude: 'Claude Code', openai: 'Codex', google: 'Antigravity',
}

export const REGISTRY_PLAN_NAME: Record<string, string> = {
  claude: 'Claude', openai: 'Codex', google: 'Antigravity',
}

/** The harness name for a row's heading. Unknown ids fall through to the raw
 *  backend id rather than to a guess — a provider this build has never heard
 *  of should look unfamiliar, not be relabelled as something it is not. */
export const registryProviderName = (provider: string): string =>
  REGISTRY_PROVIDER_NAME[provider] ?? provider

/** The subscription name for a row's plan line. Same fallback rule. */
export const registryPlanName = (provider: string): string =>
  REGISTRY_PLAN_NAME[provider] ?? provider
