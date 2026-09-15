/** THE HARMLESS DUAL-ENTRY UPDATE FIXTURE.
 *
 *  Both supported upgrade entry points — the in-app Update button's self-update
 *  handoff, and a manually launched installer — must be able to target ONE
 *  harmless fixture executable, so their arguments, process ancestry,
 *  visibility, durable phase logs, shutdown behaviour and relaunch behaviour can
 *  be compared directly instead of argued about.
 *
 *  THE MANUAL ROUTE NEEDS NOTHING FROM THIS MODULE, and that is the contract
 *  rather than an omission: the fixture is an ordinary installer-shaped
 *  executable, so running it by hand IS the manual route, on the same binary the
 *  in-app route hands off to. Only the in-app route needs a substitution, and
 *  this decides whether this build may perform one.
 *
 *  ⚠ THE CAPABILITY IS BUILD COMPOSITION, NOT METADATA AND NOT AN ENVIRONMENT
 *  VARIABLE. Two weaker designs were tried and both are rejected here, because
 *  the requirement is that a production build must not merely decline to
 *  advertise this mechanism — it must be UNABLE to perform it.
 *
 *    - An environment variable read by shipped code is a mechanism a production
 *      build ACCEPTS. The guard would be a value supplied by whoever runs the
 *      app, which is not a property of the build at all.
 *    - A flag in the build-info.json packaging writes beside the app is barely
 *      better, and it was measured rather than argued: a reviewer's probe fed
 *      `channel: release` plus `updateFixture: true` to both the capability
 *      reader and the real release provenance validator, AND BOTH ACCEPTED.
 *      That file is ordinary mutable data sitting next to the executable, so
 *      "we simply never write the flag" is not an exclusion — it is a default,
 *      and anyone with a text editor can change a default.
 *
 *  So the capability is a constant the bundler substitutes at build time.
 *  A published build has `false` compiled into dist/main/index.cjs, and no edit
 *  to any file beside the application can change that. Editing the bundle
 *  itself is not a way around it either: build-info.json carries a sha256 of
 *  dist/main/index.cjs, so a modified bundle fails the provenance check that
 *  already exists.
 *
 *  ⚠ AND IT FAILS CLOSED AT EVERY LAYER. If the define is missing entirely —
 *  an esbuild run that did not set it, a test bundling this module directly —
 *  the capability is false. The enabled state is reachable only by asking for
 *  it explicitly at build time.
 *
 *  ⚠ A REFUSAL IS NOT SILENCE. When a build that may not substitute is asked to,
 *  the decision carries the reason and the caller records it. A stray variable
 *  in an operator's environment must never change what an installed release
 *  does AND must never do so invisibly: "it was ignored" has to be readable
 *  afterwards, or the next person debugging an update has one more
 *  indistinguishable hypothesis. */

/** Substituted by tools/build.mjs with the WHOLE marker string, either
 *  `ORGTREE-UPDATE-FIXTURE-BUILD:enabled` or `…:disabled`. Declared rather than
 *  imported because it does not exist as a value anywhere — esbuild replaces
 *  the identifier.
 *
 *  ⚠ A STRING, NOT A BOOLEAN, AND THAT IS DELIBERATE. A boolean define left the
 *  preflight's bundle scan depending on dead-code elimination, and the test that
 *  measured it FAILED: esbuild kept the eliminated branch's literal, so the
 *  disabled bundle carried the sentinel too and the scan would have refused
 *  every build. Substituting the marker itself needs no elimination — the value
 *  is simply present in the output — so the scan reads a fact rather than a
 *  bundler optimisation.
 *
 *  The comparison below is deliberately written against the ':enabled' SUFFIX,
 *  never the whole marker, so this source file never contains the enabled
 *  marker as a contiguous literal. If it did, a disabled bundle would carry it
 *  as the comparison operand and the scan would be back to false positives. */
declare const __ORGTREE_UPDATE_FIXTURE__: string

