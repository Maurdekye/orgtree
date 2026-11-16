// tools/worktree.mjs - the fail-closed worktree lifecycle helper.
//
// Ported from tests/test_worktree_helper.py (59 cases, deleted in d6d4925) when
// tools/worktree.py became tools/worktree.mjs. One node test per Python test,
// titled with the Python name so the two can be lined up; the Python class is
// the `describe` group. Four cases tested OTHER modules (the deleted Python
// engine's gitworkspace, and tools/run-python-verification.py) and are kept as
// skipped tests that say why. A few cases at the end are new: they pin the
// worktree.py facts that tests/test_worktree_git_permission.py relied on, and
// run the tool against a real throwaway Git repository.
//
// Everything happens under os.tmpdir(), in directories this file created and
// removes itself. Where the Python suite patched module functions with
// `mock.patch.object`, these patch `_seams`, the one object the module routes
// those calls through (an ES module's bindings cannot be patched from outside).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as worktree from '../tools/worktree.mjs'

const { _seams, canonical } = worktree
const WIN = process.platform === 'win32'
const TOOL = path.resolve(import.meta.dirname, '..', 'tools', 'worktree.mjs')

/** Remove a tree this file created, never following a link inside it. */
function safeRemove (p) {
  let info
  try { info = fs.lstatSync(p) } catch { return }
  if (info.isSymbolicLink()) {
    try { fs.unlinkSync(p) } catch { fs.rmdirSync(p) }
  } else if (info.isDirectory()) {
    for (const name of fs.readdirSync(p)) safeRemove(path.join(p, name))
    fs.rmdirSync(p)
  } else {
    fs.unlinkSync(p)
  }
}

/** A fresh directory under os.tmpdir(), removed when the test ends. */
function tempDir (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-worktree-test-'))
  t.after(() => {
    // A worktree registered in a temp repo locks nothing, but give git's
    // own files a chance to be released before removal on Windows.
    try { safeRemove(dir) } catch { /* best effort: it is under tmpdir */ }
  })
  return dir
}

const mkdirp = (...parts) => { const p = path.join(...parts); fs.mkdirSync(p, { recursive: true }); return p }

/**
 * Create a directory link, preferring the kind the incidents involved.
 *
 * ⚠ A WINDOWS JUNCTION, NOT A SYMLINK, wherever one can be made. Symlink
 * creation needs privilege the test account usually lacks - and skipping is
 * exactly wrong for these: a junction is what fourteen agents actually created
 * and what `remove --force` followed out of a checkout. `mklink /J` needs no
 * privilege, so the guards below are exercised against the real shape rather
 * than skipped past. Returns false (and skips the test) only when no directory
 * link can be made at all.
 */
function makeLink (t, link, target) {
  if (WIN) {
    const result = spawnSync('cmd', ['/c', 'mklink', '/J', link, target], { encoding: 'utf8', windowsHide: true })
    if (result.status === 0 && worktree.isReparse(link)) return true
  }
  try {
    fs.symlinkSync(target, link, 'dir')
    return true
  } catch {
    t.skip('directory link creation is unavailable')
    return false
  }
}

/** `mock.patch.object` for the module's seams: patch, run, always restore. */
function patched (overrides, fn) {
  const saved = {}
  for (const key of Object.keys(overrides)) {
    assert.ok(key in _seams, `no seam named ${key}`)
    saved[key] = _seams[key]
    _seams[key] = overrides[key]
  }
  try { return fn() } finally { Object.assign(_seams, saved) }
}

const rootIs = (root) => ({ repositoryRoot: () => canonical(root) })
const clean = { status: () => [false, false, true] }
const dirty = { status: () => [true, false, true] }

const sink = () => { const s = { text: '', write (chunk) { s.text += chunk; return true } }; return s }
function runMain (argv) {
  const stdout = sink()
  const stderr = sink()
  const code = worktree.main(argv, { stdout, stderr })
  return { code, stdout: stdout.text, stderr: stderr.text }
}

const exists = (p) => { try { fs.lstatSync(p); return true } catch { return false } }

describe('WorktreeHelperTests', () => {
  test('test_rename_repairs_only_contained_registered_paths', () => {
    const registry = { repositories: { r: { worktree_agents: { alice: ['C:/scratch/old/project', 'C:/scratch/oldish/project'] } } } }
    const [repaired, moved] = worktree.repairRegisteredWorktrees(registry, 'C:/scratch/old', 'C:/scratch/new')
    assert.equal(moved.length, 1)
    const expectedTail = WIN ? 'new\\project' : 'new/project'
    assert.ok(repaired.repositories.r.worktree_agents.alice[0].toLowerCase().endsWith(expectedTail))
    assert.equal(repaired.repositories.r.worktree_agents.alice[1], 'C:/scratch/oldish/project')
    // The input is not mutated: the repair is a copy.
    assert.equal(registry.repositories.r.worktree_agents.alice[0], 'C:/scratch/old/project')
  })

  test('test_setup_plan_is_lockfile_based_and_does_not_write_git_metadata', (t) => {
    const folder = tempDir(t)
    fs.writeFileSync(path.join(folder, 'package.json'), '{}')
    fs.writeFileSync(path.join(folder, 'package-lock.json'), '{}')
    const plan = worktree.dependencySetup(folder)
    assert.deepEqual(plan.command, ['npm', 'ci'])
    assert.equal(plan.git_metadata_write, false)
    assert.ok(!('dependency_link' in plan))
  })

  test('test_cleanup_protects_operation_only_worktree', {
    skip: 'not a worktree.py case: it tested engine/backend/orgtree/gitworkspace.py ' +
      '(worktree_protected / preview_worktree_cleanup), the Python engine module removed ' +
      'with the Python engine; it has no counterpart in tools/worktree.mjs',
  }, () => {})

  test('test_cleanup_preview_preserves_ordinary_entries', (t) => {
    const folder = tempDir(t)
    const ordinary = path.join(folder, 'ordinary')
    fs.writeFileSync(ordinary, 'keep')
    const preview = worktree.cleanupPreview(folder, [ordinary], { owned: [ordinary] })
    assert.equal(preview.unlinkable, 0)
    assert.ok(exists(ordinary))
  })

  test('test_cleanup_unlinks_link_without_touching_target', (t) => {
    const folder = tempDir(t)
    const target = mkdirp(folder, 'target')
    fs.writeFileSync(path.join(target, 'sentinel'), 'unchanged')
    const link = path.join(folder, 'owned-link')
    if (!makeLink(t, link, target)) return
    const preview = worktree.cleanupPreview(folder, [link], { owned: [link] })
    assert.equal(preview.unlinkable, 1)
    const result = worktree.applyCleanup(preview, { confirm: true })
    assert.deepEqual(result.removed, [canonical(link)])
    assert.ok(!exists(link))
    assert.equal(fs.readFileSync(path.join(target, 'sentinel'), 'utf8'), 'unchanged')
  })

  test('test_cleanup_preserves_link_when_target_changes_after_preview', (t) => {
    const folder = tempDir(t)
    const target = mkdirp(folder, 'target')
    const link = path.join(folder, 'owned-link')
    if (!makeLink(t, link, target)) return
    const preview = worktree.cleanupPreview(folder, [link], { owned: [link] })
    const result = patched({ readlink: () => 'different-target' },
      () => worktree.applyCleanup(preview, { confirm: true }))
    assert.deepEqual(result.removed, [])
    assert.equal(result.targets[0].action, 'preserve')
    assert.ok(worktree.isReparse(link))
  })

  test('test_cleanup_does_not_unlink_replaced_entry_without_filesystem_links', () => {
    const preview = { targets: [{ path: 'C:/checkout/dependency', action: 'unlink', owned: true,
      kind: 'symlink', identity: ['symlink', 1], target: 'old-target' }] }
    let unlinked = 0
    const result = patched({
      entryKind: () => 'symlink',
      entryIdentity: () => ['symlink', 1],
      readlink: () => 'new-target',
      unlink: () => { unlinked += 1 },
      rmdir: () => { unlinked += 1 },
    }, () => worktree.applyCleanup(preview, { confirm: true }))
    assert.deepEqual(result.removed, [])
    assert.equal(result.targets[0].action, 'preserve')
    assert.equal(unlinked, 0)
  })
})

