#!/usr/bin/env node
// Publishes the ready DRAFT releases of Orgtree, Hubchat and the mail hub with one command.
//
// Each app's pushed version tag runs its own release workflow, in parallel and independently,
// up to a complete, checked draft ("draft ready" in the run's summary). Nothing is public
// until this command:
//
//   node tools/publish-release.mjs orgtree=4.7.1 hubchat=1.4.1 mailhub=2.6.1
//   node tools/publish-release.mjs --check orgtree=4.7.1      (the checks only, publishes nothing)
//
// 1. Checks EVERY named draft first, and publishes nothing unless all pass: exactly one draft
//    for tag v<version>, the tag exists, the draft carries its SHA256SUMS, and the newest
//    run of the app's release workflow for that tag succeeded (its draft job checked the
//    draft's every asset, hash and update feed).
// 2. Publishes them, one after another: a stable version becomes "Latest" (every installed
//    app updates to it); a prerelease is published as a prerelease and never "Latest".
// 3. Starts each app's after-publish workflows (verify-release, the GHCR images): publishing
//    as a person normally starts them through `release: published`; any that has not started
//    within a minute is dispatched by hand here (a workflow_dispatch with the tag).
// 4. Waits for those runs and prints each one's result. Exit status 0 only when all are green.
//
// Needs the GitHub CLI (`gh`), signed in with write access to the three repositories.
// docs/ci-release.md, "Publishing", has the procedure and what to do when a step fails.
import { execFileSync } from 'node:child_process'

const APPS = {
  orgtree: { repo: 'Maurdekye/orgtree', title: 'Orgtree',
    version: /^\d+\.\d+\.\d+(-(alpha|beta)\.\d+)?$/, sums: 'SHA256SUMS.txt',
    followers: ['verify-release.yml', 'publish-standalone-image.yml'] },
  hubchat: { repo: 'Maurdekye/orgtree-hubchat', title: 'Hubchat',
    version: /^\d+\.\d+\.\d+$/, sums: 'SHA256SUMS.txt',
    followers: ['verify-release.yml', 'publish-web-image.yml'] },
  mailhub: { repo: 'Maurdekye/orgtree-mailhub', title: 'Mail hub',
    version: /^\d+\.\d+\.\d+(-(alpha|beta)\.\d+)?$/, sums: 'SHA256SUMS',
    followers: ['release-image.yml'] },
}
const START_WAIT_MS = 60_000, POLL_MS = 15_000, FINISH_WAIT_MS = 45 * 60_000

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const wanted = args.filter(a => a !== '--check').map(a => {
  const [app, version] = a.split('=')
  if (!APPS[app] || !version) usage(`not app=version: ${a}`)
  if (!APPS[app].version.test(version)) usage(`${app} ${version} is not a version this app releases`)
  return { app, version, tag: `v${version}`, prerelease: version.includes('-'), ...APPS[app] }
})
if (!wanted.length) usage('name at least one app')
if (new Set(wanted.map(w => w.app)).size !== wanted.length) usage('each app at most once')

const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const api = (path, ...a) => JSON.parse(gh('api', ...a, path))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const line = s => console.log(s)

// 1. every draft is ready, or nothing is published
let bad = 0
const fail = (w, why) => { bad += 1; line(`FAIL ${w.title} ${w.version}: ${why}`) }
for (const w of wanted) {
  const drafts = api(`repos/${w.repo}/releases?per_page=100`).filter(r => r.draft && r.tag_name === w.tag)
  if (drafts.length !== 1) { fail(w, `${drafts.length} drafts for ${w.tag} (want exactly 1; a published release is not a draft)`); continue }
  w.release = drafts[0]
  try { w.sha = api(`repos/${w.repo}/commits/${w.tag}`).sha } catch { fail(w, `tag ${w.tag} is not on GitHub`); continue }
  if (!w.release.assets.some(a => a.name === w.sums)) fail(w, `the draft has no ${w.sums}`)
  if (!!w.release.prerelease !== w.prerelease) fail(w, `the draft's prerelease flag is ${w.release.prerelease}, the version says ${w.prerelease}`)
  const runs = api(`repos/${w.repo}/actions/workflows/release.yml/runs?event=push&branch=${encodeURIComponent(w.tag)}&per_page=5`).workflow_runs
  const run = runs.find(r => r.head_sha === w.sha)
  if (!run) fail(w, `no release run for ${w.tag} at ${w.sha.slice(0, 7)}`)
  else if (run.status !== 'completed' || run.conclusion !== 'success') fail(w, `release run ${run.html_url} is ${run.status}/${run.conclusion ?? '-'}, not a green "draft ready"`)
  else {
    const draftJob = api(`repos/${w.repo}/actions/runs/${run.id}/jobs?per_page=100`).jobs.find(j => j.name === 'draft')
    if (draftJob?.conclusion !== 'success') fail(w, `the run's draft job is ${draftJob?.conclusion ?? 'missing'}`)
    else line(`ok   ${w.title} ${w.version}: draft ${w.release.id} with ${w.release.assets.length} assets, checked by ${run.html_url}`)
  }
}
if (bad) { line(`\nNothing was published: ${bad} problem(s) above.`); process.exit(1) }
if (checkOnly) { line('\nAll drafts are ready (--check: nothing was published).'); process.exit(0) }

