import { useId } from 'react'
import { accountIdentity, accountValue, providerAccounts } from '../accountidentity'
import type { AccountChoiceRow } from '../accountidentity'

/** Account options have identical identities in every selection surface.
 * Empty/inherited values are displayed as primary without changing the
 * caller's saved binding. Only a user action calls onChange. */
export function AccountSelect({ rows, provider, value, onChange, label = 'Account' }: {
  rows: AccountChoiceRow[]; provider: string; value: string
  onChange: (value: string) => void; label?: string
}) {
  const detailId = useId()
  const choices = providerAccounts(rows, provider)
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
