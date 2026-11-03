// RT-A (spec R2): one rich-text path. No surface writes `md()`/`inlineMd()` output
// straight into the DOM, and none renders authored prose through the React
// mention components, outside this allowlist (each entry carries its reason).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

declare const __SRC_DIR__: string

const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const full = path.join(dir, name)
  return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx)$/.test(name) ? [full] : []
})
const rel = (f: string) => path.relative(__SRC_DIR__, f).replaceAll('\\', '/')
/** block comments blanked (line count kept) so prose about md() is not code */
const stripBlock = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' '))
const sources = files(__SRC_DIR__).filter(f => !/\.test\.tsx?$/.test(f)).map(f => ({ file: rel(f), text: stripBlock(readFileSync(f, 'utf8')) }))

/** File-level allowlist: where a forbidden form is the DEFINITION or an exempt use. */
const FILE_ALLOW: Record<string, string> = {
  'canvas/htmlresponse.ts': 'consumes md() output to build the sandboxed agent response (R1 exempt)',
  'canvas/refmd.tsx': 'the definition of RefMdBody',
  'canvas/reflinks.tsx': 'the definition of RefProse / Written / TypedRefText',
}
/** Line-level allowlist (file + a distinctive fragment of the line) for the plain-by-design surfaces. */
const LINE_ALLOW: [string, string, string][] = [
  ['canvas/desk.tsx', 'md(m.cmd_out)', 'P6: slash-command output is CLI machine output; mentions stay inert (spec rev 1.1 D1, deskrefs section 7)'],
]

const FORBIDDEN = [
  /dangerouslySetInnerHTML\s*=\s*\{\s*(md|inlineMd)\(/,
  /dangerouslySetInnerHTML\s*:\s*(md|inlineMd)\(/,
  /<RefProse\b/, /<Written\b/, /<TypedRefText\b/,
]

test('RT-A no surface writes md()/inlineMd() into the DOM or renders prose through the React mention path', () => {
  const found: string[] = []
  for (const { file, text } of sources) {
    if (FILE_ALLOW[file]) continue
    text.split('\n').forEach((line, i) => {
      if (!FORBIDDEN.some(re => re.test(line))) return
      if (LINE_ALLOW.some(([f, frag]) => f === file && line.includes(frag))) return
      found.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`)
    })
  }
  assert.deepEqual(found, [], 'authored prose must go through RefMdBody (spec R1)')
})

test('RT-A every md()/inlineMd() call in a .tsx file feeds a RefMdBody html prop (or a variable passed to one)', () => {
  const found: string[] = []
  for (const { file, text } of sources) {
    if (!file.endsWith('.tsx') || FILE_ALLOW[file]) continue
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      if (!/(?<![A-Za-z0-9_.])(md|inlineMd)\(/.test(line) || /^\s*(\/\/|\*|\/\*)/.test(line)) return
      if (/(function|=>)\s*(md|inlineMd)\b|import /.test(line)) return
      if (LINE_ALLOW.some(([f, frag]) => f === file && line.includes(frag))) return
      const window = lines.slice(Math.max(0, i - 1), i + 4).join('\n')
      if (/RefMdBody|html=\{|useMemo\(|const [a-zA-Z]+\s*=\s*(md|inlineMd)\(|ReceivedMailBody|html:/.test(window)) return
      found.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`)
    })
  }
  console.log('RT-A second-check candidates:\n' + found.join('\n'))
  assert.deepEqual(found, [], 'each md() call must be the value of a RefMdBody html prop')
})