/** Names the fixture executable to hand off to. Read ONLY by a build whose
 *  composition already permits a substitution; on any other build this variable
 *  decides nothing, and the attempt is recorded rather than ignored. */
export const UPDATE_FIXTURE_ENV = 'ORGTREE_UPDATE_FIXTURE'

/** Whether THIS BUILD was composed to permit an update-fixture substitution.
 *  The `typeof` guard is what makes a missing define mean `false` instead of a
 *  ReferenceError that some caller might swallow into a truthy default. */
export function buildPermitsUpdateFixture(): boolean {
  return typeof __ORGTREE_UPDATE_FIXTURE__ === 'string'
    && __ORGTREE_UPDATE_FIXTURE__.endsWith(':enabled')
}

export type FixtureDecision =
  /** No fixture was asked for. The ordinary handoff runs untouched. */
  | { kind: 'off' }
  /** Hand off to this executable instead of the downloaded installer. */
  | { kind: 'active', installer: string }
  /** A fixture was asked for and this build may not have one, or the one it
   *  named is not there. The ordinary handoff runs untouched and the caller
   *  records the reason. */
  | { kind: 'refused', reason: string }

export interface FixtureInputs {
  /** The raw environment value, if any. */
  requested?: string
  /** Defaults to this build's own composition. Injected only so the decision
   *  can be driven from both sides in one test process; production callers pass
   *  nothing and get the compiled answer. */
  permitted?: boolean
  /** Injected so the decision stays pure and testable. */
  exists: (file: string) => boolean
}

export function updateFixtureDecision(
  { requested, permitted, exists }: FixtureInputs): FixtureDecision {
  const named = (requested ?? '').trim()
  if (!named) return { kind: 'off' }
  if (!(permitted ?? buildPermitsUpdateFixture())) {
    return {
      kind: 'refused',
      reason: `${UPDATE_FIXTURE_ENV} named [${named}] but this build was not `
        + 'composed to accept an update-fixture substitution; the ordinary '
        + 'installer handoff was used unchanged',
    }
  }
  if (!exists(named)) {
    return {
      kind: 'refused',
      reason: `${UPDATE_FIXTURE_ENV} named [${named}], which does not exist; `
        + 'the ordinary installer handoff was used unchanged',
    }
  }
  return { kind: 'active', installer: named }
}

/** The marker a fixture-capable build discloses in build-info.json.
 *
 *  ⚠ THIS IS A DISCLOSURE, NOT THE GUARD, and the distinction is the whole
 *  point of the paragraph above. Nothing at runtime consults it: it exists so a
 *  fixture-capable artifact SAYS SO about itself, and so the release preflight
 *  can refuse to package one. Reading it and acting on it at runtime is exactly
 *  the rejected design. */
export const UPDATE_FIXTURE_DISCLOSURE = 'updateFixture'

/** The marker the bundler substitutes, WITHOUT its state suffix. The release
 *  preflight scans dist/main/index.cjs for this plus ':enabled', so it refuses a
 *  fixture-capable artifact by reading the thing that actually runs rather than
 *  a field beside it. The disclosure above can be deleted from a JSON file; this
 *  cannot be deleted without editing the bundle, whose sha256 build-info.json
 *  records and the provenance check verifies.
 *
 *  Kept as two pieces here for the same reason the comparison uses the suffix:
 *  this file must never contain the enabled marker as one contiguous literal,
 *  or every disabled bundle would carry it and the scan would refuse
 *  everything. The 'a disabled build does not carry the enabled marker' test
 *  measures that against real output rather than trusting this note. */
export const UPDATE_FIXTURE_MARKER = 'ORGTREE-UPDATE-FIXTURE-BUILD'
export const UPDATE_FIXTURE_ENABLED_SUFFIX = ':enabled'

/** What the bundler actually substituted, for diagnostics. Null only when no
 *  define was applied at all. */
