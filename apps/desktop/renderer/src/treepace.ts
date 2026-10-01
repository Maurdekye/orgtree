/** When App's org-tree read may run. One read in flight, a request during it
 * coalesces into exactly one trailing read (never dropped), and a read for
 * the SAME org starts no sooner than a gap after the previous one finished.
 *
 * Why the gap: every ws `changed`/`node_event` frame asks for the tree. At
 * N1000 (attempt 9) frames never stopped, so the trailing read started the
 * moment the last one landed. Four windows made 93 reads a minute, each a
 * 6.9 MB snapshot, and the engine spent ~14,000 s of request time per hour on
 * them. The gap grows with the last read's duration, so a slow (loaded)
 * engine is asked less often. A different org is never held back. */
export const TREE_MIN_GAP_MS = 1500
export const TREE_HIDDEN_GAP_MS = 10_000
export const TREE_MAX_GAP_MS = 15_000

type Last = { slug: string; at: number; took: number }

export function treeGap(last: Last | null, slug: string, now: number, hidden: boolean): number {
  if (!last || last.slug !== slug) return 0
  const gap = Math.min(TREE_MAX_GAP_MS,
    Math.max(hidden ? TREE_HIDDEN_GAP_MS : TREE_MIN_GAP_MS, 2 * last.took))
  return Math.max(0, last.at + gap - now)
}

export type TreeRequest = {
  /** A surface changed what it needs (a pile opened, a picker, a jump): the
   * user is waiting on this read, so it skips the gap (it still waits for a
   * read in flight). */
  urgent?: boolean
  /** Keep an already-queued request instead of replacing its org. */
  keep?: boolean
}

export class TreeReadPacer {
  private busy = false
  private pending: string | null = null
  private urgent = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private last: Last | null = null

  constructor(private run: (slug: string) => Promise<unknown>,
              private hidden: () => boolean = () => typeof document !== 'undefined' && document.hidden,
              private now: () => number = () => Date.now()) {}

  /** Ask for a read of `slug`; the latest org asked for wins. */
  request(slug: string, how: TreeRequest = {}): void {
    if (!(how.keep && this.pending)) this.pending = slug
    if (how.urgent) this.urgent = true
    if (this.busy) return
    this.schedule()
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
    this.urgent = false
  }

  private schedule(): void {
    const slug = this.pending
    if (!slug) return
    const wait = this.urgent ? 0 : treeGap(this.last, slug, this.now(), this.hidden())
    if (this.timer) {
      if (wait > 0) return
      clearTimeout(this.timer)
      this.timer = null
    }
    if (wait > 0) {
      this.timer = setTimeout(() => { this.timer = null; this.start() }, wait)
      return
    }
    this.start()
  }

  private start(): void {
    const slug = this.pending
    this.pending = null
    this.urgent = false
    if (!slug) return
    this.busy = true
    const started = this.now()
    const settle = () => {
      const at = this.now()
      this.busy = false
      this.last = { slug, at, took: at - started }
      this.schedule()
    }
    let reading: Promise<unknown>
    try { reading = this.run(slug) } catch (error) { reading = Promise.reject(error) }
    reading.then(settle, settle)
  }
}
