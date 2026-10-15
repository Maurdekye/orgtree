import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const library = path.join(repo, 'docs', 'skills')
const read = relative => fs.readFileSync(path.join(repo, relative), 'utf8')
const manifest = JSON.parse(read('docs/skills/tree.json'))

function implementedTools() {
  const source = read('engine/rs/orgtree-engine/src/tools/defs.rs')
  const body = source.match(/pub fn implemented\b[^\{]*\{\s*&\[([\s\S]*?)\]\s*\}/)?.[1]
  assert.ok(body, 'cannot locate the served tool inventory in defs.rs')
  const names = [...body.matchAll(/"(orgtree_[a-z_]+)"/g)].map(match => match[1])
  assert.ok(names.length > 0, 'the served tool inventory must not be empty')
  assert.equal(new Set(names).size, names.length, 'duplicate served tool name')
  return names.sort()
}

function fileFor(node) {
  assert.equal(typeof node.path, 'string', 'a manifest node needs its relative path')
  assert.match(node.path, /^[a-z0-9-]+(?:\/[a-z0-9-]+){0,2}$/, `invalid node path: ${node.path}`)
  return path.join(library, ...node.path.split('/'), 'SKILL.md')
}

function frontmatter(text, file) {
  assert.equal(text.startsWith('\uFEFF'), false, `${file}: UTF-8 BOM is not supported`)
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  assert.ok(match, `${file}: missing frontmatter`)
  const fields = Object.fromEntries(match[1].split(/\r?\n/).filter(Boolean).map(line => {
    const pair = line.match(/^(name|description):\s*(.+)$/)
    assert.ok(pair, `${file}: frontmatter supports name and description only`)
    return [pair[1], pair[2]]
  }))
  assert.deepEqual(Object.keys(fields).sort(), ['description', 'name'], `${file}: name and description are required`)
  assert.ok(fields.description.trim(), `${file}: empty description`)
  return { ...fields, body: text.slice(match[0].length).trim() }
}

test('built-in skill manifest gives every served tool exactly one leaf', () => {
  assert.equal(manifest.schema, 1, 'unsupported skill-tree schema')
  assert.ok(Array.isArray(manifest.nodes), 'manifest nodes are required')
  const homes = new Map()
  for (const node of manifest.nodes.filter(node => node.kind === 'tool')) {
    assert.equal(node.level, 3, `${node.path}: tool pages must be leaves`)
    assert.equal(node.covers?.length, 1, `${node.path}: one tool per leaf`)
    const [name] = node.covers
    assert.match(name, /^orgtree_[a-z_]+$/)
    assert.equal(homes.has(name), false, `${name}: duplicate tool leaf`)
    fileFor(node)
    homes.set(name, node)
  }
  assert.deepEqual([...homes.keys()].sort(), implementedTools(), 'served tools and documented tool homes differ')
})

test('every tool leaf exists with its own skill identity and parent link', () => {
  const missing = manifest.nodes.filter(node => node.kind === 'tool' && !fs.existsSync(fileFor(node)))
  assert.deepEqual(missing.map(node => node.path), [], 'tool leaves still need to be written')
  for (const node of manifest.nodes.filter(node => node.kind === 'tool')) {
    const file = fileFor(node)
    const skill = frontmatter(fs.readFileSync(file, 'utf8'), node.path)
    assert.equal(skill.name, node.name, `${node.path}: wrong skill name`)
    const parent = node.path.split('/').at(-2)
    assert.ok(skill.body.startsWith(`Up: [orgtree-${parent}](../SKILL.md)`), `${node.path}: missing parent link`)
    assert.ok(skill.body.includes(node.covers[0]), `${node.path}: does not identify its tool`)
    assert.ok(skill.body.length >= 200, `${node.path}: empty or scaffold-only tool page`)
  }
})
