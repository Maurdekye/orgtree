// Bundle the mounted docket fixture for copyslug_probe.py, optionally with a
// PLANTED MUTATION so the probe can be shown to catch what it claims to check.
//
//   node tests/copyslug-build.mjs                 the real component
//   node tests/copyslug-build.mjs eager-copied    bubble before the write resolves
//   node tests/copyslug-build.mjs copy-rendered   copies the row's text, not the slug
//   node tests/copyslug-build.mjs no-control-guard  embedded controls copy too
//   node tests/copyslug-build.mjs flat-top       bubble ignores the click's Y
//   node tests/copyslug-build.mjs no-ticket      repeats at one point stop restarting
//   node tests/copyslug-build.mjs global-clipboard  popped-out rows use the opener clipboard
//
// A mutation that does not find its anchor throws INERT rather than building a
// fixture that is quietly identical to the real one.
import * as esbuild from 'esbuild'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const out = path.resolve('node_modules/.orgtree-copyslug')
const mutation = process.argv[2]
const ANCHORS = {
  'eager-copied': [
    `void clip.writeText(item.slug)
      .then(() => setCopied({ id: ++copyTicket, x, y }))
      .catch(() => {})`,
    `setCopied({ id: ++copyTicket, x, y })
    void clip.writeText(item.slug).catch(() => {})`],
  'flat-top': [                       // the bubble ignores the click's Y
    'top: `${copied.y * 100}%`', 'top: "2px"'],
  'no-ticket': [                      // repeats at one point stop restarting
    'setCopied({ id: ++copyTicket, x, y })', 'setCopied({ id: 1, x, y })'],
  'copy-rendered': [
    'void clip.writeText(item.slug)',
    'void clip.writeText(e.currentTarget.textContent || "")'],
  'no-control-guard': [
    `if ((e.target as Element | null)?.closest?.(
      'button, input, textarea, select, a, .docket-copied')) return`,
    'if (false) return'],
  'global-clipboard': [
    'const clip = row.ownerDocument.defaultView?.navigator?.clipboard',
    'const clip = navigator.clipboard'],
}
if (mutation && !(mutation in ANCHORS)) throw Error('Unknown mutation ' + mutation)

const plugins = mutation ? [{
  name: mutation,
  setup(build) {
    build.onLoad({ filter: /docket\.tsx$/ }, ({ path: file }) => {
      // the tree is CRLF (.gitattributes) while the anchors below are written
      // with LF: normalise, or every multi-line anchor is INERT for the wrong
      // reason. esbuild does not care which the mutated source uses.
      const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
      const [from, to] = ANCHORS[mutation]
      if (source.split(from).length !== 2) throw Error('INERT ' + mutation)
      return { contents: source.replace(from, to), loader: 'tsx' }
    })
  },
}] : []

mkdirSync(out, { recursive: true })
await esbuild.build({
  entryPoints: ['tests/copyslug-fixture.tsx'], outdir: out,
  bundle: true, format: 'esm', jsx: 'automatic', plugins,
})
