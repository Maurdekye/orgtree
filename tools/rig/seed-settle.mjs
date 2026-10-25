// A synthetic Session 0 turn may first spend the engine's 60-second sign-in
// helper grace. Keep another 60 seconds for execution. This budget is only for
// seed settling: no placement override, fixed sleep, retry or engine change.
export const SEED_SETTLE_TIMEOUT = 120000
