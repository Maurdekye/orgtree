import { useState } from 'react'
import type { AskInfo, ToastFn } from '../types'
import { answerAsk } from '../api'
import { useQuestionVisibility } from '../notification-visibility'

type Schema = { type?: string; title?: string; description?: string; default?: unknown;
  enum?: string[]; enumNames?: string[]; oneOf?: { const: string; title?: string }[];
  anyOf?: { const: string; title?: string }[]; items?: Schema;
  properties?: Record<string, Schema>; required?: string[];
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
  minItems?: number; maxItems?: number; format?: string }
export type Elicitation = { server: string; message: string; mode: string;
  url?: string | null; schema?: Schema; expires_at: string }
const options = (s: Schema) => s.enum?.map((value, i) => ({ value, label: s.enumNames?.[i] ?? value }))
  ?? (s.oneOf ?? s.anyOf)?.map(o => ({ value: o.const, label: o.title ?? o.const }))

/** Drafts remain in this mounted card; no answer mail or persistent permissions. */
export function ElicitationAsk({ ask, slug, toast }: { ask: AskInfo; slug: string; toast: ToastFn }) {
  const e = ask.elicitation!
  const visibility = useQuestionVisibility(slug, ask.id)
  const fields = Object.entries(e.schema?.properties ?? {})
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(fields
    .filter(([, s]) => s.default != null).map(([k, s]) => [k, s.default])))
  const [sending, setSending] = useState(false)
  const [resolved, setResolved] = useState(false)
  const [error, setError] = useState('')
  const change = (k: string, value: unknown) => setValues(v => ({ ...v, [k]: value }))
  const submit = async (action: 'accept' | 'decline' | 'cancel') => {
    if (sending) return
    setSending(true); setError('')
    const content: Record<string, unknown> = Object.create(null)
    if (action === 'accept' && e.mode !== 'url') for (const [key, s] of fields) {
      const v = values[key]
      if (v == null || v === '') continue
      content[key] = s.type === 'number' || s.type === 'integer' ? Number(v)
        : s.type === 'boolean' ? v === true || v === 'true' : v
    }
    try {
      await answerAsk(slug, ask.id, { action, ...(action === 'accept' && e.mode !== 'url' ? { content } : {}) })
      setResolved(true)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message); toast(message)
    } finally { setSending(false) }
  }
  if (resolved) return null
  return <form ref={visibility} className="askcard elicitation-card" data-elicitation-id={ask.id}
    onSubmit={ev => { ev.preventDefault(); void submit('accept') }}>
    <div className="ask-head"><strong>MCP permission · {e.server}</strong></div>
    <p className="ask-q">{e.message}</p>
    <div className="ask-rows elicitation-fields">{e.mode === 'url' ? <p><a href={e.url ?? undefined} target="_blank" rel="noopener noreferrer">{e.url}</a></p>
      : fields.map(([key, s], i) => {
        const id = `${ask.id}-field-${i}`, required = e.schema?.required?.includes(key)
        const choices = options(s.type === 'array' ? s.items ?? {} : s)
        const value = values[key]
        return <label className="elicitation-field" key={key} htmlFor={id}>
          <span>{s.title ?? key}{required ? ' *' : ''}</span>
          {s.description && <small>{s.description}</small>}
          {s.type === 'boolean' ? <select id={id} required={required} disabled={sending}
            value={value == null ? '' : String(value)} onChange={ev => change(key, ev.target.value)}>
            <option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option>
          </select> : choices ? <select id={id} required={required} disabled={sending} multiple={s.type === 'array'}
            value={(s.type === 'array' ? (value ?? []) : (value ?? '')) as string | string[]}
            onChange={ev => change(key, s.type === 'array' ? [...ev.target.selectedOptions].map(o => o.value) : ev.target.value)}>
            {s.type !== 'array' && <option value="">Choose…</option>}
            {choices.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select> : <input id={id} required={required} disabled={sending}
            type={s.type === 'number' || s.type === 'integer' ? 'number' : s.format === 'email' ? 'email' : 'text'}
            step={s.type === 'integer' ? 1 : 'any'} min={s.minimum} max={s.maximum}
            minLength={s.minLength} maxLength={s.maxLength} placeholder={s.format}
            value={value == null ? '' : String(value)} onChange={ev => change(key, ev.target.value)} />}
        </label>
      })}</div>
    <p className="dim">This request expires in five minutes. {e.mode === 'url' ? 'Open the link yourself before accepting. ' : ''}Your decision applies to this request.</p>
    {error && <p role="alert">{error}</p>}
    <div className="row">
      <button type="submit" disabled={sending}>Accept</button>
      <button type="button" disabled={sending} onClick={() => void submit('decline')}>Decline</button>
      <button type="button" disabled={sending} onClick={() => void submit('cancel')}>Cancel</button>
    </div>
  </form>
}
