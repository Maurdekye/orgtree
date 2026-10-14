/** UI-only: Muse readings arrive with completed turns, not a manual refresh. */
export const MUSE_USAGE_REFRESH_HINT = 'Muse usage only arrives at the end of a Muse turn.'

export const usageRefreshDisabledReason = (provider?: string): string | undefined =>
  provider?.toLowerCase() === 'muse' ? MUSE_USAGE_REFRESH_HINT : undefined
