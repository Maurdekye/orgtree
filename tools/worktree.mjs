#!/usr/bin/env node
// tools/worktree.mjs — small, fail-closed worktree lifecycle helper.
//
// The Node port of tools/worktree.py (release 4.6.1 removes Python from the
// repository). Same subcommands, flags, JSON output, exit codes, refusal
// sentences and safety rules; dependency-free (node:fs, node:path,
// node:child_process only). Where Node cannot see what Python saw, the
// difference is stated at the place it matters - see "WHAT NODE CAN SEE" below.
//
// This module intentionally does not call `git config` or rewrite repository
// configuration. It is used to create and remove private worktrees in the one
// shape that works, to inspect checkouts, describe dependency setup, repair
// registered paths after an agent rename, and preview cleanup. Cleanup is opt-in
// and can only unlink a junction/reparse point that has been validated as an
// owned link; it never follows the link or removes its target.
//
// ⚠ THE ONE RULE THIS FILE EXISTS TO ENFORCE. A worktree created UNDER THE
// REPOSITORY ROOT needs no `node_modules` of its own, because Node resolves a
// bare specifier by walking the directory chain upward and finds the shared tree
// at the root. A worktree created anywhere else does not, which is what makes
// people reach for a `node_modules` junction back into the real checkout - and
// that junction is the cause of every worktree incident this project has had:
//
//   * two checkouts sharing one dependency tree stop being private, so a test
//     runner that clears its own scratch directory clears somebody else's too;
//   * `git worktree remove --force` follows the junction out of the throwaway
//     worktree and empties the real checkout behind it.
//
// So `add` places the worktree under the repository root and verifies that the
// dependencies actually resolve from there before it reports success, `remove`
// refuses ANY removal through a link it can see, and the junction route is
// reachable only by asking for it in as many words.
//
// ⚠ `remove` refuses whether or not `--force` was asked for, and that is the
// correction that matters. `--force` only overrides the dirty/untracked check;
// it does not change how Git deletes the tree. A `node_modules` junction is
// gitignored, so the worktree reads as clean and the *un-forced* removal is the
// one an agent actually reaches - and it destroys the junction's target just as
// completely. Measured, not assumed: see `planRemove`.
//
// `cleanup-scan` enumerates the links that already exist under a root without
// following any of them, and hands back a plan that `cleanup-apply` can execute
// against a re-validated filesystem. Removal always unlinks the link itself; the
// target is never opened, walked or deleted.
//
// ⚠ TWO KNOWN LIMITS, both recorded so the next reader gets five minutes rather
// than an afternoon, and neither fixed here:
//
// * **An UNREADABLE reparse point deadlocks.** `removalScan` counts a link
//   whose target cannot be read as escaping - the safe direction - so `remove`
//   refuses it; `accept_unscanned` waives truncation only; `cleanupScan`
//   declines to select it because its target is unknown; and `cleanupPreview`
//   preserves it as "target could not be validated". So that worktree cannot be
//   removed by this tool at all, and the cleanup its refusal points at will not
//   clear it. The obstacle is policy, not mechanism: rmdir removes a reparse
//   point without following it. Analysis by worktree-setup, from the code
//   rather than from a constructed case. (In this Node port the population is
//   different but not empty: libuv only reports a link whose target it CAN
//   read, so the usual member is now a volume mount point - see WHAT NODE CAN
//   SEE - or a link whose target became unreadable between lstat and readlink.)
// * **This repository is npm, and that is load-bearing.** Its 61,324-entry
//   `node_modules` contains zero links, so the unconditional escaping-link
//   refusal never fires on an ordinary installed tree. Under **pnpm** it would:
//   `node_modules/.pnpm` is symlinks into a global store outside the repository,
//   every one of which reads as escaping, and every worktree would become
//   unremovable with no applicable waiver - `accept_unscanned` does not cover a
//   found link, and `cleanup-scan` only selects links NAMED `node_modules`.
//   Changing package manager means revisiting this file.
//
// ⚠ WHAT NODE CAN SEE, AND HOW IT DIFFERS FROM THE PYTHON ORIGINAL. Python read
// FILE_ATTRIBUTE_REPARSE_POINT (0x400) from `os.lstat().st_file_attributes`, so
// it saw EVERY reparse point, and it called a junction kind "reparse" (S_ISLNK
// is false for a junction there) and a symlink kind "symlink". Node's
// `fs.lstat` exposes no file attributes and no reparse tag. What it does
// expose, on Windows, is libuv's classification: a junction (mount-point tag
// with a drive-letter target) and a symlink are BOTH reported as
// `isSymbolicLink()`. So:
//
//   * a junction now reads as kind "symlink", not "reparse". Every rule in this
//     file treats the two kinds identically (`LINK_KINDS`), so no decision
//     changes - only the word in the JSON. A cleanup plan written by the Python
//     tool records "reparse" and is therefore PRESERVED ("changed since
//     preview") by this one, which is the fail-closed direction: rescan.
//   * `identity` keeps its two-slot shape `[kind, tag]`, but the tag slot is
//     always null: Node has no `st_reparse_tag`. Identity therefore compares on
//     kind alone; the target comparison in `applyCleanup` is unchanged.
//   * libuv already strips the `\??\` prefix when it reads a junction, so a raw
//     `readlink` target no longer starts with `\\?\` the way Python's did.
//     `stripExtendedPrefix` is kept anyway: other Node versions and other link
//     shapes may still return it, and the containment check must not depend on
//     which one is running.
//   * OTHER reparse tags - OneDrive/cloud-files placeholders, deduplicated files,
//     WCI/container layers and the like - are not name surrogates and libuv's
//     lstat does not report them as links: it reopens them normally and returns
//     the ordinary file or directory underneath. Python recorded each of them as
//     a "reparse" link with an unreadable target (escaping, so `remove`
//     refused). This port reads them as plain files and directories, walks into
//     such directories, and lets `remove` proceed past them. That is the right
//     answer for the hazard this file guards against - none of those tags is a
//     door out of the tree, and deleting one deletes the placeholder, never a
//     target elsewhere - but it is a behaviour change, stated here.
//   * ONE non-surrogate case IS a door out: a volume mount point (a junction
//     whose target is `\??\Volume{...}\`). libuv cannot read that target as a
//     path, so it falls back and reports the MOUNTED VOLUME's root directory -
//     a walk would then descend into another disk. It is caught by its volume
//     serial: on Windows an entry whose `lstat().dev` differs from its parent
//     directory's is classified kind "reparse" with no readable target, exactly
//     as Python classified it, and is never descended into.
//   * On win32 every path comparison is case-insensitive, as `os.path.normcase`
//     made it (`canonical` lowercases and uses backslashes).

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const WIN = process.platform === 'win32'
const SEP = path.sep

export const DEFAULT_HIDDEN = new Set(['.git', '.worktree', '.worktree-state.json'])

/** Where a private worktree belongs. Relative to the repository root, and
 *  already ignored by the repository's own `.gitignore`. */
export const WORKTREES_DIR = '.worktrees'

/** The directory whose upward resolution is the whole point of the rule. */
export const DEPENDENCY_DIR = 'node_modules'

/** The two kinds every rule here treats as "a link". */
const LINK_KINDS = new Set(['symlink', 'reparse'])

// A scan of a worktree stops here rather than walking an unbounded tree. The
// number is a safety valve, not a judgement: an honest `truncated` flag is
// reported when it is hit, because a scan that quietly stopped early would
// make "no links found" mean nothing.
//
// ⚠ SIZED SO THE ORDINARY CASE FITS. It was 50000, which a correctly-shaped
// worktree (measured: 1,248 entries) never approached - but a worktree with a
// REAL installed `node_modules` (measured: 61,324 entries) sails past it. A
// junctioned `node_modules` is a reparse point and is never descended into,
// so it scans small; only the real one is expensive. Once the truncation
// refusal stopped being conditional on `--force`, a limit below that figure
// would have made every worktree anybody had run `npm install` in
// permanently unremovable by this tool - and those are exactly the checkouts
// that need cleaning up. Raising the ceiling does not remove the cliff, which
// is why `accept_unscanned` exists as well; it moves the cliff past the case
// that actually occurs, so the opt-out stays rare rather than routine.
export const SCAN_LIMIT = 400000

