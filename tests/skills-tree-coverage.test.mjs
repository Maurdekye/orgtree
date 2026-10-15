import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { filesUnder, sourceInventory } from '../tools/skills-source-inventory.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.join(repo, 'docs/skills')
const read = relative => fs.readFileSync(path.join(repo, relative), 'utf8')
const manifest = JSON.parse(read('docs/skills/tree.json'))
const inventory = sourceInventory(repo)
const nodes = manifest.nodes
const slug = node => node.path.split('/').at(-1)
const bySlug = new Map(nodes.map(node => [slug(node), node]))
const fileFor = node => path.join(root, ...node.path.split('/'), 'SKILL.md')
const identity = row => `${row.file}#${row.label}`
const resolveSlug = target => {
  const result = bySlug.get(target)
  assert.ok(result, `unknown navigation target: ${target}`)
  return result
}
function skill(node) {
  const content = fs.readFileSync(fileFor(node), 'utf8')
  assert.equal(content.startsWith('\uFEFF'), false, `${node.path}: UTF-8 BOM`)
  const front = content.match(/^---\r?\nname: ([^\r\n]+)\r?\ndescription: ([^\r\n]+)\r?\n---(?:\r?\n|$)/)
  assert.ok(front, `${node.path}: name and description must be the only frontmatter fields`)
  assert.equal(front[1], node.name, `${node.path}: wrong name`)
  return { content, name: front[1], description: front[2], body: content.slice(front[0].length).trim() }
}
function links(text) {
  return [...text.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)].map(match => match[1])
}
function hasLink(from, target, body) {
  return links(body).some(link => !/^[a-z]+:/i.test(link) && path.resolve(path.dirname(fileFor(from)), link) === fileFor(target))
}

