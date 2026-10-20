// canvas/userlimits.ts — the engine's limits on the user's own project
// registrations (domain/listeners.rs `MAX_COUNT`, domain/projects.rs
// `MAX_QUEUE_BATCH`), for the desk header's number inputs.

/** the most event listeners a listener watch can wait for */
export const MAX_WATCH_COUNT = 1024
/** the most mail-queue jobs one listener holds at once (agents' fair_queue dogs share it) */
export const MAX_QUEUE_BATCH = 20