describe('DependencyResolutionTests', () => {
  // The rule itself: a worktree under the root resolves node_modules upward.
  test('test_upward_resolution_finds_a_parent_dependency_tree', (t) => {
    const root = tempDir(t)
    mkdirp(root, 'node_modules')
    const nested = mkdirp(root, '.worktrees', 'agent')
    const answer = worktree.dependencyResolution(nested)
    assert.equal(answer.resolves, true)
    assert.equal(answer.linked, false)
    // Not the worktree's own directory - the point is that it has none.
    assert.equal(answer.own, false)
    assert.equal(answer.resolved, canonical(path.join(root, 'node_modules')))
  })

  test('test_a_worktree_with_no_tree_anywhere_above_it_reports_that_honestly', (t) => {
    const folder = tempDir(t)
    // A real parent chain could carry a node_modules; only assert the
    // negative when this machine's chain genuinely has none.
    const answer = worktree.dependencyResolution(folder)
    if (answer.resolves) { t.skip('an ancestor of the temp directory carries node_modules'); return }
    assert.equal(answer.resolved, null)
    assert.match(answer.note, /cannot run/)
  })

  test('test_a_linked_dependency_directory_is_reported_as_a_link', (t) => {
    const root = tempDir(t)
    mkdirp(root, 'real')
    if (!makeLink(t, path.join(root, 'node_modules'), path.join(root, 'real'))) return
    const answer = worktree.dependencyResolution(root)
    assert.equal(answer.resolves, true)
    assert.equal(answer.linked, true)
    assert.match(answer.note, /loses data/)
  })
})

describe('JunctionGateTests', () => {
  // The junction is the shape that hurt people; it must be hard to reach.
  test('test_linking_is_refused_when_dependencies_already_resolve_upward', (t) => {
    const root = tempDir(t)
    mkdirp(root, 'node_modules')
    fs.writeFileSync(path.join(root, 'node_modules', 'marker.txt'), 'x')
    const nested = mkdirp(root, '.worktrees', 'agent')
    // Even asking for it in as many words does not get it, because here
    // the link would buy nothing at all.
    let ran = 0
    patched({ run: () => { ran += 1; return { status: 0, stdout: '', stderr: '' } } }, () => {
      assert.throws(() => worktree.dependencySetup(nested, {
        dependency_source: path.join(root, 'node_modules'), accept_shared_dependencies: true, apply: true,
      }), (error) => error instanceof worktree.RefusalError && /already resolves it upward/.test(error.message))
    })
    // And nothing was created, so the refusal is not merely advisory.
    assert.equal(ran, 0)
    assert.equal(_seams.entryKind(path.join(nested, 'node_modules')), 'missing')
  })

  test('test_linking_needs_an_explicit_opt_in_even_with_no_upward_tree', (t) => {
    const root = tempDir(t)
    const source = mkdirp(root, 'source')
    const target = mkdirp(root, 'checkout')
    if (worktree.dependencyResolution(target).resolves) { t.skip('an ancestor of the temp directory carries node_modules'); return }
    assert.throws(() => worktree.dependencySetup(target, { dependency_source: source, apply: true }),
      (error) => error instanceof worktree.RefusalError && /accept_shared_dependencies/.test(error.message))
    assert.equal(_seams.entryKind(path.join(target, 'node_modules')), 'missing')
  })

  test('test_the_opt_in_route_still_works_when_it_is_genuinely_asked_for', (t) => {
    const root = tempDir(t)
    const source = mkdirp(root, 'source')
    const target = mkdirp(root, 'checkout')
    if (worktree.dependencyResolution(target).resolves) { t.skip('an ancestor of the temp directory carries node_modules'); return }
    const plan = worktree.dependencySetup(target, { dependency_source: source, accept_shared_dependencies: true, apply: false })
    assert.equal(plan.dependency_link.applied, false)
    assert.equal(plan.dependency_link.source, canonical(source))
  })

  test('test_a_plain_setup_reports_where_dependencies_come_from', (t) => {
    const root = tempDir(t)
    mkdirp(root, 'node_modules')
    const nested = mkdirp(root, '.worktrees', 'agent')
    fs.writeFileSync(path.join(nested, 'package.json'), '{}')
    const plan = worktree.dependencySetup(nested)
    assert.equal(plan.dependencies.resolves, true)
    assert.match(plan.note, /no install and no link are needed/)
  })

  test('test_the_engine_surface_gates_the_junction_the_same_way', {
    skip: 'not a worktree.py case: it drove engine/backend/orgtree/gitworkspace.py ' +
      '(worktree_setup), the Python engine surface removed with the Python engine. The ' +
      'gate it reached is worktree.dependency_setup, which ' +
      'test_linking_is_refused_when_dependencies_already_resolve_upward covers directly',
  }, () => {})
})

