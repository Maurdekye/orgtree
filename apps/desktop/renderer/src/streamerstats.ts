/* streamerstats.ts - the stall recorder's read of the streamer's scan counters (spec ui-stall-tooling-spec rev 1.3, R8b).
   streamer-boundary.ts exports `streamerScanStats()` once the freeze fix (@streamer-fix-opus) lands; until then, and in any
   build without it, this answers null and the stall record says `streamer: { on: false }`. A namespace read, so a missing
   export is not an import error whichever branch lands first. */
import * as boundary from './streamer-boundary'
import type { StreamerStatsLike } from './stallwatch'

export function readStreamerStats(): StreamerStatsLike | null {
  try {
    const read = (boundary as unknown as { streamerScanStats?: () => StreamerStatsLike }).streamerScanStats
    return typeof read === 'function' ? read() : null
  } catch { return null }
}
