// modalkinds.ts — A MODAL INSTANCE'S NAME IN EVERY STORE (docket
// several-instances-of-the-same-modal-team-slots-i). USER 2026-10-20
// 17:24:20Z: "different versions of the same modal (like the team modal for
// different agents / projects, the slots modal for different projects, the
// inbox modal for different agents, etc.) should be able to coexist. right now
// opening one replaces the other's position". The defaults were approved by the
// coordinator at 18:58:51Z (m5083ac2a0b30).
//
// ⚠ AN INSTANCE IS ITS KIND AND ITS TARGET. The modal pin, the open marker,
// the popped-out window row, the pin/pop request channel and the shared pin
// layer are all keyed by the string a surface's PinFrame is given. Handing
// them `node-inbox:cora` rather than `node-inbox` is the whole of "its own
// position, pin/pop state and persistence", in one spelling. Desks
// (`desk:[org,id,gen]`) and documents (`doc:<id>`) already had this shape.
//
// No imports: windowlayout, windowlife and modalpin all read these, and none
// of them may import the others through here.

/** The surfaces that belong to one agent, project or watchdog. Each was ONE
 *  window per org until 2026-10-20; the bare name is now only the legacy record
 *  that migration turns into its target's, and the kind's placement template. */
export const PER_TARGET_KINDS: ReadonlySet<string> = new Set([
  'node-inbox', 'agent-docket', 'team-docket', 'agent-team',
  'project-slots', 'project-listeners', 'project-desk', 'node-config', 'watchdog',
  // the readers (USER 2026-10-20 19:03:28Z): one per agent or project, and one
  // per agent's or project's team (canvas/readers.ts)
  'agent-gallery', 'team-gallery',
])

/** the instance of `kind` that shows `target` */
export const instanceKind = (kind: string, target: string): string => `${kind}:${target}`

/** the surface a stored kind is, without its target: `agent-team:cora` is an
 *  `agent-team`. Kinds themselves never contain a colon, so the first one
 *  splits, and a target may hold more. */
export const baseKind = (kind: string): string => {
  const at = kind.indexOf(':')
  return at < 0 ? kind : kind.slice(0, at)
}

/** the target an instance kind shows, or null for a kind with no target */
export const instanceTarget = (kind: string): string | null => {
  const at = kind.indexOf(':')
  return at < 0 ? null : kind.slice(at + 1)
}

/** is this stored kind one target's instance of a per-target surface */
export const isInstanceKind = (kind: string): boolean =>
  instanceTarget(kind) !== null && PER_TARGET_KINDS.has(baseKind(kind))

/** The kind a legacy record belongs to now. The team docket was its own kind
 *  once (teamdocket.tsx); it has been the agent docket with its Team box
 *  ticked since 2026-10-18, so its records join that docket's. A team's
 *  presentations were the agent gallery with its Team box ticked; a team
 *  reader is a reader of its own since 2026-10-20. */
export const legacyBase = (kind: string, restore?: { team?: boolean }): string =>
  kind === 'team-docket' ? 'agent-docket'
    : kind === 'agent-gallery' && restore?.team === true ? 'team-gallery' : kind

/** the single-instance kind a stored kind descends from: the old agent
 *  gallery window showed both scopes, and the old team docket is the agent
 *  docket's */
export const legacyFamily = (kind: string): string => {
  const base = baseKind(kind)
  return base === 'team-gallery' ? 'agent-gallery' : base === 'team-docket' ? 'agent-docket' : base
}

/** WHICH TARGET a legacy single-instance record was showing. Its restore
 *  identity already said so: the agent or project, or the watchdog. */
export const legacyTarget = (kind: string,
  restore: { agent?: string; watchdog?: string } | undefined): string | null => {
  const id = kind === 'watchdog' ? restore?.watchdog : restore?.agent
  return typeof id === 'string' && id.length > 0 ? id : null
}

/** The bare per-target kind with a target named in its restore, as the
 *  instance it was. Everything else (already an instance, another kind, or no
 *  target to give it) is returned unchanged. */
export const migratedKind = (kind: string,
  restore: { agent?: string; watchdog?: string; team?: boolean } | undefined): string => {
  if (!PER_TARGET_KINDS.has(kind)) return kind
  const target = legacyTarget(kind, restore)
  return target ? instanceKind(legacyBase(kind, restore), target) : kind
}
