import fs from 'node:fs'
import path from 'node:path'
import { HARNESS_LINKS } from './policy'

/** Presence only. Never launches, logs in, installs, or contacts a provider. */
export function detectHarnesses(searchPath = process.env.PATH ?? '') {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  return (Object.keys(HARNESS_LINKS) as (keyof typeof HARNESS_LINKS)[]).map(id => ({ id, url: HARNESS_LINKS[id],
    detected: searchPath.split(path.delimiter).filter(Boolean).some(dir => extensions.some(ext => {
      try { return fs.statSync(path.join(dir.replace(/^"|"$/g, ''), id + ext)).isFile() } catch { return false }
    })),
  }))
}