describe('RemovalSafetyTests', () => {
  // `remove --force` following a link out of the worktree is the 783 MB bug.
  test('test_scan_finds_an_escaping_link_without_following_it', (t) => {
    const root = tempDir(t)
    const outside = mkdirp(root, 'outside')
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'do not delete')
    const inside = path.join(root, 'checkout')
    mkdirp(inside, 'nested')
    if (!makeLink(t, path.join(inside, 'nested', 'node_modules'), outside)) return
    const scan = worktree.removalScan(inside)
    assert.equal(scan.escaping.length, 1)
    assert.equal(scan.force_safe, false)
    // The scan read the link; it never walked through it.
    assert.ok(exists(path.join(outside, 'precious.txt')))
  })

  test('test_a_link_that_stays_inside_the_worktree_does_not_block_a_force', (t) => {
    const root = tempDir(t)
    mkdirp(root, 'real')
    if (!makeLink(t, path.join(root, 'alias'), path.join(root, 'real'))) return
    const scan = worktree.removalScan(root)
    assert.equal(scan.links.length, 1)
    assert.deepEqual(scan.escaping, [])
    assert.equal(scan.force_safe, true)
  })

  test('test_plan_remove_refuses_force_through_an_escaping_link', (t) => {
    const root = tempDir(t)
    const outside = mkdirp(root, 'outside')
    const inside = mkdirp(root, 'checkout')
    if (!makeLink(t, path.join(inside, 'node_modules'), outside)) return
    let ran = 0
    patched({ ...rootIs(root), ...clean, run: () => { ran += 1; return { status: 0, stdout: '', stderr: '' } } }, () => {
      const plan = worktree.planRemove(root, inside, { force: true })
      assert.equal(plan.safe, false)
      assert.match(plan.refusals[0], /deletes through them/)
      assert.throws(() => worktree.remove(root, inside, { force: true }), worktree.RefusalError)
    })
    assert.equal(ran, 0)
  })

  test('test_an_ordinary_worktree_removes_without_force', (t) => {
    const root = tempDir(t)
    const inside = mkdirp(root, '.worktrees', 'agent')
    const plan = patched({ ...rootIs(root), ...clean }, () => worktree.planRemove(root, inside))
    assert.equal(plan.safe, true)
    assert.deepEqual(plan.refusals, [])
    assert.ok(!plan.command.includes('--force'))
  })

  test('test_a_dirty_worktree_is_not_removed_by_accident', (t) => {
    const root = tempDir(t)
    const inside = mkdirp(root, '.worktrees', 'agent')
    const plan = patched({ ...rootIs(root), ...dirty }, () => worktree.planRemove(root, inside))
    assert.equal(plan.safe, false)
    assert.match(plan.refusals[0], /uncommitted/)
  })

  test('test_removing_the_main_checkout_is_refused', (t) => {
    const folder = tempDir(t)
    patched(rootIs(folder), () => {
      assert.throws(() => worktree.planRemove(folder, folder),
        (error) => error instanceof worktree.RefusalError && /main checkout/.test(error.message))
    })
  })
})

