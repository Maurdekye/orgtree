// main/changelog-launch.ts — the Changelog after an update (docket
// changelog-window-one-row-per-version-pinnable-po, USER 2026-10-24 22:13:55Z:
// "opens automatically after an update on first launch (not on fresh install)").
//
// The Changelog lists published releases only (USER 2026-10-25 09:01:38Z,
// "Published only"), so it opens when it lists a newer release than this
// install last saw (coordinator m4455f7a604f2), not whenever the running
// version changes: an update between two local alphas that brings no newly
// published release opens nothing. The newest it lists is the engine's top row
// (crate::changelog): the newest release in the docs/releases.json this build
// bundles, or this build itself when it is a release, which its own list
// cannot have yet.
//
// The desktop keeps the newest release its Changelog has listed in
// changelog-seen.json, beside update-log.json. At startup:
// - no record and no earlier run is a fresh install: the newest listed release
//   is recorded and nothing opens. "An earlier run" is update-log.json holding
//   entries from before this run's own 'startup' line, which every launch of
//   every build since the log existed has written.
// - a newest listed release newer than the record, or no record after earlier
//   runs (an update from 4.4.4 or before, which kept none), is news. The first
//   window that asks is told, once, and only then is it recorded: a launch
//   that never showed a window (one started in the background, say) keeps it
//   for the first window that does. Whether the window opens the panel is its
//   own setting (Open changelog after updates); it takes the news either way.
// - the same release, or an older one (a downgrade), opens nothing and keeps
//   the record: it is never lowered, so going back up opens nothing either.
//   4.4.5-alpha.5 recorded the version it ran, which reads the same way: 4.4.4
//   is older than it, 4.4.5 newer.
import fs from 'node:fs'
import path from 'node:path'
import type { ChangelogAfterUpdate } from '../../../packages/contracts/index'
import { compareUpdateVersions } from './updater'

export const CHANGELOG_SEEN_FILE = 'changelog-seen.json'

/** a published release's version: GitHub's pre-releases stay out of the list */
const RELEASE = /^\d+\.\d+\.\d+$/

/** Pure: the newest release the Changelog lists, from the docs/releases.json
 *  this build bundles and its own version; null when it lists none. */
export function newestListed(list: unknown, running: string): string | null {
  const releases = (list as { releases?: unknown } | null)?.releases
  const versions = (Array.isArray(releases) ? releases : [])
    .map((r: unknown) => (r as { version?: unknown } | null)?.version)
    .filter((v): v is string => typeof v === 'string' && RELEASE.test(v))
  if (RELEASE.test(running)) versions.push(running)
  return versions.reduce<string | null>((newest, v) =>
    newest === null || (compareUpdateVersions(v, newest) ?? 0) > 0 ? v : newest, null)
}

/** Pure: the decision above, from what is on record and the newest listed. */
export function changelogAfterLaunch(seen: string | null, newest: string | null,
  earlierRun: boolean): ChangelogAfterUpdate | null {
  if (newest === null) return null
  if (seen === null) return earlierRun ? { from: null, to: newest } : null
  const order = compareUpdateVersions(newest, seen)
  return order !== null && order > 0 ? { from: seen, to: newest } : null
}

export class ChangelogLaunch {
  private pending: ChangelogAfterUpdate | null
  /** `list` is the docs/releases.json this build bundles, `running` its version */
  constructor(private readonly file: string, list: unknown, running: string, earlierRun: boolean) {
    const seen = readSeen(file)
    const newest = newestListed(list, running)
    this.pending = changelogAfterLaunch(seen, newest, earlierRun)
    // nothing to tell: a fresh install, or a record that cannot be ordered,
    // starts from the newest listed; a record at or above it stays
    if (!this.pending && newest !== null && (seen === null || compareUpdateVersions(newest, seen) === null)) {
      writeSeen(file, newest)
    }
  }

  /** The first window to ask is told; every later ask, and every later
   *  launch that lists nothing newer, hears nothing. */
  take(): ChangelogAfterUpdate | null {
    const news = this.pending
    if (news) {
      this.pending = null
      writeSeen(this.file, news.to)
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
