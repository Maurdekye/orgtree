// canvas/effortlevels.ts — the supported effort levels, on their own so the effort bar
// (and its test) need none of effort.tsx's imports.

/** EVERY LEVEL NAME A HARNESS EXPOSES, lowest first — mirrors the backend's
 *  `catalog::EFFORT_ORDER` (user 2026-10-12: each harness's own names in every
 *  selector): Claude Code's five (`--effort`), Codex's per-model list (which
 *  can include `none` and `minimal`) and Muse's catalog variants. A tier
 *  offers only its own subset — the engine's per-tier `efforts` in the
 *  staffing options (`tierEffortLevels`) — and this order is what the bar's
 *  clamp compares, exactly as the engine's launch mapping does.
 *  Typed `readonly string[]` rather than a literal tuple on purpose: every
 *  reader here compares it against a plain string coming off the payload. */
export const EFFORT_LEVELS: readonly string[] =
  ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** What the bar offers while a tier's own levels are not known yet (the
 *  staffing options have not loaded, or the tier is not offered here):
 *  Claude Code's five, the list this bar always showed before the native
 *  names; the server still refuses a level the agent's tier does not name. */
export const DEFAULT_EFFORT_LEVELS: readonly string[] =
  ['low', 'medium', 'high', 'xhigh', 'max']