describe('UnforcedRemovalTests', () => {
  // The un-forced removal is the one an agent actually reaches.
  //
  // ⚠ MEASURED, not assumed (git 2.52.0.windows.1, worktree under the repository
  // root, `node_modules` junction pointing outside it): `git worktree remove`
  // with NO flags exited 0 and emptied the junction's target, exactly as
  // `--force` did. `--force` overrides the dirty/untracked CHECK; it does not
  // change how Git deletes the tree.
  //
  // That matters because a `node_modules` junction is gitignored, so `status`
  // calls the worktree clean and none of the force-only refusals apply. Gating
  // the link check on `force` guarded the careful route and left the default
  // one wide open. These cases pin the correction: the link check is not about
  // `force` and must never be put back behind it.
  function escapingWorktree (t, root) {
    const outside = mkdirp(root, 'outside')
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'do not delete')
    const inside = mkdirp(root, 'checkout')
    return makeLink(t, path.join(inside, 'node_modules'), outside) ? inside : null
  }
  const stopped = { worktree: 'w', links: [], escaping: [], entries_scanned: 1, truncated: true, removal_safe: false, force_safe: false }

  test('test_plan_remove_refuses_an_unforced_removal_through_an_escaping_link', (t) => {
    const root = tempDir(t)
    const inside = escapingWorktree(t, root)
    if (!inside) return
    const plan = patched({ ...rootIs(root), ...clean }, () => worktree.planRemove(root, inside))
    assert.equal(plan.force, false)
    assert.equal(plan.safe, false)
    assert.match(plan.refusals[0], /deletes through them/)
    // The message must not claim this was a --force refusal, because it
    // was not; an agent told "refusing --force" on a plain remove drops
    // the flag it never passed and believes it has worked around it.
    assert.ok(!plan.refusals[0].includes('refusing --force'))
    assert.ok(plan.refusals[0].includes('WITHOUT --force'))
  })

  test('test_remove_never_runs_git_when_a_link_escapes_and_no_force_was_asked', (t) => {
    const root = tempDir(t)
    const inside = escapingWorktree(t, root)
    if (!inside) return
    let ran = 0
    patched({ ...rootIs(root), ...clean, run: () => { ran += 1; return { status: 0, stdout: '', stderr: '' } } }, () => {
      assert.throws(() => worktree.remove(root, inside), worktree.RefusalError)
    })
    assert.equal(ran, 0)
    assert.ok(exists(path.join(root, 'outside', 'precious.txt')))
  })

  test('test_a_clean_worktree_is_still_refused_because_the_junction_is_gitignored', (t) => {
    // The exact live shape: git reports nothing to commit, so every
    // force-only refusal is silent, and only the link check stands between
    // the removal and somebody else's dependency tree.
    const root = tempDir(t)
    const inside = escapingWorktree(t, root)
    if (!inside) return
    const plan = patched({ ...rootIs(root), ...clean }, () => worktree.planRemove(root, inside))
    assert.equal(plan.dirty, false)
    assert.equal(plan.unmerged, false)
    assert.equal(plan.refusals.length, 1)
    assert.equal(plan.safe, false)
  })

  test('test_a_truncated_scan_refuses_without_force_too', (t) => {
    const root = tempDir(t)
    const inside = mkdirp(root, '.worktrees', 'agent')
    const plan = patched({ ...rootIs(root), ...clean, removalScan: () => stopped }, () => worktree.planRemove(root, inside))
    assert.equal(plan.safe, false)
    assert.match(plan.refusals[0], /would be a guess/)
  })

  test('test_force_still_means_discard_changes_and_never_means_cross_a_link', (t) => {
    const root = tempDir(t)
    const inside = escapingWorktree(t, root)
    if (!inside) return
    const [forced, plain] = patched({ ...rootIs(root), ...dirty },
      () => [worktree.planRemove(root, inside, { force: true }), worktree.planRemove(root, inside)])
    // force clears the dirty refusal...
    assert.ok(!forced.refusals.some((r) => r.includes('uncommitted')))
    assert.ok(plain.refusals.some((r) => r.includes('uncommitted')))
    // ...and clears nothing about the link, in either direction.
    assert.equal(forced.safe, false)
    assert.equal(plain.safe, false)
    assert.ok(forced.refusals.some((r) => r.includes('deletes through them')))
    assert.ok(plain.refusals.some((r) => r.includes('deletes through them')))
  })

  test('test_a_worktree_with_a_real_installed_dependency_tree_is_still_removable', (t) => {
    // ⚠ The regression the un-gating nearly introduced. A junctioned
    // `node_modules` is a reparse point and is never descended into, so it
    // scans small. A REAL one is walked, and measured at 61,324 entries it used
    // to blow a 50,000-entry budget - which, once the truncation refusal
    // stopped depending on `--force`, would have made every worktree anybody
    // ran `npm install` in permanently unremovable, with no way out in the
    // message. Reported by worktree-setup in review.
    assert.ok(worktree.SCAN_LIMIT > 61324, 'the budget must clear a real installed node_modules')
    const root = tempDir(t)
    const inside = path.join(root, '.worktrees', 'agent')
    mkdirp(inside, 'node_modules', 'pkg')
    fs.writeFileSync(path.join(inside, 'node_modules', 'pkg', 'index.js'), '')
    const plan = patched({ ...rootIs(root), ...clean }, () => worktree.planRemove(root, inside))
    assert.deepEqual(plan.refusals, [])
    assert.equal(plan.safe, true)
  })

  test('test_accept_unscanned_waives_only_the_unknown', (t) => {
    const root = tempDir(t)
    const inside = mkdirp(root, '.worktrees', 'agent')
    const waived = patched({ ...rootIs(root), ...clean, removalScan: () => stopped },
      () => worktree.planRemove(root, inside, { accept_unscanned: true }))
    assert.equal(waived.safe, true)
    assert.deepEqual(waived.refusals, [])
  })

  test('test_accept_unscanned_never_waives_a_link_the_scan_actually_found', (t) => {
    // The distinction the flag exists to preserve: "I could not finish
    // looking" is waivable, "I looked and found a door out of the tree" is
    // not. Overloading one word into both is the original defect.
    const root = tempDir(t)
    const inside = escapingWorktree(t, root)
    if (!inside) return
    const plan = patched({ ...rootIs(root), ...clean },
      () => worktree.planRemove(root, inside, { force: true, accept_unscanned: true }))
    assert.equal(plan.safe, false)
    assert.ok(plan.refusals.some((r) => r.includes('deletes through them')))
  })

  test('test_the_refusal_points_at_a_command_that_can_actually_do_the_job', (t) => {
    // It used to name cleanup-preview, which cannot: the CLI passed it no
    // `owned` list, so every candidate came back preserved.
    const root = tempDir(t)
    const inside = escapingWorktree(t, root)
    if (!inside) return
    const plan = patched({ ...rootIs(root), ...clean }, () => worktree.planRemove(root, inside))
    assert.ok(plan.refusals[0].includes('cleanup-scan'))
    assert.ok(!plan.refusals[0].includes('cleanup-preview'))
    // And it names the tool that exists now, not the deleted Python one.
    assert.ok(plan.refusals[0].includes('node tools/worktree.mjs cleanup-scan'))
  })

  test('test_removal_safe_is_reported_beside_the_older_force_safe_name', (t) => {
    const root = tempDir(t)
    const inside = escapingWorktree(t, root)
    if (!inside) return
    const scan = worktree.removalScan(inside)
    assert.equal(scan.removal_safe, false)
    assert.equal(scan.removal_safe, scan.force_safe)
  })
})

