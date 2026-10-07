import { useEffect, useState } from 'react'
import { getRuntimeSettings, req } from '../api'
import type { RuntimeSettingsPayload } from '../types'
import { SetGroup, SetToggle } from './settingskit'

type Key = 'turn_timeout_s' | 'turn_idle_s'
type Unit = 'minutes' | 'hours'

const MAX_S = 31536000

/** split stored seconds into a number and unit for display; 0 = off */
export function splitLimit(seconds: number): { off: boolean; amount: string; unit: Unit } {
  if (seconds <= 0) return { off: true, amount: '', unit: 'hours' }
  if (seconds % 3600 === 0) return { off: false, amount: String(seconds / 3600), unit: 'hours' }
  return { off: false, amount: String(Math.round(seconds / 6) / 10), unit: 'minutes' }
}

/** seconds for a typed amount and unit, or null when it is not a usable limit */
export function limitSeconds(amount: string, unit: Unit): number | null {
  const n = Number(amount)
  if (!amount.trim() || !Number.isFinite(n) || n <= 0) return null
  const s = Math.round(n * (unit === 'hours' ? 3600 : 60))
  return s >= 1 && s <= MAX_S ? s : null
}

function LimitRow({ label, hint, stored, fallback, busy, onSave }: {
  label: string; hint: string; stored: number | undefined; fallback: number; busy: boolean
  onSave: (seconds: number) => void
}) {
  const [amount, setAmount] = useState('')
  const [unit, setUnit] = useState<Unit>('hours')
  const [off, setOff] = useState(false)
  useEffect(() => {
    if (stored === undefined) return
    const s = splitLimit(stored)
    setAmount(s.amount); setUnit(s.unit); setOff(s.off)
  }, [stored])
  if (stored === undefined) return null
  const parsed = limitSeconds(amount, unit)
  const valid = off || parsed !== null
  const commit = (nextOff: boolean, nextAmount: string, nextUnit: Unit) => {
    const seconds = nextOff ? 0 : limitSeconds(nextAmount, nextUnit)
    if (seconds !== null && seconds !== stored) onSave(seconds)
  }
  return <SetToggle label={label} hint={hint} checked={!off} disabled={busy}
    onChange={enabled => {
      const next = !enabled
      setOff(next)
      if (!next && !amount) {
        const s = splitLimit(fallback)
        setAmount(s.amount); setUnit(s.unit)
        commit(false, s.amount, s.unit)
      } else commit(next, amount, unit)
    }} action={<>
    <input type="number" min={1} step="any" aria-label={`${label} amount`} value={amount}
      aria-invalid={!valid} disabled={busy || off}
      onChange={e => setAmount(e.target.value)}
      onBlur={() => commit(off, amount, unit)}
      onKeyDown={e => { if (e.key === 'Enter') commit(off, amount, unit) }} />
    <select aria-label={`${label} unit`} value={unit} disabled={busy || off}
      onChange={e => { const u = e.target.value as Unit; setUnit(u); commit(off, amount, u) }}>
      <option value="minutes">minutes</option>
      <option value="hours">hours</option>
    </select>
    </>} />
}

export function TurnLimitsSetting() {
  const [runtime, setRuntime] = useState<Pick<RuntimeSettingsPayload, Key> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { let live = true
    getRuntimeSettings().then(p => { if (live) setRuntime(p) })
      .catch((e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [])
  const save = (key: Key) => (seconds: number) => { setBusy(true)
    req<RuntimeSettingsPayload>('/api/app-settings/runtime', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: seconds }),
    }).then(p => { setRuntime(p); setError('') })
      .catch((err: Error) => setError(err.message)).finally(() => setBusy(false))
  }
  return <SetGroup title="Turn time limits"
    note="Applies to every organization from the next turn that starts; a turn already running keeps its limit.">
    <LimitRow label="Total limit"
      hint="Stop a turn that runs longer than this, even if the agent is active. Default 24 hours."
      stored={runtime?.turn_timeout_s} fallback={86400} busy={busy} onSave={save('turn_timeout_s')} />
    <LimitRow label="Silence limit"
      hint="Stop a turn whose agent produces no output for this long. Default 10 minutes."
      stored={runtime?.turn_idle_s} fallback={600} busy={busy} onSave={save('turn_idle_s')} />
    {error && <p role="alert">{error}</p>}
  </SetGroup>
}
