/** The stored account ID is the public identity. `name` and `label` are
 * legacy fields and must never rename a managed account in the renderer. */
export interface AccountChoiceRow {
  id: string
  provider: string
  /** Retained in old API responses; never used for identity. */
  name?: string
  label?: string
  ambient?: boolean
  identity?: { email?: string | null }
  standing?: { state?: string; auth?: string }
}

/** GET /api/accounts's `host_identity`: who each provider's HOST login — the
 * `provider/primary` selector every surface shows as `default` — is signed in
 * as. It exists because that login often has NO registry row, and reading its
 * address off the ambient row alone made the account-swap selector say
 * `email unavailable` about an account the Usage modal was naming by address.
 * Display metadata only: the selector still submits `provider/primary`. */
export type HostIdentity = Record<string, { email?: string | null } | undefined>

/** GET /api/accounts as a selection surface reads it: the rows it offers and
 * the host logins behind `default`. An older backend answers without
 * `host_identity`, which reads as "nothing observed" — never as an error. */
export interface AccountChoicePayload {
  accounts?: AccountChoiceRow[]
  host_identity?: HostIdentity
}

export const accountEmail = (email?: string | null): string => email?.trim() || 'email unavailable'
export const accountIdentity = (id: string, email?: string | null): string =>
  `${id} · ${accountEmail(email)}`
export const accountDisplayId = (row: AccountChoiceRow): string => row.ambient ? 'default' : row.id
export const primaryAccount = (provider: string): string => `${provider}/primary`
/** The host login's address: the ambient registry row when one carries it,
 * otherwise the authoritative host identity the same payload reports. Both are
 * observations of that one login, never a guess derived from a label. */
export const primaryEmail = (rows: AccountChoiceRow[], provider: string,
                             host?: HostIdentity): string | null | undefined =>
  rows.find(row => row.ambient && row.provider === provider)?.identity?.email
    || host?.[provider]?.email

/** Only the explicit ambient marker translates a legacy stored ID to the
 * supported primary selector. A legacy mutable name is never consulted. */
export function accountValue(value: string, rows: AccountChoiceRow[], provider: string): string {
  if (value === 'primary') return primaryAccount(provider)
  const row = rows.find(row => row.id === value)
  return row?.ambient ? primaryAccount(row.provider) : value
}

export function accountProvider(value: string, rows: AccountChoiceRow[]): string | undefined {
  return rows.find(row => row.id === value)?.provider
    ?? /^(claude|openai|google)(?:\/primary$|-|:)/.exec(value)?.[1]
}

/** The host login is implicit even before migration has registered its row.
 * Limited/unobserved accounts remain choices; their standing is disclosed. */
export function providerAccounts(rows: AccountChoiceRow[], provider: string,
                                 host?: HostIdentity) {
  return [
    { value: primaryAccount(provider), text: accountIdentity('default', primaryEmail(rows, provider, host)) },
    ...rows.filter(row => row.provider === provider && !row.ambient).map(row => ({
      value: row.id,
      text: accountIdentity(row.id, row.identity?.email)
        + (row.standing?.state === 'limited' ? ' (limited — will wait)'
          : row.standing?.auth === 'unauthenticated' ? ' (sign-in required)' : ''),
    })),
  ]
}

export function usageIdentity(id: string, email: string | null | undefined, multiple: boolean): string {
  return multiple ? accountIdentity(id, email) : accountEmail(email)
}