describe('CleanupScanTests', () => {
  // Enumeration was the missing half: nothing produced a candidate list.
  test('test_an_escaping_dependency_link_is_found_and_selected', (t) => {
    const root = tempDir(t)
    const scanned = path.join(root, 'scratch')
    const outside = mkdirp(root, 'real')
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'the real dependency tree')
    mkdirp(scanned, 'agent', 'wt')
    if (!makeLink(t, path.join(scanned, 'agent', 'wt', 'node_modules'), outside)) return
    const plan = worktree.cleanupScan(scanned)
    assert.equal(plan.selection.selected, 1)
    assert.equal(plan.unlinkable, 1)
    // Found by reading the entry, never by walking through it.
    assert.ok(exists(path.join(outside, 'precious.txt')))
  })

  test('test_a_link_that_stays_inside_the_scanned_root_is_preserved', (t) => {
    const root = tempDir(t)
    mkdirp(root, 'real')
    mkdirp(root, 'wt')
    if (!makeLink(t, path.join(root, 'wt', 'node_modules'), path.join(root, 'real'))) return
    const plan = worktree.cleanupScan(root)
    assert.equal(plan.selection.selected, 0)
    assert.equal(plan.unlinkable, 0)
    assert.equal(plan.preserved, 1)
  })

  test('test_a_link_with_another_name_is_listed_but_not_selected', (t) => {
    const root = tempDir(t)
    const outside = mkdirp(root, 'elsewhere')
    mkdirp(root, 'wt')
    if (!makeLink(t, path.join(root, 'wt', 'cache'), outside)) return
    const plan = worktree.cleanupScan(root)
    assert.equal(plan.selection.links_found, 1)
    assert.equal(plan.selection.selected, 0)
    assert.equal(plan.preserved, 1)
    // The reason quotes both names the way the Python tool did (repr).
    assert.equal(plan.targets[0].reason, "not selected: named 'cache', not 'node_modules'")
  })

  test('test_a_real_dependency_directory_is_recorded_and_not_descended', (t) => {
    const root = tempDir(t)
    const heavy = mkdirp(root, 'wt', 'node_modules', 'pkg')
    fs.writeFileSync(path.join(heavy, 'index.js'), '')
    const survey = worktree.findReparsePoints(root)
    assert.deepEqual(survey.links, [])
    assert.ok(survey.skipped_directories.some((p) => canonical(p) === canonical(path.join(root, 'wt', 'node_modules'))))
  })

  test('test_the_entry_budget_is_reported_rather_than_applied_quietly', (t) => {
    const root = tempDir(t)
    for (let index = 0; index < 6; index++) mkdirp(root, `d${index}`)
    const survey = worktree.findReparsePoints(root, { limit: 2 })
    assert.equal(survey.truncated, true)
    assert.equal(survey.complete, false)
  })

  test('test_the_depth_bound_is_reported_rather_than_applied_quietly', (t) => {
    const root = tempDir(t)
    mkdirp(root, 'a', 'b')
    const survey = worktree.findReparsePoints(root, { max_depth: 2 })
    assert.ok(survey.depth_limited.length)
    assert.equal(survey.exhaustive, false)
  })

  test('test_a_depth_bound_is_a_scope_statement_and_a_truncation_is_a_failure', (t) => {
    // Folding these into one flag makes the useful one useless: on any real
    // tree something is always deeper than the bound, so a combined flag
    // reads False forever and stops meaning anything.
    const root = tempDir(t)
    mkdirp(root, 'a', 'b')
    const bounded = worktree.findReparsePoints(root, { max_depth: 2 })
    assert.equal(bounded.complete, true, 'the requested depth WAS fully examined')
    assert.equal(bounded.exhaustive, false, 'but something below it was not')
    for (let index = 0; index < 6; index++) mkdirp(root, `d${index}`)
    const stoppedScan = worktree.findReparsePoints(root, { limit: 2 })
    assert.equal(stoppedScan.complete, false, 'running out of budget is a real failure')
  })

  test('test_the_plan_states_the_safe_order_and_names_the_tool_that_destroys', (t) => {
    const plan = worktree.cleanupScan(tempDir(t))
    assert.deepEqual(plan.remediation.map((s) => s.step), [1, 2])
    assert.ok(plan.remediation[0].command.includes('rmdir'))
    // Doing it the other way round IS the incident, and a recursive
    // delete is the tool that follows the link instead of removing it.
    assert.ok(plan.remediation[0].never.includes('Remove-Item -Recurse'))
  })

  test('test_a_truncated_scan_says_INCOMPLETE_in_the_plan_the_operator_reads', (t) => {
    const root = tempDir(t)
    for (let index = 0; index < 6; index++) mkdirp(root, `d${index}`)
    const plan = worktree.cleanupScan(root, { limit: 2 })
    assert.equal(plan.complete, false)
    assert.ok(plan.note.includes('INCOMPLETE'))
    assert.ok(plan.note.includes('--limit'))
  })

  test('test_a_depth_bounded_scan_states_its_scope_without_crying_incomplete', (t) => {
    // It did everything it was asked to do. Calling that INCOMPLETE would
    // make the word meaningless, since a real tree always has something
    // below any bound.
    const root = tempDir(t)
    mkdirp(root, 'a', 'b')
    const plan = worktree.cleanupScan(root, { max_depth: 2 })
    assert.equal(plan.complete, true)
    assert.equal(plan.exhaustive, false)
    assert.equal(plan.census, false)
    assert.ok(!plan.note.includes('INCOMPLETE'))
    assert.ok(plan.note.includes('not descended into'))
  })

  test('test_a_bounded_scan_leads_with_the_undercount_not_a_footnote', (t) => {
    // ⚠ A bounded scan that still selected something is the dangerous shape.
    // It looks like a finished cleanup. Whoever runs it is reading for a
    // number, so the caveat has to arrive before the remediation steps.
    const root = tempDir(t)
    const outside = mkdirp(root, 'elsewhere')
    const scanned = path.join(root, 'scratch')
    mkdirp(scanned, 'shallow')
    if (!makeLink(t, path.join(scanned, 'shallow', 'node_modules'), outside)) return
    mkdirp(scanned, 'a', 'b', 'c')
    const plan = worktree.cleanupScan(scanned, { max_depth: 3 })
    assert.equal(plan.selection.selected, 1)
    assert.equal(plan.census, false)
    assert.ok(plan.note.startsWith('⚠'), plan.note.slice(0, 60))
    assert.ok(plan.note.includes('NOT in its counts'))
    assert.ok(plan.note.includes('leave the deeper ones in place'))
  })

  test('test_census_is_true_only_when_nothing_at_all_was_skipped', (t) => {
    const root = tempDir(t)
    mkdirp(root, 'flat')
    const plan = worktree.cleanupScan(root)
    assert.equal(plan.census, true)
    assert.ok(!plan.note.includes('⚠'))
  })

  test('test_raising_depth_without_budget_finds_fewer_links_not_more', (t) => {
    // The coupling that made a depth-6 scan find 11 links where depth 4 found
    // 77. Pinned because the conclusion is counter-intuitive and a future
    // reader tuning these constants will otherwise reach for depth alone.
    const root = tempDir(t)
    const outside = mkdirp(root, 'elsewhere')
    // A wide shallow tree: deepening the walk spends budget on entries
    // that contain nothing, before the scan ever reaches the link.
    for (let index = 0; index < 12; index++) {
      const padding = mkdirp(root, `wide${index}`, 'deeper')
      for (let leaf = 0; leaf < 8; leaf++) mkdirp(padding, `leaf${leaf}`)
    }
    if (!makeLink(t, path.join(root, 'wide0', 'node_modules'), outside)) return
    const shallow = worktree.findReparsePoints(root, { max_depth: 2, limit: 60 })
    const deep = worktree.findReparsePoints(root, { max_depth: 9, limit: 60 })
    assert.equal(shallow.links.length, 1)
    assert.equal(deep.truncated, true)
    assert.ok(deep.links.length <= shallow.links.length)
  })

  test('test_scan_then_apply_unlinks_the_link_and_leaves_the_target', (t) => {
    const root = tempDir(t)
    const scanned = path.join(root, 'scratch')
    const outside = mkdirp(root, 'real')
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'the real dependency tree')
    mkdirp(scanned, 'wt')
    const link = path.join(scanned, 'wt', 'node_modules')
    if (!makeLink(t, link, outside)) return
    const plan = worktree.cleanupScan(scanned)
    const applied = worktree.applyCleanup(plan, { confirm: true })
    assert.equal(applied.removed.length, 1)
    assert.ok(!exists(link))
    // The whole point: the link is gone, the target is untouched.
    assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'the real dependency tree')
  })

  test('test_a_plan_survives_a_json_round_trip_because_that_is_how_it_is_run', (t) => {
    // The operator runs `cleanup-scan > plan.json` and then
    // `cleanup-apply plan.json`, so the identity reaches apply as parsed JSON.
    // If that comparison were reference- or type-sensitive the plan would
    // preserve everything and the cleanup would silently do nothing.
    const root = tempDir(t)
    const outside = mkdirp(root, 'real')
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'x')
    mkdirp(root, 'scratch', 'wt')
    if (!makeLink(t, path.join(root, 'scratch', 'wt', 'node_modules'), outside)) return
    const plan = JSON.parse(worktree.pyJsonDumps(worktree.cleanupScan(path.join(root, 'scratch')), 2))
    const applied = worktree.applyCleanup(plan, { confirm: true })
    assert.equal(applied.removed.length, 1)
    assert.ok(exists(path.join(outside, 'precious.txt')))
  })

  test('test_applying_without_confirmation_is_refused', (t) => {
    const root = tempDir(t)
    assert.throws(() => worktree.applyCleanup(worktree.cleanupScan(root)), worktree.RefusalError)
  })

  test('test_the_cli_defaults_match_the_api_defaults', () => {
    // ⚠ A CLI default below the API default is an invisible undercount.
    // This shipped once: `--limit` defaulted to SCAN_LIMIT (the per-worktree
    // budget) while cleanup_scan defaults to SCAN_ROOT_LIMIT (5x larger).
    const args = worktree.parseArgs(['cleanup-scan', 'some-root'])
    assert.equal(args.limit, worktree.SCAN_ROOT_LIMIT)
    assert.equal(args.max_depth, worktree.DEFAULT_SCAN_DEPTH)
    assert.equal(args.name, worktree.DEPENDENCY_DIR)
    // `remove` scans ONE worktree and correctly keeps the smaller budget;
    // the two must not be conflated in either direction.
    const removal = worktree.parseArgs(['remove', 'some-worktree'])
    assert.equal(removal.accept_unscanned, false)
    // And the whole-root budget must actually be the larger of the two,
    // otherwise the names are backwards and this test passes vacuously.
    assert.ok(worktree.SCAN_ROOT_LIMIT > worktree.SCAN_LIMIT)
  })

  test('test_the_cli_wires_scan_and_apply_together', (t) => {
    const root = tempDir(t)
    const outside = mkdirp(root, 'real')
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'x')
    mkdirp(root, 'scratch', 'wt')
    const link = path.join(root, 'scratch', 'wt', 'node_modules')
    if (!makeLink(t, link, outside)) return
    const scan = runMain(['cleanup-scan', path.join(root, 'scratch')])
    assert.equal(scan.code, 0)
    const planPath = path.join(root, 'plan.json')
    fs.writeFileSync(planPath, scan.stdout)
    assert.equal(runMain(['cleanup-apply', planPath, '--confirm']).code, 0)
    assert.ok(!exists(link))
    assert.ok(exists(path.join(outside, 'precious.txt')))
  })

  test('test_the_cli_refuses_to_apply_without_confirm', (t) => {
    const planPath = path.join(tempDir(t), 'plan.json')
    fs.writeFileSync(planPath, JSON.stringify({ targets: [] }))
    const { code, stderr } = runMain(['cleanup-apply', planPath])
    assert.equal(code, 2)
    assert.match(stderr, /confirmation/)
  })

  test('test_a_refusal_reaches_the_reader_as_a_sentence_not_a_traceback', (t) => {
    // The refusals in this tool are written to be acted on: they name the
    // hazard and the command that resolves it. A stack trace buries that.
    const root = tempDir(t)
    const outside = mkdirp(root, 'outside')
    const inside = mkdirp(root, 'checkout')
    if (!makeLink(t, path.join(inside, 'node_modules'), outside)) return
    const { code, stderr } = patched({ ...rootIs(root), ...clean },
      () => runMain(['remove', inside, '--repository', root]))
    assert.equal(code, 2)
    assert.match(stderr, /refused:/)
    assert.match(stderr, /deletes through them/)
    assert.ok(!/Traceback|\n\s+at /.test(stderr))
  })

  test('test_a_git_failure_is_an_error_and_not_reported_as_a_refusal', (t) => {
    // A refusal is this tool declining; a GitError is git breaking. Printing
    // "refused" over the second sends the reader looking for a policy to
    // satisfy when nothing judged their request.
    const root = tempDir(t)
    const inside = mkdirp(root, '.worktrees', 'agent')
    const { code, stderr } = patched({
      ...rootIs(root), ...clean, run: () => ({ status: 1, stdout: '', stderr: 'fatal: git said no' }),
    }, () => runMain(['remove', inside, '--repository', root]))
    assert.equal(code, 1)
    assert.match(stderr, /error: fatal: git said no/)
    assert.ok(!stderr.includes('refused:'))
  })
})

