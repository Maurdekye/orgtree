import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')

// The real backend serves this SAME index.html for every client-routed path
// via its SPA catch-all (`/`, `/o/<org>`, ...; engine/backend/orgtree/api.py
// `spa()`). A RELATIVE asset base resolves "./assets/..." against whatever
// deep path the document was actually loaded from — a reload from `/o/<org>`
// then requests "/o/assets/index-*.js", unmatched by the top-level `/assets`
// mount, so the catch-all answers with index.html's own text/html instead of
// the module script and the app never boots. Real bug: clicking Refresh on
// an open org turned the whole window white until the app was closed and
// reopened back to `/`. Runs the actual build (not a source regex) so a
// regression to a relative base is caught by its real output, not its intent.
test('the built renderer references its own assets by absolute path, not relative to the loaded route', () => {
  execFileSync(process.execPath, ['tools/build.mjs'], { cwd: root, stdio: 'pipe' })
  const html = fs.readFileSync(path.join(root, 'dist/renderer/index.html'), 'utf8')
  const hrefs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1])
  const assetRefs = hrefs.filter(h => h.includes('assets/'))
  assert.ok(assetRefs.length >= 2, 'expected at least a script and a stylesheet/icon reference')
  for (const ref of assetRefs) assert.match(ref, /^\//, `asset reference must be root-absolute, not route-relative: ${ref}`)
})