export function updateFixtureBuildMark(): string | null {
  return typeof __ORGTREE_UPDATE_FIXTURE__ === 'string' ? __ORGTREE_UPDATE_FIXTURE__ : null
}

// ---------------------------------------------------------------- composition
//
// ⚠ THIS FUNCTION EXISTS BECAUSE THE COMPOSITION WAS WHERE THE BUGS WERE.
// An earlier revision assembled the handoff inline in index.ts and tested the
// pieces separately, each of which passed. A reviewer extracted the real
// callback and drove it, and found three defects that no test of a piece could
// have caught: the receipt path was computed and never given to the child, a
// stale receipt plus a failed delete fabricated success, and the spawned child
// had no error listener so an asynchronous ENOENT threw instead of being
// reported. Composing it here makes the composition itself the thing under
// test.

/** The environment the fixture reads. Named here, and passed by the spawn below,
 *  so the path the proof watches and the path the fixture writes cannot drift:
 *  that drift WAS the defect — the app checked its own data directory while the
 *  fixture, told nothing, wrote beside itself. */
export const UPDATE_FIXTURE_RECEIPT_ENV = 'ORGTREE_UPDATE_FIXTURE_RECEIPT'
export const UPDATE_FIXTURE_TOKEN_ENV = 'ORGTREE_UPDATE_FIXTURE_TOKEN'
/** The line the fixture echoes its token back on. */
/** ⚠ THE TERMINAL RECORD, and it must be the LAST thing the fixture writes.
 *  An earlier shape echoed the token in the middle of the receipt and checked
 *  for it with a substring match, so a write TRUNCATED AFTER THE TOKEN still
 *  read as a completed run. No attacker is needed for that — the fixture's own
 *  partial output is enough. The fixture now assembles the whole receipt, ends
 *  it with this line, and publishes it by RENAME, so a reader sees either the
 *  complete record or no file at all. */
export const UPDATE_FIXTURE_COMPLETE_LINE = '[fixture-complete] '
/** Retained for the receipt's readable body; NOT what completion is judged on. */
export const UPDATE_FIXTURE_TOKEN_LINE = '[fixture-token] '

export interface FixtureIo {
  existsSync: (target: string) => boolean
  statSync: (target: string) => { isFile: () => boolean }
  readFileSync: (target: string, encoding: 'utf8') => string
}

export interface FixtureChild {
  pid?: number
  on: (event: 'error', listener: (error: unknown) => void) => unknown
}

export interface PrepareFixtureDeps {
  /** The raw environment value naming a fixture, if any. */
  requested?: string
  /** UNIQUE TO THIS ATTEMPT. A receipt from an earlier attempt must not be
   *  readable as this one's, and the previous design tried to achieve that by
   *  deleting a fixed path — which fabricated success whenever the delete
   *  failed. A per-attempt name removes the collision instead of cleaning up
   *  after it. */
  receiptPath: string
  /** Echoed by the fixture into its receipt and required on the way back, so a
   *  receipt that exists for any other reason cannot satisfy the proof. */
  token: string
  io: FixtureIo
  spawn: (file: string, args: string[],
    options: { env: Record<string, string | undefined> }) => FixtureChild
  /** Defaults to this build's composition; injected only for tests. */
  permitted?: boolean
}

export interface PreparedFixture {
  decision: FixtureDecision
  /** WHAT TO PASS TO installDownloadedUpdate, and the reason it exists as its
   *  own field: `undefined` and `refused` are DIFFERENT. Undefined means no
   *  fixture was requested, so the ordinary handoff runs and production
   *  behaviour is untouched. Refused means one WAS requested and cannot be
   *  used, and the handoff must be declined rather than quietly performing a
   *  real installation — which is exactly what an earlier revision did. */
  attempt?: FixtureAttemptLike
  /** Absent unless the decision is active. */
  handoff?: FixtureHandoffLike
  /** Did the fixture RUN AND FINISH? Content-checked, not existence-checked. */
  completed: () => boolean
  /** An asynchronous spawn failure the child reported, if any. */
  spawnError: () => unknown | undefined
}