// How deep `findReparsePoints` descends below its root before it stops and
// SAYS it stopped.
//
// ⚠ DEPTH AND BUDGET ARE COUPLED, and getting that backwards produces a scan
// that undercounts while reporting success. Raising the depth raises the entry
// count; if the budget does not rise with it the walk truncates early and finds
// FEWER links than a shallower one would. Measured on the live scratch root at
// a 50000 budget: depths 3, 4 and 5 each found 77 links, while depth 6 found
// ELEVEN - not because six was too deep, but because that root is 572,294
// entries and the budget ran out. Raise the two together or not at all.
//
// The default is deliberately deep enough to be exhaustive on the shapes we
// actually have. An earlier value of 4 was chosen from the observation that
// junctions sit at `<scratch>/<agent>/<worktree>/node_modules`; that was
// wrong. worktree-setup's unbounded walk found links at depth 5 in the primary
// scratch root and at depth 9 in the second one - 5 and 49 links respectively
// below a depth-4 bound, none of which a depth-4 scan would have reported while
// still printing `complete: true`. A default that silently undercounts a
// cleanup is worse than a slow one.
//
// 12 was still not enough to make the live roots a census - it left 743
// directories undescended and `census: false`, which is honest but is not the
// answer an operator running a cleanup needs. The walk never follows a reparse
// point, so it cannot cycle and depth is only a cost control; the entry BUDGET
// is the real bound and it reports itself. So this is set high enough that a
// real tree comes back exhaustive (measured: the full primary root is 572,301
// entries and 46 seconds at unbounded depth) and left as a backstop rather than
// a policy.
export const DEFAULT_SCAN_DEPTH = 64

// Never descended into. Recorded instead, so the output still says they were
// there. A real `node_modules` would exhaust the entry budget on its own and
// truncate the part of the scan that matters; `.git` and `.venv` are the
// same problem in smaller form. A link BY these names is still recorded - the
// link check runs before the descent decision.
export const SCAN_SKIP_DIRS = new Set(['.git', DEPENDENCY_DIR, '.venv'])

// The entry budget for a WHOLE-ROOT scan, which is a different scale of job
// from scanning one worktree and needs its own number. The primary scratch root
// measures 572,294 entries unbounded, so `SCAN_LIMIT` would truncate it - and
// a truncated cleanup scan is the failure mode that leaves junctions behind
// while the operator reads a count and believes it.
export const SCAN_ROOT_LIMIT = 2000000

/** This tool declining: a decision, printed as `refused:` with exit 2
 *  (Python's ValueError). */
export class RefusalError extends Error {
  constructor (message) { super(message); this.name = 'RefusalError' }
}

/** Git itself failing: a breakage, printed as `error:` with exit 1
 *  (Python's RuntimeError). */
export class GitError extends Error {
  constructor (message) { super(message); this.name = 'GitError' }
}

/** An operating-system error (Python's OSError): Node's system errors carry a
 *  string `code` such as ENOENT. */
const isOsError = (error) => error instanceof Error && typeof error.code === 'string' &&
  !(error instanceof TypeError) && !(error instanceof RangeError)

// ── seams ──────────────────────────────────────────────────────────────────
// The Python tests patched module functions (`mock.patch.object(worktree,
// "_status", ...)`). An ES module's bindings cannot be patched from outside, so
// every call the tests need to replace goes through this object instead. It is
// not configuration: nothing but a test should ever assign to it.
export const _seams = {
  /** Run a command; returns {status, stdout, stderr}. Throws an OS error if it
   *  could not be started at all (Python: FileNotFoundError from subprocess). */
  run (argv) {
    const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 })
    if (result.error) throw result.error
    return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  },
  lstat: (p) => fs.lstatSync(p),
  readlink: (p) => fs.readlinkSync(p),
  unlink: (p) => fs.unlinkSync(p),
  rmdir: (p) => fs.rmdirSync(p),
  readdir: (p) => fs.readdirSync(p),
  repositoryRoot: (p) => repositoryRootImpl(p),
  status: (p) => statusImpl(p),
  removalScan: (p, opts) => removalScanImpl(p, opts),
  entryKind: (p, parentDev) => entryKindImpl(p, parentDev),
  entryIdentity: (p) => entryIdentityImpl(p),
}

// ── Python-shaped path and JSON helpers ────────────────────────────────────

/**
 * Drop Windows' `\\?\` extended-length prefix from a raw link target.
 *
 * ⚠ NEEDED BEFORE ANY CONTAINMENT CHECK ON A LINK TARGET. Reading a junction
 * can return the target in extended-length form (`\\?\C:\...`; Python always
 * did, libuv usually strips it), and `\\?\C:\repo\x` does not lexically match
 * `C:\repo` - so a link pointing at a perfectly ordinary directory inside the
 * worktree reads as one escaping it. Getting this backwards is not harmless in
 * either direction: it would either refuse safe removals or, worse, describe an
 * escaping link as contained. Normalize the spelling, never the containment
 * rule.
 */
export function stripExtendedPrefix (p) {
  if (p.startsWith('\\\\?\\UNC\\')) return '\\\\' + p.slice(8)
  if (p.startsWith('\\\\?\\')) return p.slice(4)
  return p
}

/** Return a case-normalized absolute path without following links
 *  (`os.path.normcase(os.path.abspath(...))`). */
export function canonical (p) {
  const abs = path.resolve(stripExtendedPrefix(String(p)))
  return WIN ? abs.replace(/\//g, '\\').toLowerCase() : abs
}

/** Check lexical containment; unlike `realpath` this never traverses. Same
 *  answer as `os.path.commonpath((path, root)) == root` on canonical paths,
 *  including False across drives (where commonpath raised ValueError). */
export function contained (p, root) {
  const a = canonical(p)
  const r = canonical(root)
  if (a === r) return true
  return a.startsWith(r.endsWith(SEP) ? r : r + SEP)
}

/** `os.path.join` without normalization: the JSON spells paths exactly as the
 *  Python tool did (`path.join` would collapse `..` and drop a trailing
 *  separator that Python keeps). */
function pyJoin (base, ...parts) {
  let out = base
  for (const part of parts) {
    if (path.isAbsolute(part)) { out = part; continue }
    if (out === '' || /[\\/]$/.test(out) || (WIN && /^[a-zA-Z]:$/.test(out))) out += part
    else out += SEP + part
  }
  return out
}

const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key])
    return out
  }
  return value
}

const asciiOnly = (text) => text.replace(/[\u007f-\uffff]/g,
  (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))

const compactPy = (value) => {
  if (Array.isArray(value)) return '[' + value.map(compactPy).join(', ') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).map((k) => JSON.stringify(k) + ': ' + compactPy(value[k])).join(', ') + '}'
  }
  return JSON.stringify(value === undefined ? null : value)
}

/** `json.dumps(value, sort_keys=True[, indent=N])`, ensure_ascii included:
 *  the bytes the Python tool printed, so a reader diffing the two sees none. */
export function pyJsonDumps (value, indent) {
  const sorted = sortKeys(value)
  return asciiOnly(indent ? JSON.stringify(sorted, null, indent) : compactPy(sorted))
}

/** Python's `repr()` of a str, for the two reasons that quote a name. */
function pyRepr (text) {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'"
  let out = ''
  for (const c of text) {
    const code = c.codePointAt(0)
    if (c === '\\' || c === quote) out += '\\' + c
    else if (c === '\n') out += '\\n'
    else if (c === '\r') out += '\\r'
    else if (c === '\t') out += '\\t'
    else if (code < 0x20 || code === 0x7f) out += '\\x' + code.toString(16).padStart(2, '0')
    else out += c
  }
  return quote + out + quote
}

const casefold = (s) => s.toLowerCase().replace(/ß/g, 'ss')

// ── entry inspection (never follows a link) ────────────────────────────────

function lstatOrNull (p) {
  try { return _seams.lstat(p) } catch (error) { if (isOsError(error)) return null; throw error }
}

function readlinkOrNull (p) {
  try { return _seams.readlink(p) } catch (error) { if (isOsError(error)) return null; throw error }
}