// 2. publish
const published = []
for (const w of wanted) {
  const flags = w.prerelease ? ['--prerelease', '--latest=false'] : ['--latest']
  try {
    w.publishedAt = new Date()
    gh('release', 'edit', w.tag, '--repo', w.repo, '--draft=false', ...flags)
    const now = api(`repos/${w.repo}/releases/${w.release.id}`)
    if (now.draft) throw new Error('still a draft after the edit')
    published.push(w)
    line(`PUBLISHED ${w.title} ${w.version}${w.prerelease ? ' (prerelease)' : ' (Latest)'}: ${now.html_url}`)
  } catch (e) {
    line(`FAIL publishing ${w.title} ${w.version}: ${e.stderr || e.message}`)
    line(`STOPPED: published so far: ${published.map(p => `${p.title} ${p.version}`).join(', ') || 'none'}; not published: ${wanted.filter(x => !published.includes(x)).map(x => `${x.title} ${x.version}`).join(', ')}`)
    process.exit(1)
  }
}

// 3. the after-publish workflows: started by `release: published`, or dispatched here
const followerRuns = []
// a `release: published` run of this tag, created since the publish (a run's head_branch is the tag)
const findRun = (w, file, since) => api(`repos/${w.repo}/actions/workflows/${file}/runs?per_page=20&event=release&created=${encodeURIComponent('>=' + new Date(since - 5000).toISOString().slice(0, 19) + 'Z')}`)
  .workflow_runs.find(r => r.head_branch === w.tag)
for (const w of published) {
  for (const file of w.followers) {
    let run
    for (const deadline = Date.now() + START_WAIT_MS; !run && Date.now() < deadline; ) {
      run = findRun(w, file, w.publishedAt); if (!run) await sleep(5000)
    }
    if (!run) {
      line(`note ${w.title} ${file} did not start from the publish event: dispatching it with tag=${w.tag}`)
      const since = new Date()
      gh('workflow', 'run', file, '--repo', w.repo, '--ref', w.tag, '-f', `tag=${w.tag}`)
      for (const deadline = Date.now() + START_WAIT_MS; !run && Date.now() < deadline; ) {
        await sleep(5000); run = api(`repos/${w.repo}/actions/workflows/${file}/runs?per_page=5&event=workflow_dispatch`).workflow_runs.find(r => new Date(r.created_at) >= new Date(since - 5000))
      }
    }
    if (!run) { line(`FAIL ${w.title} ${file}: no run started`); followerRuns.push({ w, file, run: null }); continue }
    line(`started ${w.title} ${file}: ${run.html_url} (${run.event})`)
    followerRuns.push({ w, file, run })
  }
}

// 4. wait and report
for (const deadline = Date.now() + FINISH_WAIT_MS; ; ) {
  for (const f of followerRuns.filter(f => f.run && f.run.status !== 'completed')) f.run = api(`repos/${f.w.repo}/actions/runs/${f.run.id}`)
  if (followerRuns.every(f => !f.run || f.run.status === 'completed') || Date.now() > deadline) break
  await sleep(POLL_MS)
}
line('\nResults:')
let red = 0
for (const w of published) line(`  ${w.title} ${w.version}: published${w.prerelease ? ' as a prerelease' : ' as Latest'}`)
for (const { w, file, run } of followerRuns) {
  const ok = run?.status === 'completed' && run.conclusion === 'success'
  if (!ok) red += 1
  line(`  ${ok ? 'ok  ' : 'FAIL'} ${w.title} ${file}: ${run ? `${run.status}/${run.conclusion ?? '-'} ${run.html_url}` : 'never started'}`)
}
if (red) line(`\n${red} after-publish run(s) not green: see docs/ci-release.md, "Rolling back" (or re-run them).`)
process.exit(red ? 1 : 0)

function usage(message) {
  console.error(`${message}\nusage: node tools/publish-release.mjs [--check] orgtree=<v> hubchat=<v> mailhub=<v>   (any of them)`)
  process.exit(2)
}