describe('PlacementTests', () => {
  // A worktree outside the repository root is the shape that invites a junction.
  test('test_default_placement_is_under_the_repository_root', (t) => {
    const folder = tempDir(t)
    const plan = patched(rootIs(folder), () => worktree.planAdd(folder, 'agent-x', { base: 'main' }))
    assert.equal(plan.inside_repository_root, true)
    assert.equal(plan.dependency_junction, false)
    assert.equal(plan.path, canonical(path.join(folder, worktree.WORKTREES_DIR, 'agent-x')))
    assert.equal(plan.branch, 'agent-x')
    assert.ok(plan.command.includes('worktree'))
  })

  test('test_a_destination_outside_the_root_is_refused_and_says_why', (t) => {
    const folder = tempDir(t)
    const root = mkdirp(folder, 'repo')
    const elsewhere = path.join(folder, 'elsewhere')
    const plan = patched(rootIs(root), () => {
      assert.throws(() => worktree.planAdd(root, 'agent-x', { path: elsewhere }), (error) =>
        error instanceof worktree.RefusalError &&
        error.message.includes('outside the repository root') && error.message.includes('783 MB'))
      // Still reachable deliberately, so this is a guard and not a wall.
      return worktree.planAdd(root, 'agent-x', { path: elsewhere, allow_outside_root: true })
    })
    assert.equal(plan.inside_repository_root, false)
  })

  test('test_a_name_that_is_not_a_single_segment_is_refused', (t) => {
    const folder = tempDir(t)
    patched(rootIs(folder), () => {
      for (const bad of ['a/b', 'a\\b', ' leading', 'trailing ']) {
        assert.throws(() => worktree.planAdd(folder, bad), worktree.RefusalError, bad)
      }
    })
  })

  test('test_an_existing_destination_is_refused_rather_than_overwritten', (t) => {
    const folder = tempDir(t)
    const existing = mkdirp(folder, worktree.WORKTREES_DIR, 'agent-x')
    fs.writeFileSync(path.join(existing, 'work.txt'), 'mine')
    patched(rootIs(folder), () => {
      assert.throws(() => worktree.planAdd(folder, 'agent-x'),
        (error) => error instanceof worktree.RefusalError && /already exists/.test(error.message))
    })
    assert.equal(fs.readFileSync(path.join(existing, 'work.txt'), 'utf8'), 'mine')
  })

  test('test_a_worktree_inside_dot_git_is_refused', (t) => {
    const root = tempDir(t)
    patched(rootIs(root), () => {
      assert.throws(() => worktree.planAdd(root, 'agent-x', { path: path.join(root, '.git', 'agent-x') }),
        (error) => error instanceof worktree.RefusalError && error.message.includes('.git'))
    })
  })
})