/** Inspect a directory entry without following it. */
export function isReparse (p) {
  const info = lstatOrNull(p)
  return Boolean(info && info.isSymbolicLink())
}

/** "missing" | "symlink" | "reparse" | "directory" | "file".
 *
 *  On Windows a junction and a symlink are both "symlink" (see WHAT NODE CAN
 *  SEE). "reparse" is now only the volume-mount case: a directory whose volume
 *  serial differs from its parent's. `parentDev` is passed by the walks, which
 *  already know it; a standalone call reads the parent itself. */
function entryKindImpl (p, parentDev) {
  const info = lstatOrNull(p)
  if (!info) return 'missing'
  if (info.isSymbolicLink()) return 'symlink'
  if (info.isDirectory()) {
    if (WIN) {
      let dev = parentDev
      if (dev === undefined) {
        // The parent's volume is read with stat, not lstat: if the parent is
        // itself a link, the entry lives on the link's TARGET volume, and only
        // metadata is read - nothing is opened, walked or deleted through it.
        const parent = path.dirname(p)
        if (parent !== p) {
          try { dev = fs.statSync(parent).dev } catch { dev = undefined }
        }
      }
      if (dev !== undefined && dev !== null && info.dev !== dev) return 'reparse'
    }
    return 'directory'
  }
  return 'file'
}
const entryKind = (p, parentDev) => _seams.entryKind(p, parentDev)

/** Return link kind plus Windows reparse tag without following it. The tag is
 *  always null under Node (no `st_reparse_tag`); the shape is kept so plans
 *  read the same. Like Python, anything that is not a link is "file". */
function entryIdentityImpl (p) {
  const kind = entryKind(p)
  if (kind === 'missing') return null
  return [LINK_KINDS.has(kind) ? kind : 'file', null]
}
const entryIdentity = (p) => _seams.entryIdentity(p)

// ── git ────────────────────────────────────────────────────────────────────

function git (root, ...args) {
  const result = _seams.run(['git', '-C', root, ...args])
  if (result.status) throw new GitError(result.stderr.trim() || 'git operation failed')
  return result.stdout
}

