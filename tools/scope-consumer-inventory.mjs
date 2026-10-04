/** Exact TypeScript scope-origin inventory; manifest entries require review. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const categories = new Set(['effective', 'configured', 'unrelated'])
export function scanText(text, filename) {
  const source = parse(text, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  const matches = []
  function visit(node) {
    const member = node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression'
    const field = member && !node.computed && node.property.type === 'Identifier' ? node.property.name :
      member && node.computed && node.property.type === 'StringLiteral' ? node.property.value : null
    if (field === 'scope' || field === 'configured_scope') {
      matches.push({ path: filename, expression: text.slice(node.start, node.end).replace(/\s+/g, ' '),
        line: node.loc.start.line })
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'comments', 'tokens', 'leadingComments', 'trailingComments', 'innerComments'].includes(key)) continue
      if (Array.isArray(value)) { for (const child of value) if (child?.type) visit(child) }
      else if (value?.type) visit(value)
    }
  }
  visit(source)
  return matches
}
export function scan() {
  const matches = []
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(filename)
      else if (/\.(ts|tsx)$/.test(entry.name)) matches.push(...scanText(
        fs.readFileSync(filename, 'utf8'), path.relative(root, filename).replaceAll('\\', '/')))
    }
  }
  walk(path.join(root, 'apps/desktop/renderer/src'))
  return matches
}
const key = entry => JSON.stringify([entry.path, entry.expression])
export function validate(matches, entries) {
  const issues = []
  const counts = new Map()
  for (const match of matches) counts.set(key(match), (counts.get(key(match)) || 0) + 1)
  for (const entry of entries) {
    if (!categories.has(entry.classification) || !entry.reason?.trim())
      issues.push(`incomplete classification: ${key(entry)}`)
    counts.set(key(entry), (counts.get(key(entry)) || 0) - 1)
  }
  for (const [identity, difference] of counts) {
    if (difference > 0) issues.push(`unclassified expression (${difference}): ${identity}`)
    if (difference < 0) issues.push(`stale classification (${-difference}): ${identity}`)
  }
  return issues
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const matches = scan()
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tools/scope-consumers-renderer.json'), 'utf8'))
  const issues = validate(matches, manifest.entries)
  const result = { matches, classifications: manifest.entries, issues }
  const output = process.argv.indexOf('--json-output')
  if (output !== -1) fs.writeFileSync(process.argv[output + 1], JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ matches: matches.length, classifications: manifest.entries.length, issues }))
  process.exitCode = issues.length ? 1 : 0
}