test('every served tool has exactly one current leaf', () => {
  const source = read('engine/rs/orgtree-engine/src/tools/defs.rs')
  const body = source.match(/pub fn implemented\b[^\{]*\{\s*&\[([\s\S]*?)\]\s*\}/)?.[1]
  assert.ok(body, 'cannot locate served tool inventory')
  const served = [...body.matchAll(/"(orgtree_[a-z_]+)"/g)].map(match => match[1]).sort()
  assert.ok(served.length > 0)
  const homes = nodes.filter(node => node.kind === 'tool').flatMap(node => {
    assert.equal(node.level, 3, `${node.path}: tool is not a leaf`)
    assert.equal(node.covers.length, 1, `${node.path}: one tool per leaf`)
    return node.covers
  }).sort()
  assert.deepEqual(homes, served, 'tool homes differ from served source inventory')
})

test('every runtime harness and custom-provider route has a detailed comparison home', () => {
  const source = read('engine/rs/orgtree-engine/src/harnesses.rs')
  const registry = source.match(/pub const ALL:\s*&\[Harness\]\s*=\s*&\[([\s\S]*?)\n\];/)?.[1]
  assert.ok(registry, 'cannot locate the runtime harness registry')
  const harnesses = [...registry.matchAll(/\bid:\s*"([^"]+)"/g)].map(match => `harness:${match[1]}`).sort()
  const homes = nodes.flatMap(node => (node.covers ?? []).filter(key => key.startsWith('harness:'))).sort()
  assert.deepEqual(homes, harnesses, 'harness homes differ from the runtime registry')
  const required = ['concept:harness-comparison', 'route:openrouter', 'route:langserver']
  for (const key of required) assert.equal(nodes.filter(node => node.covers?.includes(key)).length, 1, `missing or duplicate ${key}`)
  const topics = ['How it runs', 'Information and timing', 'Caching', 'Compaction', 'Instructions and skills', 'Tools, permissions and sandbox', 'Models and effort', 'Gotchas and workarounds']
  for (const node of nodes.filter(node => node.covers?.some(key => /^(harness|route):/.test(key)))) {
    if (!fs.existsSync(fileFor(node))) continue // the complete-library check reports unwritten pages
    const body = skill(node).body.replace(/\r/g,'')
    for (const heading of topics) assert.ok(body.split('\n').includes(`## ${heading}`), `${node.path}: missing topic ${heading}`)
  }
  const comparison = nodes.find(node => node.covers?.includes('concept:harness-comparison'))
  if (comparison && fs.existsSync(fileFor(comparison))) assert.match(skill(comparison).body, /\|[^|\n]*gotchas[^|\n]*\|/i, 'comparison needs a gotchas column')
})

test('exported screen components have current homes or justified exemptions', () => {
  const homes = nodes.flatMap(node => node.components ?? [])
  const exempt = manifest.exempt.components
  for (const entry of exempt) assert.ok(entry.reason?.trim(), `${entry.id}: missing exemption reason`)
  const expected = [...homes, ...exempt.map(entry => entry.id)]
  assert.equal(new Set(expected).size, expected.length, 'component appears in several homes/exemptions')
  assert.deepEqual(expected.sort(), inventory.components, 'exported screen inventory differs from coverage metadata')
})

test('literal settings rows and generated notification options have homes', () => {
  const actual = new Set(inventory.labels.map(identity))
  const homes = nodes.flatMap(node => node.ui_labels ?? [])
  const exempt = manifest.exempt.labels
  for (const entry of exempt) assert.ok(entry.reason?.trim(), `${identity(entry)}: missing exemption reason`)
  const documented = new Set([...homes, ...exempt].map(identity))
  assert.deepEqual([...documented].sort(), [...actual].sort(), 'settings labels differ from source; assign each new row a leaf')
  // Dynamic labels are keyed by their component and expression, so adding a
  // second setting with a generated label cannot disappear from this scan.
  const dynamicId = row => `${row.file}#${row.component}#${row.label}`
  const dynamicHomes = nodes.flatMap(node => node.ui_dynamic_labels ?? [])
  assert.equal(new Set(dynamicHomes.map(dynamicId)).size, dynamicHomes.length, 'dynamic row has more than one home')
  assert.deepEqual(dynamicHomes.map(dynamicId).sort(), [...new Set(inventory.dynamicLabels.map(dynamicId))].sort(), 'dynamic settings rows differ from source; assign their reference home')
})

test('each storage key retains explicit source evidence', () => {
  const keys = nodes.flatMap(node => (node.covers ?? []).filter(key => /^(?:np|ls|rt|org|defaults|node|hub|api|bridge):/.test(key)))
  const evidence = nodes.flatMap(node => node.key_sources ?? [])
  assert.deepEqual(evidence.map(entry => entry.key).sort(), [...keys].sort(), 'missing or obsolete setting key evidence')
  for (const entry of evidence) {
    assert.ok(entry.needles?.length, `${entry.key}: empty source selector`)
    const content = read(entry.file)
    for (const needle of entry.needles) assert.ok(content.includes(needle), `${entry.key}: source selector no longer exists in ${entry.file}`)
  }
})

test('manifest remains a two-category tree with unique identities and covers', () => {
  assert.equal(manifest.schema, 1)
  assert.equal(bySlug.size, nodes.length, 'folder slug collision')
  assert.equal(new Set(nodes.map(node => node.name)).size, nodes.length, 'skill name collision')
  const covers = nodes.flatMap(node => node.covers ?? [])
  assert.equal(new Set(covers).size, covers.length, 'a fact has more than one home')
  assert.deepEqual(nodes.filter(node => node.registered).map(node => node.path).sort(), ['orgtree-app', 'orgtree-working'])
  for (const node of nodes) {
    assert.match(node.path, /^[a-z0-9-]+(?:\/[a-z0-9-]+){0,2}$/)
    assert.equal(node.path.split('/').length, node.level, `${node.path}: depth mismatch`)
    assert.ok(node.name.length <= 45, `${node.path}: name too long`)
    for (const child of node.children ?? []) assert.equal(resolveSlug(child).path, `${node.path}/${child}`)
    for (const target of node.see_also ?? []) resolveSlug(target)
  }
})

test('written pages have parent navigation, child lists and required see-also references', () => {
  const available = nodes.filter(node => fs.existsSync(fileFor(node)))
  for (const node of available) {
    const page = skill(node)
    if (node.level === 3) assert.ok(page.body.length >= 200, `${node.path}: empty or scaffold-only leaf`)
    if (node.kind === 'tool') assert.ok(page.body.includes(node.covers[0]), `${node.path}: tool name missing from body`)
    if (node.level > 1) {
      const parent = nodes.find(parent => parent.path === node.path.split('/').slice(0, -1).join('/'))
      assert.ok(page.body.startsWith(`Up: [${parent.name}](../SKILL.md)`), `${node.path}: missing first parent link`)
    }
    for (const child of node.children ?? []) assert.ok(hasLink(node, resolveSlug(child), page.body), `${node.path}: missing child ${child}`)
    for (const target of node.see_also ?? []) {
      const other = resolveSlug(target)
      if (node.path.split('/')[0] === other.path.split('/')[0]) assert.ok(hasLink(node, other, page.body), `${node.path}: missing see-also ${target}`)
      else {
        assert.ok(page.body.includes(other.name), `${node.path}: missing cross-category reference ${target}`)
        assert.ok(page.body.includes(other.path.split('/').slice(0,-1).join(' › ')), `${node.path}: missing breadcrumb for ${target}`)
      }
    }
    for (const link of links(page.body)) {
      if (/^[a-z]+:/i.test(link) || link.startsWith('#')) continue
      assert.ok(!path.isAbsolute(link), `${node.path}: absolute link`)
      const target = path.resolve(path.dirname(fileFor(node)), link.split('#')[0])
      assert.ok(target.startsWith(path.join(root, node.path.split('/')[0]) + path.sep), `${node.path}: link escapes its category`)
      if (node.level === 1) assert.ok(!link.split('/').includes('..'), `${node.path}: category entry link points upward`)
      assert.ok(nodes.some(other => fileFor(other) === target), `${node.path}: link is not a manifest page: ${link}`)
    }
  }
})

test('the complete library has every page and only its category descriptions are registered', () => {
  const missing = nodes.filter(node => !fs.existsSync(fileFor(node))).map(node => node.path)
  assert.deepEqual(missing, [], 'fixed skill pages remain unwritten')
  const expected = new Set(nodes.map(fileFor))
  for (const file of filesUnder(repo, 'docs/skills').filter(file => file.endsWith('/SKILL.md'))) {
    assert.ok(expected.has(path.join(repo,file)), `${file}: skill is outside the tree`)
  }
  let bytes = 0
  for (const node of nodes.filter(node => node.registered)) {
    const page = skill(node)
    assert.equal(page.description, node.description, `${node.path}: registered description differs from approved text`)
    bytes += Buffer.byteLength(`name: ${page.name}\ndescription: ${page.description}\n`, 'utf8')
  }
  assert.ok(bytes <= 600, `registered name/description lines cost ${bytes} bytes (cap 600)`)
})

test('the Developer discovery note stays confined to its one body', () => {
  const source = read('apps/desktop/renderer/src/epic/EpicSwitch.tsx')
  const label = source.match(/aria-label="([^"]+)"/)?.[1]
  assert.ok(label, 'private control label source changed')
  const pattern = new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`, 'gi')
  for (const file of filesUnder(repo,'docs/skills').filter(file=>/\.(md|json)$/.test(file))) {
    const text = read(file), count = [...text.matchAll(pattern)].length
    if (file.endsWith('/app-developer/SKILL.md')) {
      assert.equal(count, 1, 'Developer body must have exactly one discovery note')
      const page = skill(resolveSlug('app-developer'))
      assert.equal([...page.description.matchAll(pattern)].length, 0, 'private control is in a description')
      assert.equal(page.body.split('\n').some(line=>/^#/.test(line)&&pattern.test(line)), false, 'private control is in a heading')
    } else assert.equal(count, 0, `${file}: private control name escaped its one body`)
  }
})