/** Python's `str.splitlines()` boundaries. */
const splitlines = (text) => {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Parse `git worktree list --porcelain` output without path traversal. */
export function parseWorktreePorcelain (raw) {
  const rows = []
  let row = {}
  for (const line of [...splitlines(raw.replace(/\x00/g, '\n')), '']) {
    if (!line) {
      if (Object.keys(row).length) { rows.push(row); row = {} }
      continue
    }
    const at = line.indexOf(' ')
    const key = at < 0 ? line : line.slice(0, at)
    const value = at < 0 ? '' : line.slice(at + 1)
    if (key === 'worktree') row.path = value
    else if (key === 'HEAD') row.head = value
    else if (key === 'branch') row.branch = value
    else if (['bare', 'detached', 'locked', 'prunable'].includes(key)) row[key] = value || true
  }
  return rows
}

/** Return [dirty, unmerged, readable] status flags. */
function statusImpl (root) {
  let raw
  try {
    raw = git(root, 'status', '--porcelain=v2', '--untracked-files=all')
  } catch (error) {
    if (error instanceof GitError || isOsError(error)) return [true, true, false]
    throw error
  }
  const dirty = Boolean(raw.trim())
  const unmerged = splitlines(raw).some((line) => line.startsWith('u ') || line.startsWith('UU '))
  return [dirty, unmerged, true]
}

/**
 * The top level of the MAIN checkout, asked of Git rather than guessed.
 *
 * ⚠ NOT `rev-parse --show-toplevel`, which inside a linked worktree answers
 * with that worktree. Using it would nest every new worktree under whichever
 * one the agent happened to be standing in, so `.worktrees` would sprawl
 * into a chain instead of being the one flat directory the team shares.
 * `--git-common-dir` is the main checkout's `.git` from anywhere in the
 * repository, and its parent is the root this helper means everywhere.
 */
function repositoryRootImpl (p) {
  const common = git(String(p), 'rev-parse', '--path-format=absolute', '--git-common-dir').trim()
  return canonical(path.dirname(common))
}
export const repositoryRoot = (p) => _seams.repositoryRoot(p)

// ── the rule ───────────────────────────────────────────────────────────────

/**
 * Walk the chain Node walks, and report where the dependencies come from.
 *
 * This is the check that turns the rule from folklore into something a
 * command can assert. It never follows a link: a `node_modules` that IS a
 * link is reported as one and flagged, because that is the shape that shares
 * a dependency tree between two checkouts.
 */
export function dependencyResolution (worktree, { directory = DEPENDENCY_DIR } = {}) {
  const start = canonical(worktree)
  const chain = []
  let current = start
  for (;;) {
    const candidate = pyJoin(current, directory)
    const kind = entryKind(candidate)
    if (kind !== 'missing') {
      chain.push({ path: candidate, kind })
      const linked = LINK_KINDS.has(kind)
      return {
        worktree: start,
        resolves: true,
        resolved: candidate,
        kind,
        linked,
        own: canonical(path.dirname(candidate)) === start,
        searched: chain,
        note: linked
          ? 'dependencies are reached through a link, which shares one tree ' +
            'between checkouts - this is the shape that loses data'
          : 'dependencies resolve upward to a real directory; nothing is shared by link',
      }
    }
    chain.push({ path: candidate, kind })
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return {
    worktree: start,
    resolves: false,
    resolved: null,
    kind: 'missing',
    linked: false,
    own: false,
    searched: chain,
    note: `no ${directory} anywhere on the upward chain - this worktree is not under a ` +
      'checkout that has one, so its suites cannot run without installing ' +
      'dependencies into it',
  }
}

/**
 * Decide where a private worktree goes, and refuse the shapes that hurt.
 *
 * The default destination is `<repository root>/.worktrees/<name>`. A
 * destination outside the root is refused unless it is asked for explicitly,
 * because outside the root is exactly the case that has no upward
 * `node_modules` and therefore invites a junction.
 *
 * Option keys keep the Python spellings (`allow_outside_root`, ...) because the
 * refusal sentences name them.
 */
export function planAdd (repository, name, { base = 'main', branch = null, path: dest = null, allow_outside_root = false } = {}) {
  if (!name || name.trim() !== name || [...'\\/:*?"<>|'].some((c) => name.includes(c))) {
    throw new RefusalError('worktree name must be a single plain path segment')
  }
  const root = repositoryRoot(repository)
  const destination = dest ? canonical(dest) : pyJoin(root, WORKTREES_DIR, name)
  const inside = contained(destination, root) && canonical(destination) !== root
  if (!inside && !allow_outside_root) {
    throw new RefusalError(
      `refusing to place a worktree outside the repository root (${root}). ` +
      `A worktree under the root resolves ${DEPENDENCY_DIR} upward and its suites ` +
      'just run; one outside it does not, and the usual next step - junctioning ' +
      `${DEPENDENCY_DIR} back into the real checkout - is what deleted 783 MB of ` +
      "somebody's checkout. Pass allow_outside_root only if you have another way " +
      'to supply dependencies and accept that this worktree is not private.')
  }
  if (contained(destination, pyJoin(root, '.git'))) throw new RefusalError('refusing to place a worktree inside .git')
  if (entryKind(destination) !== 'missing') throw new RefusalError(`destination already exists: ${destination}`)
  return {
    repository: root,
    name,
    path: destination,
    branch: branch || name,
    base,
    inside_repository_root: inside,
    dependency_junction: false,
    command: ['git', '-C', root, 'worktree', 'add', '-b', branch || name, destination, base],
  }
}

/**
 * Create the worktree, then PROVE its suites can run before reporting success.
 *
 * Verification is the point. `git worktree add` succeeding says nothing
 * about whether the checkout is usable, and an agent that discovers the
 * difference does so by debugging its own patch against environmental
 * failures. (It REPORTS `ready`; it does not refuse when dependencies do not
 * resolve - the output is the gate, and it can be read literally.)
 */
export function add (repository, name, { base = 'main', branch = null, path: dest = null, allow_outside_root = false, apply = true } = {}) {
  const plan = planAdd(repository, name, { base, branch, path: dest, allow_outside_root })
  if (!apply) { plan.applied = false; return plan }
  const result = _seams.run(plan.command)
  if (result.status) throw new GitError(result.stderr.trim() || 'git worktree add failed')
  if (entryKind(plan.path) !== 'directory') throw new GitError('git reported success but the worktree is not a directory')
  plan.applied = true
  plan.dependencies = dependencyResolution(plan.path)
  plan.ready = Boolean(plan.dependencies.resolves)
  plan.run_tests = plan.ready ? ['npm', 'test'] : null
  plan.next = plan.ready
    ? `cd ${plan.path} && npm test`
    : `dependencies do not resolve from ${plan.path}; install them there before ` +
      `running the suites, and do NOT link ${DEPENDENCY_DIR} in from another checkout`
  return plan
}

function listDir (p) {
  try { return _seams.readdir(p) } catch (error) { if (isOsError(error)) return null; throw error }
}

/**
 * Find every link inside a worktree WITHOUT following a single one.
 *
 * `git worktree remove --force` deletes the tree, and a directory junction
 * inside that tree is a door out of it. This scan is what makes the door
 * visible before anything is deleted; it is also why the walk below never
 * descends into a reparse point.
 */
function removalScanImpl (worktree, { limit = SCAN_LIMIT } = {}) {
  const root = canonical(worktree)
  if (entryKind(root) !== 'directory') throw new RefusalError('worktree must be a real directory')
  const links = []
  let seen = 0
  let truncated = false
  let pending = [root]
  while (pending.length) {
    const current = pending.pop()
    const names = listDir(current)
    if (names === null) continue
    const dev = lstatOrNull(current)?.dev
    for (const entryName of names) {
      seen += 1
      if (seen > limit) { truncated = true; pending = []; break }
      const entryPath = pyJoin(current, entryName)
      const kind = entryKind(entryPath, dev)
      if (LINK_KINDS.has(kind)) {
        const target = readlinkOrNull(entryPath)
        links.push({
          path: canonical(entryPath),
          kind,
          target,
          // A link whose target sits outside the worktree is the one
          // that turns a delete of this tree into a delete of another.
          // An unreadable target counts as escaping, and so does a
          // target spelled with an 8.3 short name the root does not
          // use - both are false alarms in the safe direction, which
          // costs a refused --force. The unsafe direction, calling an
          // escaping link contained, is not reachable this way:
          // respelling a path never moves it inside the root.
          escapes: !(target !== null && contained(target, root)),
        })
        continue
      }
      if (kind === 'directory') pending.push(entryPath)
    }
  }
  const escaping = links.filter((link) => link.escapes)
  return {
    worktree: root,
    links,
    escaping,
    entries_scanned: Math.min(seen, limit),
    truncated,
    // `removal_safe` is the accurate name: an escaping link makes ANY
    // removal unsafe, not only a forced one. `force_safe` is kept as an
    // alias because callers and tests already read it, and it has never
    // meant anything different - only the name was narrower than the fact.
    removal_safe: !escaping.length && !truncated,
    force_safe: !escaping.length && !truncated,
  }
}
export const removalScan = (worktree, opts) => _seams.removalScan(worktree, opts)

/**
 * Decide whether this removal is safe, and say exactly why when it is not.
 *
 * `accept_unscanned` waives ONLY the truncated-scan refusal, and nothing
 * else. It exists because "I could not finish looking" and "I looked and found
 * a link" are different facts that deserve different answers: the second is a
 * measured hazard and is never waivable, while the first is an unknown the
 * caller may be entitled to accept. It is a separate word from `force` on
 * purpose - `force` means "discard my changes", and overloading it into
 * "and also stop checking for links" is how the original defect happened.
 */
export function planRemove (repository, worktree, { force = false, accept_unscanned = false } = {}) {
  const root = repositoryRoot(repository)
  const target = canonical(worktree)
  if (canonical(target) === root) throw new RefusalError('refusing to remove the main checkout')
  const scan = removalScan(target)
  const [dirty, unmerged, readable] = _seams.status(target)
  const refusals = []
  // ⚠ DELIBERATELY NOT `if (force)`. `--force` is not the dangerous ingredient
  // and never was: it overrides the dirty/untracked CHECK, it does not change
  // how Git deletes the tree afterwards. Measured on git 2.52.0.windows.1, in
  // a real worktree under the repository root with a `node_modules` junction
  // pointing outside it: `git worktree remove` with NO flags exited 0 and
  // emptied the junction's target, exactly as `--force` did.
  //
  // The un-forced path was the one actually reached, too. A `node_modules`
  // junction is gitignored, so `status` reports the worktree clean, so none
  // of the force-only refusals below applied and the removal went straight
  // through. Gating the link check on `force` therefore guarded the careful
  // route and left the default one open. Both refuse now.
  if (scan.escaping.length) {
    refusals.push(
      `refusing to remove: this worktree contains ${scan.escaping.length} link(s) pointing outside it ` +
      `(${scan.escaping.slice(0, 4).map((link) => link.path).join(', ')}). Removing the worktree deletes through them and takes the target with ` +
      'it - this is the failure that emptied a 783 MB checkout, and it happens WITHOUT ' +
      '--force just the same. Unlink them first (`node tools/worktree.mjs cleanup-scan ' +
      `${target}\`), then remove the worktree.`)
  }
  // The truncation refusal IS waivable, unlike the one above. A truncated scan
  // reports an unknown; an escaping link reports a measured hazard. Waiving
  // the first is a decision a caller can be entitled to make, and refusing it
  // outright would make every worktree containing a real installed
  // node_modules permanently unremovable by this tool - which is the
  // population most in need of cleaning up.
  if (scan.truncated && !accept_unscanned) {
    refusals.push(
      `refusing to remove: the link scan stopped after ${SCAN_LIMIT} entries, so ` +
      "'no escaping links' would be a guess rather than a result. If this worktree " +
      `simply has a large real ${DEPENDENCY_DIR} installed in it, that is expected - ` +
      'pass accept_unscanned (--accept-unscanned) to remove it anyway, which waives ' +
      'ONLY this unknown and never a link the scan actually found.')
  }
  if ((dirty || unmerged) && !force) refusals.push('worktree has uncommitted or unmerged changes; commit them or pass force')
  if (!readable && !force) refusals.push('worktree status could not be read')
  const command = ['git', '-C', root, 'worktree', 'remove', target]
  if (force) command.splice(command.length - 1, 0, '--force')
  return {
    repository: root,
    worktree: target,
    force,
    accept_unscanned,
    dirty,
    unmerged,
    links: scan.links,
    escaping: scan.escaping,
    truncated: scan.truncated,
    refusals,
    safe: !refusals.length,
    command,
  }
}

/** Remove a worktree, but never remove one through a link that leaves it. */
export function remove (repository, worktree, { force = false, accept_unscanned = false, apply = true } = {}) {
  const plan = planRemove(repository, worktree, { force, accept_unscanned })
  if (!plan.safe) throw new RefusalError(plan.refusals.join('; '))
  if (!apply) { plan.applied = false; return plan }
  const result = _seams.run(plan.command)
  if (result.status) throw new GitError(result.stderr.trim() || 'git worktree remove failed')
  plan.applied = true
  return plan
}

/**
 * Return a compact, filterable inventory and honest omitted counts.
 *
 * `owners` and `active_refs` are deliberately caller-supplied. Git does
 * not know which application identity owns a checkout or which external
 * reference is active, so inventing those values would make cleanup unsafe.
 */
export function inventory (repository, { owners = null, active_refs = null, query = null, include_hidden = false, limit = 60 } = {}) {
  if (limit < 1) throw new RefusalError('limit must be positive')
  const rows = parseWorktreePorcelain(git(repository, 'worktree', 'list', '--porcelain'))
  owners = owners || {}
  active_refs = active_refs || {}
  const own = (k) => (Object.hasOwn(owners, k) ? owners[k] : undefined)
  const visible = []
  let hidden = 0
  for (const row of rows) {
    const p = String(row.path ?? '')
    const branch = String(row.branch ?? '')
    const owner = own(p) || own(canonical(p)) || null
    const refs = [...(Object.hasOwn(active_refs, branch) ? active_refs[branch] : [])]
    let [dirty, unmerged, readable] = [false, false, true]
    if (!row.bare) [dirty, unmerged, readable] = _seams.status(p)
    const item = {
      repository: canonical(repository),
      path: p,
      branch: branch || null,
      owner,
      dirty,
      unmerged,
      readable,
      active_references: refs,
      active: Boolean(refs.length),
      bare: Boolean(row.bare),
      locked: Boolean(row.locked),
      prunable: Boolean(row.prunable),
    }
    if (!include_hidden && p && DEFAULT_HIDDEN.has(path.basename(p))) { hidden += 1; continue }
    if (query && !casefold(pyJsonDumps(item)).includes(casefold(query))) { hidden += 1; continue }
    visible.push(item)
  }
  const omitted = Math.max(0, visible.length - limit)
  return {
    repository: canonical(repository),
    worktrees: visible.slice(0, limit),
    total: rows.length,
    visible: visible.length,
    hidden,
    omitted,
    complete: omitted === 0,
    dirty: visible.filter((r) => r.dirty).length,
    unmerged: visible.filter((r) => r.unmerged).length,
    active: visible.filter((r) => r.active).length,
  }
}

const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }

/**
 * Describe deterministic local setup without granting Git metadata writes.
 *
 * The returned command is intentionally data only. A caller may execute it
 * after review; this helper never runs package managers or writes `.git`.
 *
 * ⚠ `dependency_source` is the junction route and it is now GATED. When the
 * worktree already reaches a real dependency tree by walking upward - which
 * is true of every worktree placed under the repository root - linking one in
 * adds nothing and costs privacy, so it is refused outright. When upward
 * resolution genuinely is unavailable, the caller must still say
 * `accept_shared_dependencies` in as many words, because the resulting
 * checkout shares the most failure-prone directory in the repository with
 * another one and a later `remove --force` can delete through the link.
 */
export function dependencySetup (worktree, { package_manager = null, dependency_source = null, apply = false, accept_shared_dependencies = false } = {}) {
  const root = canonical(worktree)
  if (entryKind(root) !== 'directory') throw new RefusalError('worktree must be a real directory')
  const resolution = dependencyResolution(root)
  let link = null
  if (dependency_source) {
    if (resolution.resolves && !resolution.linked) {
      throw new RefusalError(
        `refusing to link ${DEPENDENCY_DIR}: this worktree already resolves it ` +
        `upward to ${resolution.resolved}, so its suites run as they stand. ` +
        'A junction here would buy nothing and would share one dependency tree ' +
        "between two checkouts - the shape that lets one agent's test run delete " +
        "another's bundles and lets `remove --force` delete through the link.")
    }
    if (!accept_shared_dependencies) {
      throw new RefusalError(
        `refusing to link ${DEPENDENCY_DIR} without accept_shared_dependencies. ` +
        'The supported fix is to place the worktree UNDER the repository root ' +
        `(${WORKTREES_DIR}/<name>), where ${DEPENDENCY_DIR} resolves upward and no ` +
        'link is needed; the second choice is installing dependencies into this ' +
        'worktree. Linking makes the worktree non-private and is opt-in only.')
    }
    const source = canonical(dependency_source)
    const destination = pyJoin(root, DEPENDENCY_DIR)
    if (entryKind(source) !== 'directory') throw new RefusalError('dependency source must be a real directory')
    const existing = entryKind(destination)
    if (!['missing', 'directory', 'symlink', 'reparse'].includes(existing)) throw new RefusalError('node_modules destination is not a directory')
    if (LINK_KINDS.has(existing)) throw new RefusalError('node_modules is already a link; refusing to replace it')
    if (existing === 'directory') throw new RefusalError('node_modules directory already exists; refusing to replace it')
    link = { source, destination, command: ['cmd', '/c', 'mklink', '/J', destination, source], ready: true }
    if (apply) {
      if (!WIN) throw new RefusalError('junction setup is supported on Windows only')
      const result = _seams.run(link.command)
      if (result.status) throw new GitError((result.stderr || '').trim() || 'dependency junction creation failed')
      if (!isReparse(destination)) throw new GitError('dependency junction was not created; refusing to continue')
      link.applied = true
    } else {
      link.applied = false
    }
  }
  const packageJson = isFile(pyJoin(root, 'package.json'))
  const lockfile = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']
    .find((n) => isFile(pyJoin(root, n))) ?? null
  const manager = package_manager || (packageJson ? 'npm' : null)
  if (![null, 'npm', 'yarn', 'pnpm'].includes(manager)) throw new RefusalError('unsupported package manager')
  let command = null
  if (packageJson && manager === 'npm') command = lockfile ? [manager, 'ci'] : [manager, 'install']
  else if (packageJson && (manager === 'yarn' || manager === 'pnpm')) command = lockfile ? [manager, 'install', '--frozen-lockfile'] : [manager, 'install']
  const result = {
    worktree: root,
    package_manager: manager,
    lockfile,
    command,
    git_metadata_write: false,
    ready: Boolean(command),
    // Reported whether or not a link was asked for: an agent that can see
    // "already resolves upward to <path>" does not need to be told a rule,
    // and does not go looking for a junction.
    dependencies: resolution,
    note: resolution.resolves && !resolution.linked
      ? 'Dependencies already resolve upward; no install and no link are needed.'
      : 'Run this explicitly in the fresh worktree; no generic Git write is granted.',
  }
  if (link !== null) result.dependency_link = link
  return result
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function replaceContained (value, oldRoot, newRoot) {
  const old = canonical(oldRoot)
  const current = canonical(value)
  if (current === old || contained(current, old)) {
    const suffix = current.slice(old.length).replace(/^[\\/]+/, '')
    return [pyJoin(canonical(newRoot), suffix), true]
  }
  return [value, false]
}

/**
 * Repair only registered paths contained by `oldRoot`.
 *
 * No old-path alias is created. Unrelated paths, including similarly named
 * siblings, remain byte-for-byte unchanged. Returns [repaired, moved].
 */
export function repairRegisteredWorktrees (registry, oldRoot, newRoot) {
  const old = canonical(oldRoot)
  const fresh = canonical(newRoot)
  const repaired = JSON.parse(JSON.stringify(registry))
  const moved = []
  const repos = Object.hasOwn(repaired, 'repositories') ? repaired.repositories : {}
  if (!isPlainObject(repos)) throw new RefusalError('registry repositories must be an object')
  for (const repo of Object.values(repos)) {
    if (!isPlainObject(repo)) continue
    const agents = repo.worktree_agents
    if (!isPlainObject(agents)) continue
    for (const [agent, value] of Object.entries(agents)) {
      const paths = typeof value === 'string' ? [value] : value
      if (!Array.isArray(paths)) continue
      const updated = []
      for (const p of paths) {
        if (typeof p !== 'string') { updated.push(p); continue }
        const [next, changed] = replaceContained(p, old, fresh)
        updated.push(next)
        if (changed) moved.push({ agent: String(agent), old: p, new: next })
      }
      agents[agent] = updated
    }
  }
  return [repaired, moved]
}

function ownedLink (p, root, owned) {
  if (!contained(p, root)) return [false, 'outside cleanup root']
  if (!new Set([...owned].map(canonical)).has(canonical(p))) return [false, 'not registered as an owned link']
  if (!LINK_KINDS.has(entryKind(p))) return [false, 'not a junction or reparse point']
  return [true, 'validated owned link']
}

/**
 * Preview cleanup targets; optionally callers may unlink approved entries.
 *
 * This function only reads directory entries. It does not walk candidates,
 * resolve targets, or remove anything. Unknown reparse points are blocked.
 */
export function cleanupPreview (root, candidates, { owned = [] } = {}) {
  root = canonical(root)
  const entries = []
  for (const candidate of candidates) {
    const p = canonical(path.isAbsolute(candidate) ? candidate : pyJoin(root, candidate))
    const [ok, reason] = ownedLink(p, root, owned)
    const entry = { path: p, action: ok ? 'unlink' : 'preserve', reason }
    if (ok) {
      entry.owned = true
      entry.kind = entryKind(p)
      entry.identity = entryIdentity(p)
      const target = readlinkOrNull(p)
      if (target === null) {
        entry.action = 'preserve'
        entry.reason = 'reparse target could not be validated'
      }
      entry.target = target
    }
    entries.push(entry)
  }
  return {
    root,
    targets: entries,
    unlinkable: entries.filter((e) => e.action === 'unlink').length,
    preserved: entries.filter((e) => e.action !== 'unlink').length,
    retirement_authorized: false,
    applied: false,
  }
}

/**
 * Enumerate every link under a root WITHOUT following a single one.
 *
 * This is the half that was missing. `cleanupPreview` could always validate
 * a candidate, but nothing produced the candidate list, so a cleanup could
 * only ever be run against paths somebody had already typed out by hand.
 *
 * Both bounds are REPORTED rather than applied quietly. A scan that stopped
 * early and said nothing would turn "no links found" into a claim it has not
 * earned, and this is a tool whose whole job is to be trusted about what is
 * and is not there. `truncated` means the entry budget ran out;
 * `depth_limited` lists directories that were not descended into.
 *
 * Directories named in `SCAN_SKIP_DIRS` are recorded and not descended.
 * A real `node_modules` holds tens of thousands of entries and cannot
 * contain what this scan is looking for, so walking it would exhaust the
 * budget and truncate the part that matters. A `node_modules` that IS a
 * link is still recorded - the link check happens first.
 */
export function findReparsePoints (root, { max_depth = DEFAULT_SCAN_DEPTH, limit = SCAN_ROOT_LIMIT } = {}) {
  const start = canonical(root)
  if (entryKind(start) !== 'directory') throw new RefusalError('scan root must be a real directory')
  if (max_depth < 1) throw new RefusalError('max_depth must be positive')
  const links = []
  const unreadable = []
  const depthLimited = []
  const skipped = []
  let seen = 0
  let truncated = false
  let pending = [[start, 0]]
  while (pending.length) {
    const [current, depth] = pending.pop()
    const names = listDir(current)
    if (names === null) { unreadable.push(current); continue }
    const dev = lstatOrNull(current)?.dev
    for (const entryName of names) {
      seen += 1
      if (seen > limit) { truncated = true; pending = []; break }
      const entryPath = pyJoin(current, entryName)
      const kind = entryKind(entryPath, dev)
      if (LINK_KINDS.has(kind)) {
        const target = readlinkOrNull(entryPath)
        links.push({
          path: canonical(entryPath),
          name: path.basename(entryPath),
          kind,
          target: target !== null ? stripExtendedPrefix(target) : null,
          // Unreadable counts as escaping, which is the safe
          // direction: it costs a preserved link, never a followed one.
          escapes_root: !(target !== null && contained(target, start)),
        })
        continue
      }
      if (kind !== 'directory') continue
      if (SCAN_SKIP_DIRS.has(path.basename(entryPath))) { skipped.push(entryPath); continue }
      if (depth + 1 >= max_depth) { depthLimited.push(entryPath); continue }
      pending.push([entryPath, depth + 1])
    }
  }
  return {
    root: start,
    links,
    escaping: links.filter((link) => link.escapes_root),
    entries_scanned: Math.min(seen, limit),
    truncated,
    depth_limited: depthLimited,
    skipped_directories: skipped,
    unreadable,
    max_depth,
    // Two different honesties, because they are two different facts and
    // collapsing them makes the useful one useless. `complete` means
    // everything WITHIN the requested depth was examined - the scan did what
    // it was asked to. `exhaustive` additionally means nothing anywhere
    // was skipped. On any real tree some directory is always deeper than the
    // bound, so a single flag folding them together would read False forever
    // and stop carrying information.
    complete: !truncated && !unreadable.length,
    exhaustive: !truncated && !unreadable.length && !depthLimited.length,
  }
}

/**
 * Enumerate the hazard shape and return a plan `applyCleanup` can run.
 *
 * Selection is deliberately narrow. A link is marked for unlinking only when
 * it is named `name` (`node_modules` by default), its target is readable,
 * and that target lies OUTSIDE the scanned root - which is the exact shape
 * that turns a worktree removal into somebody else's data loss. Every other
 * link found is listed and preserved, with the reason attached, so the output
 * documents what was seen and skipped instead of quietly narrowing.
 *
 * ⚠ Unlinking one of these leaves that worktree unable to resolve its
 * dependencies, because the link was how it resolved them. That is correct
 * and intended - the worktree was never private to begin with - but it is a
 * consequence to know about rather than discover, so it is stated in `note`.
 */
export function cleanupScan (root, { name = DEPENDENCY_DIR, max_depth = DEFAULT_SCAN_DEPTH, limit = SCAN_ROOT_LIMIT } = {}) {
  const survey = findReparsePoints(root, { max_depth, limit })
  const selected = survey.links
    .filter((link) => (name === null || casefold(link.name) === casefold(name)) &&
      link.escapes_root && link.target !== null)
    .map((link) => link.path)
  const preview = cleanupPreview(survey.root, survey.links.map((link) => link.path), { owned: selected })
  // `cleanupPreview` can only say "not registered as an owned link", which
  // is true and useless to the person reading the plan: it describes the
  // mechanism rather than the decision. Say which of this function's own
  // criteria the link failed, so a preserved entry can be argued with instead
  // of just wondered about.
  const byPath = new Map(survey.links.map((link) => [link.path, link]))
  for (const entry of preview.targets) {
    const link = byPath.get(entry.path)
    if (entry.action === 'unlink' || link === undefined) continue
    if (name !== null && casefold(link.name) !== casefold(name)) {
      entry.reason = `not selected: named ${pyRepr(link.name)}, not ${pyRepr(name)}`
    } else if (link.target === null) {
      entry.reason = 'not selected: link target could not be read'
    } else if (!link.escapes_root) {
      entry.reason = `not selected: target ${link.target} is INSIDE the scanned ` +
        'root, so removing this tree does not reach outside it'
    }
  }
  preview.survey = survey
  preview.selection = { name, escaping_only: true, selected: selected.length, links_found: survey.links.length }
  preview.complete = survey.complete
  preview.exhaustive = survey.exhaustive
  // The order matters and is the whole safe sequence: unlink the junction
  // FIRST, then remove the worktree. Doing it the other way round is the
  // incident. `rmdir` on a junction removes the link and does not follow it;
  // a recursive delete follows it and empties the target.
  preview.remediation = [
    {
      step: 1,
      what: 'unlink the junction (never follows it)',
      command: ['cmd', '/c', 'rmdir', '<link>'],
      equivalently: 'node tools/worktree.mjs cleanup-apply <plan.json> --confirm',
      never: ['rmdir /s', 'Remove-Item -Recurse', 'rm -rf'],
    },
    {
      step: 2,
      what: 'remove the worktree, now that nothing leaves it',
      command: ['node', 'tools/worktree.mjs', 'remove', '<worktree>'],
    },
  ]
  // ⚠ THE WARNING GOES FIRST WHEN IT CHANGES THE NUMBER. Whoever acts on this
  // plan is reading it for a count, and a caveat printed after the remediation
  // steps arrives too late to stop them treating a partial scan as a census.
  // A bounded scan that nonetheless SELECTED something is the dangerous
  // combination: it looks like a completed cleanup and silently leaves
  // junctions behind.
  const warnings = []
  if (!survey.complete) {
    warnings.push(
      '⚠ THIS SCAN IS INCOMPLETE (see survey.truncated / survey.unreadable). It is not a ' +
      'census of what exists under this root - raise --limit and rerun before treating ' +
      'any count here as complete.')
  } else if (!survey.exhaustive) {
    const deeper = survey.depth_limited.length
    warnings.push(
      `⚠ THIS SCAN IS BOUNDED AT --max-depth ${max_depth}; ${deeper} director` +
      `${deeper === 1 ? 'y' : 'ies'} below that depth ${deeper === 1 ? 'was' : 'were'}` +
      ' not descended into, so links below that ' +
      'depth are NOT in this plan and NOT in its counts. Everything within the depth was ' +
      "examined ('complete'), which is not the same as everything ('exhaustive'). Raise " +
      '--max-depth AND --limit together - raising depth alone exhausts the budget and ' +
      'finds fewer links, not more.' +
      (selected.length
        ? ' Links WERE selected at this depth, so applying this plan will clean up some ' +
          'and leave the deeper ones in place.'
        : ''))
  }
  preview.note = [...warnings,
    'Unlinking removes the link itself and never its target. A worktree whose ' +
    `${DEPENDENCY_DIR} link is removed can no longer resolve dependencies from it; ` +
    'the supported fix is to recreate that worktree under the repository root, where ' +
    `${DEPENDENCY_DIR} resolves upward and no link is needed.`].join(' ')
  // One word for the only question an operator running a cleanup actually has:
  // "is this everything?" It is true only when nothing was skipped for any
  // reason - not budget, not readability, not depth.
  preview.census = survey.exhaustive
  return preview
}

const sameIdentity = (a, b) => Array.isArray(a) && Array.isArray(b) &&
  a.length === b.length && a.every((v, i) => v === b[i])

/** Unlink only a previously previewed, validated link itself. */
export function applyCleanup (preview, { confirm = false } = {}) {
  if (!confirm) throw new RefusalError('cleanup requires explicit confirmation after preview')
  if (!isPlainObject(preview)) throw new TypeError('cleanup plan must be a JSON object')
  const result = JSON.parse(JSON.stringify(preview))
  const removed = []
  for (const entry of Object.hasOwn(result, 'targets') ? result.targets : []) {
    if (!isPlainObject(entry)) throw new TypeError('cleanup plan targets must be objects')
    const p = entry.path
    if (entry.action !== 'unlink' || entry.owned !== true || typeof p !== 'string') continue
    const expectedIdentity = entry.identity
    const identityChanged = Object.hasOwn(entry, 'identity') &&
      (!Array.isArray(expectedIdentity) || !sameIdentity(entryIdentity(p), expectedIdentity))
    if (entryKind(p) !== entry.kind || !LINK_KINDS.has(entry.kind) || identityChanged) {
      entry.action = 'preserve'; entry.reason = 'changed since preview'
      continue
    }
    const currentTarget = readlinkOrNull(p)
    if (entry.target === null || entry.target === undefined || currentTarget !== entry.target) {
      entry.action = 'preserve'; entry.reason = 'link target changed since preview'
      continue
    }
    try {
      _seams.unlink(p)
    } catch (error) {
      if (!['EISDIR', 'EPERM', 'EACCES'].includes(error?.code)) throw error
      // On Windows a directory junction may need rmdir. lstat was already
      // used for validation; do not call stat()/isDirectory() through the
      // link, which would follow an unvalidated target. (Python checked
      // S_ISDIR on its lstat, which a junction satisfies there; libuv reports
      // a junction as a symlink, so either reading is accepted here.)
      const info = lstatOrNull(p)
      if (!info) { entry.action = 'preserve'; entry.reason = 'changed since preview'; continue }
      if (!info.isDirectory() && !info.isSymbolicLink()) {
        entry.action = 'preserve'; entry.reason = 'unlink refused'
        continue
      }
      _seams.rmdir(p)
    }
    removed.push(p)
    entry.action = 'unlinked'
  }
  result.removed = removed
  result.applied = true
  return result
}

// ── CLI ────────────────────────────────────────────────────────────────────
// A small argparse work-alike: same subcommands, flags, defaults, unique-prefix
// abbreviations (`--dry` for `--dry-run`), `--flag=value`, `--`, and exit 2
// with a usage line on a malformed command. The usage/help TEXT is not
// argparse's byte for byte; the exit codes and the parsed values are.

const opt = (help, extra = {}) => ({ help, ...extra })
const COMMANDS = {
  add: {
    help: 'create a private worktree under the repository root',
    positionals: [{ dest: 'name', help: 'worktree directory name under .worktrees/' }],
    options: {
      '--repository': opt('any path inside the repository', { value: true, default: '.' }),
      '--base': opt('commit or branch to start from', { value: true, default: 'main' }),
      '--branch': opt('branch to create (defaults to the name)', { value: true }),
      '--path': opt('explicit destination; must be under the repository root', { value: true }),
      '--allow-outside-root': opt('place it outside the root; its suites will not find dependencies'),
      '--dry-run': opt('print the plan without creating it'),
    },
  },
  remove: {
    help: 'remove a worktree without deleting through a link',
    positionals: [{ dest: 'worktree' }],
    options: {
      '--repository': opt('', { value: true, default: '.' }),
      '--force': opt('discard uncommitted changes. It does NOT affect the link check: a ' +
        'removal is refused when a link leaves the worktree whether or not ' +
        'this is passed, because an un-forced removal deletes through a link ' +
        'exactly as a forced one does'),
      '--accept-unscanned': opt('proceed when the link scan could not finish (a large real ' +
        `${DEPENDENCY_DIR} does this). Waives only that unknown, never a ` +
        'link the scan actually found'),
      '--dry-run': opt(''),
    },
  },
  verify: {
    help: 'report where an existing worktree gets dependencies',
    positionals: [{ dest: 'worktree' }],
    options: {},
  },
  inventory: {
    help: '',
    positionals: [{ dest: 'repository' }],
    options: {
      '--query': opt('', { value: true }),
      '--limit': opt('', { value: true, int: true, default: 60 }),
      '--include-hidden': opt(''),
    },
  },
  setup: {
    help: '',
    positionals: [{ dest: 'worktree' }],
    options: {
      '--package-manager': opt('', { value: true }),
      '--dependency-source': opt('', { value: true }),
      '--apply': opt(''),
      '--accept-shared-dependencies': opt('opt in to a node_modules link and to this worktree not being private'),
    },
  },
  'cleanup-preview': {
    help: '',
    positionals: [{ dest: 'root' }, { dest: 'candidates', many: true }],
    options: {},
  },
  'cleanup-scan': {
    help: 'enumerate escaping dependency links under a root and emit a cleanup plan',
    positionals: [{ dest: 'root', help: 'directory to scan; links are never followed' }],
    // ⚠ SCAN_ROOT_LIMIT, not SCAN_LIMIT. These defaults must match the ones on
    // `cleanupScan` itself: this is the path an operator actually runs, and a
    // CLI default below the API default makes the command truncate on a real
    // root and emit a short plan while the library call on the same root returns
    // a full one. That shipped once - the whole-root budget is 5x the
    // per-worktree one, and borrowing the smaller number here cut a 572,301-entry
    // scan off at 400,000 and reported 64 links where there are 82.
    options: {
      '--name': opt(`only select links with this name (default ${DEPENDENCY_DIR}); ` +
        "pass --name '' to consider every name", { value: true, default: DEPENDENCY_DIR }),
      '--max-depth': opt('', { value: true, int: true, default: DEFAULT_SCAN_DEPTH }),
      '--limit': opt('', { value: true, int: true, default: SCAN_ROOT_LIMIT }),
    },
  },
  'cleanup-apply': {
    help: 'unlink the links a cleanup-scan plan selected, after re-validating each one',
    positionals: [{ dest: 'plan', help: 'path to a plan written by cleanup-scan, or - for stdin' }],
    options: {
      '--confirm': opt('required; without it nothing is unlinked'),
    },
  },
}

const PROG = 'worktree.mjs'

/** Thrown by `parseArgs`: `code` 2 for a malformed command, 0 after help. */
export class UsageExit extends Error {
  constructor (code, text) { super(text); this.name = 'UsageExit'; this.code = code; this.text = text }
}

const destOf = (flag) => flag.replace(/^--/, '').replace(/-/g, '_')
const NEGATIVE_NUMBER = /^-\d+$|^-\d*\.\d+$/
const looksLikeOption = (token) => token.startsWith('-') && token !== '-' && !NEGATIVE_NUMBER.test(token)

function usageLine (command) {
  if (!command) return `usage: ${PROG} [-h] {${Object.keys(COMMANDS).join(',')}} ...`
  const spec = COMMANDS[command]
  const opts = Object.entries(spec.options)
    .map(([flag, o]) => (o.value ? `[${flag} ${destOf(flag).toUpperCase()}]` : `[${flag}]`))
  const pos = spec.positionals.map((p) => (p.many ? `${p.dest} [${p.dest} ...]` : p.dest))
  return `usage: ${PROG} ${command} [-h] ${[...opts, ...pos].join(' ')}`.replace(/\s+$/, '')
}

function helpText (command) {
  const lines = [usageLine(command), '']
  if (!command) {
    lines.push('create, verify and remove private worktrees safely', '', 'commands:')
    for (const [name, spec] of Object.entries(COMMANDS)) lines.push(`  ${name.padEnd(16)} ${spec.help}`.trimEnd())
  } else {
    const spec = COMMANDS[command]
    if (spec.help) lines.push(spec.help, '')
    if (spec.positionals.length) {
      lines.push('positional arguments:')
      for (const p of spec.positionals) lines.push(`  ${p.dest.padEnd(28)} ${p.help ?? ''}`.trimEnd())
      lines.push('')
    }
    lines.push('options:', `  ${'-h, --help'.padEnd(28)} show this help message and exit`)
    for (const [flag, o] of Object.entries(spec.options)) {
      const shown = o.value ? `${flag} ${destOf(flag).toUpperCase()}` : flag
      lines.push(`  ${shown.padEnd(28)} ${o.help}`.trimEnd())
    }
  }
  return lines.join('\n') + '\n'
}

const usageError = (command, message) =>
  new UsageExit(2, `${usageLine(command)}\n${PROG}${command ? ' ' + command : ''}: error: ${message}\n`)

function parseInt10 (command, flag, raw) {
  if (!/^\s*[+-]?\d+(_\d+)*\s*$/.test(raw)) throw usageError(command, `argument ${flag}: invalid int value: ${pyRepr(raw)}`)
  return Number(raw.trim().replace(/_/g, ''))
}

/** Parse a command line into `{command, ...values}` with argparse's defaults.
 *  Throws `UsageExit`. Separate from `main` so the defaults are testable: a CLI
 *  default that disagrees with the API default it shadows is invisible from
 *  either side on its own - you have to compare them. */
export function parseArgs (argv) {
  let i = 0
  let command = null
  for (; i < argv.length; i++) {
    const token = argv[i]
    if (token === '-h' || (token.length > 2 && '--help'.startsWith(token))) throw new UsageExit(0, helpText(null))
    if (looksLikeOption(token)) throw usageError(null, `unrecognized arguments: ${token}`)
    command = token
    i += 1
    break
  }
  if (command === null) throw usageError(null, 'the following arguments are required: command')
  if (!Object.hasOwn(COMMANDS, command)) {
    throw usageError(null, `argument command: invalid choice: ${pyRepr(command)} (choose from ${Object.keys(COMMANDS).map(pyRepr).join(', ')})`)
  }
  const spec = COMMANDS[command]
  const values = { command }
  for (const [flag, o] of Object.entries(spec.options)) values[destOf(flag)] = o.value ? (o.default ?? null) : false
  const positionals = []
  const unrecognized = []
  let literal = false
  for (; i < argv.length; i++) {
    const token = argv[i]
    if (literal || !looksLikeOption(token)) { positionals.push(token); continue }
    if (token === '--') { literal = true; continue }
    const eq = token.startsWith('--') ? token.indexOf('=') : -1
    const given = eq > 0 ? token.slice(0, eq) : token
    const explicit = eq > 0 ? token.slice(eq + 1) : undefined
    const flags = [...Object.keys(spec.options), '--help']
    let flag = given === '-h' ? '--help' : flags.find((f) => f === given)
    if (!flag && given.startsWith('--')) {
      const matches = flags.filter((f) => f.startsWith(given))
      if (matches.length > 1) throw usageError(command, `ambiguous option: ${given} could match ${matches.join(', ')}`)
      flag = matches[0]
    }
    if (!flag) { unrecognized.push(token); continue }
    if (flag === '--help') throw new UsageExit(0, helpText(command))
    const o = spec.options[flag]
    if (!o.value) {
      if (explicit !== undefined) throw usageError(command, `argument ${flag}: ignored explicit argument ${pyRepr(explicit)}`)
      values[destOf(flag)] = true
      continue
    }
    let raw = explicit
    if (raw === undefined) {
      const next = argv[i + 1]
      if (next === undefined || looksLikeOption(next)) throw usageError(command, `argument ${flag}: expected one argument`)
      raw = next
      i += 1
    }
    values[destOf(flag)] = o.int ? parseInt10(command, flag, raw) : raw
  }
  const missing = []
  let at = 0
  for (const p of spec.positionals) {
    if (p.many) {
      if (at >= positionals.length) missing.push(p.dest)
      values[p.dest] = positionals.slice(at)
      at = positionals.length
    } else if (at < positionals.length) {
      values[p.dest] = positionals[at++]
    } else {
      missing.push(p.dest)
    }
  }
  if (missing.length) throw usageError(command, `the following arguments are required: ${missing.join(', ')}`)
  unrecognized.push(...positionals.slice(at))
  if (unrecognized.length) throw usageError(command, `unrecognized arguments: ${unrecognized.join(' ')}`)
  return values
}

function dispatch (args, io) {
  let value
  if (args.command === 'add') {
    value = add(args.repository, args.name, {
      base: args.base, branch: args.branch, path: args.path,
      allow_outside_root: args.allow_outside_root, apply: !args.dry_run,
    })
  } else if (args.command === 'remove') {
    value = remove(args.repository, args.worktree, {
      force: args.force, accept_unscanned: args.accept_unscanned, apply: !args.dry_run,
    })
  } else if (args.command === 'verify') {
    value = dependencyResolution(args.worktree)
  } else if (args.command === 'inventory') {
    value = inventory(args.repository, { query: args.query, limit: args.limit, include_hidden: args.include_hidden })
  } else if (args.command === 'setup') {
    value = dependencySetup(args.worktree, {
      package_manager: args.package_manager, dependency_source: args.dependency_source,
      apply: args.apply, accept_shared_dependencies: args.accept_shared_dependencies,
    })
  } else if (args.command === 'cleanup-scan') {
    value = cleanupScan(args.root, { name: args.name || null, max_depth: args.max_depth, limit: args.limit })
  } else if (args.command === 'cleanup-apply') {
    const raw = args.plan === '-' ? io.readStdin() : fs.readFileSync(args.plan, 'utf8')
    let plan
    // Python's json.loads raised ValueError, which the CLI printed as a
    // refusal (exit 2); a plan that is not JSON is declined the same way.
    try { plan = JSON.parse(raw) } catch (error) { throw new RefusalError(error.message) }
    value = applyCleanup(plan, { confirm: args.confirm })
  } else {
    value = cleanupPreview(args.root, args.candidates)
  }
  io.stdout.write(pyJsonDumps(value, 2) + '\n')
  return 0
}

/** Run the CLI; returns the exit code. `io` is injectable for tests. */
export function main (argv = process.argv.slice(2), io = {}) {
  const streams = {
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    readStdin: io.readStdin ?? (() => fs.readFileSync(0, 'utf8')),
  }
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    if (!(error instanceof UsageExit)) throw error
    ;(error.code ? streams.stderr : streams.stdout).write(error.text)
    return error.code
  }
  try {
    return dispatch(args, streams)
  } catch (error) {
    if (error instanceof RefusalError) {
      // A refusal is an ANSWER, not a crash. Printing a stack buries the
      // one sentence that says what to do next under a trace the reader did
      // not ask for, and the refusals in this file are written to be read -
      // they name the hazard and the command that resolves it.
      streams.stderr.write(`refused: ${error.message}\n`)
      return 2
    }
    if (error instanceof GitError) {
      // ⚠ A DIFFERENT WORD ON PURPOSE. GitError is raised when git itself
      // failed, which is a breakage; RefusalError is this tool declining, which
      // is a decision. Printing "refused" over a git failure would tell the
      // reader their request was judged and rejected when in fact nothing
      // judged it, and they would go looking for a policy to satisfy instead
      // of at the error git actually returned.
      streams.stderr.write(`error: ${error.message}\n`)
      return 1
    }
    throw error
  }
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : ''
const self = import.meta.filename ?? ''
if (entry && (WIN ? entry.toLowerCase() === self.toLowerCase() : entry === self)) process.exitCode = main()
