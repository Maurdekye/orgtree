/** Shared app-feed ordering for renderer and Electron main. See step-6 §5. */
export type Stamp = { epoch: string; seq: number }
export type AppCursor = { app_uuid: string; incarnation: string; rev: number }
export type RegistryOrg = {
  org_id: number; slug: string; org_uuid: string; state: string
  unavailable_step: string | null; state_reason: string | null
  attempts: number; report_path: string | null
}
export type RegistryFrame = { type: 'registry_snapshot'; epoch: string; cursor: AppCursor
  records: { entity: 'registry_org'; id: string; body: RegistryOrg }[] }
export type SummaryBody = { name: string; created: string | null; net_slug: string | null
  nodes: number; live: number; cost_usd_total: number }
export type OrgStamp = Stamp & { org_id: number; org_uuid: string
  incarnation: string | null; rev: number | null }
export type SummaryFrame = OrgStamp & { type: 'org_summary'; body: SummaryBody | null }
export type NoticeFrame = OrgStamp & { type: 'org_notices'; notices: unknown[] | null }
export type Value = Stamp & { value: unknown }
export type Working = Stamp & { working: number }
export type Runtime = { values: Record<string, Value>; orgs: Record<string, Working> }
export type RuntimeFrame = Stamp & { type: 'app_runtime'; values?: Record<string, Value>
  orgs?: Record<string, Working | null> }
export type AppSnapshot = Stamp & { type: 'app_snapshot'; registry: RegistryFrame
  summaries: Record<string, SummaryFrame>; notices: Record<string, NoticeFrame>; runtime: Runtime }
export type AppFrame = AppSnapshot | RegistryFrame | SummaryFrame | NoticeFrame | RuntimeFrame
type Entry<T> = { seq: number; value: T | null }

export class AppFeedState {
  epoch: string | null = null
  registry: RegistryFrame | null = null
  readonly summaries = new Map<string, Entry<SummaryFrame>>()
  readonly notices = new Map<string, Entry<NoticeFrame>>()
  readonly values = new Map<string, Entry<Value>>()
  readonly working = new Map<string, Entry<Working>>()
  // A copy is a tombstone for ABSENT keys too. Without this floor a delayed
  // frame for an entry the client has never seen could resurrect old data.
  private floors = new Map<Map<string, unknown>, number>()

  clear() {
    this.epoch = null
    this.registry = null
    this.summaries.clear(); this.notices.clear(); this.values.clear(); this.working.clear()
    this.floors.clear()
  }

  private put<T>(map: Map<string, Entry<T>>, key: string, seq: number, value: T | null) {
    if (seq <= Math.max(map.get(key)?.seq ?? -1, this.floors.get(map) ?? -1)) return
    map.set(key, { seq, value })
  }

  private copy<T>(map: Map<string, Entry<T>>, incoming: Record<string, T>, seq: number) {
    if (seq <= (this.floors.get(map) ?? -1)) return
    for (const key of new Set([...map.keys(), ...Object.keys(incoming)])) {
      this.put(map, key, seq, incoming[key] ?? null)
    }
    this.floors.set(map, seq)
  }

  private registryFrame(frame: RegistryFrame): boolean {
    const current = this.registry?.cursor
    if (current && (current.app_uuid !== frame.cursor.app_uuid ||
        current.incarnation !== frame.cursor.incarnation)) {
      this.clear()
      return false
    }
    if (!current || frame.cursor.rev > current.rev) this.registry = frame
    return true
  }

  /** Only the first socket copy may establish/change epoch. HTTP never can.
   * false requests a reconnect after an impossible within-epoch app replacement. */
  apply(frame: AppFrame, firstSocketCopy = false): boolean {
    if (firstSocketCopy && frame.type === 'app_snapshot' && frame.epoch !== this.epoch) {
      this.clear()
      this.epoch = frame.epoch
    }
    if (frame.epoch !== this.epoch) return true
    switch (frame.type) {
      case 'registry_snapshot': return this.registryFrame(frame)
      case 'app_snapshot':
        if (!this.registryFrame(frame.registry)) return false
        this.copy(this.summaries, frame.summaries, frame.seq)
        this.copy(this.notices, frame.notices, frame.seq)
        this.copy(this.values, frame.runtime.values, frame.seq)
        this.copy(this.working, frame.runtime.orgs, frame.seq)
        break
      case 'org_summary':
        this.put(this.summaries, String(frame.org_id), frame.seq, frame.body === null ? null : frame)
        break
      case 'org_notices':
        this.put(this.notices, String(frame.org_id), frame.seq, frame.notices === null ? null : frame)
        break
      case 'app_runtime':
        for (const [key, value] of Object.entries(frame.values ?? {}))
          this.put(this.values, key, value.seq, value)
        for (const [key, value] of Object.entries(frame.orgs ?? {}))
          this.put(this.working, key, value?.seq ?? frame.seq, value)
        break
    }
    return true
  }

  summary(org: RegistryOrg): SummaryBody | null {
    const frame = this.summaries.get(String(org.org_id))?.value
    return org.state === 'active' && frame?.org_uuid === org.org_uuid ? frame.body : null
  }

  allNotices(): unknown[] {
    return (this.registry?.records ?? []).flatMap(({ id, body }) => {
      const frame = this.notices.get(id)?.value
      return body.state === 'active' && frame?.org_uuid === body.org_uuid ? frame.notices ?? [] : []
    })
  }

  value<T>(key: string): T | undefined {
    return this.values.get(key)?.value?.value as T | undefined
  }
}
