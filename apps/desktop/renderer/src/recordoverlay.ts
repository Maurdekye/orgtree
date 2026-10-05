import type { FeedCursor } from './recordfeed'

export interface RuntimeValue { epoch: string; seq: number; [field: string]: unknown }
export interface AgentRuntime extends Pick<FeedCursor, 'org_uuid' | 'incarnation'> {
  type: 'agent_runtime'; epoch: string; seq: number; full: boolean
  agents: { [id: string]: RuntimeValue }
  net?: RuntimeValue
}
export type RuntimeTable = ReadonlyMap<string, Readonly<RuntimeValue>>
export const agentRuntimeFields = new Set(`busy waiting queued_for_slot responding phase ran_as
  codex_route queued proc_warm proc_live proc_relaunch proc_relaunch_reason
  proc_paused proc_control_enabled proc_control_action proc_control_reason
  mcp_tool_count mcp_tool_count_provider mcp_tool_count_source mcp_tool_count_reason
  mcp_readiness_waiting mcp_readiness_state mcp_readiness_reason
  tasks bg_tasks last_error activity cache_forecast ask_linger_visible context_window mail_stages`.split(/\s+/))

/** The first FULL copy on a socket establishes that socket's host epoch.
 * HTTP copies can update an established epoch, never establish a different
 * one. Values and removals are ordered separately from database revisions.
 */
export class RecordOverlay {
  readonly epoch: string | null
  readonly values: RuntimeTable
  constructor(readonly identity: Pick<FeedCursor, 'org_uuid' | 'incarnation'>,
    epoch: string | null = null, values: RuntimeTable = new Map(), readonly floor = 0,
    readonly net: Readonly<RuntimeValue> | null = null) {
    this.epoch = epoch; this.values = values
  }

  receive(frame: AgentRuntime, firstSocketCopy = false): RecordOverlay {
    if (frame.org_uuid !== this.identity.org_uuid || frame.incarnation !== this.identity.incarnation)
      return this
    if (typeof frame.epoch !== 'string' || !frame.epoch || !Number.isSafeInteger(frame.seq)
        || frame.seq <= 0 || typeof frame.full !== 'boolean' || !frame.agents
        || typeof frame.agents !== 'object' || Array.isArray(frame.agents))
      throw new Error('Invalid runtime frame')
    const establish = firstSocketCopy && frame.full
    if ((!this.epoch || frame.epoch !== this.epoch) && !establish) return this
    const replaced = this.epoch !== frame.epoch
    const values = new Map(replaced ? [] : this.values)
    let floor = replaced ? 0 : this.floor
    let net = replaced ? null : this.net
    if (frame.net) {
      const value = frame.net
      if (value.epoch !== frame.epoch || !Number.isSafeInteger(value.seq)
          || value.seq <= 0 || value.seq > frame.seq || !Array.isArray(value.hubs))
        throw new Error('Invalid hub runtime value')
      const ids = new Set<string>()
      const hubs = value.hubs.map((hub: unknown) => {
        if (!hub || typeof hub !== 'object' || Array.isArray(hub)) throw new Error('Invalid runtime hub')
        const source = hub as Record<string, unknown>
        if (typeof source.id !== 'string' || ids.has(source.id) || typeof source.address !== 'string')
          throw new Error('Invalid runtime hub identity')
        ids.add(source.id)
        const safe: Record<string, unknown> = {}
        for (const key of ['id', 'address', 'name', 'connected', 'hidden', 'last_ok', 'error', 'roster'])
          if (Object.hasOwn(source, key)) safe[key] = structuredClone(source[key])
        return safe
      })
      if (value.seq > (net?.seq ?? floor)) net = { epoch: value.epoch, seq: value.seq, hubs }
    } else if (frame.full && (!net || net.seq <= frame.seq)) net = null
    for (const [id, value] of Object.entries(frame.agents)) {
      if (!id || !value || value.epoch !== frame.epoch || !Number.isSafeInteger(value.seq)
          || value.seq <= 0 || value.seq > frame.seq)
        throw new Error('Invalid runtime value')
      const previous = values.get(id)
      if ((previous && value.seq <= previous.seq) || (!previous && value.seq <= floor)) continue
      const safe: RuntimeValue = { epoch: value.epoch, seq: value.seq }
      for (const field of agentRuntimeFields) if (Object.hasOwn(value, field)) safe[field] = structuredClone(value[field])
      values.set(id, safe)
    }
    if (frame.full && frame.seq >= floor) {
      for (const [id, value] of values) {
        if (!Object.hasOwn(frame.agents, id) && value.seq <= frame.seq) values.delete(id)
      }
      floor = frame.seq
    }
    return new RecordOverlay(this.identity, frame.epoch, values, floor, net)
  }
}