describe('BundledRuntimeDiscoveryTests', () => {
  const why = 'not a worktree.py case: it tested bundled_runtime_candidates in ' +
    'tools/run-python-verification.py (where the bundled Python runtime is found from a ' +
    'worktree), which has no counterpart in tools/worktree.mjs and no meaning once the ' +
    'repository carries no Python'
  test('test_a_worktree_finds_the_runtime_owned_by_the_checkout_above_it', { skip: why }, () => {})
  test('test_the_walk_terminates_at_the_filesystem_root', { skip: why }, () => {})
})

// ── beyond the Python suite ────────────────────────────────────────────────

describe('worktree.py facts tests/test_worktree_git_permission.py relied on', () => {
  // That file tested the Codex prompt (supervisor / scope_diagnostics), not
  // this tool; but s2_12 and s2_13 told agents two things about the helper,
  // and those are this tool's behaviour.
  test('s2_12: add runs a plain `git worktree add` (it is not a way around the .git denial)', (t) => {
    const folder = tempDir(t)
    const plan = patched(rootIs(folder), () => worktree.planAdd(folder, 'agent-x'))
    assert.deepEqual(plan.command.slice(0, 5), ['git', '-C', canonical(folder), 'worktree', 'add'])
  })

  test('s2_13: add REPORTS ready rather than gating on dependencies', (t) => {
    const folder = tempDir(t)
    // git "succeeds" by creating the directory; no node_modules anywhere above.
    const result = patched({
      ...rootIs(folder),
      run: (argv) => { fs.mkdirSync(argv[argv.length - 2], { recursive: true }); return { status: 0, stdout: '', stderr: '' } },
    }, () => worktree.add(folder, 'agent-x'))
    if (result.dependencies.resolves) { t.skip('an ancestor of the temp directory carries node_modules'); return }
    assert.equal(result.applied, true)
    assert.equal(result.ready, false)
    assert.equal(result.run_tests, null)
    assert.match(result.next, /do NOT link node_modules/)
  })

  test('add raises only when git failed or left no directory', (t) => {
    const folder = tempDir(t)
    patched({ ...rootIs(folder), run: () => ({ status: 0, stdout: '', stderr: '' }) }, () => {
      assert.throws(() => worktree.add(folder, 'agent-x'),
        (error) => error instanceof worktree.GitError && /not a directory/.test(error.message))
    })
    patched({ ...rootIs(folder), run: () => ({ status: 128, stdout: '', stderr: 'fatal: no' }) }, () => {
      assert.throws(() => worktree.add(folder, 'agent-x'),
        (error) => error instanceof worktree.GitError && error.message === 'fatal: no')
    })
  })
})

describe('Node port specifics', () => {
  test('stripExtendedPrefix normalizes the spelling only', () => {
    assert.equal(worktree.stripExtendedPrefix('\\\\?\\C:\\repo\\x'), 'C:\\repo\\x')
    assert.equal(worktree.stripExtendedPrefix('\\\\?\\UNC\\server\\share\\x'), '\\\\server\\share\\x')
    assert.equal(worktree.stripExtendedPrefix('C:\\repo'), 'C:\\repo')
  })

  test('containment is lexical, component-wise and (on win32) case-insensitive', () => {
    const base = path.join(os.tmpdir(), 'Repo')
    assert.equal(worktree.contained(path.join(base, 'a'), base), true)
    assert.equal(worktree.contained(base + 'ish', base), false)
    assert.equal(worktree.contained(base, base), true)
    if (WIN) {
      assert.equal(worktree.contained(path.join(base, 'a').toUpperCase(), base.toLowerCase()), true)
      assert.equal(worktree.contained('\\\\?\\' + path.join(base, 'a'), base), true)
      assert.equal(worktree.contained('D:\\x', 'C:\\x'), false)
    }
  })

  test('a junction reads as kind symlink, with a null reparse tag in its identity', { skip: !WIN && 'Windows junctions only' }, (t) => {
    const root = tempDir(t)
    const real = mkdirp(root, 'real')
    const link = path.join(root, 'jn')
    if (!makeLink(t, link, real)) return
    assert.equal(_seams.entryKind(link), 'symlink')
    assert.deepEqual(_seams.entryIdentity(link), ['symlink', null])
    // libuv strips `\??\`; whatever it returns, containment sees it as inside.
    assert.equal(worktree.contained(fs.readlinkSync(link), root), true)
  })

  test('a directory on another volume (a mount point) is a link with no readable target', (t) => {
    // A volume mount point cannot be made without elevation, so this fakes
    // only the volume serial libuv reports for it.
    if (!WIN) { t.skip('volume-serial check is Windows-only'); return }
    const root = tempDir(t)
    const mounted = mkdirp(root, 'mounted')
    const realLstat = _seams.lstat
    const scan = patched({
      lstat: (p) => {
        const info = realLstat(p)
        if (canonical(p) === canonical(mounted)) return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { dev: info.dev + 1 })
        return info
      },
    }, () => worktree.removalScan(root))
    assert.equal(scan.links.length, 1)
    assert.equal(scan.links[0].kind, 'reparse')
    assert.equal(scan.links[0].target, null)
    assert.equal(scan.removal_safe, false)
  })

  test('a plan written by the Python tool (kind "reparse") is preserved, not applied', (t) => {
    const root = tempDir(t)
    const real = mkdirp(root, 'real')
    const link = path.join(root, 'node_modules')
    if (!makeLink(t, link, real)) return
    const pythonPlan = { targets: [{ path: canonical(link), action: 'unlink', owned: true, kind: 'reparse',
      identity: ['reparse', 2684354563], target: '\\\\?\\' + real }] }
    const result = worktree.applyCleanup(pythonPlan, { confirm: true })
    assert.deepEqual(result.removed, [])
    assert.equal(result.targets[0].reason, 'changed since preview')
    assert.ok(exists(link))
  })

  test('JSON output is Python json.dumps(sort_keys, indent=2, ensure_ascii)', () => {
    assert.equal(worktree.pyJsonDumps({ b: [], a: { d: '⚠', c: null } }, 2),
      '{\n  "a": {\n    "c": null,\n    "d": "\\u26a0"\n  },\n  "b": []\n}')
    assert.equal(worktree.pyJsonDumps({ b: 1, a: [1, 'x'] }), '{"a": [1, "x"], "b": 1}')
  })

  test('the CLI parses like argparse: abbreviations, =values, ints, usage errors', () => {
    assert.equal(worktree.parseArgs(['remove', 'w', '--dry']).dry_run, true)
    assert.equal(worktree.parseArgs(['cleanup-scan', 'r', '--limit=5']).limit, 5)
    assert.equal(worktree.parseArgs(['cleanup-scan', 'r', '--name', '']).name, '')
    assert.equal(worktree.parseArgs(['inventory', 'r', '--limit', '-1']).limit, -1)
    assert.deepEqual(worktree.parseArgs(['cleanup-preview', 'r', 'a', 'b']).candidates, ['a', 'b'])
    for (const bad of [[], ['nope'], ['remove'], ['remove', 'a', 'b'], ['remove', 'a', '--bogus'],
      ['cleanup-scan', 'r', '--limit', 'x'], ['cleanup-preview', 'r'], ['remove', 'w', '--force=1']]) {
      assert.equal(runMain(bad).code, 2, JSON.stringify(bad))
    }
    const help = runMain(['--help'])
    assert.equal(help.code, 0)
    assert.match(help.stdout, /cleanup-scan/)
  })

  test('a plan that is not JSON is a refusal (exit 2), as json.loads ValueError was', (t) => {
    const planPath = path.join(tempDir(t), 'plan.json')
    fs.writeFileSync(planPath, 'not json')
    const { code, stderr } = runMain(['cleanup-apply', planPath, '--confirm'])
    assert.equal(code, 2)
    assert.match(stderr, /^refused: /)
  })
})

