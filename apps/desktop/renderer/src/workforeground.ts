import type { WorkItemsPayload } from './types'

export const WORK_FOREGROUND_FORMAT = 'orgtree.work-foreground/v1'
const PAGE_SIZE = 100
type Page = {
  format: string
  archived: NonNullable<WorkItemsPayload['archived']>
  references: NonNullable<WorkItemsPayload['references']>
  next_cursor: string | null
  catalog: number[]
}
type First = WorkItemsPayload & Partial<Page>
type Read = (path: string, etag?: string) => Promise<Response>
type Legacy = (org: string, archived: boolean, backlogged: boolean) => Promise<WorkItemsPayload>

class Restart extends Error {}
class Compatibility extends Error {}

async function answer(response: Response): Promise<any> {
  const body = await response.json()
  if (response.status === 409 && body.kind === 'reset') throw new Restart()
  if (response.status === 409 && body.kind === 'compatibility') throw new Compatibility()
  if (!response.ok) throw new Error(body.detail || `Docket request failed (${response.status})`)
  if (body.format !== WORK_FOREGROUND_FORMAT) throw new Error('Invalid docket response format')
  return body
}

/** Full archive lists live only in the requesting view and its pending promise.
 * A failed/reset chain is never published or mixed with the legacy answer. */
export class ForegroundWorkReader {
  private cache = new Map<string, { etag: string; body: WorkItemsPayload }>()
  private pending = new Map<string, Promise<WorkItemsPayload>>()
  private generation = 0

  constructor(private read: Read, private legacy: Legacy) {}

  invalidate(): void {
    ++this.generation
    this.pending.clear()
    this.cache.clear()
  }

  get(org: string, archived = false, backlogged = false): Promise<WorkItemsPayload> {
    const key = JSON.stringify([org, archived, backlogged])
    const waiting = this.pending.get(key)
    if (waiting) return waiting
    const generation = this.generation
    const hit = archived ? undefined : this.cache.get(key)
    const task: Promise<WorkItemsPayload> = (async () => {
      // One retry absorbs an ordinary write. Continuing churn switches the
      // entire read to the coherent legacy projection, never individual pages.
      for (let attempt = 0; attempt < 2; ++attempt) {
        try {
          const path = `/api/orgs/${encodeURIComponent(org)}/work-items-foreground`
            + `?backlogged=${backlogged ? 1 : 0}&archive_limit=${archived ? PAGE_SIZE : 0}`
          const response = await this.read(path, hit?.etag)
          if (response.status === 304 && hit) return hit.body
          const first: First = await answer(response)
          let body: WorkItemsPayload = first
          if (archived) {
            if (!Array.isArray(first.archived) || !Array.isArray(first.catalog)
                || !Array.isArray(first.references) || !('next_cursor' in first)) {
              throw new Error('Archive start is incomplete')
            }
            const rows = [...first.archived]
            const references = [...first.references]
            const seen = new Set(rows.map(row => row.slug))
            const cursors = new Set<string>()
            let cursor = first.next_cursor
            while (cursor) {
              if (cursors.has(cursor)) throw new Error('Archive cursor did not advance')
              cursors.add(cursor)
              const page: Page = await answer(await this.read(
                `/api/orgs/${encodeURIComponent(org)}/work-items-archive-page`
                  + `?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`))
              if (JSON.stringify(page.catalog) !== JSON.stringify(first.catalog)) throw new Restart()
              if (!Array.isArray(page.archived) || !Array.isArray(page.references)
                  || !('next_cursor' in page)) throw new Error('Archive page is incomplete')
              for (const row of page.archived) {
                if (seen.has(row.slug)) throw new Restart()
                seen.add(row.slug)
                rows.push(row)
              }
              references.push(...page.references)
              cursor = page.next_cursor
            }
            // Transport cursor state is not retained by views. In particular,
            // no result combines rows from different attempts or catalogs.
            const { next_cursor: _cursor, catalog: _catalog, ...rest } = first
            body = { ...rest, archived: rows, references }
          }
          if (!archived && generation === this.generation && this.pending.get(key) === task) {
            const etag = response.headers.get('ETag')
            if (etag) this.cache.set(key, { etag, body })
            else this.cache.delete(key)
            while (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value!)
          }
          return body
        } catch (error) {
          if (error instanceof Compatibility) break
          if (error instanceof Restart) continue
          throw error
        }
      }
      return this.legacy(org, archived, backlogged)
    })().finally(() => {
      if (this.pending.get(key) === task) this.pending.delete(key)
    })
    this.pending.set(key, task)
    return task
  }
}
