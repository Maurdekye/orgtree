import { useCallback, useEffect, useState } from 'react'
import { listOrgs, req } from '../api'
import type { OrgListEntry, RuntimeSettingsPayload } from '../types'
import { SetBlock, SetGroup, SetRow, SetToggle } from './settingskit'

type Feed = Pick<RuntimeSettingsPayload, 'live_feed_enabled' | 'live_feed_port' | 'live_feed_status'>
export type FeedToken = { id: string; label: string; org: string; agent: string; created_at: string; last_used: string | null; agent_live?: boolean }

const RUNTIME = '/api/app-settings/runtime'
const TOKENS = '/api/app-settings/live-feed/tokens'

export const validFeedPort = (s: string): number | null => {
  const n = Number(s)
  return s.trim() !== '' && Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null
}

/** The status line under the toggle. */
export function feedStatusText(s: Feed['live_feed_status']): string {
  if (!s || s.state === 'off') return 'Off'
  if (s.state === 'listening') return `Listening on ${s.url ?? ''}`
  return `${s.error ?? 'could not start'}; retrying every 30 s`
}

/** App settings > Runtime > Live feed: the local WebSocket that publishes engine events to programs on this computer (docs/rust-engine/live-feed.md). */
export function LiveFeedSetting() {
  const [feed, setFeed] = useState<Feed | null>(null)
  const [port, setPort] = useState('')
  const [tokens, setTokens] = useState<FeedToken[]>([])
  const [orgs, setOrgs] = useState<OrgListEntry[]>([])
  const [label, setLabel] = useState('')
  const [org, setOrg] = useState('')
  const [agent, setAgent] = useState('')
  const [agents, setAgents] = useState<string[]>([])
  const [fresh, setFresh] = useState<{ label: string; token: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const load = useCallback(() => {
    req<RuntimeSettingsPayload>(RUNTIME).then(p => { setFeed(p); setPort(String(p.live_feed_port ?? '')) }).catch((e: Error) => setError(e.message))
    req<{ tokens: FeedToken[] }>(TOKENS).then(r => setTokens(r.tokens)).catch(() => setTokens([]))
  }, [])
  useEffect(() => {
    load()
    listOrgs().then(list => { setOrgs(list); setOrg(o => o || list[0]?.slug || '') }).catch(() => {})
  }, [load])
  useEffect(() => {
    if (!org) { setAgents([]); return }
    let live = true
    req<{ agents: string[] }>(`/api/app-settings/live-feed/agents?org=${encodeURIComponent(org)}`)
      .then(r => { if (live) { setAgents(r.agents); setAgent(a => (r.agents.includes(a) ? a : r.agents[0] ?? '')) } })
      .catch(() => { if (live) setAgents([]) })
    return () => { live = false }
  }, [org])
  const save = (body: Record<string, unknown>) => {
    setBusy(true)
    req<RuntimeSettingsPayload>(RUNTIME, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(p => { setFeed(p); setPort(String(p.live_feed_port ?? '')); setError('') })
      .catch((e: Error) => setError(e.message)).finally(() => setBusy(false))
  }
  if (!feed || feed.live_feed_enabled === undefined) return error ? <p role="alert">{error}</p> : null
  const n = validFeedPort(port)
  const create = () => {
    setBusy(true)
    req<{ id: string; token: string }>(TOKENS, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: label.trim(), org, agent: agent.trim() }) })
      .then(r => { setFresh({ label: label.trim(), token: r.token }); setCopied(false); setLabel(''); setError(''); load() })
      .catch((e: Error) => setError(e.message)).finally(() => setBusy(false))
  }
  const revoke = (t: FeedToken) => {
    setBusy(true)
    req(`${TOKENS}/${encodeURIComponent(t.id)}`, { method: 'DELETE' }).then(() => { setError(''); load() })
      .catch((e: Error) => setError(e.message)).finally(() => setBusy(false))
  }
  return <SetGroup title="Live feed">
    <SetToggle label="Publish engine events to programs on this computer" checked={feed.live_feed_enabled} disabled={busy}
      onChange={v => save({ live_feed_enabled: v })}
      hint={`A local WebSocket at ws://127.0.0.1:${feed.live_feed_port ?? 47830}/v1/events. Without a token a program sees only how many agents are in a turn and how many are live. With a token it sees what the token's agent could watch with an event watchdog. Never reachable from other computers.`} />
    <SetRow label="Port" hint="1024 to 65535, default 47830. A change reconnects open programs.">
      <input type="number" min={1024} max={65535} aria-label="Live feed port" value={port} aria-invalid={n === null} disabled={busy}
        onChange={e => setPort(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && n !== null && n !== feed.live_feed_port) save({ live_feed_port: n }) }} />
      <button type="button" disabled={busy || n === null || n === feed.live_feed_port} onClick={() => n !== null && save({ live_feed_port: n })}>Save port</button>
    </SetRow>
    <SetRow label="Status"><span role="status" aria-label="Live feed status">{feedStatusText(feed.live_feed_status)}</span></SetRow>
    <SetBlock label="Access tokens" hint="A token binds a program to one live agent. It sees what an event watchdog of that agent would. The token is shown once, and no agent can create or read one.">
      {tokens.map(t => <SetRow key={t.id} label={t.label}
        hint={`${t.org} / ${t.agent}${t.agent_live === false ? ' (not live)' : ''} · created ${t.created_at.slice(0, 10)} · last used ${t.last_used ? t.last_used.slice(0, 19).replace('T', ' ') : 'never'}`}>
        <button type="button" aria-label={`Revoke ${t.label}`} disabled={busy} onClick={() => revoke(t)}>Revoke</button>
      </SetRow>)}
      <SetRow label="New token">
        <input aria-label="Token label" placeholder="Label" value={label} maxLength={100} disabled={busy} onChange={e => setLabel(e.target.value)} />
        <select aria-label="Token organization" value={org} disabled={busy} onChange={e => setOrg(e.target.value)}>
          {orgs.map(o => <option key={o.slug} value={o.slug}>{o.name || o.slug}</option>)}
        </select>
        <select aria-label="Token agent" value={agent} disabled={busy} onChange={e => setAgent(e.target.value)}>
          {agents.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <button type="button" disabled={busy || !label.trim() || !org || !agent.trim()} onClick={create}>New token</button>
      </SetRow>
      {fresh && <SetRow label={`Token for ${fresh.label}`} hint="Copy it now. It is not shown again.">
        <code className="mono-sm" aria-label="New token value">{fresh.token}</code>
        <button type="button" onClick={() => { navigator.clipboard.writeText(fresh.token).then(() => setCopied(true)).catch(() => setError('copy is unavailable; select the text and copy it')) }}>{copied ? 'Copied' : 'Copy'}</button>
        <button type="button" onClick={() => setFresh(null)}>Done</button>
      </SetRow>}
    </SetBlock>
    {error && <p role="alert">{error}</p>}
  </SetGroup>
}
