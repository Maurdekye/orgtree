import type { WorkItemsPayload } from './types'

export type WorkReference = NonNullable<WorkItemsPayload['references']>[number]
type Batch = (org: string, names: string[]) => Promise<WorkReference[]>

/** Bounded settled answers; subscribed callers own their answers independently.
 * In-flight promises deduplicate names and are never evicted out from under a
 * caller. Failed requests are not negative answers. */
export class WorkReferenceReader {
  private cache = new Map<string, WorkReference | null>()
  private pending = new Map<string, Promise<WorkReference | null>>()
  private running = 0
  private queue: (() => void)[] = []
  private generation = 0
  constructor(private batch: Batch, private capacity = 512) {}

  invalidate(): void { ++this.generation; this.cache.clear(); this.pending.clear() }

  private async slot<T>(job: () => Promise<T>): Promise<T> {
    if (this.running >= 4) await new Promise<void>(resolve => this.queue.push(resolve))
    else ++this.running
    try { return await job() }
    finally {
      const next = this.queue.shift()
      if (next) next()
      else --this.running
    }
  }

  async get(org: string, revision: string, names: string[]): Promise<Map<string, WorkReference | null>> {
    const unique = [...new Set(names)]
    const generation = this.generation
    const keyOf = (id: string) => JSON.stringify([org, revision, id])
    const wanted = unique.filter(id => !this.cache.has(keyOf(id)) && !this.pending.has(keyOf(id)))
    for (let n = 0; n < wanted.length; n += 128) {
      const group = wanted.slice(n, n + 128)
      const task = this.slot(async () => {
        const rows = await this.batch(org, group)
        const map = new Map(rows.map(row => [row.slug, row]))
        if (rows.some(row => !group.includes(row.slug))) throw new Error('Unrequested docket reference')
        return map
      })
      for (const id of group) {
        const key = keyOf(id)
        const pending: Promise<WorkReference | null> = task.then(rows => {
          const result = rows.get(id) ?? null
          if (generation === this.generation && this.pending.get(key) === pending) {
            this.cache.delete(key)
            this.cache.set(key, result)
            while (this.cache.size > this.capacity) this.cache.delete(this.cache.keys().next().value!)
          }
          return result
        }).finally(() => {
          if (this.pending.get(key) === pending) this.pending.delete(key)
        })
        this.pending.set(key, pending)
      }
    }
    return new Map(await Promise.all(unique.map(async id => {
      const key = keyOf(id)
      const pending = this.pending.get(key)
      if (pending) return [id, await pending] as const
      const value = this.cache.get(key)!
      this.cache.delete(key); this.cache.set(key, value)
      return [id, value] as const
    })))
  }
}
