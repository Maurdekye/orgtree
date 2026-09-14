// The opt-in gate for probes that are allowed to disturb the machine they run
// on: open a console, show a window or dialog, raise a UAC prompt, or execute a
// compiled installer.
//
// WHY THIS EXISTS. On 2026-09-14 a full backend run made the developer's PC
// nearly unusable — repeated console windows and modal dialogs, several at once
// because `node --test` runs files concurrently. Nothing was misbehaving: the
// probes were doing exactly what they were written to do. The defect was that
// they were reachable from an ordinary `npm test`, with no way to say no.
//
// TWO BARRIERS, DELIBERATELY REDUNDANT. A probe lives under tests/disruptive/,
// which the default glob `tests/*.test.mjs` cannot reach because it does not
// recurse; AND it asks this gate before it spawns anything. Either barrier alone
// would do on a good day. One typo in either is a bad day on someone's desktop.
export const DISRUPTIVE_ENV = 'ORGTREE_DISRUPTIVE_PROBES'

/** Has the operator explicitly asked for disruptive probes? Nothing else — no
 *  CI heuristic, no "looks interactive" guess — may turn these on. */
export function disruptiveProbesEnabled(env = process.env) {
  return env[DISRUPTIVE_ENV] === '1'
}

/** Gate a disruptive probe. Returns true only on an explicit opt-in.
 *
 *  A GATED-OUT PROBE MUST NEVER READ AS A PASS. Callers use the returned false
 *  to `t.skip()`, which node:test reports as skipped rather than passed, and
 *  this prints a line naming the gate so a reader of the log can tell "nobody
 *  asked for this" from "this was measured and was fine". A control that is
 *  silently absent is indistinguishable from one that ran and proved nothing. */
export function requireDisruptiveOptIn(name, env = process.env) {
  if (disruptiveProbesEnabled(env)) return true
  console.log(`NOT RUN — disruptive probe "${name}" is opt-in. Set ${DISRUPTIVE_ENV}=1 and run \`npm run test:disruptive\` on a machine you are willing to have interrupted.`)
  return false
}
