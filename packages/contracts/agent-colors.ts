/** Appearance only; provider identity, model identity and status are unchanged. */
export type AgentColorSource = 'provider' | 'organization'
export const isAgentColorSource = (value: unknown): value is AgentColorSource => value === 'provider' || value === 'organization'
