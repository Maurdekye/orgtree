// main/changelog-launch.ts — the Changelog after an update (docket
// changelog-window-one-row-per-version-pinnable-po, USER 2026-10-24 22:13:55Z:
// "opens automatically after an update on first launch (not on fresh install)").
//
// The desktop keeps the last version it ran in changelog-seen.json, beside
// update-log.json. At startup:
// - no version on record and no earlier run is a fresh install: this version
//   is recorded and nothing opens. "An earlier run" is update-log.json holding
//   entries from before this run's own 'startup' line, which every launch of
//   every build since the log existed has written.
// - a recorded version older than this one, or none recorded after earlier
//   runs (an update from 4.4.4 or before, which kept no record), is the first
//   launch after an update. The first window that asks is told, once, and only
//   then is this version recorded: a launch that never showed a window (one
//   started in the background, say) keeps it for the first window that does.
//   Whether the window opens the panel is its own setting (Open changelog
//   after updates); it takes the news either way.
// - this version again, or an older one (a downgrade), opens nothing and
//   records this one.
import fs from 'node:fs'
import path from 'node:path'
import type { ChangelogAfterUpdate } from '../../../packages/contracts/index'
import { compareUpdateVersions } from './updater'

export const CHANGELOG_SEEN_FILE = 'changelog-seen.json'

/** Pure: the decision above, from what is on record. */
export function changelogAfterLaunch(seen: string | null, running: string,
  earlierRun: boolean): ChangelogAfterUpdate | null {
  if (seen === null) return earlierRun ? { from: null, to: running } : null
  const order = compareUpdateVersions(running, seen)
  return order !== null && order > 0 ? { from: seen, to: running } : null
}

export class ChangelogLaunch {
  private pending: ChangelogAfterUpdate | null
  constructor(private readonly file: string, private readonly running: string, earlierRun: boolean) {
    const seen = readSeen(file)
    this.pending = changelogAfterLaunch(seen, running, earlierRun)
    if (!this.pending && seen !== running) writeSeen(file, running)
  }

  /** The first window to ask is told; every later ask, and every later
   *  launch of this version, hears nothing. */
  take(): ChangelogAfterUpdate | null {
    const news = this.pending
    if (news) {
      this.pending = null
      writeSeen(this.file, this.running)
    }
    return news
  }
}

/** A missing, unreadable or foreign file reads as nothing on record. */
function readSeen(file: string): string | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    const version = (value as { version?: unknown } | null)?.version
    return typeof version === 'string' && version.trim() ? version.trim() : null
  } catch {
    return null
  }
}

/** Never throws: a record that cannot be written costs at most one more
 *  Changelog, never the launch. */
function writeSeen(file: string, version: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file + '.tmp', JSON.stringify({ version }), { mode: 0o600 })
    fs.renameSync(file + '.tmp', file)
  } catch { /* see above */ }
}