/** Structurally the updater's FixtureHandoff; declared here to keep this module
 *  free of a cycle back into updater.ts. */
export type FixtureAttemptLike = FixtureHandoffLike | { refused: string }

export interface FixtureHandoffLike {
  installer: string
  receipt: string
  spawn: (file: string, args: string[]) => { pid?: number }
}

export function prepareUpdateFixture(deps: PrepareFixtureDeps): PreparedFixture {
  const decision = updateFixtureDecision({
    requested: deps.requested,
    permitted: deps.permitted,
    exists: (file) => deps.io.existsSync(file),
  })
  let spawnError: unknown | undefined

  // ⚠ A RECEIPT PATH THAT ALREADY EXISTS IS REFUSED, NOT CLEANED UP. Deleting it
  // is what the previous revision did, and a delete that failed was swallowed
  // into a false 'completed'. Refusing costs one rehearsal and cannot invent a
  // success; the path carries a per-attempt token, so this should never happen
  // and its happening means something is wrong.
  if (decision.kind === 'active' && deps.io.existsSync(deps.receiptPath)) {
    return {
      decision: {
        kind: 'refused',
        reason: `the update fixture receipt path [${deps.receiptPath}] already exists `
          + 'before this attempt started, so a completed run could not be told from a '
          + 'stale one; the handoff was DECLINED rather than performing a real update',
      },
      attempt: { refused: `the update fixture receipt path [${deps.receiptPath}] already `
        + 'existed before this attempt started' },
      completed: () => false,
      spawnError: () => spawnError,
    }
  }

  const completed = () => {
    try {
      if (!deps.io.existsSync(deps.receiptPath)) return false
      // A DIRECTORY EXISTS TOO. So does an empty file, and so does a partial
      // write. Existence was never evidence that the fixture finished.
      if (!deps.io.statSync(deps.receiptPath).isFile()) return false
      // AN EXACT TERMINAL LINE, not a substring anywhere in the file. The
      // fixture publishes atomically, so a readable receipt is a complete one;
      // requiring the terminal line as its own line means a truncated or
      // concatenated body cannot satisfy it even if a publish ever were not
      // atomic.
      const wanted = UPDATE_FIXTURE_COMPLETE_LINE + deps.token
      return deps.io.readFileSync(deps.receiptPath, 'utf8')
        .split(/\r?\n/).some((line) => line === wanted)
    } catch { return false }
  }

  if (decision.kind !== 'active') {
    return {
      decision,
      // 'off' carries no attempt, so the ordinary handoff runs untouched.
      // 'refused' carries one, so the handoff is declined instead of falling
      // through to a real installation.
      ...(decision.kind === 'refused' ? { attempt: { refused: decision.reason } } : {}),
      completed: () => false,
      spawnError: () => spawnError,
    }
  }

  const handoff: FixtureHandoffLike = {
    installer: decision.installer,
    receipt: deps.receiptPath,
    spawn: (file, args) => {
        const child = deps.spawn(file, args, {
          env: {
            [UPDATE_FIXTURE_RECEIPT_ENV]: deps.receiptPath,
            [UPDATE_FIXTURE_TOKEN_ENV]: deps.token,
          },
        })
        // ⚠ AN UNHANDLED 'error' ON A ChildProcess THROWS. Node reports a failed
        // exec asynchronously, so a missing fixture arrived as an uncaught
        // exception rather than as a verdict, and the updater's own error slot
        // never sees it because that only carries electron-updater's errors.
        // Captured here and surfaced through spawnError().
        try { child.on('error', (error) => { spawnError ??= error }) } catch { /* not an emitter */ }
        return child
      },
  }

  return { decision, handoff, attempt: handoff, completed, spawnError: () => spawnError }
}
