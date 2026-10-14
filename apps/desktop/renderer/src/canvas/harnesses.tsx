// canvas/harnesses.tsx — App settings › Harnesses (user 2026-10-13: "document
// the full harness list in the app", placed in App settings by the
// coordinator, there being no Help surface). Every harness the engine knows,
// from its one registry (GET /api/harnesses, engine `harnesses.rs`): installed
// state, cached version, compatibility tags and a missing-only install link.
// A harness added to the registry
// appears here with nothing to change in this file.
//
// `HarnessesLink` is the "Which harnesses are supported?" link every harness
// selector carries; it opens this tab.

import { useEffect, useState } from 'react'
import { getHarnesses } from '../api'
import type { HarnessesDoc } from '../types'
import { SetGroup, openAppSettings } from './settingskit'

/** One entry of a harness picker. `enabled`: it can be chosen here (it is
 *  installed and, for a language server, can drive that kind of server). */
export interface HarnessChoice {
  id: string
  label: string
  installed: boolean
  enabled: boolean
  /** shown after the label when an installed one cannot be chosen */
  note?: string
  title?: string
}

/** The value of the picker's separator row: never a harness id. */
export const HARNESS_SEPARATOR = '__harness-separator__'

/** Every harness picker's options (user 2026-10-13 22:20Z: every supported
 *  harness is shown wherever one is selectable): the installed ones first,
 *  then a separator, then the ones not installed, greyed out and disabled.
 *  Registry order within each group. A saved choice since uninstalled is in
 *  the second group and stays the select's value, so it shows; the engine
 *  refuses to launch it. */
export function HarnessOptions({ choices }: { choices: HarnessChoice[] }) {
  const there = choices.filter((c) => c.installed)
  const absent = choices.filter((c) => !c.installed)
  return <>
    {there.map((c) => <option key={c.id} value={c.id} disabled={!c.enabled} title={c.title}>
      {c.label}{c.enabled || !c.note ? '' : ` (${c.note})`}
    </option>)}
    {there.length > 0 && absent.length > 0
      && <option key={HARNESS_SEPARATOR} value={HARNESS_SEPARATOR} disabled className="harness-sep">──────────</option>}
    {absent.map((c) => <option key={c.id} value={c.id} disabled className="harness-absent"
      title={`${c.label} is not installed on this computer`}>{c.label} (not installed)</option>)}
  </>
}

export function HarnessesLink() {
  return <button type="button" className="link-btn harness-help-link"
    onClick={() => openAppSettings('harnesses')}>Which harnesses are supported?</button>
}

export function HarnessesSection({ active }: { active: boolean }) {
  const [doc, setDoc] = useState<HarnessesDoc | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // read on every visit: installing a CLI changes the answer, and the read
  // spawns nothing (presence only)
  useEffect(() => {
    if (!active) return
    // an engine without the route (or a malformed answer) is an error line,
    // never a render crash that takes the whole settings modal down
    getHarnesses().then((d) => {
      if (Array.isArray(d?.harnesses)) { setDoc(d); setErr(null) }
      else setErr('the engine did not list its harnesses')
    }).catch((e: Error) => setErr(e.message))
  }, [active])
  return <SetGroup title="Harnesses">
    <p className="dim harness-intro">Tags show where else a harness can be used.</p>
    {err && <div className="ask-warn" role="alert">could not read the harnesses: {err}</div>}
    {!doc && !err && <div className="dim">reading the harnesses…</div>}
    {doc && <div className="harness-list" role="list">
      {doc.harnesses.map((h) => <div className="harness-entry" role="listitem" key={h.id} data-harness={h.id}>
        <div className="harness-head">
          <b>{h.name}</b>
          <span className={h.installed ? 'harness-installed' : 'dim'}>
            {h.installed ? ' · installed' : ' · not installed'}</span>
        </div>
        <span className="harness-tags">
          {h.selectable && (h.providers ?? []).some((p) => p.id === 'openrouter')
            && <span className="harness-tag">OpenRouter</span>}
          {h.selectable && (h.providers ?? []).some((p) => p.id === 'langserver')
            && <span className="harness-tag">Language server</span>}
        </span>
        <span className="harness-detail">
          {h.installed ? <span className="dim harness-version">{h.version?.trim() || 'version unknown'}</span>
            : h.install_url && <a href={h.install_url} target="_blank" rel="noreferrer">How to install</a>}
        </span>
      </div>)}
    </div>}
  </SetGroup>
}
