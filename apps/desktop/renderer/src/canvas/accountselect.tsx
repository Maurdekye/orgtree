import { useId } from 'react'
import { accountIdentity, accountValue, providerAccounts } from '../accountidentity'
import type { AccountChoiceRow, HostIdentity } from '../accountidentity'

/** Account options have identical identities in every selection surface.
 * Empty/inherited values are displayed as primary without changing the
 * caller's saved binding. Only a user action calls onChange.
 *
 * `host` is the account payload's own `host_identity` — how `default` gets
 * the host login's address on a machine whose primary account has no registry
 * row. Omitted or unknown, `default` still reads `email unavailable`. */
export function AccountSelect({ rows, provider, value, onChange, host, label = 'Account',
                               eligible }: {
  rows: AccountChoiceRow[]; provider: string; value: string
  onChange: (value: string) => void; host?: HostIdentity; label?: string
  /** the account VALUES the backend says can run the chosen tier right now.
   *  Given, ineligible accounts are OMITTED rather than offered and then
   *  refused (user ruling 2026-09-15). Omitted or empty, every account is
   *  offered exactly as before — an absent answer is not "none of them work",
   *  and a selector that empties itself because availability could not be
   *  loaded would be worse than one that lets the hire refuse. A binding
   *  already held stays visible through the existing `unknown` path, so
   *  filtering never silently rebinds anybody. */
  eligible?: readonly string[] | null
}) {
  const detailId = useId()
  const all = providerAccounts(rows, provider, host)
  const allowed = eligible && eligible.length
    ? all.filter(choice => eligible.includes(choice.value)) : all
  const choices = allowed.length ? allowed : all
  const selected = accountValue(value, rows, provider) || choices[0].value
  const unknown = !choices.some(choice => choice.value === selected)
  const detail = choices.find(choice => choice.value === selected)?.text
    ?? `${accountIdentity(selected)} (unavailable)`
  return <div className="account-choice">
    <select aria-label={label} aria-describedby={detailId} title={detail}
      value={selected} disabled={choices.length === 1}
      onChange={event => onChange(event.target.value)}>
      {unknown && <option value={selected} disabled>{detail}</option>}
      {choices.map(choice => <option key={choice.value} value={choice.value}>{choice.text}</option>)}
    </select>
    <span id={detailId} className="dim account-choice-identity">{detail}</span>
    {/* A vanished binding must remain visible and must not silently rebind
        on Save. Its explicit recovery action still works with one account. */}
    {unknown && choices.length === 1 && <button type="button"
      onClick={() => onChange(choices[0].value)}>Use {choices[0].text}</button>}
  </div>
}