describe('against a real throwaway git repository', () => {
  const gitOk = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0
  function makeRepo (t) {
    const base = tempDir(t)
    const repo = mkdirp(base, 'repo')
    const g = (...args) => {
      const r = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      return r.stdout
    }
    g('init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(repo, '.gitignore'), '.worktrees/\nnode_modules/\n')
    fs.writeFileSync(path.join(repo, 'README'), 'x\n')
    g('add', '.')
    g('commit', '-q', '-m', 'init')
    return { base, repo, g }
  }
  const cli = (args, cwd) => {
    const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', cwd, windowsHide: true })
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: r.status === 0 ? JSON.parse(r.stdout) : null }
  }

  test('add, verify, inventory and remove a clean worktree end to end', { skip: !gitOk && 'git unavailable' }, (t) => {
    const { repo } = makeRepo(t)
    mkdirp(repo, 'node_modules')
    const dry = cli(['add', 'agent-x', '--repository', repo, '--dry-run'])
    assert.equal(dry.code, 0)
    assert.equal(dry.json.applied, false)
    const added = cli(['add', 'agent-x', '--repository', repo])
    assert.equal(added.code, 0, added.stderr)
    assert.equal(added.json.ready, true)
    assert.equal(added.json.dependencies.own, false)
    const wt = added.json.path
    assert.equal(cli(['verify', wt]).json.resolves, true)
    const inv = cli(['inventory', repo])
    assert.equal(inv.json.total, 2)
    assert.equal(cli(['remove', wt, '--repository', repo, '--dry-run']).json.safe, true)
    const removed = cli(['remove', wt, '--repository', repo])
    assert.equal(removed.code, 0, removed.stderr)
    assert.ok(!exists(wt))
  })

  test('a dirty worktree is refused, and --force removes it', { skip: !gitOk && 'git unavailable' }, (t) => {
    const { repo } = makeRepo(t)
    const wt = cli(['add', 'agent-d', '--repository', repo]).json.path
    fs.writeFileSync(path.join(wt, 'scratch.txt'), 'uncommitted')
    const refused = cli(['remove', wt, '--repository', repo])
    assert.equal(refused.code, 2)
    assert.match(refused.stderr, /refused: worktree has uncommitted/)
    assert.equal(cli(['remove', wt, '--repository', repo, '--force']).code, 0)
  })

  test('a node_modules junction to outside refuses removal, with and without --force; the target survives', { skip: !gitOk && 'git unavailable' }, (t) => {
    const { base, repo } = makeRepo(t)
    const wt = cli(['add', 'agent-j', '--repository', repo]).json.path
    const outside = mkdirp(base, 'precious')
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep')
    if (!makeLink(t, path.join(wt, 'node_modules'), outside)) return
    for (const extra of [[], ['--force']]) {
      const r = cli(['remove', wt, '--repository', repo, ...extra])
      assert.equal(r.code, 2)
      assert.match(r.stderr, /deletes through them/)
    }
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep')
    // The documented sequence: scan, apply, then remove.
    const plan = cli(['cleanup-scan', wt])
    assert.equal(plan.json.selection.selected, 1)
    const planPath = path.join(base, 'plan.json')
    fs.writeFileSync(planPath, plan.stdout)
    assert.equal(cli(['cleanup-apply', planPath]).code, 2)
    assert.equal(cli(['cleanup-apply', planPath, '--confirm']).json.removed.length, 1)
    assert.equal(cli(['remove', wt, '--repository', repo]).code, 0)
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep')
  })

  test('the main checkout cannot be removed, and git failures exit 1', { skip: !gitOk && 'git unavailable' }, (t) => {
    const { base, repo } = makeRepo(t)
    // Git answers with the long spelling of the path; os.tmpdir() may be an
    // 8.3 short name (C:\Users\NCOLA_~1\...). The guard is lexical, so it is
    // exercised with the spelling git uses...
    const long = fs.realpathSync.native(repo)
    const main = cli(['remove', long, '--repository', long])
    assert.equal(main.code, 2)
    assert.match(main.stderr, /main checkout/)
    // ...and with a short spelling it misses, exactly as the Python tool did,
    // and git's own "is a main working tree" refusal is what stops it.
    if (long.toLowerCase() !== repo.toLowerCase()) {
      const short = cli(['remove', repo, '--repository', repo])
      assert.equal(short.code, 1)
      assert.match(short.stderr, /main working tree/)
    }
    const notRepo = mkdirp(base, 'plain')
    const r = cli(['add', 'x', '--repository', notRepo])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /^error: /)
  })
})
