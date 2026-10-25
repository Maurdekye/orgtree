// The standalone image's build stage must hold every file the engine compile
// reads (docket standalone-docker-omits-the-changelog-catalog-an). The
// Changelog's docs/releases.json is an include_str!, so leaving it out fails
// the compile; build.rs embeds docs/skills and every stable
// docs/release-notes-<x.y.z>.md, so leaving those out silently empties the
// glossary or the notes. The context comes from the allowlist in
// standalone/Dockerfile.dockerignore and the stage from the build stage's COPY
// lines: this applies both to the tracked files the way BuildKit does, with no
// Docker.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
// The tracked files; a submodule (engine/mailhub) is a folder, not a file.
const tracked = execFileSync('git', ['ls-files', '-z', '--stage'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 })
  .split('\0')
  .filter(entry => entry && !entry.startsWith('160000 '))
  .map(entry => entry.slice(entry.indexOf('\t') + 1))

// A path pattern as a regular expression: `*` and `?` stay within one path
// segment and, in a .dockerignore pattern, `**` spans any number of them.
function pattern(glob, dockerignore) {
  let source = '^'
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (dockerignore && ch === '*' && glob[i + 1] === '*') {
      i += glob[i + 2] === '/' ? 2 : 1
      source += i + 1 < glob.length ? '(.*/)?' : '.*'
    } else if (ch === '*') source += '[^/]*'
    else if (ch === '?') source += '[^/]'
    else source += '.+()|{}$'.includes(ch) ? `\\${ch}` : ch
  }
  return new RegExp(`${source}$`)
}

// A .dockerignore as BuildKit reads it (moby/patternmatcher): `#` lines are
// comments, `!` makes an exception, and each pattern is a cleaned path.
function ignorePatterns(text) {
  return text
    .split(/\r?\n/)
    .filter(line => !line.startsWith('#'))
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const exception = line.startsWith('!')
      const clean = path.posix.normalize((exception ? line.slice(1) : line).trim()).replace(/^\/+|\/+$/g, '')
      return { exception, re: pattern(clean, true) }
    })
}

// Whether a file is in the build context: the last pattern matching it
// decides. BuildKit 0.31 (Docker Desktop 29.6, measured 2026-10-25) also
// counts a pattern that matches one of the file's directories, so `!docs/`
// re-includes all of docs/; patternmatcher's newer per-path rule (buildx#850)
// counts only the path itself, starting from its directory's verdict, so each
// file under `!docs/` that the leading `**` excludes needs its own exception.
// The allowlist has to work under both.
function inContext(patterns, file, directories) {
  const parts = file.split('/')
  const paths = parts.map((_, i) => parts.slice(0, i + 1).join('/'))
  let excluded = false
  if (directories) {
    for (const { exception, re } of patterns) if (paths.some(at => re.test(at))) excluded = !exception
  } else {
    for (const at of paths) for (const { exception, re } of patterns) if (re.test(at)) excluded = !exception
  }
  return !excluded
}

// The files of the stage named `build`, by repository path (its WORKDIR is
// the repository root): each COPY of context sources puts a file, or a
// directory's contents, at its destination. `missing` lists the sources the
// context lacks, which fail the build.
function buildStage(dockerfile, context) {
  const stage = new Map()
  const missing = []
  let workdir = '/'
  let inBuild = false
  for (const line of dockerfile.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    const [op = '', ...args] = line.trim().split(/\s+/)
    if (/^from$/i.test(op)) inBuild = /^as$/i.test(args.at(-2) ?? '') && args.at(-1) === 'build'
    if (!inBuild) continue
    if (/^workdir$/i.test(op)) workdir = path.posix.resolve(workdir, args[0])
    if (!/^copy$/i.test(op) || args.some(arg => arg.startsWith('--from'))) continue
    const operands = args.filter(arg => !arg.startsWith('--'))
    const dest = path.posix.resolve(workdir, operands.at(-1))
    const intoDir = operands.at(-1).endsWith('/') || operands.length > 2
    for (const source of operands.slice(0, -1)) {
      const src = path.posix.normalize(source).replace(/\/+$/, '')
      const glob = /[*?[]/.test(src) ? pattern(src, false) : null
      let found = false
      for (const file of context) {
        const parts = file.split('/')
        const hit = src === '.' ? '' : parts.map((_, i) => parts.slice(0, i + 1).join('/')).find(at => (glob ? glob.test(at) : at === src))
        if (hit === undefined) continue
        found = true
        const to = hit === file
          ? (intoDir || glob ? path.posix.join(dest, parts.at(-1)) : dest)
          : path.posix.join(dest, hit === '' ? file : file.slice(hit.length + 1))
        stage.set(path.posix.relative(workdir, to), file)
      }
      if (!found) missing.push(source)
    }
  }
  return { stage, missing }
}

// What the engine compile reads: the workspace members' files and the Cargo
// manifest and lockfile, every include_str!/include_bytes! path in their
// sources, and build.rs's inputs: the glossary (docs/skills), the release list
// and every stable release's notes.
function compileInputs(files) {
  const members = [...read('engine/rs/Cargo.toml').match(/^members\s*=\s*\[([^\]]*)\]/m)[1].matchAll(/"([^"]+)"/g)]
    .map(([, member]) => `engine/rs/${member}`)
  const inputs = new Set(['engine/rs/Cargo.toml', 'engine/rs/Cargo.lock', 'docs/releases.json'])
  for (const file of files) {
    const crate = members.find(member => file.startsWith(`${member}/`))
    if (crate) inputs.add(file)
    if (crate && file.endsWith('.rs')) {
      const includes = /include_(?:str|bytes)!\(\s*(?:"([^"]+)"|concat!\(\s*env!\("CARGO_MANIFEST_DIR"\)\s*,\s*"([^"]+)"\s*\))/g
      for (const [, relative, fromCrate] of read(file).matchAll(includes)) {
        inputs.add(relative ? path.posix.join(path.posix.dirname(file), relative) : path.posix.join(crate, fromCrate))
      }
    }
    if (file.startsWith('docs/skills/') || /^docs\/release-notes-\d+\.\d+\.\d+\.md$/.test(file)) inputs.add(file)
  }
  return inputs
}

const patterns = ignorePatterns(read('standalone/Dockerfile.dockerignore'))
const inputs = compileInputs(tracked)
const stages = [
  ['directory exceptions cover their contents (BuildKit 0.31)', true],
  ['each path needs its own exception', false],
].map(([rule, directories]) => ({
  rule,
  ...buildStage(read('standalone/Dockerfile'), tracked.filter(file => inContext(patterns, file, directories))),
}))
const each = check => assert.deepEqual(stages.map(check), stages.map(({ rule }) => ({ rule, files: [] })))

test('every COPY source of the standalone build stage is in its context', () => {
  assert.ok(stages.every(({ stage }) => stage.size > 0), 'standalone/Dockerfile has a stage named build')
  each(({ rule, missing }) => ({ rule, files: missing }))
})

test('the standalone build stage holds every file the engine compile reads', () => {
  // A new one is copied in standalone/Dockerfile's build stage and allowed,
  // under its own path, in standalone/Dockerfile.dockerignore.
  each(({ rule, stage }) => ({ rule, files: [...inputs].filter(file => stage.get(file) !== file).sort() }))
})

test('the standalone build stage holds nothing the engine compile does not read', () => {
  // Pre-release notes (build.rs skips them) and the other docs stay out.
  each(({ rule, stage }) => ({ rule, files: [...stage.keys()].filter(file => !inputs.has(file)).sort() }))
})
